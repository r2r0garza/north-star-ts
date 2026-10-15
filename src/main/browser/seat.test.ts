import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// The pool never constructs a real session (the host does), but seat.ts
// imports session.ts, which imports Electron.
vi.mock("electron", () => ({ WebContentsView: class {} }))

import { OriginNotAllowedError } from "./errors"
import {
  SeatBrowserPool,
  SeatSlots,
  seatOriginAllowed,
  seatPartition,
  seatTabId,
  type SeatHandleInput,
  type SeatPoolHost,
} from "./seat"
import type { BrowserSession } from "./session"

type Listener = (...args: unknown[]) => void

// A stand-in for a BrowserSession: navigate() commits the URL (or the URL a
// server would redirect it to) and fires the same events Electron would.
class FakeSession {
  url = "about:blank"
  listeners = new Map<string, Listener[]>()
  cleared = false
  disposed = false
  // url → where the "server" redirects it after commit.
  redirects = new Map<string, string>()
  webContents = {
    on: (event: string, listener: Listener) => {
      this.listeners.set(event, [
        ...(this.listeners.get(event) ?? []),
        listener,
      ])
    },
    getURL: () => this.url,
    getTitle: () => "",
    isDestroyed: () => this.disposed,
    isLoadingMainFrame: () => false,
    setWindowOpenHandler: vi.fn(),
    loadURL: vi.fn(async (url: string) => {
      this.url = url
    }),
  }
  view = {}

  constructor(readonly partition: string) {}

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  async navigate(url: string) {
    this.url = this.redirects.get(url) ?? url
    this.emit("did-navigate", {}, this.url)
    return { url: this.url, title: "" }
  }

  async snapshot() {
    return "- document"
  }

  async screenshot() {
    return { jpeg: Buffer.from("jpeg-bytes"), width: 10, height: 10 }
  }

  async clearStorage() {
    this.cleared = true
  }

  dispose() {
    this.disposed = true
  }
}

let sessions: FakeSession[]
let reveal: boolean
let evidenceRoot: string
let host: SeatPoolHost & {
  shown: string[]
  hidden: string[]
  views: Set<string>
}

function makePool(cap?: number) {
  return new SeatBrowserPool(host, cap)
}

function input(
  phaseRunId: string,
  extra: Partial<SeatHandleInput> = {}
): SeatHandleInput {
  return {
    phaseRunId,
    conversationId: `conv-${phaseRunId}`,
    label: `qa@pod-1 · ${phaseRunId}`,
    signal: new AbortController().signal,
    allowedOrigins: () => [],
    ...extra,
  }
}

beforeEach(() => {
  sessions = []
  reveal = false
  evidenceRoot = mkdtempSync(join(tmpdir(), "seat-evidence-"))
  const shown: string[] = []
  const hidden: string[] = []
  const views = new Set<string>()
  host = {
    shown,
    hidden,
    views,
    createSession: (partition) => {
      const session = new FakeSession(partition)
      sessions.push(session)
      return session as unknown as BrowserSession
    },
    addView: (id) => views.add(id),
    removeView: (id) => views.delete(id),
    showSeat: (id) => shown.push(id),
    hideSeat: (id) => hidden.push(id),
    tabsChanged: () => {},
    revealSetting: () => reveal,
    evidenceDir: (phaseRunId) => join(evidenceRoot, phaseRunId),
  }
})

afterEach(() => {
  rmSync(evidenceRoot, { recursive: true, force: true })
})

describe("seatOriginAllowed", () => {
  it("allows loopback origins and about:blank", () => {
    for (const url of [
      "http://localhost:3000/",
      "https://localhost/",
      "http://127.0.0.1:5173/x",
      "http://[::1]:8080/",
      "http://app.localhost:4000/",
      "about:blank",
    ])
      expect(seatOriginAllowed(url, [])).toBe(true)
  })

  it("allows an app_start origin and refuses everything else", () => {
    const started = ["http://devbox.test:4100"]
    expect(seatOriginAllowed("http://devbox.test:4100/login", started)).toBe(
      true
    )
    expect(seatOriginAllowed("http://devbox.test:4101/", started)).toBe(false)
    for (const url of [
      "https://example.com",
      "file:///etc/passwd",
      "data:text/html,hi",
      "http://localhost.example.com/",
      "not a url",
    ])
      expect(seatOriginAllowed(url, started)).toBe(false)
  })
})

describe("SeatBrowserPool", () => {
  it("refuses a non-local origin without opening a tab", async () => {
    const pool = makePool()
    const handle = pool.handle(input("pr-1"))
    const err = await handle.navigate("https://example.com").catch((e) => e)
    expect(err).toBeInstanceOf(OriginNotAllowedError)
    expect(err.message).toMatch(/loopback origins/)
    expect(sessions).toHaveLength(0)
  })

  it("allows an app_start URL", async () => {
    const pool = makePool()
    const handle = pool.handle(
      input("pr-1", { allowedOrigins: () => ["http://devbox.test:4100"] })
    )
    await expect(
      handle.navigate("http://devbox.test:4100/")
    ).resolves.toMatchObject({ url: "http://devbox.test:4100/" })
  })

  it("gives each phase run its own non-persistent partition", async () => {
    const pool = makePool()
    await pool.handle(input("pr-1")).navigate("http://localhost:3000")
    await pool.handle(input("pr-2")).navigate("http://localhost:3000")
    expect(sessions.map((s) => s.partition)).toEqual([
      seatPartition("pr-1"),
      seatPartition("pr-2"),
    ])
    expect(sessions[0].partition).not.toMatch(/^persist:/)
    // Popups are denied: they would escape the guard.
    expect(sessions[0].webContents.setWindowOpenHandler).toHaveBeenCalled()
  })

  it("keeps one tab per phase run across turns", async () => {
    const pool = makePool()
    await pool.handle(input("pr-1")).navigate("http://localhost:3000")
    await pool.handle(input("pr-1")).navigate("http://localhost:3000/b")
    expect(sessions).toHaveLength(1)
    expect(pool.handle(input("pr-1")).state()).toMatchObject({
      url: "http://localhost:3000/b",
    })
  })

  it("blanks a page that redirected off-origin and says why", async () => {
    const pool = makePool()
    const handle = pool.handle(input("pr-1"))
    await handle.navigate("http://localhost:3000")
    sessions[0].redirects.set(
      "http://localhost:3000/sso",
      "https://login.example.com/"
    )
    const err = await handle
      .navigate("http://localhost:3000/sso")
      .catch((e) => e)
    expect(err).toBeInstanceOf(OriginNotAllowedError)
    expect(err.message).toMatch(/login\.example\.com/)
    expect(err.message).toMatch(/replaced with about:blank/)
    expect(sessions[0].webContents.loadURL).toHaveBeenCalledWith("about:blank")
    // Reported once.
    await expect(handle.navigate("http://localhost:3000")).resolves.toBeTruthy()
  })

  it("stops an off-origin navigation the page starts", async () => {
    const pool = makePool()
    const handle = pool.handle(input("pr-1"))
    await handle.navigate("http://localhost:3000")
    const event = { preventDefault: vi.fn() }
    sessions[0].emit("will-navigate", event, "https://evil.example/")
    expect(event.preventDefault).toHaveBeenCalled()
    const local = { preventDefault: vi.fn() }
    sessions[0].emit("will-navigate", local, "http://localhost:3000/next")
    expect(local.preventDefault).not.toHaveBeenCalled()
    // The next tool call reports it.
    const err = await handle.snapshot().catch((e) => e)
    expect(err).toBeInstanceOf(OriginNotAllowedError)
    expect(err.message).toMatch(/navigation was stopped/)
  })

  it("caps concurrent seat tabs: a fourth waits for a free slot", async () => {
    const pool = makePool(3)
    for (const id of ["a", "b", "c"])
      await pool.handle(input(id)).navigate("http://localhost:3000")
    let done = false
    const fourth = pool
      .handle(input("d"))
      .navigate("http://localhost:3000")
      .then(() => (done = true))
    await new Promise((r) => setTimeout(r, 10))
    expect(done).toBe(false)
    expect(pool.waiting).toBe(1)
    await pool.release("a")
    await fourth
    expect(done).toBe(true)
    expect(pool.openTabs).toBe(3)
  })

  it("unwinds a seat waiting for a slot when its turn is cancelled", async () => {
    const pool = makePool(1)
    await pool.handle(input("a")).navigate("http://localhost:3000")
    const abort = new AbortController()
    const waiting = pool
      .handle(input("b", { signal: abort.signal }))
      .navigate("http://localhost:3000")
    await new Promise((r) => setTimeout(r, 0))
    abort.abort(new Error("stopped"))
    await expect(waiting).rejects.toThrow("stopped")
    expect(pool.waiting).toBe(0)
    // The held slot is unaffected and frees normally.
    await pool.release("a")
    await pool.handle(input("c")).navigate("http://localhost:3000")
    expect(pool.openTabs).toBe(1)
  })

  it("closes the tab and clears its storage at phase end", async () => {
    const pool = makePool()
    await pool.handle(input("pr-1")).navigate("http://localhost:3000")
    expect(host.views.has(seatTabId("pr-1"))).toBe(true)
    await pool.release("pr-1")
    expect(sessions[0].cleared).toBe(true)
    expect(sessions[0].disposed).toBe(true)
    expect(host.views.size).toBe(0)
    expect(pool.openTabs).toBe(0)
    // Releasing a phase that never opened a tab is harmless.
    await pool.release("never")
  })

  it("stays hidden by default", async () => {
    const pool = makePool()
    await pool.handle(input("pr-1")).navigate("http://localhost:3000")
    expect(host.shown).toEqual([])
    expect(pool.tabInfos(null)).toEqual([])
  })

  it("with the setting on, lists the tab with its label and reveals it once", async () => {
    reveal = true
    const pool = makePool()
    const handle = pool.handle(input("pr-1"))
    await handle.navigate("http://localhost:3000")
    await handle.navigate("http://localhost:3000/b")
    expect(host.shown).toEqual([seatTabId("pr-1")])
    expect(pool.tabInfos(seatTabId("pr-1"))).toEqual([
      expect.objectContaining({
        id: seatTabId("pr-1"),
        title: "qa@pod-1 · pr-1",
        active: true,
        seat: true,
      }),
    ])
  })

  it("applies a mid-run toggle at the seat's next navigation", async () => {
    const pool = makePool()
    const handle = pool.handle(input("pr-1"))
    await handle.navigate("http://localhost:3000")
    reveal = true
    expect(pool.tabInfos(null)).toEqual([])
    await handle.navigate("http://localhost:3000/b")
    expect(pool.tabInfos(null)).toHaveLength(1)
    reveal = false
    await handle.navigate("http://localhost:3000/c")
    expect(host.hidden).toEqual([seatTabId("pr-1")])
    expect(pool.tabInfos(null)).toEqual([])
  })

  it("saves screenshots and requested excerpts as evidence", async () => {
    const pool = makePool()
    const handle = pool.handle(input("pr-1"))
    await handle.navigate("http://localhost:3000")
    const shot = await handle.screenshot()
    expect(shot.evidencePath).toBeTruthy()
    expect(shot.evidencePath!.startsWith(join(evidenceRoot, "pr-1"))).toBe(true)
    expect(readFileSync(shot.evidencePath!, "utf8")).toBe("jpeg-bytes")
    const saved = await handle.saveEvidence!("console.json", "[]")
    expect(existsSync(saved)).toBe(true)
    expect(saved.endsWith("console.json")).toBe(true)
  })
})

describe("SeatSlots", () => {
  it("hands a freed slot straight to the next waiter", async () => {
    const slots = new SeatSlots(1)
    await slots.acquire("a")
    const b = slots.acquire("b")
    slots.release()
    await b
    expect(slots.inUse).toBe(1)
    slots.release()
    expect(slots.inUse).toBe(0)
  })

  it("fails a key's waiters when its phase ends first", async () => {
    const slots = new SeatSlots(1)
    await slots.acquire("a")
    const b = slots.acquire("b")
    slots.cancel("b", new Error("The phase ended."))
    await expect(b).rejects.toThrow("The phase ended.")
    expect(slots.waiting).toBe(0)
  })
})

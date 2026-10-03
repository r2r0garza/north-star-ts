import { beforeEach, describe, expect, it, vi } from "vitest"

// Placement of conversation views across the hosts. A view hidden with
// setVisible(false) can't be screenshotted in real Electron (the CDP capture
// never resolves), so every tab that isn't on screen must be parked VISIBLE in
// the never-shown ParkedViewHost window. These fakes track each view's parent
// window and visibility so the tests can check exactly that.

const fakes = vi.hoisted(() => {
  type Bounds = { x: number; y: number; width: number; height: number }
  type Listener = (...args: unknown[]) => void

  class FakeView {
    parent: FakeWindow | null = null
    visible = true
    bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 }
    setVisible(visible: boolean) {
      this.visible = visible
    }
    setBounds(bounds: Bounds) {
      this.bounds = bounds
    }
    getBounds() {
      return this.bounds
    }
  }

  class FakeWindow {
    static all: FakeWindow[] = []
    title: string
    destroyed = false
    shown = false
    children: FakeView[] = []
    private listeners = new Map<string, Listener[]>()
    contentView = {
      addChildView: (view: FakeView) => {
        if (view.parent) throw new Error("view already has a parent")
        view.parent = this
        this.children.push(view)
      },
      removeChildView: (view: FakeView) => {
        this.children = this.children.filter((v) => v !== view)
        if (view.parent === this) view.parent = null
      },
    }
    webContents = { send: () => {}, isDestroyed: () => this.destroyed }
    constructor(options: { title?: string } = {}) {
      this.title = options.title ?? "main"
      FakeWindow.all.push(this)
    }
    on(event: string, listener: Listener) {
      this.listeners.set(event, [
        ...(this.listeners.get(event) ?? []),
        listener,
      ])
    }
    removeAllListeners(event: string) {
      this.listeners.delete(event)
    }
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      for (const view of this.children) view.parent = null
      this.children = []
      this.destroyed = true
      for (const listener of this.listeners.get("closed") ?? []) listener()
    }
    loadURL() {
      return Promise.resolve()
    }
    loadFile() {
      return Promise.resolve()
    }
    getContentSize() {
      return [1000, 760]
    }
    isVisible() {
      return this.shown
    }
    showInactive() {
      this.shown = true
    }
    hide() {
      this.shown = false
    }
  }

  class FakeSession {
    static all: FakeSession[] = []
    view = new FakeView()
    url = "about:blank"
    disposed = false
    webContents = {
      on: () => {},
      getURL: () => this.url,
      getTitle: () => "",
      isDestroyed: () => this.disposed,
      isLoadingMainFrame: () => false,
      setWindowOpenHandler: () => {},
      loadURL: async (url: string) => {
        this.url = url
      },
    }
    constructor() {
      FakeSession.all.push(this)
    }
    async navigate(url: string) {
      this.url = url
      return { url, title: "" }
    }
    // Mirrors real Electron: a hidden view's capture never resolves.
    async screenshot() {
      if (!this.view.visible || !this.view.parent || this.view.parent.destroyed)
        throw new Error("Browser operation timed out")
      return { jpeg: Buffer.from("jpeg"), width: 10, height: 10 }
    }
    async clearStorage() {}
    dispose() {
      this.disposed = true
    }
  }

  return { FakeView, FakeWindow, FakeSession }
})

const settings = vi.hoisted(() => ({
  revealOnAgentUse: "never",
  revealMissionControl: false,
}))

vi.mock("electron", () => ({
  BrowserWindow: fakes.FakeWindow,
  WebContentsView: fakes.FakeView,
}))
vi.mock("./session", () => ({
  BrowserSession: fakes.FakeSession,
  StaleRefError: class StaleRefError extends Error {},
}))
vi.mock("../settings/service", () => ({ getBrowser: () => settings }))

import { BrowserManager } from "./manager"
import { PARKED_VIEWPORT } from "./parked-host"

type FakeWindow = InstanceType<typeof fakes.FakeWindow>

let manager: BrowserManager
let main: FakeWindow

const SIDEBAR = { x: 800, y: 0, width: 400, height: 800 }

function viewOf(conversationId: string) {
  // Sessions are created in the order the tests first use each conversation.
  const session = (
    manager as unknown as {
      tabs: Map<string, InstanceType<typeof fakes.FakeSession>>
    }
  ).tabs.get(conversationId)
  if (!session) throw new Error(`no tab for ${conversationId}`)
  return session.view
}

// Where a conversation's view lives: "main" (sidebar embed), "agent" (the
// Agent Browser window), "parked", or null (detached).
function where(conversationId: string): string | null {
  const parent = viewOf(conversationId).parent
  if (!parent || parent.destroyed) return null
  if (parent === main) return "main"
  if (parent.title === "Agent Browser") return "agent"
  if (parent.title === "Agent Browser (parked)") return "parked"
  return parent.title
}

function visible(conversationId: string): boolean {
  return viewOf(conversationId).visible
}

function parkedWindow(): FakeWindow | undefined {
  return fakes.FakeWindow.all.find(
    (w) => w.title === "Agent Browser (parked)" && !w.destroyed
  )
}

async function open(conversationId: string) {
  const handle = manager.handleForTurn(conversationId)
  await handle.navigate("http://localhost:3000/")
  return handle
}

beforeEach(() => {
  fakes.FakeWindow.all = []
  fakes.FakeSession.all = []
  settings.revealOnAgentUse = "never"
  settings.revealMissionControl = false
  manager = new BrowserManager()
  main = new fakes.FakeWindow()
  manager.setMainWindow(main as never)
})

describe("BrowserManager view placement (sidebar surface)", () => {
  it("parks a background conversation's tab visible, so it can be screenshotted", async () => {
    manager.setActiveConversation("A")
    manager.reportSidebarBounds(SIDEBAR)
    await open("A")
    const b = await open("B")

    expect(where("B")).toBe("parked")
    expect(visible("B")).toBe(true)
    await expect(b.screenshot()).resolves.toMatchObject({ width: 10 })
    // The user's tab is untouched.
    expect(where("A")).toBe("main")
    expect(visible("A")).toBe(true)
  })

  it("gives a never-shown parked view a real size", async () => {
    manager.setActiveConversation("A")
    await open("B")
    expect(viewOf("B").bounds).toEqual(PARKED_VIEWPORT)
  })

  it("parks the active tab while the panel is closed and embeds it when it opens", async () => {
    manager.setActiveConversation("A")
    const a = await open("A")
    expect(where("A")).toBe("parked")
    await expect(a.screenshot()).resolves.toBeDefined()

    manager.reportSidebarBounds(SIDEBAR)
    expect(where("A")).toBe("main")
    expect(visible("A")).toBe(true)
    expect(viewOf("A").bounds).toEqual(SIDEBAR)

    // A modal over the panel, then the panel closing: parked each time,
    // keeping the size the user last saw.
    manager.setSidebarVisible(false)
    expect(where("A")).toBe("parked")
    expect(visible("A")).toBe(true)
    expect(viewOf("A").bounds).toEqual(SIDEBAR)
    manager.setSidebarVisible(true)
    expect(where("A")).toBe("main")
    manager.reportSidebarBounds(null)
    expect(where("A")).toBe("parked")
    await expect(a.screenshot()).resolves.toBeDefined()
  })

  it("swaps the embed when the user switches conversation", async () => {
    manager.setActiveConversation("A")
    manager.reportSidebarBounds(SIDEBAR)
    await open("A")
    await open("B")

    manager.setActiveConversation("B")
    expect(where("B")).toBe("main")
    expect(where("A")).toBe("parked")
    expect(visible("A")).toBe(true)
    expect(main.children).toEqual([viewOf("B")])
  })
})

describe("BrowserManager view placement (window surface)", () => {
  beforeEach(() => manager.setSurface("window"))

  it("shows only the active tab in the window and parks the rest visible", async () => {
    manager.setActiveConversation("A")
    await open("A")
    const b = await open("B")

    expect(where("A")).toBe("agent")
    expect(visible("A")).toBe(true)
    expect(where("B")).toBe("parked")
    expect(visible("B")).toBe(true)
    await expect(b.screenshot()).resolves.toBeDefined()

    manager.setActiveConversation("B")
    expect(where("B")).toBe("agent")
    expect(where("A")).toBe("parked")
  })

  it("moves views between surfaces when the user pops out or docks", async () => {
    manager.setActiveConversation("A")
    manager.reportSidebarBounds(SIDEBAR)
    await open("A")
    expect(where("A")).toBe("agent")

    manager.setSurface("sidebar")
    expect(where("A")).toBe("main")
    manager.setSurface("window")
    expect(where("A")).toBe("agent")
    expect(main.children).toEqual([])
  })

  it("a handoff reveal shows a background tab and parks the one it replaces", async () => {
    manager.setActiveConversation("A")
    await open("A")
    const b = await open("B")

    b.reveal()
    expect(where("B")).toBe("agent")
    expect(visible("B")).toBe(true)
    expect(where("A")).toBe("parked")
    expect(visible("A")).toBe(true)
  })

  it("parks the window's conversation tab while a seat is shown there", async () => {
    settings.revealMissionControl = true
    manager.setActiveConversation("A")
    await open("A")
    const seat = manager.seatHandle({
      phaseRunId: "run-1",
      conversationId: "seat-conv",
      label: "qa@pod-1 · US-1",
      signal: new AbortController().signal,
      allowedOrigins: () => [],
    })
    await seat.navigate("http://localhost:3000/")

    expect(where("A")).toBe("parked")
    expect(visible("A")).toBe(true)

    await manager.releaseSeat("run-1")
    expect(where("A")).toBe("agent")
    expect(visible("A")).toBe(true)
  })
})

describe("BrowserManager parked host lifecycle", () => {
  it("closing tabs removes their views, and the parked window goes with the last", async () => {
    manager.setActiveConversation("A")
    await open("B")
    await open("C")
    expect(parkedWindow()?.children).toHaveLength(2)

    manager.closeTab("B")
    expect(parkedWindow()?.children).toEqual([viewOf("C")])
    manager.closeTab("C")
    expect(parkedWindow()).toBeUndefined()
  })

  it("never parks a view while it's in another window", async () => {
    // FakeWindow.addChildView throws if a view still has a parent, so any
    // re-parenting order bug surfaces here.
    manager.setActiveConversation("A")
    await open("A")
    await open("B")
    manager.reportSidebarBounds(SIDEBAR)
    manager.setActiveConversation("B")
    manager.setSurface("window")
    manager.setActiveConversation("A")
    manager.setSurface("sidebar")
    manager.setSidebarVisible(false)
    manager.setSidebarVisible(true)
    expect(where("A")).toBe("main")
    expect(where("B")).toBe("parked")
  })
})

import { mkdir, writeFile } from "fs/promises"
import { join } from "path"
import { OriginNotAllowedError } from "./errors"
import type { BrowserHandle, BrowserState } from "./manager"
import { BrowserSession, StaleRefError } from "./session"
import type { TabInfo } from "./window"
import {
  INTERACT_TIMEOUT_MS,
  NAVIGATE_TIMEOUT_MS,
  SCREENSHOT_TIMEOUT_MS,
  SNAPSHOT_TIMEOUT_MS,
} from "./timeouts"

// Browsers for Mission Control seats (plan 109.04). A seat's `work` turn drives
// the app it's testing in a background tab that is:
//   - isolated: a non-persistent partition per phase run, so it never sees the
//     user's `persist:agent-browser` logins and parallel seats never see each
//     other's cookies or storage;
//   - local-only: loopback origins plus the origins `app_start` returned for
//     this phase run. Navigation the page starts itself is checked too, and an
//     off-origin page is replaced with about:blank;
//   - capped: at most `cap` seat tabs exist at once; further seats wait for a
//     slot, bounded by their turn's signal;
//   - torn down at phase end, whatever the outcome: the tab closes and its
//     partition's storage is cleared.
// Screenshots are also saved as evidence under the phase run's evidence
// directory, so a proof can cite them.

export const DEFAULT_SEAT_TAB_CAP = 3
const SEAT_PARTITION_PREFIX = "agent-browser-seat:"
const SEAT_TAB_PREFIX = "seat:"

export function seatPartition(phaseRunId: string): string {
  return `${SEAT_PARTITION_PREFIX}${phaseRunId}`
}

export function seatTabId(phaseRunId: string): string {
  return `${SEAT_TAB_PREFIX}${phaseRunId}`
}

export function isSeatTabId(id: string): boolean {
  return id.startsWith(SEAT_TAB_PREFIX)
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "[::1]"
  )
}

// Whether a seat may be on `url`: about:blank, loopback http(s), or one of
// `extraOrigins` (the app_start URLs of this phase run). Everything else —
// public sites, file://, data: — is refused.
export function seatOriginAllowed(
  url: string,
  extraOrigins: string[]
): boolean {
  if (url === "about:blank") return true
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  if (isLoopbackHost(parsed.hostname)) return true
  return extraOrigins.some((origin) => {
    try {
      return new URL(origin).origin === parsed.origin
    } catch {
      return false
    }
  })
}

function describeAllowed(extraOrigins: string[]): string {
  const extra = [...new Set(extraOrigins)].filter((o) => {
    try {
      return !isLoopbackHost(new URL(o).hostname)
    } catch {
      return false
    }
  })
  return [
    "loopback origins (localhost, 127.0.0.1, [::1], *.localhost)",
    ...extra,
  ].join(", ")
}

// A counting semaphore whose waiters can be cancelled by their signal or by
// key (the phase ended while it was still waiting).
export class SeatSlots {
  private held = 0
  private waiters: Array<{
    key: string
    grant: () => void
    fail: (err: unknown) => void
  }> = []

  constructor(readonly cap: number) {}

  get inUse(): number {
    return this.held
  }

  get waiting(): number {
    return this.waiters.length
  }

  acquire(key: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal))
    if (this.held < this.cap) {
      this.held++
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.drop(waiter)
        reject(abortReason(signal!))
      }
      const waiter = {
        key,
        grant: () => {
          signal?.removeEventListener("abort", onAbort)
          resolve()
        },
        fail: (err: unknown) => {
          signal?.removeEventListener("abort", onAbort)
          reject(err)
        },
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    // The slot passes straight to the next waiter; `held` is unchanged.
    if (next) next.grant()
    else this.held = Math.max(0, this.held - 1)
  }

  // Fail every waiter for `key` (its phase ended before a slot freed).
  cancel(key: string, err: unknown): void {
    for (const waiter of this.waiters.filter((w) => w.key === key)) {
      this.drop(waiter)
      waiter.fail(err)
    }
  }

  cancelAll(err: unknown): void {
    for (const waiter of this.waiters.splice(0)) waiter.fail(err)
  }

  private drop(waiter: (typeof this.waiters)[number]): void {
    const at = this.waiters.indexOf(waiter)
    if (at >= 0) this.waiters.splice(at, 1)
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Aborted")
}

export interface SeatHandleInput {
  // The phase run the seat is working in: keys the tab, its partition, its
  // evidence directory, and its teardown.
  phaseRunId: string
  conversationId: string
  // Shown on the tab when it's visible, e.g. `qa@pod-1 · F1.M2.US3`.
  label: string
  signal: AbortSignal
  // The origins app_start returned in this phase run (read live).
  allowedOrigins: () => string[]
}

// What the pool needs from the browser manager: a place to home views, a way
// to show one in the Agent Browser window, and the reveal setting.
export interface SeatPoolHost {
  createSession(partition: string): BrowserSession
  // Home a view where it runs unseen (see ParkedViewHost), and remove it from
  // wherever it is.
  addView(id: string, view: BrowserSession["view"]): void
  removeView(id: string): void
  // Bring the window forward showing this seat's tab.
  showSeat(id: string): void
  // A visible seat tab became hidden (setting turned off) or closed.
  hideSeat(id: string): void
  // The seat tab list changed (title/url/visibility).
  tabsChanged(): void
  // "Show the Mission Control browser when the agent uses it".
  revealSetting(): boolean
  // Where evidence for a phase run is saved (app data).
  evidenceDir(phaseRunId: string): string
}

interface SeatTab {
  id: string
  phaseRunId: string
  session: BrowserSession
  label: string
  // Listed in (and showable by) the Agent Browser window.
  visible: boolean
  // Brought the window forward once already for this tab.
  revealed: boolean
  // An off-origin navigation the guard stopped (or blanked, once committed)
  // since it was last reported.
  blocked: { url: string; blanked: boolean } | null
  allowedOrigins: () => string[]
  screenshots: number
}

export class SeatBrowserPool {
  private readonly slots: SeatSlots
  private tabs = new Map<string, SeatTab>()
  // A tab being created (waiting for a slot) — shared by concurrent calls.
  private pending = new Map<string, Promise<SeatTab>>()
  private disposed = false

  constructor(
    private readonly host: SeatPoolHost,
    cap = DEFAULT_SEAT_TAB_CAP
  ) {
    this.slots = new SeatSlots(cap)
  }

  get openTabs(): number {
    return this.tabs.size
  }

  get waiting(): number {
    return this.slots.waiting
  }

  has(id: string): boolean {
    return this.tabs.has(id)
  }

  // Seat tabs the Agent Browser window lists (visible ones only).
  tabInfos(shownId: string | null): TabInfo[] {
    const infos: TabInfo[] = []
    for (const tab of this.tabs.values()) {
      if (!tab.visible) continue
      const wc = tab.session.webContents
      if (wc.isDestroyed()) continue
      const url = wc.getURL()
      infos.push({
        id: tab.id,
        title: tab.label,
        url,
        loading: wc.isLoadingMainFrame(),
        active: tab.id === shownId,
        seat: true,
      })
    }
    return infos
  }

  isVisible(id: string): boolean {
    return !!this.tabs.get(id)?.visible
  }

  viewOf(id: string): BrowserSession["view"] | null {
    return this.tabs.get(id)?.session.view ?? null
  }

  private async ensureTab(input: SeatHandleInput): Promise<SeatTab> {
    if (this.disposed) throw new Error("The seat browser is shut down.")
    const id = seatTabId(input.phaseRunId)
    const existing = this.tabs.get(id)
    if (existing) return existing
    const inflight = this.pending.get(id)
    if (inflight) return inflight
    const created = (async () => {
      await this.slots.acquire(id, input.signal)
      if (this.disposed) {
        this.slots.release()
        throw new Error("The seat browser is shut down.")
      }
      return this.createTab(id, input)
    })()
    this.pending.set(id, created)
    try {
      return await created
    } finally {
      this.pending.delete(id)
    }
  }

  private createTab(id: string, input: SeatHandleInput): SeatTab {
    const session = this.host.createSession(seatPartition(input.phaseRunId))
    const tab: SeatTab = {
      id,
      phaseRunId: input.phaseRunId,
      session,
      label: input.label,
      visible: false,
      revealed: false,
      blocked: null,
      allowedOrigins: input.allowedOrigins,
      screenshots: 0,
    }
    const wc = session.webContents
    // No popups: a new window would escape the guard and the tab strip.
    wc.setWindowOpenHandler?.(() => ({ action: "deny" }))
    const allowed = (url: string) =>
      seatOriginAllowed(url, tab.allowedOrigins())
    // Stop off-origin navigation the page starts (links, window.location,
    // server redirects) before the request goes out...
    const veto = (event: { preventDefault(): void }, url: string) => {
      if (allowed(url)) return
      event.preventDefault()
      tab.blocked = { url, blanked: false }
    }
    wc.on("will-navigate", veto as never)
    wc.on("will-redirect", veto as never)
    // ...and check again once a navigation has committed, in case one got
    // past the veto: an off-origin page is replaced with about:blank.
    wc.on("did-navigate", ((_event: unknown, url: string) => {
      if (allowed(url)) return
      tab.blocked = { url, blanked: true }
      void wc.loadURL("about:blank").catch(() => undefined)
    }) as never)
    const push = () => {
      if (tab.visible) this.host.tabsChanged()
    }
    wc.on("did-navigate-in-page", push)
    wc.on("did-stop-loading", push)
    wc.on("page-title-updated", push)
    this.tabs.set(id, tab)
    this.host.addView(id, session.view)
    return tab
  }

  // Apply the reveal setting at a navigation: on → list the tab in the Agent
  // Browser window and bring it forward the first time; off → hide it again.
  private applyReveal(tab: SeatTab): void {
    if (this.host.revealSetting()) {
      if (!tab.visible) {
        tab.visible = true
        this.host.tabsChanged()
      }
      if (!tab.revealed) {
        tab.revealed = true
        this.host.showSeat(tab.id)
      }
    } else if (tab.visible) {
      tab.visible = false
      this.host.hideSeat(tab.id)
      this.host.tabsChanged()
    }
  }

  // Report (once) an off-origin navigation the guard stopped or blanked.
  private takeBlocked(tab: SeatTab): void {
    const blocked = tab.blocked
    if (!blocked) return
    tab.blocked = null
    const outcome = blocked.blanked
      ? "so the page was replaced with about:blank"
      : "so the navigation was stopped"
    throw new OriginNotAllowedError(
      `The page tried to go to ${blocked.url}, which a Mission Control seat may not open, ${outcome}. Allowed: ${describeAllowed(tab.allowedOrigins())}.`
    )
  }

  private existing(phaseRunId: string): SeatTab | undefined {
    return this.tabs.get(seatTabId(phaseRunId))
  }

  private async saveEvidence(
    phaseRunId: string,
    name: string,
    data: string | Buffer
  ): Promise<string> {
    const dir = this.host.evidenceDir(phaseRunId)
    await mkdir(dir, { recursive: true })
    const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "file"
    const path = join(dir, safe)
    await writeFile(path, data)
    return path
  }

  // A per-turn handle for one seat's tab, bound to the turn's signal. The tab
  // outlives the turn; release() at phase end closes it.
  handle(input: SeatHandleInput): BrowserHandle {
    const { signal, phaseRunId } = input
    const run = async <T>(op: (tab: SeatTab) => Promise<T>): Promise<T> => {
      const tab = await this.ensureTab(input)
      let result: T
      try {
        result = await op(tab)
      } catch (err) {
        // A navigation the guard stopped can fail the call; say why.
        this.takeBlocked(tab)
        throw err
      }
      this.takeBlocked(tab)
      return result
    }
    const stamp = () => new Date().toISOString().replace(/[:.]/g, "-")
    return {
      navigate: (url) => {
        const extra = input.allowedOrigins()
        if (!seatOriginAllowed(url, extra))
          return Promise.reject(
            new OriginNotAllowedError(
              `${url} isn't allowed for a Mission Control seat. Allowed: ${describeAllowed(extra)}.`
            )
          )
        return run(async (tab) => {
          this.applyReveal(tab)
          return tab.session.navigate(url, NAVIGATE_TIMEOUT_MS, signal)
        })
      },
      screenshot: () =>
        run(async (tab) => {
          const shot = await tab.session.screenshot(
            SCREENSHOT_TIMEOUT_MS,
            signal
          )
          tab.screenshots++
          const evidencePath = await this.saveEvidence(
            phaseRunId,
            `screenshot-${String(tab.screenshots).padStart(3, "0")}-${stamp()}.jpg`,
            shot.jpeg
          ).catch((err) => {
            console.warn("[browser] could not save seat evidence:", err)
            return undefined
          })
          return evidencePath ? { ...shot, evidencePath } : shot
        }),
      snapshot: () =>
        run((tab) => tab.session.snapshot(SNAPSHOT_TIMEOUT_MS, signal)),
      describeRef: (ref) => {
        const tab = this.existing(phaseRunId)
        if (!tab) throw new StaleRefError(ref)
        return tab.session.describeRef(ref)
      },
      click: (ref) =>
        run((tab) => tab.session.click(ref, INTERACT_TIMEOUT_MS, signal)),
      hover: (ref) =>
        run((tab) => tab.session.hover(ref, INTERACT_TIMEOUT_MS, signal)),
      drag: (fromRef, toRef) =>
        run((tab) =>
          tab.session.drag(fromRef, toRef, INTERACT_TIMEOUT_MS, signal)
        ),
      type: (ref, text, submit) =>
        run((tab) =>
          tab.session.type(ref, text, submit, INTERACT_TIMEOUT_MS, signal)
        ),
      selectOption: (ref, option) =>
        run((tab) =>
          tab.session.selectOption(ref, option, INTERACT_TIMEOUT_MS, signal)
        ),
      wait: (waitInput) =>
        run((tab) => tab.session.wait(waitInput, NAVIGATE_TIMEOUT_MS, signal)),
      console: (options) =>
        this.existing(phaseRunId)?.session.console(options) ?? {
          entries: [],
          nextCursor: null,
        },
      network: (options) =>
        this.existing(phaseRunId)?.session.network(options) ?? {
          entries: [],
          nextCursor: null,
        },
      dialog: () => this.existing(phaseRunId)?.session.dialog() ?? null,
      handleDialog: (action, promptText) =>
        run((tab) =>
          tab.session.handleDialog(
            action,
            promptText,
            INTERACT_TIMEOUT_MS,
            signal
          )
        ),
      evaluate: (expression) =>
        run((tab) =>
          tab.session.evaluate(expression, INTERACT_TIMEOUT_MS, signal)
        ),
      back: () => run((tab) => tab.session.back(NAVIGATE_TIMEOUT_MS, signal)),
      // Closing mid-phase frees the slot; a later navigate opens a fresh tab
      // in the same partition.
      close: () => {
        const tab = this.existing(phaseRunId)
        if (!tab) return false
        this.closeTab(tab, false)
        return true
      },
      // No human is waiting in a headless phase; browser_handoff isn't
      // offered to seats, so there is nothing to reveal for.
      reveal: () => {},
      state: () => {
        const tab = this.existing(phaseRunId)
        if (!tab) return null
        return stateOf(tab.session)
      },
      saveEvidence: (name, content) =>
        this.saveEvidence(phaseRunId, `${stamp()}-${name}`, content),
    }
  }

  // Close a seat's tab and free its slot. Its partition's storage is cleared
  // at phase end; a close mid-phase keeps it for the next tab in the run.
  private closeTab(tab: SeatTab, clearStorage: boolean): Promise<void> {
    this.tabs.delete(tab.id)
    if (tab.visible) this.host.hideSeat(tab.id)
    this.host.removeView(tab.id)
    const wipe = clearStorage
      ? tab.session.clearStorage().catch((err) => {
          console.warn("[browser] could not clear a seat's storage:", err)
        })
      : Promise.resolve()
    return wipe.finally(() => {
      tab.session.dispose()
      this.slots.release()
      this.host.tabsChanged()
    })
  }

  // Phase end, whatever the outcome: close the seat's tab, clear its
  // partition's storage, and fail any call still waiting for a slot.
  async release(phaseRunId: string): Promise<void> {
    const id = seatTabId(phaseRunId)
    this.slots.cancel(id, new Error("The phase ended."))
    const pending = this.pending.get(id)
    if (pending) await pending.catch(() => undefined)
    const tab = this.tabs.get(id)
    if (tab) await this.closeTab(tab, true)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.slots.cancelAll(new Error("The seat browser is shut down."))
    for (const tab of this.tabs.values()) tab.session.dispose()
    this.tabs.clear()
  }
}

function stateOf(session: BrowserSession): BrowserState | null {
  const wc = session.webContents
  if (wc.isDestroyed()) return null
  const url = wc.getURL()
  if (!url || url === "about:blank") return null
  return { url, title: wc.getTitle() || url, loading: wc.isLoadingMainFrame() }
}

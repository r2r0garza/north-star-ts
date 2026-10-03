import type { BrowserWindow } from "electron"
import { BrowserSession } from "./session"
import { BrowserWindowHost, type TabInfo } from "./window"
import { SidebarBrowserHost, type SidebarBounds } from "./sidebar-host"
import { isSeatTabId, SeatBrowserPool, type SeatHandleInput } from "./seat"
import { ParkedViewHost } from "./parked-host"
import * as settingsService from "../settings/service"
import {
  INTERACT_TIMEOUT_MS,
  NAVIGATE_TIMEOUT_MS,
  SCREENSHOT_TIMEOUT_MS,
  SNAPSHOT_TIMEOUT_MS,
} from "./timeouts"
import type {
  BrowserRefDescription,
  InteractionResult,
  NavigateResult,
  SelectOptionResult,
  ScreenshotResult,
} from "./session"
import type {
  BrowserConsoleEntry,
  BrowserDialogState,
  BrowserEvaluateResult,
  BrowserLogPage,
  BrowserNetworkEntry,
  BrowserWaitInput,
  PickedElement,
} from "./types"

// Forwards a picked element to the main app renderer (so it can surface as a
// composer chip). Injected by the caller — the manager can't reach the main
// window itself (see src/main/index.ts wiring), same cycle-avoidance as the
// browser handle / task-runner enqueue.
export type PickForwarder = (element: PickedElement) => void

// Requests the main app switch to a conversation (from clicking its tab in the
// browser). Injected by the caller for the same cycle-avoidance reason as the
// pick forwarder — the manager can't reach the main window directly.
export type ConversationActivator = (conversationId: string) => void

// Asks the main app renderer to open its right-hand panel in Browser mode. The
// sidebar-embed equivalent of "reveal the window" — used when the surface is
// "sidebar" and the agent (or a handoff) wants the browser brought forward.
export type OpenRequester = () => void

// Where the ACTIVE conversation's view is displayed. "sidebar" embeds it in the
// main app window's right panel (the default); "window" shows it in the separate
// Agent Browser window (the classic pop-out). A view has one parent at a time, so
// switching surface re-parents the active view between the hosts.
export type BrowserSurface = "window" | "sidebar"

// The single owner of the agent's browser. TABBED: one BrowserSession
// (WebContentsView) per conversation, keyed by conversationId. A tab's view sits
// in the surface showing it (the SidebarBrowserHost embedded in the main window,
// or the BrowserWindowHost) only while it's shown there; every other tab is
// parked, visible, in the never-shown ParkedViewHost. A view hidden with
// setVisible(false) can't be screenshotted, so background conversations (and
// the active one while the sidebar panel is closed) must stay parked to keep
// working. See placeTabs. Instantiated once in src/main/index.ts and disposed on
// will-quit.
//
// The agent loop never touches a session directly — it gets a per-turn
// BrowserHandle (bound to that turn's AbortSignal AND its conversationId) built
// alongside `env` and released when the turn ends. The tab persists across turns
// (so "navigate, then next turn screenshot" works); only the handle is per-turn.

// A snapshot of the live page in this conversation's tab, for surfacing to the
// agent WITHOUT it having to call a read tool. `state()` returns this when a
// real page is open, or null when nothing is (no tab / closed / blank start
// page). The section renderer states BOTH cases explicitly — see
// browserStateSection — so a closed browser can't be reported as still open.
export interface BrowserState {
  url: string
  title: string
  loading: boolean
}

// The narrow surface the browser tools call, scoped to one conversation's tab.
// Every method binds the turn's signal so Stop/shutdown unwinds an in-flight
// browser op (see cdp.withDeadline).
export interface BrowserHandle {
  navigate(url: string): Promise<NavigateResult>
  screenshot(): Promise<ScreenshotResult>
  snapshot(): Promise<string>
  describeRef(ref: string): BrowserRefDescription
  click(ref: string): Promise<InteractionResult>
  hover(ref: string): Promise<InteractionResult>
  drag(fromRef: string, toRef: string): Promise<InteractionResult>
  type(ref: string, text: string, submit: boolean): Promise<InteractionResult>
  selectOption(ref: string, option: string): Promise<SelectOptionResult>
  wait(input: BrowserWaitInput): Promise<NavigateResult>
  console(options: {
    cursor?: number
    level?: string
    limit?: number
    sinceMs?: number
  }): BrowserLogPage<BrowserConsoleEntry>
  network(options: {
    cursor?: number
    status?: number
    limit?: number
    sinceMs?: number
  }): BrowserLogPage<BrowserNetworkEntry>
  dialog(): BrowserDialogState | null
  handleDialog(
    action: "accept" | "dismiss",
    promptText?: string
  ): Promise<NavigateResult>
  evaluate(expression: string): Promise<BrowserEvaluateResult>
  back(): Promise<NavigateResult>
  // Close this conversation's tab. Returns true if a tab was actually open.
  close(): boolean
  // Force the browser visible + show this conversation's tab (for a manual
  // handoff — captcha/login). Routes to whichever surface is active.
  reveal(): void
  // The live page in this conversation's tab, or null if nothing is open
  // (no tab / closed / blank). Read-only — must NOT create a tab.
  state(): BrowserState | null
  // Mission Control seat handles only (plan 109.04): save a text excerpt (a
  // console or network page) to the phase run's evidence directory. Returns
  // the saved file's path.
  saveEvidence?(name: string, content: string): Promise<string>
}

export class BrowserManager {
  // The separate Agent Browser window. Holds only the tab it shows (the active
  // conversation's when the surface is "window", or a seat's).
  private readonly windowHost = new BrowserWindowHost()
  // The in-app embed surface: layers the active tab's view over the main window's
  // right panel when the surface is "sidebar".
  private readonly sidebarHost = new SidebarBrowserHost()
  // One session (tab) per conversation.
  private tabs = new Map<string, BrowserSession>()
  // The conversation the user is currently viewing in the app (from the
  // renderer). Its tab is the one shown; null = viewing an uncreated/fresh
  // conversation or one with no tab.
  private activeConversationId: string | null = null
  // Current display surface. Default "sidebar" — the browser lives in the app's
  // right panel unless the user pops it out.
  private surface: BrowserSurface = "sidebar"
  // The conversation whose view is currently embedded in the sidebar host.
  private sidebarEmbeddedId: string | null = null
  // The conversation tab the window shows when the surface is "window" and no
  // seat is shown: the active conversation, unless a handoff revealed another.
  private windowConversationId: string | null = null
  private disposed = false
  // Where picked elements go (main app renderer). Set via setPickForwarder.
  private pickForwarder: PickForwarder | null = null
  // Requests an app conversation switch (tab click). Set via setConversationActivator.
  private conversationActivator: ConversationActivator | null = null
  // Requests the app open its right panel in Browser mode. Set via setOpenRequester.
  private openRequester: OpenRequester | null = null
  // Where a seat's evidence is saved. Set via setEvidenceRoot (needs app data).
  private evidenceRoot: ((phaseRunId: string) => string) | null = null
  // Where every view not on screen runs (a never-shown window; see
  // ParkedViewHost): background conversation tabs and hidden seat tabs.
  private readonly parkedHost = new ParkedViewHost()
  // Mission Control seat tabs (plan 109.04): isolated, local-only, capped, and
  // shown (when the setting allows) in the Agent Browser window — never the
  // sidebar, which follows the conversation being viewed.
  private readonly seats = new SeatBrowserPool({
    createSession: (partition) => {
      return new BrowserSession({
        partition,
        backgroundThrottling: false,
      })
    },
    addView: (id, view) => this.parkedHost.addView(id, view),
    removeView: (id) => {
      if (this.windowSeatId === id) this.windowSeatId = null
      this.windowHost.removeView(id)
      this.parkedHost.removeView(id)
    },
    showSeat: (id) => {
      this.setWindowSeat(id)
      this.windowHost.reveal()
      this.windowHost.showView(id)
      this.pushTabs()
    },
    hideSeat: (id) => {
      if (this.windowSeatId !== id) return
      this.setWindowSeat(null)
      this.refreshActiveView()
      if (this.surface === "sidebar") this.windowHost.hide()
    },
    tabsChanged: () => this.pushTabs(),
    revealSetting: () => settingsService.getBrowser().revealMissionControl,
    evidenceDir: (phaseRunId) => {
      if (!this.evidenceRoot) throw new Error("No evidence directory is set.")
      return this.evidenceRoot(phaseRunId)
    },
  })
  // The seat tab the Agent Browser window is showing instead of the active
  // conversation's, or null. Only this seat's view is in the window; the
  // others stay in the parked host, where they keep painting.
  private windowSeatId: string | null = null

  // Move a seat's view into the Agent Browser window (to be shown there), and
  // the previously shown one back to the parked host. A view the window isn't
  // showing would be hidden, and a hidden view can't be screenshotted. Showing
  // a seat parks the conversation tab the window was showing.
  private setWindowSeat(id: string | null): void {
    const prev = this.windowSeatId
    if (prev === id) return
    if (prev) {
      const view = this.seats.viewOf(prev)
      this.windowHost.removeView(prev)
      if (view) this.parkedHost.addView(prev, view)
    }
    this.windowSeatId = null
    const view = id ? this.seats.viewOf(id) : null
    if (id && view) {
      this.windowSeatId = id
      this.placeTabs()
      this.parkedHost.removeView(id)
      this.windowHost.addView(id, view)
    }
  }

  // Wire the destination for picked elements. Called once from main/index.ts.
  setPickForwarder(forward: PickForwarder): void {
    this.pickForwarder = forward
  }

  // Wire the app-conversation-switch requester (tab click → app switches). Called
  // once from main/index.ts after the main window exists.
  setConversationActivator(activate: ConversationActivator): void {
    this.conversationActivator = activate
  }

  // Wire the "open the right panel in Browser mode" requester. Called once from
  // main/index.ts. Used for the sidebar equivalent of revealing the window.
  setOpenRequester(open: OpenRequester): void {
    this.openRequester = open
  }

  // Wire where seat evidence is saved (app data). Called once from main/index.ts.
  setEvidenceRoot(root: (phaseRunId: string) => string): void {
    this.evidenceRoot = root
  }

  // Give the sidebar host the main app window to embed views into. Called once
  // from createWindow() in main/index.ts.
  setMainWindow(win: BrowserWindow): void {
    this.sidebarHost.setMainWindow(win)
  }

  // Called from the chrome when the user clicks a tab: ask the app to switch to
  // that conversation. The app's switch will loop back via setActiveConversation
  // to actually show the tab, so this doesn't change view state itself.
  requestConversationActivation(conversationId: string): void {
    if (this.disposed) return
    // A seat tab has no conversation to switch to: show it in the window.
    if (isSeatTabId(conversationId)) {
      if (!this.seats.isVisible(conversationId)) return
      this.setWindowSeat(conversationId)
      this.windowHost.showView(conversationId)
      this.pushTabs()
      return
    }
    if (!this.tabs.has(conversationId)) return
    // Back to the conversation tabs; the app's switch loops back to show it.
    if (this.windowSeatId) {
      this.setWindowSeat(null)
      this.refreshActiveView()
    }
    this.conversationActivator?.(conversationId)
  }

  // Get-or-create the tab (session) for a conversation. Wires per-tab listeners
  // and parks the view (until it's shown).
  private ensureTab(conversationId: string): BrowserSession {
    if (this.disposed) throw new Error("BrowserManager is disposed")
    const existing = this.tabs.get(conversationId)
    if (existing) return existing

    const session = new BrowserSession()
    const wc = session.webContents
    // Any state change (url/title/loading) refreshes the chrome's tab strip and
    // the app renderer's browser chrome.
    const push = () => this.pushTabs()
    wc.on("did-navigate", push)
    wc.on("did-navigate-in-page", push)
    wc.on("did-start-loading", push)
    wc.on("did-stop-loading", push)
    wc.on("page-title-updated", push)
    // Forward a pick to the main app renderer (which shows the chip on its own
    // active conversation).
    session.onElementPicked = (element) => {
      this.pickForwarder?.(element)
    }
    // Keep the "Pick" toggle in sync with the session's TRUE pick-mode state —
    // for the active tab only. This fires on every change (toggle, pick complete,
    // failure), so the button can never get stuck highlighted while the overlay is
    // actually off, or vice versa. Pushed to BOTH the separate window's chrome and
    // the app renderer (only one is showing this tab at a time).
    session.onPickModeChanged = (active) => {
      if (this.activeConversationId === conversationId) {
        this.windowHost.sendToChrome("browser:pick-mode", active)
        this.appPickModeEmitter?.(active)
      }
    }
    this.tabs.set(conversationId, session)
    this.placeTabs()
    // If nothing is shown yet, show this new tab so the surface isn't blank.
    if (this.activeConversationId === null) this.refreshActiveView()
    this.pushTabs()
    return session
  }

  // Push the active tab's pick-mode state to the app renderer (mirrors the
  // window chrome push), so the panel's "Pick" toggle tracks the true state. Set
  // from main/index.ts.
  private appPickModeEmitter: ((active: boolean) => void) | null = null
  setAppPickModeEmitter(emit: (active: boolean) => void): void {
    this.appPickModeEmitter = emit
  }

  // Put every conversation tab's view where it belongs. At most one is embedded
  // in the sidebar (the active tab, on the "sidebar" surface, while the panel is
  // on screen) and at most one is in the window (windowConversationId, on the
  // "window" surface, unless a seat is shown there). Every other view is parked
  // visible, so it can still be screenshotted and driven. Views are taken out of
  // their old parent before going into a new one (a view has one parent), and
  // parked before the shown ones leave the parked host so its window isn't
  // destroyed and recreated in between. Idempotent.
  private placeTabs(): void {
    const has = (id: string | null): id is string => !!id && this.tabs.has(id)
    const sidebarId =
      this.surface === "sidebar" &&
      this.sidebarHost.isShowing() &&
      has(this.activeConversationId)
        ? this.activeConversationId
        : null
    const windowId =
      this.surface === "window" &&
      !this.windowSeatId &&
      has(this.windowConversationId)
        ? this.windowConversationId
        : null

    if (this.sidebarEmbeddedId && this.sidebarEmbeddedId !== sidebarId) {
      this.sidebarHost.detachCurrent()
      this.sidebarEmbeddedId = null
    }
    for (const [id, session] of this.tabs) {
      if (id === sidebarId || id === windowId) continue
      this.windowHost.removeView(id)
      this.parkedHost.addView(id, session.view)
    }
    if (sidebarId) {
      this.windowHost.removeView(sidebarId)
      this.parkedHost.removeView(sidebarId)
      this.sidebarHost.attach(this.tabs.get(sidebarId)!.view)
      this.sidebarEmbeddedId = sidebarId
    }
    if (windowId) {
      this.parkedHost.removeView(windowId)
      this.windowHost.addView(windowId, this.tabs.get(windowId)!.view)
    }
    this.windowHost.showView(this.windowSeatId ?? windowId)
  }

  // Show the active conversation's tab on the CURRENT surface (or blank if it has
  // no tab), parking the rest.
  private refreshActiveView(): void {
    this.windowConversationId = this.activeConversationId
    this.placeTabs()
    this.pushTabs()
  }

  // Switch the display surface, re-parenting the active view. "window" reveals
  // the separate window; "sidebar" hides it and embeds in the app panel.
  setSurface(target: BrowserSurface): void {
    if (this.disposed || this.surface === target) return
    this.surface = target
    this.refreshActiveView()
    if (target === "window") this.windowHost.reveal()
    else this.windowHost.hide()
  }

  // The renderer reports the sidebar Browser slot's rectangle (or null to hide).
  // Only meaningful while the surface is "sidebar"; harmless otherwise (the
  // sidebar host has no view attached). Embeds the active tab when the slot
  // appears and parks it when the slot goes away.
  reportSidebarBounds(bounds: SidebarBounds | null): void {
    if (this.disposed) return
    this.sidebarHost.reportBounds(bounds)
    this.placeTabs()
  }

  // Explicitly show/hide the embedded view (panel closed / obscured by a modal).
  // A hidden embed is parked so the agent can keep using it.
  setSidebarVisible(visible: boolean): void {
    if (this.disposed) return
    this.sidebarHost.setVisible(visible)
    this.placeTabs()
  }

  // Bring the browser forward on whichever surface is active: sidebar → ask the
  // app to open its Browser panel; window → reveal the separate window.
  private revealSurface(): void {
    if (this.surface === "sidebar") this.openRequester?.()
    else this.windowHost.reveal()
  }

  // Whether an agent navigation in this conversation is "foreground" (the user
  // is viewing it, or is on a fresh conversation that just became it) — in which
  // case it may reveal + show. A background conversation navigates silently.
  private isForeground(conversationId: string): boolean {
    return (
      this.activeConversationId === null ||
      this.activeConversationId === conversationId
    )
  }

  // Build the tab list and push it to the window chrome for the tab strip. Also
  // pushed to the app renderer's browser chrome (URL/title/loading of the active
  // tab) via the same forwarder path.
  private pushTabs(): void {
    const tabs: TabInfo[] = []
    const windowShowsSeat = this.windowSeatId !== null
    for (const [id, session] of this.tabs) {
      const wc = session.webContents
      if (wc.isDestroyed()) continue
      const url = wc.getURL()
      tabs.push({
        id,
        title: wc.getTitle() || url || "New tab",
        url,
        loading: wc.isLoadingMainFrame(),
        active: id === this.activeConversationId,
      })
    }
    // The window also lists visible seat tabs; the app's panel never does.
    const windowTabs = [
      ...tabs.map((t) => (windowShowsSeat ? { ...t, active: false } : t)),
      ...this.seats.tabInfos(this.windowSeatId),
    ]
    this.windowHost.sendToChrome("browser:tabs", windowTabs)
    this.appTabsEmitter?.(tabs)
  }

  // Push the tab list to the app renderer (so the sidebar chrome can show the
  // active tab's URL/title/loading). Set from main/index.ts.
  private appTabsEmitter: ((tabs: TabInfo[]) => void) | null = null
  setAppTabsEmitter(emit: (tabs: TabInfo[]) => void): void {
    this.appTabsEmitter = emit
  }

  // Read the live page for a conversation's tab without creating one. Returns
  // null when there's no tab, its contents are gone, or it's still on the blank
  // start page (about:blank / empty) — i.e. nothing meaningful is open. Used to
  // surface browser state to the agent (see handle.state()).
  private stateFor(conversationId: string): BrowserState | null {
    const session = this.tabs.get(conversationId)
    if (!session) return null
    const wc = session.webContents
    if (wc.isDestroyed()) return null
    const url = wc.getURL()
    if (!url || url === "about:blank") return null
    return {
      url,
      title: wc.getTitle() || url,
      loading: wc.isLoadingMainFrame(),
    }
  }

  // The renderer tells us which conversation the user is viewing; show its tab.
  setActiveConversation(conversationId: string | null): void {
    if (this.disposed) return
    this.activeConversationId = conversationId
    // In window mode the window follows the conversation the user switched to.
    if (this.surface === "window") this.setWindowSeat(null)
    this.refreshActiveView()
  }

  // Enter/exit element-pick mode (from a chrome/panel toggle) on the ACTIVE tab.
  setPickMode(active: boolean): void {
    if (this.disposed || !this.activeConversationId) return
    const session = this.tabs.get(this.activeConversationId)
    if (!session) return
    session.setPickMode(active)
    if (active) this.revealSurface()
  }

  // User-driven navigation from a chrome/panel URL bar — applies to the active
  // tab. Not gated (the human is driving). Creates the tab on demand: the human
  // can open the Browser panel and type a URL before the agent has ever browsed
  // in this conversation, so there may be no tab yet. Still a no-op without an
  // active conversation (a fresh/unsaved one has no id to key a tab by).
  userNavigate(url: string): void {
    if (this.disposed || !this.activeConversationId) return
    const session = this.ensureTab(this.activeConversationId)
    // Bring the freshly-created tab onto the current surface (ensureTab only
    // auto-shows when nothing was active; here the conversation IS active).
    this.refreshActiveView()
    void session.webContents.loadURL(url).catch(() => {
      // Bad/aborted load — the strip stays in sync via the listeners above.
    })
  }

  // User-driven close from a chrome/panel — closes the active conversation's
  // tab (the "×" the user clicks when they're done with the page). No-op if
  // there's no active conversation or it has no tab. Returns true if a tab was
  // actually closed, so the caller can reflect it.
  userClose(): boolean {
    if (this.disposed || !this.activeConversationId) return false
    return this.closeTab(this.activeConversationId)
  }

  // User-driven reload from a chrome/panel — applies to the active tab.
  userReload(): void {
    if (this.disposed || !this.activeConversationId) return
    this.tabs.get(this.activeConversationId)?.webContents.reload()
  }

  // Close a conversation's tab: dispose its session/view. If it was the last
  // tab, hide the window. Distinct from dispose() (permanent, app-quit) — the
  // manager stays usable. Returns true if a tab was open. Called by the handle's
  // close(), the user's × (userClose), and the conversation-delete hook.
  closeTab(conversationId: string): boolean {
    if (this.disposed) return false
    const session = this.tabs.get(conversationId)
    if (!session) return false
    this.tabs.delete(conversationId)
    // If this tab was embedded in the sidebar, detach it there first.
    if (this.sidebarEmbeddedId === conversationId) {
      this.sidebarHost.detachCurrent()
      this.sidebarEmbeddedId = null
    }
    this.windowHost.removeView(conversationId)
    this.parkedHost.removeView(conversationId)
    session.dispose()
    if (this.tabs.size === 0 && !this.windowSeatId) {
      this.windowHost.hide()
    } else {
      // If we closed the shown tab, fall back to showing the active
      // conversation's tab (or blank) on the current surface.
      this.refreshActiveView()
    }
    this.pushTabs()
    return true
  }

  // Build a per-turn handle scoped to one conversation's tab, bound to the
  // turn's AbortSignal. Cheap — the tab is created lazily on first use.
  handleForTurn(conversationId: string, signal?: AbortSignal): BrowserHandle {
    // Agent navigation: create the tab, apply reveal policy for a foreground
    // conversation, then navigate. Background conversations navigate silently
    // (no reveal, no tab switch — the strip shows their loading state).
    const navigate = (url: string) => {
      const session = this.ensureTab(conversationId)
      if (this.isForeground(conversationId)) {
        if (settingsService.getBrowser().revealOnAgentUse === "always") {
          this.revealSurface()
        }
        this.refreshActiveView()
      }
      return session.navigate(url, NAVIGATE_TIMEOUT_MS, signal)
    }
    return {
      navigate,
      screenshot: () =>
        this.ensureTab(conversationId).screenshot(
          SCREENSHOT_TIMEOUT_MS,
          signal
        ),
      snapshot: () =>
        this.ensureTab(conversationId).snapshot(SNAPSHOT_TIMEOUT_MS, signal),
      describeRef: (ref) => this.ensureTab(conversationId).describeRef(ref),
      click: (ref) =>
        this.ensureTab(conversationId).click(ref, INTERACT_TIMEOUT_MS, signal),
      hover: (ref) =>
        this.ensureTab(conversationId).hover(ref, INTERACT_TIMEOUT_MS, signal),
      drag: (fromRef, toRef) =>
        this.ensureTab(conversationId).drag(
          fromRef,
          toRef,
          INTERACT_TIMEOUT_MS,
          signal
        ),
      type: (ref, text, submit) =>
        this.ensureTab(conversationId).type(
          ref,
          text,
          submit,
          INTERACT_TIMEOUT_MS,
          signal
        ),
      selectOption: (ref, option) =>
        this.ensureTab(conversationId).selectOption(
          ref,
          option,
          INTERACT_TIMEOUT_MS,
          signal
        ),
      wait: (input) =>
        this.ensureTab(conversationId).wait(input, NAVIGATE_TIMEOUT_MS, signal),
      console: (options) => this.ensureTab(conversationId).console(options),
      network: (options) => this.ensureTab(conversationId).network(options),
      dialog: () => this.ensureTab(conversationId).dialog(),
      handleDialog: (action, promptText) =>
        this.ensureTab(conversationId).handleDialog(
          action,
          promptText,
          INTERACT_TIMEOUT_MS,
          signal
        ),
      evaluate: (expression) =>
        this.ensureTab(conversationId).evaluate(
          expression,
          INTERACT_TIMEOUT_MS,
          signal
        ),
      back: () =>
        this.ensureTab(conversationId).back(NAVIGATE_TIMEOUT_MS, signal),
      // close() must NOT create a tab — it closes this conversation's tab (or
      // no-ops if none), so it calls closeTab directly.
      close: () => this.closeTab(conversationId),
      // state() is read-only and must NOT create a tab — it reports whatever the
      // conversation's existing tab shows (or null), so the agent can be told a
      // page is open without having to call a read tool first.
      state: () => this.stateFor(conversationId),
      // A handoff (captcha/login) needs the browser up so the user can act on it.
      // But it must NEVER yank the user out of whatever conversation they're in:
      // if conversation A hits a wall while the user is typing in conversation B,
      // we leave B alone — the sidebar's "needs you" bell already flags A, and the
      // handoff waits until the user switches to A themselves.
      //
      // Sidebar: only open the Browser panel when THIS conversation is the one
      // being viewed (so the panel would actually show its page). Otherwise do
      // nothing here. Window: reveal the separate window and show this tab — that
      // window is independent, so it doesn't disturb the app's active conversation.
      reveal: () => {
        this.ensureTab(conversationId)
        if (this.surface === "sidebar") {
          if (this.activeConversationId === conversationId)
            this.openRequester?.()
        } else {
          this.windowHost.reveal()
          this.setWindowSeat(null)
          this.windowConversationId = conversationId
          this.placeTabs()
          this.pushTabs()
        }
      },
    }
  }

  // A per-turn handle for a Mission Control seat's tab (plan 109.04). The tab
  // is created on first use (waiting for a free slot under the cap) and lives
  // until releaseSeat() at phase end.
  seatHandle(input: SeatHandleInput): BrowserHandle {
    if (this.disposed) throw new Error("BrowserManager is disposed")
    return this.seats.handle(input)
  }

  // Phase end: close the seat's tab and clear its partition's storage.
  releaseSeat(phaseRunId: string): Promise<void> {
    return this.seats.release(phaseRunId)
  }

  // Called on app `before-quit`: clear the browser window's user-close veto so
  // quitting closes it cleanly instead of being cancelled (which would leak the
  // process). Safe to call when no window exists yet.
  prepareForQuit(): void {
    this.windowHost.prepareForQuit()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.sidebarHost.detachCurrent()
    for (const session of this.tabs.values()) session.dispose()
    this.tabs.clear()
    this.seats.dispose()
    this.parkedHost.dispose()
    this.windowHost.dispose()
  }
}

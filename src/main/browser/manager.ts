import { BrowserSession } from "./session"
import { BrowserWindowHost, type TabInfo } from "./window"
import * as settingsService from "../settings/service"
import type {
  InteractionResult,
  NavigateResult,
  ScreenshotResult,
} from "./session"
import type { PickedElement } from "./types"

// Forwards a picked element to the main app renderer (so it can surface as a
// composer chip). Injected by the caller — the manager can't reach the main
// window itself (see src/main/index.ts wiring), same cycle-avoidance as the
// browser handle / task-runner enqueue.
export type PickForwarder = (element: PickedElement) => void

// Requests the main app switch to a conversation (from clicking its tab in the
// browser). Injected by the caller for the same cycle-avoidance reason as the
// pick forwarder — the manager can't reach the main window directly.
export type ConversationActivator = (conversationId: string) => void

// The single owner of the agent's browser. TABBED: one BrowserSession
// (WebContentsView) per conversation, keyed by conversationId, in one shared
// window that shows one tab at a time. Instantiated once in src/main/index.ts
// and disposed on will-quit.
//
// The agent loop never touches a session directly — it gets a per-turn
// BrowserHandle (bound to that turn's AbortSignal AND its conversationId) built
// alongside `env` and released when the turn ends. The tab persists across turns
// (so "navigate, then next turn screenshot" works); only the handle is per-turn.

// Per-action timeouts. Navigation waits longest (real page loads); reads and
// interactions are quicker. All are bounded so a hung page can't wedge a turn.
const NAVIGATE_TIMEOUT_MS = 30_000
const SNAPSHOT_TIMEOUT_MS = 15_000
const SCREENSHOT_TIMEOUT_MS = 15_000
const INTERACT_TIMEOUT_MS = 15_000

// The narrow surface the browser tools call, scoped to one conversation's tab.
// Every method binds the turn's signal so Stop/shutdown unwinds an in-flight
// browser op (see cdp.withDeadline).
export interface BrowserHandle {
  navigate(url: string): Promise<NavigateResult>
  screenshot(): Promise<ScreenshotResult>
  snapshot(): Promise<string>
  click(ref: string): Promise<InteractionResult>
  type(ref: string, text: string, submit: boolean): Promise<InteractionResult>
  back(): Promise<NavigateResult>
  // Close this conversation's tab. Returns true if a tab was actually open.
  close(): boolean
  // Force the browser window visible + show this conversation's tab (for a
  // manual handoff — captcha/login).
  reveal(): void
}

export class BrowserManager {
  private readonly host = new BrowserWindowHost()
  // One session (tab) per conversation.
  private tabs = new Map<string, BrowserSession>()
  // The conversation the user is currently viewing in the app (from the
  // renderer). Its tab is the one shown; null = viewing an uncreated/fresh
  // conversation or one with no tab.
  private activeConversationId: string | null = null
  private disposed = false
  // Where picked elements go (main app renderer). Set via setPickForwarder.
  private pickForwarder: PickForwarder | null = null
  // Requests an app conversation switch (tab click). Set via setConversationActivator.
  private conversationActivator: ConversationActivator | null = null

  // Wire the destination for picked elements. Called once from main/index.ts.
  setPickForwarder(forward: PickForwarder): void {
    this.pickForwarder = forward
  }

  // Wire the app-conversation-switch requester (tab click → app switches). Called
  // once from main/index.ts after the main window exists.
  setConversationActivator(activate: ConversationActivator): void {
    this.conversationActivator = activate
  }

  // Called from the chrome when the user clicks a tab: ask the app to switch to
  // that conversation. The app's switch will loop back via setActiveConversation
  // to actually show the tab, so this doesn't change view state itself.
  requestConversationActivation(conversationId: string): void {
    if (this.disposed || !this.tabs.has(conversationId)) return
    this.conversationActivator?.(conversationId)
  }

  // Get-or-create the tab (session) for a conversation. Wires per-tab listeners
  // and registers the view with the window host (hidden until shown).
  private ensureTab(conversationId: string): BrowserSession {
    if (this.disposed) throw new Error("BrowserManager is disposed")
    const existing = this.tabs.get(conversationId)
    if (existing) return existing

    const session = new BrowserSession()
    const wc = session.webContents
    // Any state change (url/title/loading) refreshes the chrome's tab strip.
    const push = () => this.pushTabs()
    wc.on("did-navigate", push)
    wc.on("did-navigate-in-page", push)
    wc.on("did-start-loading", push)
    wc.on("did-stop-loading", push)
    wc.on("page-title-updated", push)
    // A pick exits pick mode; forward it to the main app renderer (which shows
    // the chip on its own active conversation) and un-toggle the chrome button.
    session.onElementPicked = (element) => {
      this.host.sendToChrome("browser:pick-mode", false)
      this.pickForwarder?.(element)
    }
    this.tabs.set(conversationId, session)
    this.host.addView(conversationId, session.view)
    // If nothing is shown yet, show this new tab so the window isn't blank.
    if (this.activeConversationId === null) this.refreshActiveView()
    this.pushTabs()
    return session
  }

  // Show the tab for the active conversation (or blank if it has none).
  private refreshActiveView(): void {
    const id =
      this.activeConversationId && this.tabs.has(this.activeConversationId)
        ? this.activeConversationId
        : null
    this.host.showView(id)
    this.pushTabs()
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

  // Build the tab list and push it to the chrome for the tab strip.
  private pushTabs(): void {
    const tabs: TabInfo[] = []
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
    this.host.sendToChrome("browser:tabs", tabs)
  }

  // The renderer tells us which conversation the user is viewing; show its tab.
  setActiveConversation(conversationId: string | null): void {
    if (this.disposed) return
    this.activeConversationId = conversationId
    this.refreshActiveView()
  }

  // Enter/exit element-pick mode (from the chrome toggle) on the ACTIVE tab.
  setPickMode(active: boolean): void {
    if (this.disposed || !this.activeConversationId) return
    const session = this.tabs.get(this.activeConversationId)
    if (!session) return
    session.setPickMode(active)
    if (active) this.host.reveal()
  }

  // User-driven navigation from the chrome URL bar — applies to the active tab.
  // Not gated (the human is driving). No-op if the active conversation has no tab.
  userNavigate(url: string): void {
    if (this.disposed || !this.activeConversationId) return
    const session = this.tabs.get(this.activeConversationId)
    if (!session) return
    void session.webContents.loadURL(url).catch(() => {
      // Bad/aborted load — the strip stays in sync via the listeners above.
    })
  }

  // User-driven reload from the chrome — applies to the active tab.
  userReload(): void {
    if (this.disposed || !this.activeConversationId) return
    this.tabs.get(this.activeConversationId)?.webContents.reload()
  }

  // Close a conversation's tab: dispose its session/view. If it was the last
  // tab, hide the window. Distinct from dispose() (permanent, app-quit) — the
  // manager stays usable. Returns true if a tab was open. Called by the handle's
  // close() and by the conversation-delete hook.
  closeTab(conversationId: string): boolean {
    if (this.disposed) return false
    const session = this.tabs.get(conversationId)
    if (!session) return false
    this.tabs.delete(conversationId)
    const remaining = this.host.removeView(conversationId)
    session.dispose()
    if (remaining === 0) {
      this.host.hide()
    } else {
      // If we closed the shown tab, fall back to showing the active
      // conversation's tab (or blank).
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
          this.host.reveal()
        }
        this.refreshActiveView()
      }
      return session.navigate(url, NAVIGATE_TIMEOUT_MS, signal)
    }
    return {
      navigate,
      screenshot: () =>
        this.ensureTab(conversationId).screenshot(SCREENSHOT_TIMEOUT_MS, signal),
      snapshot: () =>
        this.ensureTab(conversationId).snapshot(SNAPSHOT_TIMEOUT_MS, signal),
      click: (ref) =>
        this.ensureTab(conversationId).click(ref, INTERACT_TIMEOUT_MS, signal),
      type: (ref, text, submit) =>
        this.ensureTab(conversationId).type(
          ref,
          text,
          submit,
          INTERACT_TIMEOUT_MS,
          signal
        ),
      back: () =>
        this.ensureTab(conversationId).back(NAVIGATE_TIMEOUT_MS, signal),
      // close() must NOT create a tab — it closes this conversation's tab (or
      // no-ops if none), so it calls closeTab directly.
      close: () => this.closeTab(conversationId),
      // A handoff needs the window up and this conversation's tab visible so the
      // user can act on it — regardless of the reveal setting or what's active.
      reveal: () => {
        this.ensureTab(conversationId)
        this.host.reveal()
        this.host.showView(conversationId)
        this.pushTabs()
      },
    }
  }

  // Called on app `before-quit`: clear the browser window's user-close veto so
  // quitting closes it cleanly instead of being cancelled (which would leak the
  // process). Safe to call when no window exists yet.
  prepareForQuit(): void {
    this.host.prepareForQuit()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const session of this.tabs.values()) session.dispose()
    this.tabs.clear()
    this.host.dispose()
  }
}

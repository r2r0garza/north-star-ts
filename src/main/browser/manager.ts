import { BrowserSession } from "./session"
import { BrowserWindowHost } from "./window"
import type {
  InteractionResult,
  NavigateResult,
  ScreenshotResult,
} from "./session"

// The single owner of the agent's browser. Phase 1: one shared window + one
// global session (per-conversation sessions land in Phase 4). Instantiated once
// in src/main/index.ts and disposed on will-quit.
//
// The agent loop never touches the session directly — it gets a per-turn
// BrowserHandle (bound to that turn's AbortSignal) built alongside `env` and
// released when the turn ends. The SESSION persists across turns (so "navigate,
// then next turn screenshot" works); only the handle is per-turn.

// Per-action timeouts. Navigation waits longest (real page loads); reads and
// interactions are quicker. All are bounded so a hung page can't wedge a turn.
const NAVIGATE_TIMEOUT_MS = 30_000
const SNAPSHOT_TIMEOUT_MS = 15_000
const SCREENSHOT_TIMEOUT_MS = 15_000
const INTERACT_TIMEOUT_MS = 15_000

// The narrow surface the browser tools call. Every method binds the turn's
// signal so Stop/shutdown unwinds an in-flight browser op (see cdp.withDeadline).
export interface BrowserHandle {
  navigate(url: string): Promise<NavigateResult>
  screenshot(): Promise<ScreenshotResult>
  snapshot(): Promise<string>
  click(ref: string): Promise<InteractionResult>
  type(ref: string, text: string, submit: boolean): Promise<InteractionResult>
  back(): Promise<NavigateResult>
}

export class BrowserManager {
  private readonly host = new BrowserWindowHost()
  private session: BrowserSession | null = null
  private disposed = false

  // Get the shared session, creating it (and attaching its view to the window)
  // on first use. Reveal policy is applied here in Phase 1 (always reveal); the
  // "always/never" setting gates this in Phase 4.
  private ensureSession(): BrowserSession {
    if (this.disposed) throw new Error("BrowserManager is disposed")
    if (this.session) return this.session
    const session = new BrowserSession()
    // Keep the chrome's URL bar in sync with wherever the page ends up — whether
    // the agent navigated or the user clicked a link / typed a URL.
    const pushUrl = () =>
      this.host.sendToChrome("browser:url", session.webContents.getURL())
    session.webContents.on("did-navigate", pushUrl)
    session.webContents.on("did-navigate-in-page", pushUrl)
    this.host.attachView(session)
    this.host.reveal()
    this.session = session
    return session
  }

  // User-driven navigation from the chrome URL bar. Not gated — the human is
  // explicitly driving their own browser. No-op if no session exists yet.
  userNavigate(url: string): void {
    if (this.disposed) return
    const session = this.ensureSession()
    void session.webContents.loadURL(url).catch(() => {
      // Bad URL / aborted load — the chrome keeps showing the prior URL via the
      // did-navigate sync above; nothing to surface here.
    })
  }

  // User-driven reload from the chrome. No-op if no session exists yet.
  userReload(): void {
    if (this.disposed || !this.session) return
    this.session.webContents.reload()
  }

  // Build a per-turn handle bound to this turn's AbortSignal. Cheap — it just
  // closes over the signal; the durable session is created lazily on first call.
  handleForTurn(signal?: AbortSignal): BrowserHandle {
    return {
      navigate: (url) =>
        this.ensureSession().navigate(url, NAVIGATE_TIMEOUT_MS, signal),
      screenshot: () =>
        this.ensureSession().screenshot(SCREENSHOT_TIMEOUT_MS, signal),
      snapshot: () =>
        this.ensureSession().snapshot(SNAPSHOT_TIMEOUT_MS, signal),
      click: (ref) =>
        this.ensureSession().click(ref, INTERACT_TIMEOUT_MS, signal),
      type: (ref, text, submit) =>
        this.ensureSession().type(ref, text, submit, INTERACT_TIMEOUT_MS, signal),
      back: () => this.ensureSession().back(NAVIGATE_TIMEOUT_MS, signal),
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
    this.session?.dispose()
    this.session = null
    this.host.dispose()
  }
}

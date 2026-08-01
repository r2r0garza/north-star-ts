import { BrowserWindow } from "electron"
import { join } from "path"
import type { BrowserSession } from "./session"

// The secondary window that displays the agent's browser. A thin React chrome
// (URL bar + reload — src/renderer-browser) is loaded as the window's own web
// contents; the agent-controlled page is a WebContentsView layered *beneath*
// that chrome bar. Phase 1 hosts a single session's view; Phase 4 swaps which
// session's view is attached (session switcher).
//
// The window is created hidden (show:false). Even hidden, the attached
// WebContentsView's page runs and paints, so CDP screenshots work before the
// user ever reveals it — which is what lets "never show" still support the agent
// seeing the page (see the plan's visibility section).

// Height of the chrome bar (URL/reload) drawn by the renderer-browser page. The
// WebContentsView sits below it.
const CHROME_HEIGHT = 44

export class BrowserWindowHost {
  private window: BrowserWindow | null = null
  private attachedView: BrowserSession["view"] | null = null
  private resizeHandler: (() => void) | null = null
  // Set on app quit. The user-close handler below normally vetoes close and
  // hides the window (so the session survives a stray close). But that veto,
  // left in place during quit, cancels the whole quit — the main process and its
  // renderer children stay alive (a leaked Electron process). When quitting we
  // stop vetoing so every window closes and the process exits cleanly.
  private quitting = false

  // Lazily create the window on first use. Hidden until reveal() so the page can
  // load/paint/screenshot without stealing focus.
  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window
    const win = new BrowserWindow({
      width: 1000,
      height: 760,
      show: false,
      title: "Agent Browser",
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, "../preload/browser-chrome.js"),
        sandbox: false,
      },
    })
    // Load the chrome (URL bar + reload). Dev server in development, built file
    // otherwise — mirrors the main window's loader.
    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/browser.html`)
    } else {
      void win.loadFile(join(__dirname, "../renderer/browser.html"))
    }
    win.on("closed", () => {
      if (this.resizeHandler) this.resizeHandler = null
      this.window = null
      this.attachedView = null
    })
    // Hide instead of destroy on user close, so a live session survives a stray
    // window close and can be revealed again on the next agent action. EXCEPT
    // during app quit: vetoing then would cancel the quit and leak the process,
    // so once `quitting` is set we let the close proceed.
    win.on("close", (e) => {
      if (!this.quitting && !win.isDestroyed()) {
        e.preventDefault()
        win.hide()
      }
    })
    this.window = win
    return win
  }

  // Attach a session's view as the visible page beneath the chrome bar, sizing
  // it to fill the window below CHROME_HEIGHT and keeping it sized on resize.
  attachView(session: BrowserSession): void {
    const win = this.ensureWindow()
    if (this.attachedView && this.attachedView !== session.view) {
      win.contentView.removeChildView(this.attachedView)
    }
    win.contentView.addChildView(session.view)
    this.attachedView = session.view
    this.layout()
    if (!this.resizeHandler) {
      this.resizeHandler = () => this.layout()
      win.on("resize", this.resizeHandler)
    }
  }

  // Reveal the window without stealing focus from the main app (the user is
  // usually mid-conversation; showInactive keeps their cursor in the composer).
  reveal(): void {
    const win = this.ensureWindow()
    if (!win.isVisible()) win.showInactive()
  }

  // Detach the current page view and hide the window, WITHOUT destroying the
  // window — so a later attachView/reveal (a fresh session) reuses it. Used by
  // browser_close: the session's WebContentsView is disposed by its owner; here
  // we just stop showing it and hide the chrome.
  hide(): void {
    if (!this.window || this.window.isDestroyed()) return
    if (this.attachedView) {
      this.window.contentView.removeChildView(this.attachedView)
      this.attachedView = null
    }
    if (this.window.isVisible()) this.window.hide()
  }

  // Push a message to the chrome (URL bar / reload UI). No-op if the window is
  // gone or its chrome hasn't finished loading yet.
  sendToChrome(channel: string, ...args: unknown[]): void {
    const wc = this.window?.webContents
    if (wc && !wc.isDestroyed()) wc.send(channel, ...args)
  }

  // Called on app `before-quit`, ahead of the window-close pass. Clears the
  // user-close veto so quitting actually closes the window instead of being
  // cancelled by it (see the `quitting` field).
  prepareForQuit(): void {
    this.quitting = true
  }

  private layout(): void {
    if (!this.window || this.window.isDestroyed() || !this.attachedView) return
    const [width, height] = this.window.getContentSize()
    this.attachedView.setBounds({
      x: 0,
      y: CHROME_HEIGHT,
      width,
      height: Math.max(0, height - CHROME_HEIGHT),
    })
  }

  dispose(): void {
    // Belt-and-suspenders: ensure the veto is off even if dispose is reached
    // without a prior prepareForQuit (e.g. a programmatic teardown).
    this.quitting = true
    if (this.window && !this.window.isDestroyed()) {
      this.window.removeAllListeners("close")
      this.window.destroy()
    }
    this.window = null
    this.attachedView = null
    this.resizeHandler = null
  }
}

import { BrowserWindow } from "electron"
import { join } from "path"
import type { BrowserSession } from "./session"

// The secondary window that displays the agent's browser. A thin chrome (tab
// strip + URL bar + reload — src/renderer/browser.html) is loaded as the
// window's own web contents; the agent-controlled pages are WebContentsViews
// layered *beneath* that chrome bar, ONE visible at a time (the active tab).
//
// This host is a pure display layer: the BrowserManager owns the sessions/views
// (one per conversation) and tells the host which to show. All views are added
// as children of the window, laid out, and kept visible, with the active one
// raised to the top. A setVisible(false) view has a 0×0 viewport, so CDP clicks
// on a background tab (e.g. a workflow step the user isn't watching) would hit
// nothing; a covered-but-visible view still hit-tests normally.
//
// The window is created hidden (show:false). Even hidden, an attached view's
// page runs and paints, so CDP screenshots work before the user reveals it.

// Height of the chrome (tab strip 36 + control bar 44). Must match the CSS in
// src/renderer/browser.html so views sit flush beneath the chrome.
const CHROME_HEIGHT = 80

// Metadata for one tab, pushed to the chrome so it can render the strip.
export interface TabInfo {
  id: string
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  active: boolean
}

export class BrowserWindowHost {
  private window: BrowserWindow | null = null
  // All views currently hosted, keyed by conversationId. Every view is a laid-out
  // child of the window; `activeId`'s view is stacked on top.
  private views = new Map<string, BrowserSession["view"]>()
  private activeId: string | null = null
  private resizeHandler: (() => void) | null = null
  // Set on app quit. The user-close handler below normally vetoes close and
  // hides the window (so live tabs survive a stray close). But that veto, left
  // in place during quit, cancels the whole quit — the main process and its
  // renderer children stay alive (a leaked Electron process). When quitting we
  // stop vetoing so every window closes and the process exits cleanly.
  private quitting = false

  // Lazily create the window on first use. Hidden until reveal() so pages can
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
    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/browser.html`)
    } else {
      void win.loadFile(join(__dirname, "../renderer/browser.html"))
    }
    win.on("closed", () => {
      this.resizeHandler = null
      this.window = null
      this.views.clear()
      this.activeId = null
    })
    // Hide instead of destroy on user close, so live tabs survive a stray close
    // and can be revealed again. EXCEPT during app quit: vetoing then would
    // cancel the quit and leak the process.
    win.on("close", (e) => {
      if (!this.quitting && !win.isDestroyed()) {
        e.preventDefault()
        win.hide()
      }
    })
    this.window = win
    return win
  }

  // Register a view as a child of the window (a new tab), beneath the active
  // tab. Idempotent.
  addView(id: string, view: BrowserSession["view"]): void {
    const win = this.ensureWindow()
    if (this.views.has(id)) return
    win.contentView.addChildView(view)
    this.views.set(id, view)
    if (!this.resizeHandler) {
      this.resizeHandler = () => this.layout()
      win.on("resize", this.resizeHandler)
      win.on("show", this.resizeHandler)
      win.on("hide", this.resizeHandler)
    }
    this.layout()
  }

  // Show the given tab by raising it above the others. A null id (no active
  // conversation, or that conversation has no tab) shows none.
  showView(id: string | null): void {
    if (!this.window || this.window.isDestroyed()) return
    this.activeId = id
    this.layout()
  }

  // Remove a tab's view. Returns the number of tabs remaining. If the removed
  // tab was active, nothing is shown until the manager picks a new active tab.
  removeView(id: string): number {
    const view = this.views.get(id)
    if (view && this.window && !this.window.isDestroyed()) {
      this.window.contentView.removeChildView(view)
    }
    this.views.delete(id)
    if (this.activeId === id) this.activeId = null
    return this.views.size
  }

  hasView(id: string): boolean {
    return this.views.has(id)
  }

  viewCount(): number {
    return this.views.size
  }

  // Reveal the window without stealing focus (the user is usually mid-
  // conversation; showInactive keeps their cursor in the composer).
  reveal(): void {
    const win = this.ensureWindow()
    if (!win.isVisible()) win.showInactive()
  }

  focusUrl(): boolean {
    const win = this.window
    if (!win || win.isDestroyed() || !win.isVisible()) return false
    win.webContents.focus()
    this.sendToChrome("browser:focus-url")
    return true
  }

  // Hide the window (kept for reuse, not destroyed) — used when the last tab
  // closes. The manager disposes the views themselves.
  hide(): void {
    if (this.window && !this.window.isDestroyed() && this.window.isVisible()) {
      this.window.hide()
    }
  }

  // Push a message to the chrome (tab strip / URL bar). No-op if the window is
  // gone or its chrome hasn't finished loading yet.
  sendToChrome(channel: string, ...args: unknown[]): void {
    const wc = this.window?.webContents
    if (wc && !wc.isDestroyed()) wc.send(channel, ...args)
  }

  // Called on app `before-quit`, ahead of the window-close pass. Clears the
  // user-close veto so quitting actually closes the window.
  prepareForQuit(): void {
    this.quitting = true
  }

  // Lay out every view to fill the window below the chrome bar and raise the
  // active one. Views are hidden only while the window is on screen with no
  // active tab, so the user never sees a stale page; otherwise they stay
  // visible (and so hit-testable) underneath.
  private layout(): void {
    const win = this.window
    if (!win || win.isDestroyed()) return
    const [width, height] = win.getContentSize()
    const bounds = {
      x: 0,
      y: CHROME_HEIGHT,
      width,
      height: Math.max(0, height - CHROME_HEIGHT),
    }
    const visible = this.activeId !== null || !win.isVisible()
    for (const view of this.views.values()) {
      view.setBounds(bounds)
      view.setVisible(visible)
    }
    const active = this.activeId ? this.views.get(this.activeId) : undefined
    // Re-adding an existing child moves it to the top of the stack.
    if (active) win.contentView.addChildView(active)
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
    this.views.clear()
    this.activeId = null
    this.resizeHandler = null
  }
}

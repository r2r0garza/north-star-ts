import { BrowserWindow } from "electron"
import type { BrowserSession } from "./session"

// The size a parked view lays out at if it has never been shown. A view that
// was never laid out has no size, so its page would render (and screenshot)
// at 0×0.
export const PARKED_VIEWPORT = { x: 0, y: 0, width: 1280, height: 800 }

// Where agent browser views live while nobody is looking at them: background
// conversation tabs, the active conversation's tab while the sidebar panel is
// closed, and Mission Control seat tabs (plan 109.04). It's a window that is
// never shown, holding every parked view VISIBLE and stacked.
//
// Chromium won't capture a view that's setVisible(false) (the CDP screenshot
// never resolves), but a visible view in a hidden window paints, screenshots,
// and takes input, even under other views. So a view moves into the Agent
// Browser window or the sidebar only while it's shown there, and comes back
// here otherwise.
//
// The window is created on the first parked view and destroyed with the last,
// so it doesn't outlive the views that need it.
export class ParkedViewHost {
  private window: BrowserWindow | null = null
  private views = new Map<string, BrowserSession["view"]>()

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window
    const win = new BrowserWindow({
      width: PARKED_VIEWPORT.width,
      height: PARKED_VIEWPORT.height,
      show: false,
      skipTaskbar: true,
      title: "Agent Browser (parked)",
      paintWhenInitiallyHidden: true,
      webPreferences: { backgroundThrottling: false },
    })
    win.on("closed", () => {
      this.window = null
      this.views.clear()
    })
    this.window = win
    return win
  }

  has(id: string): boolean {
    return this.views.has(id)
  }

  // Park a view. It keeps the bounds it was last shown at, so the page doesn't
  // relayout when the user looks away. Idempotent.
  addView(id: string, view: BrowserSession["view"]): void {
    if (this.views.has(id)) return
    this.ensureWindow().contentView.addChildView(view)
    const { width, height } = view.getBounds()
    if (width === 0 || height === 0) view.setBounds(PARKED_VIEWPORT)
    view.setVisible(true)
    this.views.set(id, view)
  }

  removeView(id: string): void {
    const view = this.views.get(id)
    if (!view) return
    this.views.delete(id)
    if (this.window && !this.window.isDestroyed()) {
      this.window.contentView.removeChildView(view)
      if (this.views.size === 0) this.dispose()
    }
  }

  dispose(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = null
    this.views.clear()
  }
}

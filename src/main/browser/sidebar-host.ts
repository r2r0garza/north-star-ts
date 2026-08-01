import type { BrowserWindow } from "electron"
import type { BrowserSession } from "./session"

// The IN-APP embed surface for the agent's browser. Where BrowserWindowHost is a
// SEPARATE window that computes its own view bounds, this host layers the active
// conversation's WebContentsView directly over the MAIN app window's content,
// positioned to a rectangle the renderer reports (the right-sidebar "Browser"
// slot's getBoundingClientRect). It is a pure display layer — the BrowserManager
// owns the sessions and arbitrates which host owns the active view at any moment
// (a view has exactly one parent, so the manager re-parents on pop-out/dock).
//
// A WebContentsView paints as a NATIVE layer on top of the DOM; it never flows
// inside React/CSS. So the renderer must feed it a rect (reportBounds) and the
// host must hide it (setVisible(false)) whenever the DOM needs to draw over it —
// the panel is closed, not in Browser mode, or a modal/sheet is open. Otherwise
// the page would occlude those overlays.

export interface SidebarBounds {
  x: number
  y: number
  width: number
  height: number
}

export class SidebarBrowserHost {
  private window: BrowserWindow | null = null
  // The single view currently embedded (the active conversation's), or null.
  private view: BrowserSession["view"] | null = null
  // The most recent rect reported by the renderer. Re-applied whenever the view
  // or visibility changes so a re-parent lands in the right place immediately.
  private bounds: SidebarBounds | null = null
  // Whether the renderer wants the embed shown. Gated by the manager's surface
  // choice AND the renderer's own occlusion logic (panel closed / obscured).
  private visible = false

  // Injected once from createWindow() in src/main/index.ts. Reads it lazily so
  // creation order doesn't matter (mirrors the pick-forwarder wiring).
  setMainWindow(win: BrowserWindow): void {
    this.window = win
  }

  private hasWindow(): boolean {
    return !!this.window && !this.window.isDestroyed()
  }

  // Embed a view (the active conversation's). Detaches any previously embedded
  // view first so only one is ever a child. Idempotent for the same view.
  attach(view: BrowserSession["view"]): void {
    if (!this.hasWindow() || this.view === view) return
    if (this.view) this.detachCurrent()
    this.window!.contentView.addChildView(view)
    this.view = view
    this.apply()
  }

  // Remove the currently embedded view (on pop-out or when there's no active
  // tab). Safe to call when nothing is attached.
  detachCurrent(): void {
    if (this.view && this.hasWindow()) {
      this.window!.contentView.removeChildView(this.view)
    }
    this.view = null
  }

  // The renderer reports the slot rectangle (device-independent px, same space
  // as WebContentsView bounds). A null rect hides the embed.
  reportBounds(bounds: SidebarBounds | null): void {
    this.bounds = bounds
    if (!bounds) this.visible = false
    else this.visible = true
    this.apply()
  }

  // Explicit visibility gate (panel closed / obscured by a modal). Kept separate
  // from bounds so the last known rect survives a temporary hide.
  setVisible(visible: boolean): void {
    this.visible = visible
    this.apply()
  }

  // Push the current visibility + bounds to the embedded view. Rounds to integer
  // pixels (setBounds wants ints; fractional rects can blur the page).
  private apply(): void {
    if (!this.view) return
    const show = this.visible && !!this.bounds
    this.view.setVisible(show)
    if (show && this.bounds) {
      this.view.setBounds({
        x: Math.round(this.bounds.x),
        y: Math.round(this.bounds.y),
        width: Math.round(this.bounds.width),
        height: Math.round(this.bounds.height),
      })
    }
  }
}

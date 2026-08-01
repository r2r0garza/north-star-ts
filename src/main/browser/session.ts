import { WebContentsView } from "electron"
import { sendCommand, withDeadline } from "./cdp"

// One agent-controllable browser page. Wraps a WebContentsView (its page runs in
// its own renderer/GPU process, off the main event loop) and drives it over the
// Chrome DevTools Protocol via webContents.debugger.
//
// Phase 1 surface: navigate / screenshot / snapshot. Each method is async and
// takes an AbortSignal + timeout so a Stop or a hung page unwinds the turn (see
// cdp.ts withDeadline). The session persists across turns — only the per-turn
// handle that binds ctx.signal is rebound (see BrowserManager / the agent loop).

// Dedicated partition so logins/cookies survive across runs but stay isolated
// from anything else the app might load. See the plan's cookie-isolation note.
const BROWSER_PARTITION = "persist:agent-browser"

// Bounds for a screenshot fed to the model: cap the longest side and JPEG-encode
// so a 4K page can't become a multi-MB base64 blob in the prompt / over IPC.
const SCREENSHOT_MAX_DIMENSION = 1280
const SCREENSHOT_QUALITY = 70

export interface ScreenshotResult {
  // Raw JPEG bytes (already downscaled/compressed). The caller base64-encodes
  // for the model side-channel; keeping bytes here avoids double-encoding.
  jpeg: Buffer
  width: number
  height: number
}

export interface NavigateResult {
  url: string
  title: string
}

export class BrowserSession {
  readonly view: WebContentsView
  // Whether webContents.debugger is currently attached. Attach is exclusive
  // (opening DevTools on the view detaches us), so we re-attach lazily and track
  // state rather than assuming it stays attached.
  private attached = false
  private disposed = false

  constructor() {
    this.view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        // The page is untrusted content the agent navigates to — keep it isolated
        // and sandboxed. (The pick-mode preload in Phase 2 lands here.)
        contextIsolation: true,
        sandbox: true,
      },
    })
    // Detach bookkeeping: if DevTools or anything else steals the debugger, we
    // learn about it and re-attach on the next command.
    this.view.webContents.debugger.on("detach", () => {
      this.attached = false
    })
  }

  get webContents() {
    return this.view.webContents
  }

  // Attach the debugger if needed. The CDP methods used here
  // (Page.captureScreenshot, Accessibility.getFullAXTree) are one-shot commands
  // that don't require enabling their domains first, so attach is all we need.
  private ensureAttached(): void {
    if (this.disposed) throw new Error("Browser session is disposed")
    if (this.attached) return
    const dbg = this.view.webContents.debugger
    if (!dbg.isAttached()) dbg.attach("1.3")
    this.attached = true
  }

  // Navigate and wait for the load to settle (or the deadline/abort to fire).
  async navigate(
    url: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<NavigateResult> {
    this.ensureAttached()
    const wc = this.view.webContents
    // Wait for the DOM-ready load rather than every subresource: did-stop-loading
    // fires when the main frame is done, which is what "the page is ready" means
    // for verifying a flow. Race it against the deadline + abort.
    const loaded = new Promise<void>((resolve, reject) => {
      const onStop = () => {
        cleanup()
        resolve()
      }
      const onFail = (
        _e: unknown,
        errorCode: number,
        errorDescription: string
      ) => {
        // -3 is ERR_ABORTED, which fires for ordinary client-side redirects —
        // not a real failure, so ignore it and keep waiting for did-stop-loading.
        if (errorCode === -3) return
        cleanup()
        reject(new Error(`Navigation failed: ${errorDescription} (${errorCode})`))
      }
      const cleanup = () => {
        wc.off("did-stop-loading", onStop)
        wc.off("did-fail-load", onFail)
      }
      wc.on("did-stop-loading", onStop)
      wc.on("did-fail-load", onFail)
    })
    await wc.loadURL(url).catch(() => {
      // loadURL rejects on aborted/redirected loads even when the navigation is
      // fine; rely on the did-stop-loading race below for the real signal.
    })
    await withDeadline(loaded, timeoutMs, signal)
    return { url: wc.getURL(), title: wc.getTitle() }
  }

  // Capture the current page, downscaled + JPEG-compressed. Uses CDP
  // Page.captureScreenshot so it works even when the hosting window is hidden
  // (drives the renderer's own compositor rather than the OS window).
  async screenshot(
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<ScreenshotResult> {
    this.ensureAttached()
    const dbg = this.view.webContents.debugger
    const { data } = await sendCommand<{ data: string }>(
      dbg,
      "Page.captureScreenshot",
      { format: "jpeg", quality: SCREENSHOT_QUALITY },
      timeoutMs,
      signal
    )
    // Downscale to bound the payload. nativeImage keeps aspect ratio when only
    // one dimension is given; re-encode to JPEG at the quality cap.
    const { nativeImage } = await import("electron")
    let img = nativeImage.createFromBuffer(Buffer.from(data, "base64"))
    const size = img.getSize()
    if (Math.max(size.width, size.height) > SCREENSHOT_MAX_DIMENSION) {
      const resizeOpts =
        size.width >= size.height
          ? { width: SCREENSHOT_MAX_DIMENSION }
          : { height: SCREENSHOT_MAX_DIMENSION }
      img = img.resize(resizeOpts)
    }
    const finalSize = img.getSize()
    return {
      jpeg: img.toJPEG(SCREENSHOT_QUALITY),
      width: finalSize.width,
      height: finalSize.height,
    }
  }

  // A compact accessibility outline of the page — the model's primary "read the
  // page" perception (works even if the gateway rejects screenshot images).
  // Phase 1 returns URL/title + a flattened role/name list; the ref registry for
  // click/type targeting lands in Phase 3.
  async snapshot(
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<string> {
    this.ensureAttached()
    const wc = this.view.webContents
    const dbg = wc.debugger
    const tree = await sendCommand<{ nodes: AXNode[] }>(
      dbg,
      "Accessibility.getFullAXTree",
      undefined,
      timeoutMs,
      signal
    )
    const lines: string[] = [`URL: ${wc.getURL()}`, `Title: ${wc.getTitle()}`, ""]
    for (const node of tree.nodes) {
      const role = node.role?.value
      if (!role || role === "none" || role === "generic") continue
      const name = node.name?.value?.trim()
      if (!name && !INTERACTIVE_ROLES.has(role)) continue
      lines.push(name ? `${role}: ${name}` : role)
    }
    return lines.join("\n")
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try {
      const dbg = this.view.webContents.debugger
      if (dbg.isAttached()) dbg.detach()
    } catch {
      // Already detached / contents gone — nothing to clean up.
    }
    this.attached = false
    if (!this.view.webContents.isDestroyed()) {
      this.view.webContents.close()
    }
  }
}

// Roles worth listing even without an accessible name (interactive landmarks
// the agent may want to know exist). Kept small; Phase 3's ref model supersedes
// this for actual targeting.
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "menuitem",
  "tab",
  "switch",
])

// Minimal shape of a CDP Accessibility node (only the fields we read).
interface AXNode {
  role?: { value?: string }
  name?: { value?: string }
}

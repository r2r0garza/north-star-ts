import { WebContentsView } from "electron"
import { sendCommand, withDeadline } from "./cdp"
import type { PickedElement } from "./types"

// One agent-controllable browser page. Wraps a WebContentsView (its page runs in
// its own renderer/GPU process, off the main event loop) and drives it over the
// Chrome DevTools Protocol via webContents.debugger.
//
// Surface: navigate / screenshot / snapshot (read) + click / type / back
// (interaction). Each method is async and takes an AbortSignal + timeout so a
// Stop or a hung page unwinds the turn (see cdp.ts withDeadline). The session
// persists across turns — only the per-turn handle that binds ctx.signal is
// rebound (see BrowserManager / the agent loop).
//
// Element targeting is Playwright-style: snapshot() assigns a short ref (e1, e2…)
// to each interactive node and remembers ref → backendDOMNodeId. click()/type()
// resolve a ref to its on-screen box and dispatch real mouse/key events at its
// center, so the page's own handlers fire exactly as if the user had done it. The
// ref map is cleared on navigation (a new page invalidates every node id), so the
// model must snapshot again after a navigation before it can click.

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

// Outcome of an interaction, reporting the resulting page state so the model can
// tell whether a click navigated or changed the page.
export interface InteractionResult {
  // A short human description of what was acted on (role + name), for the tool's
  // string result, e.g. `button "Sign up"`.
  target: string
  url: string
  title: string
}

// Raised when a ref isn't in the current map (stale after navigation, or the
// model invented one). The tool turns this into an actionable message telling the
// model to snapshot again.
export class StaleRefError extends Error {
  constructor(ref: string) {
    super(
      `Unknown element ref "${ref}". The page may have changed — call browser_snapshot again to get current refs.`
    )
    this.name = "StaleRefError"
  }
}

export class BrowserSession {
  readonly view: WebContentsView
  // Whether webContents.debugger is currently attached. Attach is exclusive
  // (opening DevTools on the view detaches us), so we re-attach lazily and track
  // state rather than assuming it stays attached.
  private attached = false
  private disposed = false
  // ref → backendDOMNodeId for the most recent snapshot. Cleared on navigation,
  // since node ids don't survive a document swap. A short label (role + name) is
  // kept alongside so an interaction can report what it acted on.
  private refs = new Map<string, { backendNodeId: number; label: string }>()

  // Called with the element the user picked in pick mode. Set by the manager so
  // the pick can be forwarded to the main app renderer.
  onElementPicked?: (element: PickedElement) => void
  // Fired whenever pick mode turns on/off for ANY reason (user toggle, a pick
  // completing, or a failure). The manager mirrors this to the chrome's toggle
  // button so its highlighted state can never drift from reality.
  onPickModeChanged?: (active: boolean) => void
  private pickMode = false
  private pickModeGeneration = 0

  constructor() {
    this.view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        // The page is untrusted content the agent navigates to — keep it isolated
        // and sandboxed. Element picking is handled by CDP's native inspect mode,
        // so no page preload or page-world bridge is needed.
        contextIsolation: true,
        sandbox: true,
      },
    })
    // Detach bookkeeping: if DevTools or anything else steals the debugger, we
    // learn about it and re-attach (and re-enable domains) on the next command.
    this.view.webContents.debugger.on("detach", () => {
      this.attached = false
    })
    // A document-level navigation invalidates every backendDOMNodeId, so drop the
    // ref map. (In-page navigations keep the DOM, so those don't clear it.)
    this.view.webContents.on("did-navigate", () => this.refs.clear())
    // Chromium's native inspector performs hit-testing in the real page/renderer
    // context (including composed content) and reports the exact backend node.
    // This avoids Electron isolated-world DOM APIs collapsing every hit to <html>.
    this.view.webContents.debugger.on("message", (_event, method, params) => {
      // inspectNodeRequested is ONLY emitted while inspect mode is engaged in the
      // renderer — so if we get it, the user genuinely clicked a node. Don't gate
      // on this.pickMode (it can drift from the renderer's real overlay state and
      // would then swallow a legitimate pick). Chromium auto-exits inspect mode
      // after this event, so we flip our flag to match and describe the node.
      if (method !== "Overlay.inspectNodeRequested") return
      const backendNodeId = (params as { backendNodeId?: unknown })
        ?.backendNodeId
      if (typeof backendNodeId !== "number") return
      this.setPickModeFlag(false)
      const generation = ++this.pickModeGeneration
      // Do not wait for node description before forcing inspect mode off. More
      // importantly, this off command supersedes any timed-out enable command
      // that may still be running underneath withDeadline.
      void this.updatePickMode(false, generation)
      void this.completeElementPick(backendNodeId, generation).catch(
        () => undefined
      )
    })
  }

  // Single point that mutates the pickMode flag, so every change (toggle, pick,
  // failure) notifies the manager and the flag can't silently drift from the UI.
  private setPickModeFlag(active: boolean): void {
    if (this.pickMode === active) return
    this.pickMode = active
    this.onPickModeChanged?.(active)
  }

  // Enter/exit Chromium's native inspect mode. DevTools owns hit-testing,
  // highlighting, and click interception; we only describe the selected node.
  setPickMode(active: boolean): void {
    if (this.disposed || this.view.webContents.isDestroyed()) return
    this.setPickModeFlag(active)
    const generation = ++this.pickModeGeneration
    void this.updatePickMode(active, generation)
  }

  get webContents() {
    return this.view.webContents
  }

  // Attach the debugger and enable the domains the interaction methods need.
  // DOM must be enabled before DOM.getBoxModel / DOM.focus return usable data;
  // Accessibility backs the snapshot. Both are idempotent to enable.
  private async ensureAttached(
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    if (this.disposed) throw new Error("Browser session is disposed")
    if (this.attached) return
    const dbg = this.view.webContents.debugger
    if (!dbg.isAttached()) dbg.attach("1.3")
    await sendCommand(dbg, "DOM.enable", undefined, timeoutMs, signal)
    await sendCommand(dbg, "Accessibility.enable", undefined, timeoutMs, signal)
    this.attached = true
  }

  private async updatePickMode(
    active: boolean,
    generation: number
  ): Promise<void> {
    try {
      if (active) {
        await this.ensureAttached(PICK_TIMEOUT_MS)
        if (!this.pickMode || generation !== this.pickModeGeneration) return
        const dbg = this.view.webContents.debugger
        await sendCommand(dbg, "Overlay.enable", undefined, PICK_TIMEOUT_MS)
        if (!this.pickMode || generation !== this.pickModeGeneration) return
        await this.applyInspectMode(
          true,
          generation,
          {
            mode: "searchForNode",
            highlightConfig: PICK_HIGHLIGHT_CONFIG,
          }
        )
        return
      }

      await this.exitInspectMode(generation)
    } catch {
      // Enabling pick mode failed partway (e.g. a CDP timeout after the overlay
      // may already have engaged in the renderer). Reset the flag AND force the
      // overlay down, so we never leave the renderer stuck in inspect mode with
      // our flag reading "off" (hover-highlights with clicks going nowhere).
      if (generation === this.pickModeGeneration) {
        this.setPickModeFlag(false)
        await this.exitInspectMode(generation).catch(() => undefined)
      }
    }
  }

  // CDP deadlines only stop awaiting a command; Electron cannot cancel the
  // underlying side effect. If a timed-out/stale inspect command settles later,
  // reconcile Chromium back to the latest desired state so an old "on" cannot
  // resurrect the picker after a completed selection (and an old "off" cannot
  // cancel a newer selection attempt).
  private async applyInspectMode(
    active: boolean,
    generation: number,
    params: Record<string, unknown>
  ): Promise<void> {
    const dbg = this.view.webContents.debugger
    const command = dbg.sendCommand(
      "Overlay.setInspectMode",
      params
    ) as Promise<unknown>

    void command.then(
      () => {
        if (this.disposed || this.view.webContents.isDestroyed()) return
        if (
          generation === this.pickModeGeneration &&
          active === this.pickMode
        ) {
          return
        }
        void this.updatePickMode(this.pickMode, this.pickModeGeneration)
      },
      () => undefined
    )

    await withDeadline(command, PICK_TIMEOUT_MS)
  }

  // Force Chromium's inspect overlay off. Best-effort and idempotent — safe to
  // call even if inspect mode isn't engaged (setInspectMode:none is a no-op then).
  private async exitInspectMode(generation: number): Promise<void> {
    if (this.disposed || this.view.webContents.isDestroyed()) return
    const dbg = this.view.webContents.debugger
    if (!dbg.isAttached()) return
    await this.applyInspectMode(false, generation, { mode: "none" })
  }

  private async completeElementPick(
    backendNodeId: number,
    generation: number
  ): Promise<void> {
    const element = await this.describePickedElement(backendNodeId)
    if (generation === this.pickModeGeneration) {
      this.onElementPicked?.(element)
    }
  }

  private async describePickedElement(
    backendNodeId: number
  ): Promise<PickedElement> {
    const dbg = this.view.webContents.debugger
    const { object } = await sendCommand<{
      object?: { objectId?: string }
    }>(dbg, "DOM.resolveNode", { backendNodeId }, PICK_TIMEOUT_MS)
    const objectId = object?.objectId
    if (!objectId) throw new Error("Could not resolve the picked element.")

    try {
      const [domResult, axResult] = await Promise.all([
        sendCommand<{
          result?: { value?: PickedElementDomDetails | null }
        }>(
          dbg,
          "Runtime.callFunctionOn",
          {
            objectId,
            functionDeclaration: DESCRIBE_PICKED_ELEMENT,
            returnByValue: true,
            silent: true,
          },
          PICK_TIMEOUT_MS
        ),
        sendCommand<{ nodes?: AXNode[] }>(
          dbg,
          "Accessibility.getPartialAXTree",
          { backendNodeId, fetchRelatives: false },
          PICK_TIMEOUT_MS
        ),
      ])

      const details = domResult.result?.value
      if (!details) throw new Error("The picked node is not an HTML element.")
      const axNode =
        axResult.nodes?.find(
          (node) => node.backendDOMNodeId === backendNodeId
        ) ?? axResult.nodes?.[0]
      const axRole = axString(axNode?.role)
      const axName = axString(axNode?.name)
      const role = axRole && !NON_SEMANTIC_AX_ROLES.has(axRole) ? axRole : null

      return {
        selector: details.selector,
        role,
        name: axName || details.name,
        tag: details.tag,
        text: details.text,
      }
    } finally {
      await sendCommand(
        dbg,
        "Runtime.releaseObject",
        { objectId },
        PICK_TIMEOUT_MS
      ).catch(() => undefined)
    }
  }

  // Navigate and wait for the load to settle (or the deadline/abort to fire).
  async navigate(
    url: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<NavigateResult> {
    const wc = this.view.webContents
    // Navigation itself does not need CDP. In Electron 37, DOM.enable can stall
    // indefinitely on a newly-created WebContentsView's initial about:blank page.
    // Attaching here would therefore prevent loadURL from ever running on the
    // first browser_navigate call. CDP-backed reads/interactions attach lazily
    // after a real page has loaded.
    // Resolve as soon as the page is ready, treating THREE signals as success
    // (whichever comes first):
    //  - loadURL() resolving — fires on did-finish-load (DOM + onload done). This
    //    is the primary signal and the one the manual URL bar implicitly uses.
    //  - did-finish-load — same milestone, belt-and-suspenders.
    //  - did-stop-loading — the webContents went idle.
    // We must NOT wait on did-stop-loading ALONE: a dev server holds a persistent
    // connection open (HMR websocket / streaming), so with the debugger attached
    // the "loading" state can linger and did-stop-loading may never fire — the
    // page is fully usable but the navigate call would hang to the deadline. Only
    // a real did-fail-load (not -3 ERR_ABORTED, which fires for benign redirects)
    // rejects.
    const loaded = new Promise<void>((resolve, reject) => {
      const onReady = () => {
        cleanup()
        resolve()
      }
      const onFail = (
        _e: unknown,
        errorCode: number,
        errorDescription: string
      ) => {
        if (errorCode === -3) return
        cleanup()
        reject(
          new Error(`Navigation failed: ${errorDescription} (${errorCode})`)
        )
      }
      const cleanup = () => {
        wc.off("did-finish-load", onReady)
        wc.off("did-stop-loading", onReady)
        wc.off("did-fail-load", onFail)
      }
      wc.on("did-finish-load", onReady)
      wc.on("did-stop-loading", onReady)
      wc.on("did-fail-load", onFail)
      // loadURL resolves on did-finish-load and rejects on a failed load. A
      // rejection here for a benign reason (aborted/redirected) shouldn't fail the
      // navigation — the event listeners above carry the real verdict — but a
      // clean resolution is a definitive "ready", so wire it in as another signal.
      wc.loadURL(url).then(onReady, () => {
        /* ignore — the did-fail-load listener decides real failures */
      })
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
    await this.ensureAttached(timeoutMs, signal)
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
  // page" perception (works even if the gateway rejects screenshot images). Each
  // interactive node is prefixed with a ref (e.g. `[e3] button: "Save"`) that
  // browser_click / browser_type target. Rebuilds the ref map every call.
  async snapshot(timeoutMs: number, signal?: AbortSignal): Promise<string> {
    await this.ensureAttached(timeoutMs, signal)
    const wc = this.view.webContents
    const dbg = wc.debugger
    const tree = await sendCommand<{ nodes: AXNode[] }>(
      dbg,
      "Accessibility.getFullAXTree",
      undefined,
      timeoutMs,
      signal
    )
    this.refs.clear()
    const lines: string[] = [
      `URL: ${wc.getURL()}`,
      `Title: ${wc.getTitle()}`,
      "",
    ]
    let refCounter = 0
    for (const node of tree.nodes) {
      if (node.ignored) continue
      const role = node.role?.value
      if (!role || role === "none" || role === "generic") continue
      const name = node.name?.value?.trim()
      const interactive = INTERACTIVE_ROLES.has(role)
      if (!name && !interactive) continue

      // Assign a ref to interactive nodes that map to a real DOM node, so the
      // model can act on them. Non-interactive named nodes (headings, text) are
      // listed for context but get no ref.
      if (interactive && typeof node.backendDOMNodeId === "number") {
        const ref = `e${++refCounter}`
        const label = name ? `${role} "${name}"` : role
        this.refs.set(ref, { backendNodeId: node.backendDOMNodeId, label })
        lines.push(name ? `[${ref}] ${role}: ${name}` : `[${ref}] ${role}`)
      } else {
        lines.push(name ? `${role}: ${name}` : role)
      }
    }
    return lines.join("\n")
  }

  // Click the element behind a ref: scroll it into view, resolve its box, and
  // dispatch a real left click (press + release) at its center so the page's own
  // handlers run. Waits briefly for any navigation the click kicks off.
  async click(
    ref: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<InteractionResult> {
    const entry = this.requireRef(ref)
    const dbg = this.view.webContents.debugger
    const { x, y } = await this.centerOf(entry.backendNodeId, timeoutMs, signal)
    await sendCommand(
      dbg,
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x, y, button: "left", clickCount: 1 },
      timeoutMs,
      signal
    )
    await sendCommand(
      dbg,
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x, y, button: "left", clickCount: 1 },
      timeoutMs,
      signal
    )
    await this.settle(timeoutMs, signal)
    return this.interactionResult(entry.label)
  }

  // Type into the element behind a ref: focus it, insert the text, and optionally
  // press Enter (e.g. to submit a form or search box).
  async type(
    ref: string,
    text: string,
    submit: boolean,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<InteractionResult> {
    const entry = this.requireRef(ref)
    const dbg = this.view.webContents.debugger
    await sendCommand(
      dbg,
      "DOM.focus",
      { backendNodeId: entry.backendNodeId },
      timeoutMs,
      signal
    )
    if (text) {
      await sendCommand(dbg, "Input.insertText", { text }, timeoutMs, signal)
    }
    if (submit) {
      // A synthetic Enter: keyDown + keyUp with the fields most handlers check.
      for (const type of ["keyDown", "keyUp"] as const) {
        await sendCommand(
          dbg,
          "Input.dispatchKeyEvent",
          {
            type,
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
          },
          timeoutMs,
          signal
        )
      }
      await this.settle(timeoutMs, signal)
    }
    return this.interactionResult(entry.label)
  }

  // Go back in history, waiting for the resulting load to settle.
  async back(timeoutMs: number, signal?: AbortSignal): Promise<NavigateResult> {
    await this.ensureAttached(timeoutMs, signal)
    const wc = this.view.webContents
    const nav = wc.navigationHistory
    if (!nav.canGoBack()) {
      throw new Error("There is no page to go back to.")
    }
    // Resolve on did-finish-load OR did-stop-loading, whichever fires first —
    // did-stop-loading alone can linger on a dev-server page (see navigate()).
    const loaded = new Promise<void>((resolve) => {
      const onReady = () => {
        wc.off("did-finish-load", onReady)
        wc.off("did-stop-loading", onReady)
        resolve()
      }
      wc.once("did-finish-load", onReady)
      wc.once("did-stop-loading", onReady)
    })
    nav.goBack()
    await withDeadline(loaded, timeoutMs, signal)
    return { url: wc.getURL(), title: wc.getTitle() }
  }

  // Resolve a ref or throw StaleRefError.
  private requireRef(ref: string): { backendNodeId: number; label: string } {
    const entry = this.refs.get(ref)
    if (!entry) throw new StaleRefError(ref)
    return entry
  }

  // Scroll a node into view and return the CSS-pixel center of its content box.
  // getBoxModel returns a quad [x1,y1,…,x4,y4]; the center of the diagonal is a
  // safe click point. Screenshot pixels aren't involved, so no DPR scaling.
  private async centerOf(
    backendNodeId: number,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ x: number; y: number }> {
    const dbg = this.view.webContents.debugger
    await sendCommand(
      dbg,
      "DOM.scrollIntoViewIfNeeded",
      { backendNodeId },
      timeoutMs,
      signal
    ).catch(() => {
      // Some nodes (e.g. detached or zero-box) reject scroll; fall through and
      // let getBoxModel surface the real error if there's genuinely no box.
    })
    const { model } = await sendCommand<{ model?: { content: number[] } }>(
      dbg,
      "DOM.getBoxModel",
      { backendNodeId },
      timeoutMs,
      signal
    )
    if (!model || model.content.length < 8) {
      throw new Error("Element is not visible on the page (no layout box).")
    }
    const q = model.content
    return { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2 }
  }

  // Give the page a beat to navigate/repaint after an interaction, bounded by the
  // deadline. Resolves on the next did-stop-loading, or after a short grace period
  // if the interaction didn't trigger navigation (the common case).
  private settle(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const wc = this.view.webContents
    const settled = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wc.off("did-stop-loading", onStop)
        resolve()
      }, SETTLE_GRACE_MS)
      const onStop = () => {
        clearTimeout(timer)
        resolve()
      }
      wc.once("did-stop-loading", onStop)
    })
    return withDeadline(settled, timeoutMs, signal).catch(() => {
      // A settle timeout isn't a failure — the interaction already happened.
    })
  }

  private interactionResult(target: string): InteractionResult {
    const wc = this.view.webContents
    return { target, url: wc.getURL(), title: wc.getTitle() }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.refs.clear()
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

// How long to wait after an interaction for a possible navigation before giving
// up and reporting the (unchanged) page. Short: most clicks don't navigate.
const SETTLE_GRACE_MS = 500
const PICK_TIMEOUT_MS = 5_000

const PICK_HIGHLIGHT_CONFIG = {
  showInfo: true,
  showAccessibilityInfo: true,
  contentColor: { r: 80, g: 130, b: 255, a: 0.25 },
  borderColor: { r: 80, g: 130, b: 255, a: 0.9 },
}

const NON_SEMANTIC_AX_ROLES = new Set(["none", "generic"])

const DESCRIBE_PICKED_ELEMENT = `function () {
  const node = this && this.nodeType === 1 ? this : this && this.parentElement
  if (!node) return null
  const maxText = 120
  const clean = (value) => {
    const text = typeof value === "string" ? value.replace(/\\s+/g, " ").trim() : ""
    return text ? text.slice(0, maxText) : null
  }
  const escape = (value) => CSS.escape(String(value))
  const selector = (() => {
    if (node.id) return "#" + escape(node.id)
    for (const attr of ["data-testid", "data-test", "name"]) {
      const value = node.getAttribute(attr)
      if (value) return node.tagName.toLowerCase() + "[" + attr + "=\\\"" + escape(value) + "\\\"]"
    }
    const parts = []
    let current = node
    let depth = 0
    while (current && current.nodeType === 1 && depth < 4) {
      let part = current.tagName.toLowerCase()
      const parent = current.parentElement
      if (parent) {
        const sameTag = Array.from(parent.children).filter(
          (child) => child.tagName === current.tagName
        )
        if (sameTag.length > 1) {
          part += ":nth-of-type(" + (sameTag.indexOf(current) + 1) + ")"
        }
      }
      parts.unshift(part)
      if (current.id) {
        parts[0] = "#" + escape(current.id)
        break
      }
      current = parent
      depth++
    }
    return parts.join(" > ")
  })()
  const inputValue =
    node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
      ? clean(node.value) || clean(node.placeholder)
      : null
  const text = clean(node.innerText) || ""
  const name =
    clean(node.getAttribute("aria-label")) ||
    clean(node.getAttribute("title")) ||
    inputValue ||
    text ||
    null
  return {
    selector,
    tag: node.tagName.toLowerCase(),
    text,
    name,
  }
}`

// Roles that get a ref (things the agent can meaningfully click or type into).
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
  "switch",
  "slider",
  "spinbutton",
])

// Minimal shape of a CDP Accessibility node (only the fields we read).
interface AXNode {
  ignored?: boolean
  role?: AXValue
  name?: AXValue
  backendDOMNodeId?: number
}

interface AXValue {
  value?: string
}

interface PickedElementDomDetails {
  selector: string
  tag: string
  text: string
  name: string | null
}

function axString(value?: AXValue): string | null {
  return value?.value?.trim() || null
}

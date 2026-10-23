import type { CdpEvent, CdpPipe } from "./cdp-pipe"
import { LaunchError } from "./launch"

// Window inspection and input for one app session (plan 119 Phase C), over the
// session's CDP pipe. Pure CDP: the accessibility tree for perception, DOM box
// models plus Input.* for pointer and keyboard. Model input never becomes
// script; the only host-authored page functions are a constant readiness probe
// and the native <select> setter (Electron draws that popup as an OS menu, so
// it cannot be driven by renderer input), both reported as such.

export interface AppWindowRef {
  windowId: string
  title: string
  url: string
}

export interface RefTarget {
  ref: string
  role: string
  name: string
  label: string
  windowId: string
  generation: number
}

export interface InteractionResult {
  action: string
  target?: string
  inputMethod: "cdp-input" | "cdp-insert-text" | "cdp-key-events" | "dom-assisted-native-select"
  navigated: boolean
  window: AppWindowRef
  detail?: Record<string, unknown>
}

export type InteractInput =
  | { action: "click"; ref: string; button?: "left" | "right"; clickCount?: number }
  | { action: "hover"; ref: string }
  | { action: "drag"; ref: string; toRef: string }
  | { action: "fill"; ref: string; text: string; submit?: boolean }
  | { action: "type"; ref: string; text: string; submit?: boolean }
  | { action: "select"; ref: string; option: string }
  | { action: "press"; key: string; modifiers?: string[]; ref?: string }
  | { action: "scroll"; ref?: string; deltaX?: number; deltaY?: number }

export type WaitCondition =
  | { kind: "load" }
  | { kind: "text"; text: string }
  | { kind: "text_gone"; text: string }
  | { kind: "ref_gone"; ref: string }
  | { kind: "url"; contains: string }
  | { kind: "title"; contains: string }
  | { kind: "window_count"; atLeast?: number; atMost?: number }

interface AXValue {
  value?: unknown
}
interface AXNode {
  nodeId: string
  parentId?: string
  childIds?: string[]
  ignored?: boolean
  role?: AXValue
  name?: AXValue
  value?: AXValue
  properties?: { name: string; value: AXValue }[]
  backendDOMNodeId?: number
}

export interface TargetNode {
  backendNodeId: number
  role: string
  name: string
  label: string
}
type RefEntry = TargetNode

// Durable element selector for scripted checks: snapshot refs do not survive
// runs or reloads. Matching is literal; nothing here is evaluated.
export interface Locator {
  role?: string
  name?: string
  nameContains?: string
  label?: string
  text?: string
  testId?: string
  // 1-based pick among several matches; without it, several matches fail.
  nth?: number
}

export interface LocatedNode extends TargetNode {
  value: string
  states: Record<string, string | boolean>
}

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
  "PopUpButton",
])
// Non-interactive roles that still get a ref when named, so hover and drag
// can target tooltips, drop zones, list rows and the like.
const POINTER_TARGET_ROLES = new Set([
  "region",
  "listitem",
  "row",
  "cell",
  "gridcell",
  "img",
  "image",
  "note",
  "group",
  "dialog",
  "tooltip",
  "article",
  "treeitem",
])
const SKIPPED_ROLES = new Set([
  "none",
  "generic",
  "presentation",
  "InlineTextBox",
  "LineBreak",
  "ignored",
])
const STATE_PROPERTIES = ["focused", "disabled", "checked", "pressed", "expanded", "selected", "required", "readonly"]
const EDITABLE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"])
const LABELLED_ROLES = new Set([...EDITABLE_ROLES, "checkbox", "radio", "switch", "slider", "listbox"])

export const SNAPSHOT_MAX_BYTES = 40_000
export const SNAPSHOT_MAX_REFS = 300
const SNAPSHOT_MAX_DEPTH = 30
const VALUE_MAX_CHARS = 120
export const SCREENSHOT_MAX_DIMENSION = 1280
export const WAIT_MAX_MS = 30_000
const WAIT_POLL_MS = 150
const SETTLE_MS = 200
export const FILL_MAX_CHARS = 10_000
export const TYPE_MAX_CHARS = 1_000

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Space: { code: "Space", keyCode: 32, text: " " },
}
const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

// Fixed, host-authored. Selects a native <select> option by label, text or value.
const SELECT_NATIVE_OPTION = `function (wanted) {
  if (!(this instanceof HTMLSelectElement)) return { ok: false, reason: "not_native_select" }
  const options = Array.from(this.options)
  const option = options.find((o) => o.label === wanted || o.text.trim() === wanted || o.value === wanted)
  if (!option) return { ok: false, reason: "no_option", options: options.slice(0, 30).map((o) => o.label) }
  if (option.disabled || this.disabled) return { ok: false, reason: "disabled" }
  this.focus()
  this.value = option.value
  this.dispatchEvent(new Event("input", { bubbles: true }))
  this.dispatchEvent(new Event("change", { bubbles: true }))
  return { ok: true, label: option.label, value: option.value }
}`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function bounded(value: string, max = VALUE_MAX_CHARS): string {
  const flat = value.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function stringValue(v: AXValue | undefined): string {
  return typeof v?.value === "string" ? v.value : v?.value === undefined ? "" : String(v.value)
}

export class StaleTargetError extends LaunchError {
  constructor(message: string) {
    super("stale_ref", message, "Take a fresh electron_snapshot and use its refs.")
  }
}

export class WindowControl {
  private selected: string | null = null
  private readonly cdpSessions = new Map<string, Promise<string>>()
  private readonly resolvedSessions = new Map<string, string>()
  // Bumped on navigation, reload, window closure and reselection: every ref
  // and approval taken under an older generation is stale.
  private generation = 0
  private snapshotNo = 0
  private refs = new Map<string, RefEntry>()
  private refWindow: string | null = null

  constructor(
    private readonly pipe: CdpPipe,
    private readonly windows: () => AppWindowRef[],
    private readonly refreshWindows: () => Promise<void>
  ) {
    pipe.onEvent((event) => this.onEvent(event))
  }

  get currentGeneration(): number {
    return this.generation
  }

  get selectedWindow(): string | null {
    return this.selected
  }

  invalidate(): void {
    this.generation++
    this.refs.clear()
  }

  private onEvent(event: CdpEvent): void {
    if (event.method === "Target.targetDestroyed" || event.method === "Target.detachedFromTarget") {
      const targetId = (event.params as { targetId?: string }).targetId
      if (targetId) {
        this.cdpSessions.delete(targetId)
        this.resolvedSessions.delete(targetId)
      }
      if (targetId && targetId === this.selected) {
        this.selected = null
        this.invalidate()
      }
      return
    }
    if (event.method === "Page.frameNavigated") {
      const frame = (event.params as { frame?: { parentId?: string } }).frame
      if (frame && !frame.parentId) {
        const windowId = this.windowForCdpSession(event.sessionId)
        if (windowId && windowId === this.refWindow) this.invalidate()
      }
    }
  }

  private windowForCdpSession(sessionId: string | undefined): string | null {
    for (const [windowId, id] of this.resolvedSessions)
      if (id === sessionId) return windowId
    return null
  }

  private cdpSession(windowId: string): Promise<string> {
    let pending = this.cdpSessions.get(windowId)
    if (!pending) {
      pending = (async () => {
        const { sessionId } = await this.pipe.send<{ sessionId: string }>(
          "Target.attachToTarget",
          { targetId: windowId, flatten: true }
        )
        this.resolvedSessions.set(windowId, sessionId)
        await Promise.all(
          ["Page.enable", "DOM.enable", "Accessibility.enable"].map((m) =>
            this.pipe.send(m, {}, { sessionId })
          )
        )
        // Keyboard input reaches only a focused page; an unfocused or hidden
        // app window would silently drop it.
        await this.pipe.send("Emulation.setFocusEmulationEnabled", { enabled: true }, { sessionId })
        return sessionId
      })()
      pending.catch(() => this.cdpSessions.delete(windowId))
      this.cdpSessions.set(windowId, pending)
    }
    return pending
  }

  // Set by the manager for the duration of one serialized operation: once the
  // turn is stopped, no further CDP command (no late click) is sent.
  activeSignal: AbortSignal | null = null

  private async send<T>(windowId: string, method: string, params: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
    this.activeSignal?.throwIfAborted()
    const sessionId = await this.cdpSession(windowId)
    this.activeSignal?.throwIfAborted()
    return this.pipe.send<T>(method, params, { sessionId, timeoutMs })
  }

  // The explicitly selected window, or the only window when there is exactly
  // one. Never guesses among several.
  target(): string {
    const windows = this.windows()
    if (this.selected && windows.some((w) => w.windowId === this.selected)) return this.selected
    if (this.selected) {
      this.selected = null
      this.invalidate()
    }
    if (windows.length === 1) {
      this.selected = windows[0].windowId
      return this.selected
    }
    throw new LaunchError(
      windows.length ? "window_ambiguous" : "no_window",
      windows.length
        ? `The app has ${windows.length} windows; choose one with electron_select_window.`
        : "The app has no open window."
    )
  }

  windowInfo(windowId: string): AppWindowRef {
    return this.windows().find((w) => w.windowId === windowId) ?? { windowId, title: "", url: "" }
  }

  async select(windowId: string): Promise<AppWindowRef & { generation: number }> {
    await this.refreshWindows()
    if (!this.windows().some((w) => w.windowId === windowId))
      throw new LaunchError("unknown_window", "That windowId is not an open window of this session.", "Call electron_status for the current windows.")
    if (this.selected !== windowId) {
      this.selected = windowId
      this.invalidate()
    }
    await this.cdpSession(windowId)
    return { ...this.windowInfo(windowId), generation: this.generation }
  }

  async snapshot(): Promise<{ text: string; window: AppWindowRef; generation: number }> {
    const windowId = this.target()
    await this.refreshWindows()
    const { nodes } = await this.send<{ nodes: AXNode[] }>(windowId, "Accessibility.getFullAXTree", {})
    const byId = new Map(nodes.map((n) => [n.nodeId, n]))
    const root = nodes.find((n) => !n.parentId) ?? nodes[0]
    const snapshotNo = ++this.snapshotNo
    const refs = new Map<string, RefEntry>()
    const info = this.windowInfo(windowId)
    const lines = [`Window: ${windowId}`, `URL: ${bounded(info.url, 300)}`, `Title: ${bounded(info.title, 200)}`, ""]
    let bytes = lines.join("\n").length
    let truncated = false
    let refCount = 0

    const visit = (node: AXNode | undefined, depth: number, parentName: string): void => {
      if (!node || truncated) return
      const role = stringValue(node.role)
      const name = bounded(stringValue(node.name))
      const skip = node.ignored || SKIPPED_ROLES.has(role) || (role === "StaticText" && (!name || name === parentName))
      let nextDepth = depth
      if (!skip && role !== "RootWebArea") {
        const interactive =
          typeof node.backendDOMNodeId === "number" &&
          (INTERACTIVE_ROLES.has(role) || (!!name && POINTER_TARGET_ROLES.has(role)))
        if (interactive || name) {
          const states = (node.properties ?? [])
            .filter((p) => STATE_PROPERTIES.includes(p.name) && p.value?.value !== false && p.value?.value !== "false")
            .map((p) => (p.value?.value === true || p.value?.value === "true" ? p.name : `${p.name}=${String(p.value?.value)}`))
          const value = bounded(stringValue(node.value))
          if (value) states.push(`value="${value}"`)
          let line = `${"  ".repeat(Math.min(depth, SNAPSHOT_MAX_DEPTH))}${role}${name ? ` "${name}"` : ""}${states.length ? ` [${states.join(", ")}]` : ""}`
          if (interactive && refCount < SNAPSHOT_MAX_REFS) {
            const ref = `s${snapshotNo}e${++refCount}`
            refs.set(ref, { backendNodeId: node.backendDOMNodeId!, role, name, label: name ? `${role} "${name}"` : role })
            line = `${"  ".repeat(Math.min(depth, SNAPSHOT_MAX_DEPTH))}[${ref}] ${role}${name ? ` "${name}"` : ""}${states.length ? ` [${states.join(", ")}]` : ""}`
          } else if (interactive) truncated = true
          if (bytes + line.length + 1 > SNAPSHOT_MAX_BYTES) {
            truncated = true
            return
          }
          lines.push(line)
          bytes += line.length + 1
          nextDepth = depth + 1
        }
      }
      for (const child of node.childIds ?? []) visit(byId.get(child), nextDepth, name || parentName)
    }
    visit(root, 0, "")
    if (truncated) lines.push("", "[snapshot truncated: bounded output; some elements and refs omitted]")
    this.refs = refs
    this.refWindow = windowId
    return { text: lines.join("\n"), window: info, generation: this.generation }
  }

  describe(ref: string): RefTarget {
    const entry = this.requireRef(ref)
    return { ref, role: entry.role, name: entry.name, label: entry.label, windowId: this.refWindow!, generation: this.generation }
  }

  // Throws unless `ref` still names the same element in the same window and
  // document generation the caller saw (e.g. before an approval wait).
  verify(target: RefTarget): void {
    if (target.generation !== this.generation || target.windowId !== this.refWindow)
      throw new StaleTargetError("The window navigated, closed or was reselected since that ref was taken; nothing was done.")
    this.requireRef(target.ref)
  }

  private requireRef(ref: string): RefEntry {
    const entry = this.refs.get(ref)
    if (!entry || !this.refWindow || !this.windows().some((w) => w.windowId === this.refWindow))
      throw new StaleTargetError(`Ref ${ref} is not from the latest snapshot of the selected window.`)
    return entry
  }

  private async center(windowId: string, backendNodeId: number): Promise<{ x: number; y: number }> {
    await this.send(windowId, "DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {})
    const { model } = await this.send<{ model?: { content: number[] } }>(windowId, "DOM.getBoxModel", { backendNodeId }).catch(() => ({ model: undefined }))
    if (!model || model.content.length < 8)
      throw new LaunchError("not_visible", "The element has no layout box (hidden or detached).")
    const q = model.content
    return { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2 }
  }

  private mouse(windowId: string, params: Record<string, unknown>): Promise<unknown> {
    return this.send(windowId, "Input.dispatchMouseEvent", params)
  }

  private async key(windowId: string, key: string, modifiers = 0): Promise<void> {
    const known = KEYS[key]
    const single = !known && [...key].length === 1 ? key : null
    if (!known && !single)
      throw new LaunchError("bad_args", `Unsupported key "${key}". Use a single character or one of: ${Object.keys(KEYS).join(", ")}.`)
    const text = modifiers & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta | MODIFIER_BITS.Alt) ? undefined : (known?.text ?? single ?? undefined)
    const code = known?.code ?? (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : "")
    const keyCode = known?.keyCode ?? key.toUpperCase().charCodeAt(0)
    const base = { key: known ? key.replace("Space", " ") : key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers }
    await this.send(windowId, "Input.dispatchKeyEvent", { ...base, type: text ? "keyDown" : "rawKeyDown", ...(text ? { text, unmodifiedText: text } : {}) })
    await this.send(windowId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" })
  }

  async interact(input: InteractInput, approved?: RefTarget): Promise<InteractionResult> {
    const windowId = this.target()
    if (approved) this.verify(approved)
    const entry = "ref" in input && input.ref ? this.requireRef(input.ref) : null
    const to = input.action === "drag" ? this.requireRef(input.toRef) : null
    return this.perform(windowId, input, entry, to)
  }

  // Acts on already-resolved elements: snapshot refs (interact) or durable
  // locators (scripted checks). Same input pipeline for both.
  async perform(
    windowId: string,
    input: InteractInput,
    entry: TargetNode | null,
    to: TargetNode | null
  ): Promise<InteractionResult> {
    const before = this.generation
    let inputMethod: InteractionResult["inputMethod"] = "cdp-input"
    let detail: Record<string, unknown> | undefined

    switch (input.action) {
      case "click": {
        const { x, y } = await this.center(windowId, entry!.backendNodeId)
        const button = input.button ?? "left"
        const clickCount = Math.min(Math.max(input.clickCount ?? 1, 1), 3)
        await this.mouse(windowId, { type: "mouseMoved", x, y, button: "none" })
        for (let i = 1; i <= clickCount; i++) {
          await this.mouse(windowId, { type: "mousePressed", x, y, button, clickCount: i })
          await this.mouse(windowId, { type: "mouseReleased", x, y, button, clickCount: i })
        }
        break
      }
      case "hover": {
        const { x, y } = await this.center(windowId, entry!.backendNodeId)
        await this.mouse(windowId, { type: "mouseMoved", x, y, button: "none" })
        break
      }
      case "drag": {
        const start = await this.center(windowId, entry!.backendNodeId)
        const end = await this.center(windowId, to!.backendNodeId)
        await this.mouse(windowId, { type: "mouseMoved", ...start, button: "none" })
        await this.mouse(windowId, { type: "mousePressed", ...start, button: "left", clickCount: 1 })
        for (const t of [0.25, 0.5, 0.75, 1])
          await this.mouse(windowId, { type: "mouseMoved", x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t, button: "left", buttons: 1 })
        await this.mouse(windowId, { type: "mouseReleased", ...end, button: "left", clickCount: 1 })
        detail = { to: to!.label }
        break
      }
      case "fill":
      case "type": {
        if (!EDITABLE_ROLES.has(entry!.role))
          throw new LaunchError("not_editable", `${entry!.label} is not a text field.`)
        await this.send(windowId, "DOM.focus", { backendNodeId: entry!.backendNodeId })
        if (input.action === "fill") {
          inputMethod = "cdp-insert-text"
          await this.send(windowId, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, commands: ["selectAll"] })
          await this.send(windowId, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 })
          if (input.text) await this.send(windowId, "Input.insertText", { text: input.text })
          else await this.key(windowId, "Backspace")
        } else {
          inputMethod = "cdp-key-events"
          for (const char of input.text) await this.key(windowId, char === "\n" ? "Enter" : char)
        }
        if (input.submit) await this.key(windowId, "Enter")
        break
      }
      case "select": {
        inputMethod = "dom-assisted-native-select"
        const { object } = await this.send<{ object: { objectId?: string } }>(windowId, "DOM.resolveNode", { backendNodeId: entry!.backendNodeId })
        if (!object.objectId) throw new LaunchError("not_visible", "The control is detached.")
        try {
          const { result } = await this.send<{ result: { value?: { ok: boolean; reason?: string; options?: string[]; label?: string; value?: string } } }>(
            windowId,
            "Runtime.callFunctionOn",
            { objectId: object.objectId, functionDeclaration: SELECT_NATIVE_OPTION, arguments: [{ value: input.option }], returnByValue: true, silent: true }
          )
          const outcome = result.value
          if (!outcome?.ok) {
            if (outcome?.reason === "not_native_select")
              throw new LaunchError("not_native_select", `${entry!.label} is not a native <select>.`, "For a custom dropdown, click it open, snapshot, then click the option.")
            if (outcome?.reason === "no_option")
              throw new LaunchError("no_option", `No option matches "${bounded(input.option)}".`, `Options: ${JSON.stringify(outcome.options ?? [])}`)
            throw new LaunchError("disabled", `${entry!.label} or that option is disabled.`)
          }
          detail = { option: outcome.label, value: outcome.value }
        } finally {
          await this.send(windowId, "Runtime.releaseObject", { objectId: object.objectId }).catch(() => {})
        }
        break
      }
      case "press": {
        const bits = (input.modifiers ?? []).reduce((sum, m) => {
          if (!(m in MODIFIER_BITS)) throw new LaunchError("bad_args", `Unknown modifier "${m}". Use Alt, Control, Meta or Shift.`)
          return sum | MODIFIER_BITS[m]
        }, 0)
        if (entry) await this.send(windowId, "DOM.focus", { backendNodeId: entry.backendNodeId })
        await this.key(windowId, input.key, bits)
        break
      }
      case "scroll": {
        const point = entry ? await this.center(windowId, entry.backendNodeId) : await this.viewportCenter(windowId)
        const clamp = (v: number | undefined) => Math.max(-5_000, Math.min(5_000, v ?? 0))
        await this.mouse(windowId, { type: "mouseWheel", ...point, deltaX: clamp(input.deltaX), deltaY: clamp(input.deltaY ?? 400) })
        break
      }
    }
    await sleep(SETTLE_MS)
    await this.refreshWindows().catch(() => {})
    return {
      action: input.action,
      target: entry?.label,
      inputMethod,
      navigated: this.generation !== before,
      window: this.windowInfo(windowId),
      detail,
    }
  }

  private async viewportCenter(windowId: string): Promise<{ x: number; y: number }> {
    const { cssLayoutViewport } = await this.send<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>(windowId, "Page.getLayoutMetrics", {})
    return { x: cssLayoutViewport.clientWidth / 2, y: cssLayoutViewport.clientHeight / 2 }
  }

  async screenshot(): Promise<{ jpegBase64: string; width: number; height: number; window: AppWindowRef }> {
    const windowId = this.target()
    const metrics = await this.send<{
      cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number }
      visualViewport?: { clientWidth: number }
    }>(windowId, "Page.getLayoutMetrics", {})
    const vv = metrics.cssVisualViewport
    // Legacy visualViewport is in device pixels; the ratio is the device scale.
    const dpr = Math.max(1, (metrics.visualViewport?.clientWidth ?? vv.clientWidth) / Math.max(1, vv.clientWidth))
    const scale = Math.min(1, SCREENSHOT_MAX_DIMENSION / (Math.max(vv.clientWidth, vv.clientHeight) * dpr))
    const { data } = await this.send<{ data: string }>(
      windowId,
      "Page.captureScreenshot",
      { format: "jpeg", quality: 70, clip: { x: vv.pageX, y: vv.pageY, width: vv.clientWidth, height: vv.clientHeight, scale } },
      15_000
    )
    await this.refreshWindows().catch(() => {})
    return {
      jpegBase64: data,
      width: Math.round(vv.clientWidth * scale * dpr),
      height: Math.round(vv.clientHeight * scale * dpr),
      window: this.windowInfo(windowId),
    }
  }

  async wait(condition: WaitCondition, timeoutMs: number, signal: AbortSignal): Promise<{ met: true; elapsedMs: number; window?: AppWindowRef }> {
    const started = Date.now()
    const deadline = started + Math.min(Math.max(timeoutMs, 100), WAIT_MAX_MS)
    const goneRef = condition.kind === "ref_gone" ? this.requireRef(condition.ref) : null
    for (;;) {
      signal.throwIfAborted()
      await this.refreshWindows().catch(() => {})
      if (await this.check(condition, goneRef)) {
        const windowId = condition.kind === "window_count" ? null : this.selectedOrSingle()
        return { met: true, elapsedMs: Date.now() - started, window: windowId ? this.windowInfo(windowId) : undefined }
      }
      if (Date.now() >= deadline)
        throw new LaunchError("wait_timeout", `Condition ${JSON.stringify(condition)} not met within ${deadline - started} ms.`)
      await sleep(WAIT_POLL_MS)
    }
  }

  private selectedOrSingle(): string | null {
    try {
      return this.target()
    } catch {
      return null
    }
  }

  private async check(condition: WaitCondition, goneRef: RefEntry | null): Promise<boolean> {
    if (condition.kind === "window_count") {
      const count = this.windows().length
      return count >= (condition.atLeast ?? 0) && count <= (condition.atMost ?? Infinity)
    }
    const windowId = this.selectedOrSingle()
    if (!windowId) return false
    const info = this.windowInfo(windowId)
    switch (condition.kind) {
      case "url":
        return info.url.includes(condition.contains)
      case "title":
        return info.title.includes(condition.contains)
      case "load":
        return this.isLoaded()
      case "ref_gone": {
        const { nodes } = await this.send<{ nodes: AXNode[] }>(windowId, "Accessibility.getFullAXTree", {}).catch(() => ({ nodes: [] as AXNode[] }))
        return !nodes.some((n) => !n.ignored && n.backendDOMNodeId === goneRef!.backendNodeId)
      }
      case "text":
      case "text_gone": {
        const { nodes } = await this.send<{ nodes: AXNode[] }>(windowId, "Accessibility.getFullAXTree", {}).catch(() => ({ nodes: [] as AXNode[] }))
        const present = nodes.some((n) => !n.ignored && (stringValue(n.name).includes(condition.text) || stringValue(n.value).includes(condition.text)))
        return condition.kind === "text" ? present : !present
      }
    }
  }

  async selectWhere(match: { title?: string; url?: string }): Promise<AppWindowRef> {
    await this.refreshWindows()
    const found = this.windows().filter(
      (w) => (!match.title || w.title.includes(match.title)) && (!match.url || w.url.includes(match.url))
    )
    if (found.length !== 1)
      throw new LaunchError(
        found.length ? "window_ambiguous" : "unknown_window",
        `${found.length} windows match ${JSON.stringify(match)}.`
      )
    return this.select(found[0].windowId)
  }

  // All non-ignored accessibility nodes matching the locator, in tree order.
  async locate(locator: Locator): Promise<LocatedNode[]> {
    const windowId = this.target()
    let nodes: AXNode[]
    if (locator.testId !== undefined) {
      const { root } = await this.send<{ root: { nodeId: number } }>(windowId, "DOM.getDocument", { depth: 0 })
      const { nodeIds } = await this.send<{ nodeIds: number[] }>(windowId, "DOM.querySelectorAll", {
        nodeId: root.nodeId,
        // testId is validated to [A-Za-z0-9_.:-], so it cannot break out of the string.
        selector: `[data-testid="${locator.testId}"]`,
      })
      nodes = []
      for (const nodeId of nodeIds.slice(0, 50)) {
        const { node } = await this.send<{ node: { backendNodeId: number } }>(windowId, "DOM.describeNode", { nodeId })
        const partial = await this.send<{ nodes: AXNode[] }>(windowId, "Accessibility.getPartialAXTree", {
          backendNodeId: node.backendNodeId,
          fetchRelatives: false,
        }).catch(() => ({ nodes: [] as AXNode[] }))
        const ax = partial.nodes.find((n) => n.backendDOMNodeId === node.backendNodeId)
        if (ax) nodes.push(ax)
      }
    } else {
      ;({ nodes } = await this.send<{ nodes: AXNode[] }>(windowId, "Accessibility.getFullAXTree", {}))
    }
    const byId = new Map(nodes.map((n) => [n.nodeId, n]))
    const norm = (v: string) => v.replace(/\s+/g, " ").trim()
    const seen = new Set<number>()
    const out: LocatedNode[] = []
    for (const raw of nodes) {
      if (raw.ignored) continue
      let node: AXNode | undefined = raw
      const role = stringValue(node.role)
      const name = norm(stringValue(node.name))
      if (locator.role !== undefined && role !== locator.role) continue
      if (locator.name !== undefined && name !== norm(locator.name)) continue
      if (locator.nameContains !== undefined && !name.includes(locator.nameContains)) continue
      if (locator.label !== undefined && (name !== norm(locator.label) || !LABELLED_ROLES.has(role))) continue
      if (locator.text !== undefined) {
        if (!name.includes(locator.text) && !stringValue(node.value).includes(locator.text)) continue
        // Text runs resolve to their element.
        while (node && (stringValue(node.role) === "StaticText" || typeof node.backendDOMNodeId !== "number"))
          node = node.parentId ? byId.get(node.parentId) : undefined
        if (!node) continue
      }
      if (typeof node.backendDOMNodeId !== "number" || seen.has(node.backendDOMNodeId)) continue
      seen.add(node.backendDOMNodeId)
      const nodeRole = stringValue(node.role)
      const nodeName = bounded(stringValue(node.name))
      const states: Record<string, string | boolean> = {}
      for (const p of node.properties ?? [])
        if (STATE_PROPERTIES.includes(p.name))
          states[p.name] = p.value?.value === true || p.value?.value === "true" ? true : p.value?.value === false || p.value?.value === "false" ? false : String(p.value?.value)
      out.push({
        backendNodeId: node.backendDOMNodeId,
        role: nodeRole,
        name: nodeName,
        label: nodeName ? `${nodeRole} "${nodeName}"` : nodeRole,
        value: stringValue(node.value),
        states,
      })
    }
    return out
  }

  windowCount(): number {
    return this.windows().length
  }

  // Constant, host-authored readiness probe; never model input.
  async isLoaded(): Promise<boolean> {
    const windowId = this.target()
    const { result } = await this.send<{ result: { value?: unknown } }>(windowId, "Runtime.evaluate", { expression: "document.readyState", returnByValue: true, silent: true }).catch(() => ({ result: {} as { value?: unknown } }))
    return result.value === "complete"
  }

  // Whether the element currently has a layout box (rendered, not collapsed).
  async hasBox(backendNodeId: number): Promise<boolean> {
    const windowId = this.target()
    const { model } = await this.send<{ model?: { width: number; height: number } }>(windowId, "DOM.getBoxModel", { backendNodeId }).catch(() => ({ model: undefined }))
    return !!model && model.width > 0 && model.height > 0
  }

  async bringToFront(): Promise<AppWindowRef | null> {
    const windowId = this.selectedOrSingle() ?? this.windows()[0]?.windowId
    if (!windowId) return null
    await this.pipe.send("Target.activateTarget", { targetId: windowId }).catch(() => {})
    await this.send(windowId, "Page.bringToFront", {}).catch(() => {})
    return this.windowInfo(windowId)
  }
}

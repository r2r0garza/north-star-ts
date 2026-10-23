import { LaunchError } from "./launch"
import {
  FILL_MAX_CHARS,
  type AppWindowRef,
  type InteractInput,
  type LocatedNode,
  type Locator,
  type WindowControl,
} from "./window-control"

// Declarative Electron checks (plan 119 Phase C2). A check is data: steps that
// reuse the interact/wait vocabulary, durable locators and a finite assertion
// set. The host runs every step without a model round trip, polling waits and
// assertions, and stops at the first failure with evidence. There is no
// expression language, no script and no main-process access: every string is
// matched literally.

export type Condition =
  | { visible: Locator }
  | { hidden: Locator }
  | { enabled: Locator }
  | { disabled: Locator }
  | { focused: Locator }
  | { count: Locator; equals: number }
  | { text: Locator; equals?: string; contains?: string }
  | { state: Locator; checked?: boolean; selected?: boolean; expanded?: boolean; pressed?: boolean; value?: string }
  | { url: { equals?: string; contains?: string } }
  | { title: { equals?: string; contains?: string } }
  | { windowCount: number }
  | { pageText: { contains: string } }
  | { load: true }

export type Step =
  | { step: "click"; target: Locator; button?: "left" | "right"; clickCount?: number }
  | { step: "hover"; target: Locator }
  | { step: "drag"; target: Locator; to: Locator }
  | { step: "fill" | "type"; target: Locator; text: string; submit?: boolean }
  | { step: "select"; target: Locator; option: string }
  | { step: "press"; key: string; modifiers?: string[]; target?: Locator }
  | { step: "scroll"; target?: Locator; deltaX?: number; deltaY?: number }
  | { step: "wait" | "assert"; until?: Condition; that?: Condition; timeoutMs?: number }
  | { step: "window"; title?: string; url?: string }
  | { step: "screenshot" }
  | { step: "snapshot" }

export interface Check {
  name?: string
  description?: string
  timeoutMs?: number
  stepTimeoutMs?: number
  steps: Step[]
}

export const CHECK_LIMITS = {
  maxJsonBytes: 64 * 1024,
  maxSteps: 200,
  maxString: 2_000,
  maxTimeoutMs: 300_000,
  defaultTimeoutMs: 60_000,
  maxStepTimeoutMs: 30_000,
  defaultStepTimeoutMs: 5_000,
  maxScreenshots: 5,
  evidenceChars: 4_000,
} as const

const POLL_MS = 40
export const EFFECTFUL_STEPS = new Set(["click", "drag", "fill", "type", "select", "press"])

// ---------- validation ----------

type Errors = string[]

function keysOnly(value: Record<string, unknown>, allowed: string[], path: string, errors: Errors): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) errors.push(`${path}: unknown field "${key}"`)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function str(value: unknown, path: string, errors: Errors, max: number = CHECK_LIMITS.maxString): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") errors.push(`${path}: must be a string`)
  else if (value.length > max) errors.push(`${path}: longer than ${max} characters`)
  return value as string
}

function int(value: unknown, path: string, errors: Errors, min: number, max: number): void {
  if (value === undefined) return
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    errors.push(`${path}: must be an integer from ${min} to ${max}`)
}

function bool(value: unknown, path: string, errors: Errors): void {
  if (value !== undefined && typeof value !== "boolean") errors.push(`${path}: must be true or false`)
}

const LOCATOR_KEYS = ["role", "name", "nameContains", "label", "text", "testId", "nth"]

function locator(value: unknown, path: string, errors: Errors): void {
  if (!isObject(value)) {
    errors.push(`${path}: must be a locator object`)
    return
  }
  keysOnly(value, LOCATOR_KEYS, path, errors)
  for (const key of ["role", "name", "nameContains", "label", "text"]) str(value[key], `${path}.${key}`, errors)
  if (value.testId !== undefined && (typeof value.testId !== "string" || !/^[A-Za-z0-9_.:-]{1,100}$/.test(value.testId)))
    errors.push(`${path}.testId: must be 1–100 characters of A–Z, a–z, 0–9, _ . : -`)
  int(value.nth, `${path}.nth`, errors, 1, 1000)
  if (!["name", "nameContains", "label", "text", "testId", "role"].some((k) => value[k] !== undefined))
    errors.push(`${path}: needs at least one of role, name, nameContains, label, text, testId`)
}

function matcher(value: unknown, path: string, errors: Errors): void {
  if (!isObject(value)) {
    errors.push(`${path}: must be { equals } or { contains }`)
    return
  }
  keysOnly(value, ["equals", "contains"], path, errors)
  str(value.equals, `${path}.equals`, errors)
  str(value.contains, `${path}.contains`, errors)
  if (value.equals === undefined && value.contains === undefined) errors.push(`${path}: needs equals or contains`)
}

function condition(value: unknown, path: string, errors: Errors): void {
  if (!isObject(value)) {
    errors.push(`${path}: must be a condition object`)
    return
  }
  const kinds = ["visible", "hidden", "enabled", "disabled", "focused", "count", "text", "state", "url", "title", "windowCount", "pageText", "load"]
  const kind = kinds.filter((k) => k in value)
  if (kind.length !== 1) {
    errors.push(`${path}: exactly one of ${kinds.join(", ")} is required`)
    return
  }
  const k = kind[0]
  switch (k) {
    case "visible":
    case "hidden":
    case "enabled":
    case "disabled":
    case "focused":
      keysOnly(value, [k], path, errors)
      locator(value[k], `${path}.${k}`, errors)
      break
    case "count":
      keysOnly(value, ["count", "equals"], path, errors)
      locator(value.count, `${path}.count`, errors)
      int(value.equals, `${path}.equals`, errors, 0, 1000)
      if (value.equals === undefined) errors.push(`${path}.equals: required`)
      break
    case "text":
      keysOnly(value, ["text", "equals", "contains"], path, errors)
      locator(value.text, `${path}.text`, errors)
      str(value.equals, `${path}.equals`, errors)
      str(value.contains, `${path}.contains`, errors)
      if (value.equals === undefined && value.contains === undefined) errors.push(`${path}: needs equals or contains`)
      break
    case "state":
      keysOnly(value, ["state", "checked", "selected", "expanded", "pressed", "value"], path, errors)
      locator(value.state, `${path}.state`, errors)
      for (const b of ["checked", "selected", "expanded", "pressed"]) bool(value[b], `${path}.${b}`, errors)
      str(value.value, `${path}.value`, errors)
      if (!["checked", "selected", "expanded", "pressed", "value"].some((b) => value[b] !== undefined))
        errors.push(`${path}: needs one of checked, selected, expanded, pressed, value`)
      break
    case "url":
    case "title":
      keysOnly(value, [k], path, errors)
      matcher(value[k], `${path}.${k}`, errors)
      break
    case "windowCount":
      keysOnly(value, ["windowCount"], path, errors)
      int(value.windowCount, `${path}.windowCount`, errors, 0, 100)
      break
    case "pageText":
      keysOnly(value, ["pageText"], path, errors)
      if (!isObject(value.pageText) || typeof value.pageText.contains !== "string") errors.push(`${path}.pageText: needs { contains }`)
      else {
        keysOnly(value.pageText, ["contains"], `${path}.pageText`, errors)
        str(value.pageText.contains, `${path}.pageText.contains`, errors)
      }
      break
    case "load":
      keysOnly(value, ["load"], path, errors)
      if (value.load !== true) errors.push(`${path}.load: must be true`)
      break
  }
}

function step(value: unknown, path: string, errors: Errors): void {
  if (!isObject(value)) {
    errors.push(`${path}: must be a step object`)
    return
  }
  const timeout = (v: unknown) => int(v, `${path}.timeoutMs`, errors, 1, CHECK_LIMITS.maxStepTimeoutMs)
  switch (value.step) {
    case "click":
      keysOnly(value, ["step", "target", "button", "clickCount"], path, errors)
      locator(value.target, `${path}.target`, errors)
      if (value.button !== undefined && value.button !== "left" && value.button !== "right") errors.push(`${path}.button: left or right`)
      int(value.clickCount, `${path}.clickCount`, errors, 1, 3)
      break
    case "hover":
      keysOnly(value, ["step", "target"], path, errors)
      locator(value.target, `${path}.target`, errors)
      break
    case "drag":
      keysOnly(value, ["step", "target", "to"], path, errors)
      locator(value.target, `${path}.target`, errors)
      locator(value.to, `${path}.to`, errors)
      break
    case "fill":
    case "type":
      keysOnly(value, ["step", "target", "text", "submit"], path, errors)
      locator(value.target, `${path}.target`, errors)
      if (typeof value.text !== "string") errors.push(`${path}.text: required string`)
      else str(value.text, `${path}.text`, errors, value.step === "fill" ? FILL_MAX_CHARS : 1_000)
      bool(value.submit, `${path}.submit`, errors)
      break
    case "select":
      keysOnly(value, ["step", "target", "option"], path, errors)
      locator(value.target, `${path}.target`, errors)
      if (typeof value.option !== "string") errors.push(`${path}.option: required string`)
      else str(value.option, `${path}.option`, errors)
      break
    case "press":
      keysOnly(value, ["step", "key", "modifiers", "target"], path, errors)
      if (typeof value.key !== "string" || !value.key) errors.push(`${path}.key: required string`)
      else str(value.key, `${path}.key`, errors, 20)
      if (value.modifiers !== undefined && (!Array.isArray(value.modifiers) || value.modifiers.some((m) => !["Alt", "Control", "Meta", "Shift"].includes(m as string))))
        errors.push(`${path}.modifiers: array of Alt, Control, Meta, Shift`)
      if (value.target !== undefined) locator(value.target, `${path}.target`, errors)
      break
    case "scroll":
      keysOnly(value, ["step", "target", "deltaX", "deltaY"], path, errors)
      if (value.target !== undefined) locator(value.target, `${path}.target`, errors)
      int(value.deltaX, `${path}.deltaX`, errors, -5_000, 5_000)
      int(value.deltaY, `${path}.deltaY`, errors, -5_000, 5_000)
      break
    case "wait":
      keysOnly(value, ["step", "until", "timeoutMs"], path, errors)
      condition(value.until, `${path}.until`, errors)
      timeout(value.timeoutMs)
      break
    case "assert":
      keysOnly(value, ["step", "that", "timeoutMs"], path, errors)
      condition(value.that, `${path}.that`, errors)
      timeout(value.timeoutMs)
      break
    case "window":
      keysOnly(value, ["step", "title", "url"], path, errors)
      str(value.title, `${path}.title`, errors)
      str(value.url, `${path}.url`, errors)
      if (value.title === undefined && value.url === undefined) errors.push(`${path}: needs title and/or url`)
      break
    case "screenshot":
    case "snapshot":
      keysOnly(value, ["step"], path, errors)
      break
    default:
      errors.push(`${path}.step: unknown step ${JSON.stringify(value.step)}`)
  }
}

export function validateCheck(raw: unknown): { check: Check } | { errors: string[] } {
  const errors: Errors = []
  let size = 0
  try {
    size = Buffer.byteLength(JSON.stringify(raw) ?? "", "utf8")
  } catch {
    return { errors: ["check is not JSON-serializable"] }
  }
  if (size > CHECK_LIMITS.maxJsonBytes) return { errors: [`check is larger than ${CHECK_LIMITS.maxJsonBytes} bytes`] }
  if (!isObject(raw)) return { errors: ["check must be an object with a `steps` array"] }
  keysOnly(raw, ["name", "description", "timeoutMs", "stepTimeoutMs", "steps"], "check", errors)
  str(raw.name, "check.name", errors, 200)
  str(raw.description, "check.description", errors)
  int(raw.timeoutMs, "check.timeoutMs", errors, 1_000, CHECK_LIMITS.maxTimeoutMs)
  int(raw.stepTimeoutMs, "check.stepTimeoutMs", errors, 1, CHECK_LIMITS.maxStepTimeoutMs)
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) errors.push("check.steps: must be a non-empty array")
  else if (raw.steps.length > CHECK_LIMITS.maxSteps) errors.push(`check.steps: at most ${CHECK_LIMITS.maxSteps} steps`)
  else raw.steps.forEach((s, i) => step(s, `steps[${i}]`, errors))
  if (Array.isArray(raw.steps) && raw.steps.filter((s) => isObject(s) && s.step === "screenshot").length > CHECK_LIMITS.maxScreenshots)
    errors.push(`check.steps: at most ${CHECK_LIMITS.maxScreenshots} screenshot steps`)
  return errors.length ? { errors: errors.slice(0, 20) } : { check: raw as unknown as Check }
}

// Text the target is described by, for approval classification before the run.
export function locatorText(l: Locator | undefined): string {
  if (!l) return "the focused element"
  const named = l.name ?? l.nameContains ?? l.label ?? l.text ?? (l.testId ? `testId ${l.testId}` : "")
  return `${l.role ?? "element"}${named ? ` "${named}"` : ""}${l.nth ? ` #${l.nth}` : ""}`
}

export function describeStep(s: Step): string {
  switch (s.step) {
    case "click":
    case "hover":
    case "select":
      return `${s.step} ${locatorText(s.target)}${s.step === "select" ? ` → "${s.option}"` : ""}`
    case "drag":
      return `drag ${locatorText(s.target)} → ${locatorText(s.to)}`
    case "fill":
    case "type":
      return `${s.step} ${locatorText(s.target)}${s.submit ? " and submit" : ""}`
    case "press":
      return `press ${[...(s.modifiers ?? []), s.key].join("+")}${s.target ? ` on ${locatorText(s.target)}` : ""}`
    case "scroll":
      return `scroll${s.target ? ` ${locatorText(s.target)}` : ""}`
    case "wait":
    case "assert":
      return `${s.step} ${JSON.stringify(s.step === "wait" ? s.until : s.that)}`
    case "window":
      return `window ${JSON.stringify({ title: s.title, url: s.url })}`
    default:
      return s.step
  }
}

// ---------- running ----------

export interface StepResult {
  index: number
  step: string
  status: "pass" | "fail" | "not_run"
  ms?: number
  inputMethod?: string
  detail?: unknown
  error?: string
}

export interface RunResult {
  name?: string
  status: "pass" | "fail" | "cancelled"
  totalMs: number
  steps: StepResult[]
  failure?: {
    index: number
    error: string
    window?: AppWindowRef
    snapshotExcerpt?: string
    screenshot: boolean
  }
}

export interface RunOptions {
  signal: AbortSignal
  // Called before every effectful step with its resolved target; false = denied.
  confirm: (index: number, step: Step, target: string) => Promise<boolean>
  onScreenshot: (shot: { jpegBase64: string; window: AppWindowRef; label: string }) => void
}

class StepFailure extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function poll<T>(
  deadline: number,
  signal: AbortSignal,
  attempt: () => Promise<{ done: true; value: T } | { done: false; why: string }>
): Promise<T> {
  let why = "condition not met"
  for (;;) {
    signal.throwIfAborted()
    const outcome = await attempt()
    if (outcome.done) return outcome.value
    why = outcome.why
    if (Date.now() >= deadline) throw new StepFailure(why)
    await sleep(POLL_MS)
  }
}

function pick(matches: LocatedNode[], l: Locator): { node?: LocatedNode; why: string } {
  if (l.nth !== undefined)
    return matches.length >= l.nth ? { node: matches[l.nth - 1], why: "" } : { why: `${locatorText(l)}: ${matches.length} match(es), need #${l.nth}` }
  if (matches.length === 1) return { node: matches[0], why: "" }
  return { why: matches.length ? `${locatorText(l)} is ambiguous (${matches.length} matches); add nth or narrow it` : `${locatorText(l)} not found` }
}

async function resolveTarget(control: WindowControl, l: Locator, deadline: number, signal: AbortSignal): Promise<LocatedNode> {
  return poll(deadline, signal, async () => {
    const { node, why } = pick(await control.locate(l), l)
    if (!node) return { done: false, why }
    if (!(await control.hasBox(node.backendNodeId))) return { done: false, why: `${locatorText(l)} is not visible` }
    return { done: true, value: node }
  })
}

async function evaluate(control: WindowControl, c: Condition): Promise<{ ok: boolean; why: string }> {
  const one = async (l: Locator) => pick(await control.locate(l), l)
  if ("visible" in c) {
    const { node, why } = await one(c.visible)
    return node ? { ok: await control.hasBox(node.backendNodeId), why: `${locatorText(c.visible)} has no layout box` } : { ok: false, why }
  }
  if ("hidden" in c) {
    const matches = await control.locate(c.hidden)
    for (const m of matches) if (await control.hasBox(m.backendNodeId)) return { ok: false, why: `${locatorText(c.hidden)} is still visible` }
    return { ok: true, why: "" }
  }
  if ("enabled" in c || "disabled" in c) {
    const l = "enabled" in c ? c.enabled : c.disabled
    const { node, why } = await one(l)
    if (!node) return { ok: false, why }
    const disabled = node.states.disabled === true
    return { ok: "enabled" in c ? !disabled : disabled, why: `${node.label} is ${disabled ? "disabled" : "enabled"}` }
  }
  if ("focused" in c) {
    const { node, why } = await one(c.focused)
    return node ? { ok: node.states.focused === true, why: `${node.label} is not focused` } : { ok: false, why }
  }
  if ("count" in c) {
    const n = (await control.locate(c.count)).length
    return { ok: n === c.equals, why: `${locatorText(c.count)}: ${n} match(es), expected ${c.equals}` }
  }
  if ("text" in c) {
    const { node, why } = await one(c.text)
    if (!node) return { ok: false, why }
    const actual = node.value || node.name
    const ok = c.equals !== undefined ? actual === c.equals : actual.includes(c.contains!)
    return { ok, why: `${node.label} text is ${JSON.stringify(actual)}` }
  }
  if ("state" in c) {
    const { node, why } = await one(c.state)
    if (!node) return { ok: false, why }
    for (const key of ["checked", "selected", "expanded", "pressed"] as const) {
      const want = c[key]
      if (want !== undefined && (node.states[key] === true) !== want) return { ok: false, why: `${node.label} ${key} is ${node.states[key] === true}` }
    }
    if (c.value !== undefined && node.value !== c.value) return { ok: false, why: `${node.label} value is ${JSON.stringify(node.value)}` }
    return { ok: true, why: "" }
  }
  if ("url" in c || "title" in c) {
    const window = control.windowInfo(control.target())
    const actual = "url" in c ? window.url : window.title
    const m = "url" in c ? c.url : c.title
    const ok = m.equals !== undefined ? actual === m.equals : actual.includes(m.contains!)
    return { ok, why: `${"url" in c ? "URL" : "title"} is ${JSON.stringify(actual)}` }
  }
  if ("windowCount" in c) {
    const n = control.windowCount()
    return { ok: n === c.windowCount, why: `${n} window(s), expected ${c.windowCount}` }
  }
  if ("pageText" in c) {
    const ok = (await control.locate({ text: c.pageText.contains })).length > 0
    return { ok, why: `text ${JSON.stringify(c.pageText.contains)} not on the page` }
  }
  return { ok: await control.isLoaded(), why: "document is still loading" }
}

function toInput(s: Step): InteractInput {
  switch (s.step) {
    case "click":
      return { action: "click", ref: "", button: s.button, clickCount: s.clickCount }
    case "hover":
      return { action: "hover", ref: "" }
    case "drag":
      return { action: "drag", ref: "", toRef: "" }
    case "fill":
    case "type":
      return { action: s.step, ref: "", text: s.text, submit: s.submit }
    case "select":
      return { action: "select", ref: "", option: s.option }
    case "press":
      return { action: "press", key: s.key, modifiers: s.modifiers }
    case "scroll":
      return { action: "scroll", deltaX: s.deltaX, deltaY: s.deltaY }
    default:
      throw new Error(`not an action step: ${s.step}`)
  }
}

export async function runCheck(control: WindowControl, check: Check, options: RunOptions): Promise<RunResult> {
  const started = Date.now()
  const runDeadline = started + (check.timeoutMs ?? CHECK_LIMITS.defaultTimeoutMs)
  const stepTimeout = check.stepTimeoutMs ?? CHECK_LIMITS.defaultStepTimeoutMs
  const results: StepResult[] = check.steps.map((s, index) => ({ index, step: describeStep(s), status: "not_run" }))
  let screenshots = 0

  for (const [index, s] of check.steps.entries()) {
    const stepStarted = Date.now()
    const timeoutMs = "timeoutMs" in s && s.timeoutMs ? s.timeoutMs : stepTimeout
    const deadline = Math.min(runDeadline, stepStarted + timeoutMs)
    const result = results[index]
    try {
      if (Date.now() >= runDeadline) throw new StepFailure("the check's total timeout was reached")
      if ("target" in s && s.target) {
        const action = toInput(s)
        const target = "target" in s && s.target ? await resolveTarget(control, s.target, deadline, options.signal) : null
        const to = s.step === "drag" ? await resolveTarget(control, s.to, deadline, options.signal) : null
        if (EFFECTFUL_STEPS.has(s.step)) {
          const label = [target?.label, to?.label].filter(Boolean).join(" → ") || "the focused element"
          if (!(await options.confirm(index, s, label))) throw new StepFailure("approval for this step was denied")
        }
        const done = await control.perform(control.target(), action, target, to)
        result.inputMethod = done.inputMethod
        if (done.detail) result.detail = done.detail
      } else if (s.step === "press" || s.step === "scroll") {
        if (s.step === "press" && !(await options.confirm(index, s, "the focused element")))
          throw new StepFailure("approval for this step was denied")
        const done = await control.perform(control.target(), toInput(s), null, null)
        result.inputMethod = done.inputMethod
      } else if (s.step === "wait" || s.step === "assert") {
        const c = (s.step === "wait" ? s.until : s.that)!
        await poll(deadline, options.signal, async () => {
          const { ok, why } = await evaluate(control, c)
          return ok ? { done: true, value: undefined } : { done: false, why }
        })
      } else if (s.step === "window") {
        result.detail = await control.selectWhere({ title: s.title, url: s.url })
      } else if (s.step === "screenshot") {
        const shot = await control.screenshot()
        screenshots++
        options.onScreenshot({ jpegBase64: shot.jpegBase64, window: shot.window, label: `step ${index + 1}` })
        result.detail = { width: shot.width, height: shot.height }
      } else if (s.step === "snapshot") {
        result.detail = (await control.snapshot()).text.slice(0, CHECK_LIMITS.evidenceChars)
      }
      result.status = "pass"
      result.ms = Date.now() - stepStarted
    } catch (error) {
      result.status = "fail"
      result.ms = Date.now() - stepStarted
      const cancelled = options.signal.aborted
      result.error = cancelled
        ? "cancelled"
        : error instanceof StepFailure || error instanceof LaunchError || error instanceof Error
          ? error.message
          : String(error)
      const failure: RunResult["failure"] = { index, error: result.error, screenshot: false }
      if (!cancelled) {
        // Evidence for the next exploratory step: where it stood when it failed.
        try {
          const snap = await control.snapshot()
          failure.window = snap.window
          failure.snapshotExcerpt = snap.text.slice(0, CHECK_LIMITS.evidenceChars)
          if (screenshots < CHECK_LIMITS.maxScreenshots) {
            const shot = await control.screenshot()
            options.onScreenshot({ jpegBase64: shot.jpegBase64, window: shot.window, label: `failure at step ${index + 1}` })
            failure.screenshot = true
          }
        } catch {
          // The window may be gone; the error above is the evidence.
        }
      }
      return { name: check.name, status: cancelled ? "cancelled" : "fail", totalMs: Date.now() - started, steps: results, failure }
    }
  }
  return { name: check.name, status: "pass", totalMs: Date.now() - started, steps: results }
}

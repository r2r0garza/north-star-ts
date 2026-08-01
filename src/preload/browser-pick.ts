import { ipcRenderer } from "electron"

// Pick-mode preload, injected into the agent-browser page's WebContentsView.
// Runs in the page's isolated world (contextIsolation + sandbox), so it can't be
// clobbered by the page's own JS. It exposes NOTHING to the page — the only
// surface is main↔preload over ipcRenderer:
//   main → "browser-pick:set" (boolean) : enter/exit pick mode
//   preload → "browser-pick:picked" (PickedElement) : the user clicked an element
//
// In pick mode: hovering draws a highlight overlay over the element under the
// cursor; a capture-phase click is swallowed (so it selects instead of
// activating the page) and its descriptor is computed and sent to main.

// Kept in sync with PickedElement in src/main/browser/types.ts (can't import a
// main-process type into a sandboxed preload bundle without pulling it in).
interface PickedElement {
  selector: string
  role: string | null
  name: string | null
  tag: string
  text: string
}

const MAX_TEXT = 120

let active = false
let overlay: HTMLDivElement | null = null

// A single reused highlight box positioned over the hovered element.
function ensureOverlay(): HTMLDivElement {
  if (overlay) return overlay
  const el = document.createElement("div")
  el.style.cssText = [
    "position:fixed",
    "z-index:2147483647", // max — sit above app content
    "pointer-events:none", // never intercept; we listen on document
    "background:rgba(80,130,255,0.25)",
    "border:2px solid rgba(80,130,255,0.9)",
    "border-radius:2px",
    "transition:all 60ms ease-out",
    "display:none",
  ].join(";")
  document.documentElement.appendChild(el)
  overlay = el
  return el
}

function moveOverlayTo(target: Element): void {
  const box = ensureOverlay()
  const r = target.getBoundingClientRect()
  box.style.display = "block"
  box.style.left = `${r.left}px`
  box.style.top = `${r.top}px`
  box.style.width = `${r.width}px`
  box.style.height = `${r.height}px`
}

function hideOverlay(): void {
  if (overlay) overlay.style.display = "none"
}

// Best-effort stable selector: prefer #id, then a [data-testid]/[data-test]/
// [name] attribute, else a short structural path with :nth-of-type. Advisory —
// dynamic apps can still make this non-unique, which the agent is told.
function computeSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`
  for (const attr of ["data-testid", "data-test", "name"]) {
    const v = el.getAttribute(attr)
    if (v) return `${el.tagName.toLowerCase()}[${attr}="${CSS.escape(v)}"]`
  }
  // Structural path, capped at a few levels so it stays readable.
  const parts: string[] = []
  let node: Element | null = el
  let depth = 0
  while (node && node.nodeType === 1 && depth < 4) {
    let part = node.tagName.toLowerCase()
    const parent: Element | null = node.parentElement
    if (parent) {
      const sameTag = Array.from(parent.children).filter(
        (c) => c.tagName === node!.tagName
      )
      if (sameTag.length > 1) {
        part += `:nth-of-type(${sameTag.indexOf(node) + 1})`
      }
    }
    parts.unshift(part)
    if (node.id) {
      // An ancestor id anchors the path — prepend and stop.
      parts[0] = `#${CSS.escape(node.id)}`
      break
    }
    node = parent
    depth++
  }
  return parts.join(" > ")
}

// Implicit ARIA role for the common interactive tags, when no explicit role is
// set. Not exhaustive — enough to give the agent a useful label.
function implicitRole(el: Element): string | null {
  const tag = el.tagName.toLowerCase()
  if (tag === "a" && el.hasAttribute("href")) return "link"
  if (tag === "button") return "button"
  if (tag === "select") return "combobox"
  if (tag === "textarea") return "textbox"
  if (tag === "input") {
    const type = (el.getAttribute("type") || "text").toLowerCase()
    if (["button", "submit", "reset", "image"].includes(type)) return "button"
    if (type === "checkbox") return "checkbox"
    if (type === "radio") return "radio"
    return "textbox"
  }
  return null
}

function describe(el: Element): PickedElement {
  const role = el.getAttribute("role") || implicitRole(el)
  const ariaLabel = el.getAttribute("aria-label")?.trim()
  const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT)
  const name = ariaLabel || text || null
  return {
    selector: computeSelector(el),
    role: role || null,
    name,
    tag: el.tagName.toLowerCase(),
    text,
  }
}

function onMove(e: MouseEvent): void {
  if (!active) return
  const target = e.target as Element | null
  if (target && target.nodeType === 1) moveOverlayTo(target)
}

function onClick(e: MouseEvent): void {
  if (!active) return
  // Swallow the click so it selects rather than activating the page.
  e.preventDefault()
  e.stopPropagation()
  const target = e.target as Element | null
  if (!target || target.nodeType !== 1) return
  ipcRenderer.send("browser-pick:picked", describe(target))
  // One pick per activation; main decides whether to re-enable.
  setActive(false)
}

function setActive(next: boolean): void {
  if (next === active) return
  active = next
  if (active) {
    // Capture phase so we see the event before the page's own handlers.
    document.addEventListener("mousemove", onMove, true)
    document.addEventListener("click", onClick, true)
  } else {
    document.removeEventListener("mousemove", onMove, true)
    document.removeEventListener("click", onClick, true)
    hideOverlay()
  }
}

ipcRenderer.on("browser-pick:set", (_e, next: boolean) => setActive(!!next))

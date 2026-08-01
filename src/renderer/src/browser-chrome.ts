import type { BrowserChromeApi, ChromeTab } from "../../preload/browser-chrome"

// Script for the agent-browser chrome (tab strip + URL bar + reload). Talks to
// main only via the narrow `browserChrome` preload bridge. Kept dependency-free
// (no React) — this is a tiny toolbar, not an app surface.

declare global {
  interface Window {
    browserChrome: BrowserChromeApi
  }
}

const bridge = window.browserChrome
const tabsEl = document.getElementById("tabs") as HTMLDivElement
const urlInput = document.getElementById("url") as HTMLInputElement
const reloadBtn = document.getElementById("reload") as HTMLButtonElement
const pickBtn = document.getElementById("pick") as HTMLButtonElement

// Local mirror of pick-mode state; main is the source of truth (it pushes
// browser:pick-mode when a pick completes or is cancelled).
let picking = false
function setPicking(next: boolean): void {
  picking = next
  pickBtn.classList.toggle("active", picking)
}

// Whether the user is actively editing the URL bar — while they are, don't clobber
// their text with page-driven URL updates.
let editing = false

// Normalize a typed value into a navigable URL: bare hosts get https://, but
// localhost / IPs / explicit ports keep http:// for convenience.
function toUrl(raw: string): string {
  const v = raw.trim()
  if (/^[a-z]+:\/\//i.test(v) || v.startsWith("file:")) return v
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i.test(v)) return `http://${v}`
  return `https://${v}`
}

urlInput.addEventListener("focus", () => {
  editing = true
  urlInput.select()
})
urlInput.addEventListener("blur", () => {
  editing = false
})
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && urlInput.value.trim()) {
    bridge.navigate(toUrl(urlInput.value))
    urlInput.blur()
  }
})
reloadBtn.addEventListener("click", () => bridge.reload())

pickBtn.addEventListener("click", () => {
  // Optimistically flip; main will confirm/correct via onPickMode.
  setPicking(!picking)
  bridge.setPickMode(picking)
})

// Render the tab strip and sync the URL bar to the active tab. Rebuilt on every
// push — the list is tiny (one tab per conversation with a browser open).
bridge.onTabs((tabs: ChromeTab[]) => {
  tabsEl.replaceChildren()
  for (const tab of tabs) {
    const el = document.createElement("div")
    el.className = tab.active ? "tab active" : "tab"
    el.title = tab.url || tab.title
    if (tab.loading) {
      const dot = document.createElement("span")
      dot.className = "spinner"
      el.appendChild(dot)
    }
    const title = document.createElement("span")
    title.className = "title"
    title.textContent = tab.title
    el.appendChild(title)
    el.addEventListener("click", () => bridge.activateTab(tab.id))
    tabsEl.appendChild(el)
  }
  // Drive the URL bar from the active tab (unless the user is mid-edit).
  if (!editing) {
    const active = tabs.find((t) => t.active)
    urlInput.value = active?.url ?? ""
  }
})

// Main pushes the authoritative pick-mode state (e.g. auto-off after a pick).
bridge.onPickMode(setPicking)

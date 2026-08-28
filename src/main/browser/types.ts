// An element the user picked in the agent browser ("point at this button").
// Produced from Chromium's native CDP inspect mode, forwarded to the main app
// renderer, and shown as a pending chip above the composer.
export interface PickedElement {
  // A best-effort stable CSS selector for the element (id → data-testid →
  // structural path). The agent can grep source for it or match it in a
  // browser_snapshot. Never guaranteed unique across a dynamic app — advisory.
  selector: string
  // ARIA role (explicit or implicit), e.g. "button", "link". Null if none.
  role: string | null
  // Accessible name / trimmed visible text, e.g. "Sign up". Null if none.
  name: string | null
  // Lowercase tag name, e.g. "button", "a", "input".
  tag: string
  // Trimmed visible text content (may duplicate name; capped during CDP extraction).
  text: string
}

export interface BrowserWaitInput {
  condition:
    | "duration"
    | "url_changed"
    | "title_changed"
    | "ref_visible"
    | "ref_hidden"
    | "network_idle"
  ref?: string
  timeoutMs: number
  idleMs?: number
}

export interface BrowserConsoleEntry {
  id: number
  timestamp: number
  level: string
  text: string
  url?: string
  line?: number
}

export interface BrowserNetworkEntry {
  id: number
  timestamp: number
  requestId: string
  method: string
  url: string
  resourceType?: string
  status?: number
  timingMs?: number
  failure?: string
}

export interface BrowserLogPage<T> {
  entries: T[]
  nextCursor: number | null
}

export interface BrowserDialogState {
  type: string
  message: string
  defaultPrompt?: string
  url: string
}

export interface BrowserEvaluateResult {
  value: unknown
  truncated: boolean
}

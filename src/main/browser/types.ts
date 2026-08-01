// An element the user picked in the agent browser ("point at this button").
// Produced by the pick-mode preload injected into the page, forwarded to the
// main app renderer, and shown as a pending chip above the composer. The shape
// is shared by the preload (which computes it), the main process (which
// forwards it), and the renderer (which displays it).
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
  // Trimmed visible text content (may duplicate name; capped in the preload).
  text: string
}

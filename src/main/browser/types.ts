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

import type { BrowserHandle } from "../browser/manager"
import type { SeatHandleInput } from "../browser/seat"
import { checksForRun } from "./qa-scope"
import type { MissionControlRunLink } from "../db/types"
import type { ContextSection } from "../agent/context/context-builder"
import { SEAT_CONTEXT_PRIORITY } from "./seat-context"

// The seat browser as the Process runner sees it (plan 109.04). Installed from
// main/index.ts, which owns the BrowserManager — the runner can't import it
// (same cycle-avoidance as the seat sessions installer). Absent in tests and
// anywhere without a browser: seats then simply get no browser tools.
export interface SeatBrowserProvider {
  handle(input: SeatHandleInput): BrowserHandle
  release(phaseRunId: string): Promise<void>
}

let installed: SeatBrowserProvider | null = null

export function installSeatBrowser(provider: SeatBrowserProvider | null): void {
  installed = provider
}

export function getSeatBrowser(): SeatBrowserProvider | null {
  return installed
}

// The tab label shown in the Agent Browser window: the seat address and the
// user story it's working on, e.g. `qa@pod-1 · CHK.M1.US2`.
export function seatBrowserLabel(
  address: string,
  link: MissionControlRunLink
): string {
  let storyRef: string | null = null
  try {
    storyRef = checksForRun(link).storyRef
  } catch {
    // Missing rows only cost the label its story.
  }
  return storyRef ? `${address} · ${storyRef}` : address
}

// How a seat's browser differs from the chat browser, stated where the model
// reads its context (the tool descriptions are shared with chat).
export const SEAT_BROWSER_BRIEFING = `## Your browser
When you have the browser_* tools, they drive the app you're working on in a browser that is yours alone for this step:
- It only opens local apps: localhost, 127.0.0.1, [::1], *.localhost, and the URLs app_start gives you. Anything else is refused, and a page that redirects elsewhere is stopped.
- It starts with no cookies or logins and is wiped when the step ends. If the app needs a login, sign in with test data the project provides; if you can't get past it, say so (message the seat that can help, or record the criterion as not verifiable with the reason). Nobody can take over the browser for you.
- Start the app with app_start before you navigate, if it isn't running. Call browser_snapshot before you interact, and again after the page changes.
- Every browser_screenshot is saved as evidence; its path is in the result, so cite it. browser_console and browser_network can save what they return as evidence too (save_evidence: true).`

export function seatBrowserContextSection(): ContextSection {
  return {
    name: "mission_control_seat_browser",
    priority: SEAT_CONTEXT_PRIORITY,
    content: SEAT_BROWSER_BRIEFING,
    provenance: {
      trust: "system",
      channel: "runtime",
      source: "mission_control_seat_browser",
    },
  }
}

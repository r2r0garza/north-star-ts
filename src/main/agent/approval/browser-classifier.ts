import type { ActionClassifier, ActionDecision, ToolAction } from "./types"

// Classifier for `browser` actions. Navigation opens an arbitrary origin (a real
// network side effect), so it always prompts. Interactions WITHIN an already-open
// page — click, type, back — auto-allow: the user approved opening the page, and
// prompting on every click would make verifying a multi-step flow unusable.
// Reads (browser_snapshot / browser_screenshot) build no ToolAction, so they
// never reach the engine at all, like file reads.
//
// The `allow` verdicts here rely on the local-backend carve-out in policy.ts: the
// generic `allow → require_approval` tightening on a local backend explicitly
// skips `browser` interactions, so click/type/back stay auto even on the host.
//
// Navigation deliberately carries NO `category`: the sandbox auto-approve
// downgrade keys on category, and there is no browser sandbox category, so a
// container backend doesn't silence the navigate prompt either.
//
// The set of tool names that merely interact with the current page (no new
// origin fetched). Anything else with kind "browser" is treated as navigation.
const INTERACTION_TOOLS = new Set([
  "browser_click",
  "browser_type",
  "browser_back",
])

export class BrowserActionClassifier implements ActionClassifier {
  classify(action: ToolAction): ActionDecision | null {
    if (action.kind !== "browser") return null
    if (INTERACTION_TOOLS.has(action.tool)) {
      return { level: "allow", reason: "browser interaction (page already open)" }
    }
    return {
      level: "require_approval",
      reason: "Opening a URL in the agent browser",
    }
  }
}

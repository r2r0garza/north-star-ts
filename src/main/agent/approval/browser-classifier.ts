import type { ActionClassifier, ActionDecision, ToolAction } from "./types"

// Classifier for `browser` actions. Navigation opens an arbitrary origin (a real
// network side effect), so it always prompts. Clearly reversible interactions
// WITHIN an already-open page stay auto-allowed so verification remains usable.
// Consequential clicks and submitted typing prompt separately because approving
// a page does not authorize purchase/delete/send/permission changes available on
// that authenticated page. Reads (browser_snapshot / browser_screenshot) build
// no ToolAction, so they never reach the engine at all, like file reads.
//
// The `allow` verdicts here rely on the local-backend carve-out in policy.ts:
// only browser actions classified here as `allow` skip the generic local
// `allow → require_approval` tightening.
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
  "browser_close",
  "browser_handoff",
])

export class BrowserActionClassifier implements ActionClassifier {
  classify(action: ToolAction): ActionDecision | null {
    if (action.kind !== "browser") return null
    if (action.detail?.interactionKind === "consequential_commit") {
      return {
        level: "require_approval",
        reason: "Browser action may commit an external change",
      }
    }
    if (INTERACTION_TOOLS.has(action.tool)) {
      return {
        level: "allow",
        reason: "browser interaction (page already open)",
      }
    }
    return {
      level: "require_approval",
      reason: "Opening a URL in the agent browser",
    }
  }
}

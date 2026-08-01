import type { ActionClassifier, ActionDecision, ToolAction } from "./types"

// Classifier for `browser` actions. Phase 1 only gates navigation: opening a URL
// fetches an arbitrary origin (a real network side effect), so it always prompts
// the user. Reads (browser_snapshot / browser_screenshot) build no ToolAction,
// so they never reach the engine — like file reads.
//
// Deliberately carries NO `category`: the sandbox auto-approve downgrade keys on
// category, and there is no browser sandbox category, so a container backend
// doesn't silence the navigate prompt.
//
// Phase 3 will add click/type actions (auto-allowed within an approved page, via
// a carve-out from the local-backend tightening) and may auto-allow localhost /
// dev-server navigations. Neither exists yet.
export class BrowserActionClassifier implements ActionClassifier {
  classify(action: ToolAction): ActionDecision | null {
    if (action.kind !== "browser") return null
    return {
      level: "require_approval",
      reason: "Opening a URL in the agent browser",
    }
  }
}

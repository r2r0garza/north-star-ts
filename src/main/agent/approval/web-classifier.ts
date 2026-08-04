import type { ActionClassifier, ActionDecision, ToolAction } from "./types"

// Classifier for `web` actions (headless web access). web_fetch retrieves an
// arbitrary origin — a real network side effect, exactly like browser_navigate —
// so it always requires approval. web_search is NOT classified here: it builds
// no ToolAction (it only hits the configured, trusted search provider), so it
// never reaches the engine, like a read.
//
// Like navigation, this deliberately carries NO `category`, so the sandbox
// auto-approve downgrade (which keys on category) never silences the prompt in a
// container backend. Auto mode still auto-approves it (handled in the gate), and
// the user can grant "once" or "for this session" via the allowlist.
export class WebActionClassifier implements ActionClassifier {
  classify(action: ToolAction): ActionDecision | null {
    if (action.kind !== "web") return null
    return {
      level: "require_approval",
      reason: "Fetching a web page",
    }
  }
}

import type { ActionClassifier, ActionDecision, ToolAction } from "./types"

// Classifier for `delegate` actions — handing the remaining work off to a
// background task (run_todos_in_background). Delegation ALWAYS requires the
// human to approve: it's the moment the agent stops working in the foreground
// and the TaskRunner takes over, so the user must opt in each time.
//
// Deliberately carries NO `category`: the PolicyEngine's sandbox auto-approve
// downgrade keys on category, so a category-less require_approval can never be
// silenced by running in a container. Delegation is also not allowlistable in
// practice — there's no "always delegate" affordance — so it prompts every time.
export class DelegationClassifier implements ActionClassifier {
  classify(action: ToolAction): ActionDecision | null {
    if (action.kind !== "delegate") return null
    return { level: "require_approval", reason: "Starting a background task" }
  }
}

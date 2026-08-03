import type { ActionClassifier, ActionDecision, ToolAction } from "./types"

// The filesystem/side-effecting action kinds plan mode forbids. Reads never build
// a ToolAction, so they're unaffected; `browser` is left interactive (navigation
// already prompts). write_plan does NOT gate (it's not a ToolAction), so the plan
// file stays writable.
const BLOCKED_KINDS = new Set<ToolAction["kind"]>([
  "file_write",
  "file_edit",
  "shell",
  "delegate",
])

// Belt-and-suspenders for plan mode. The primary gate is that the mutating tools
// are omitted from the per-turn toolset, so the model can't call them — but if it
// fabricates one anyway, this hard_blocks it. Reads a live getter (plan mode is a
// mutable per-turn flag the loop flips off on approval), so once a plan is
// approved this stops blocking and the same turn can implement. Placed FIRST in
// the PolicyEngine so a hard_block wins over any allowlist/sandbox downgrade.
export class PlanModeClassifier implements ActionClassifier {
  constructor(private readonly isPlanMode: () => boolean) {}

  classify(action: ToolAction): ActionDecision | null {
    if (!this.isPlanMode() || !BLOCKED_KINDS.has(action.kind)) return null
    return {
      level: "hard_block",
      reason:
        "Plan mode is active — the workspace can't be modified until the user " +
        "approves the plan (call present_plan).",
    }
  }
}

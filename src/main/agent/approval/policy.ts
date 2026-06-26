import type { ActionClassifier, ActionDecision, ToolAction } from "./types"

// Context for a policy decision — the scope inputs the allowlist matches on.
export interface PolicyContext {
  workspacePath?: string
  conversationId?: string
}

// Allowlist lookup the PolicyEngine consults before classifying. Decoupled from
// the DB layer (the repo implements it) so the engine is unit-testable without
// SQLite. Returns true when a remembered rule covers this action+scope.
export interface AllowlistLookup {
  isAllowed(action: ToolAction, ctx: PolicyContext): boolean
}

// The single decision point for every gated action. Consults the allowlist
// first, then an ordered list of classifiers (first non-null verdict wins). A
// `hard_block` from a classifier is never overridable by the allowlist — the
// allowlist can only turn a `require_approval` into an implicit allow.
export class PolicyEngine {
  constructor(
    private readonly classifiers: ActionClassifier[],
    private readonly allowlist?: AllowlistLookup
  ) {}

  decide(action: ToolAction, ctx: PolicyContext = {}): ActionDecision {
    // Classify first so a hard_block always wins, even over an allowlist rule
    // (a remembered "always allow" must never resurrect a catastrophic command).
    let verdict: ActionDecision = { level: "allow" }
    for (const classifier of this.classifiers) {
      const result = classifier.classify(action)
      if (result) {
        verdict = result
        break
      }
    }

    if (verdict.level === "hard_block") return verdict

    // An allowlist rule downgrades a required approval to an allow.
    if (
      verdict.level === "require_approval" &&
      this.allowlist?.isAllowed(action, ctx)
    ) {
      return { level: "allow", reason: "allowlisted" }
    }

    return verdict
  }
}

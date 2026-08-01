import type { ActionClassifier, ActionDecision, ToolAction } from "./types"

// Context for a policy decision — the scope inputs the allowlist matches on,
// plus whether this turn runs in a sandbox (a container backend), which gates the
// sandbox auto-approve downgrade.
export interface PolicyContext {
  workspacePath?: string
  conversationId?: string
  // True when the active execution backend is an isolated container, so the
  // sandbox policy may auto-approve selected require_approval categories.
  sandboxed?: boolean
}

// Allowlist lookup the PolicyEngine consults before classifying. Decoupled from
// the DB layer (the repo implements it) so the engine is unit-testable without
// SQLite. Returns true when a remembered rule covers this action+scope.
export interface AllowlistLookup {
  isAllowed(action: ToolAction, ctx: PolicyContext): boolean
}

// Sandbox auto-approve policy. Returns true when an action of the given category
// should be auto-approved while running in a container. Decoupled from settings
// (the service implements it) so the engine stays unit-testable. Hardline is
// never routed here — see decide().
export interface SandboxPolicyLookup {
  autoApproves(category: string | undefined): boolean
}

// The single decision point for every gated action. Consults the allowlist
// first, then an ordered list of classifiers (first non-null verdict wins). A
// `hard_block` from a classifier is never overridable by the allowlist — the
// allowlist can only turn a `require_approval` into an implicit allow.
export class PolicyEngine {
  constructor(
    private readonly classifiers: ActionClassifier[],
    private readonly allowlist?: AllowlistLookup,
    private readonly sandboxPolicy?: SandboxPolicyLookup
  ) {}

  decide(action: ToolAction, ctx: PolicyContext = {}): ActionDecision {
    // Classify first so a hard_block always wins, even over an allowlist rule or
    // a sandbox (a remembered/sandboxed "allow" must never resurrect a
    // catastrophic command).
    let verdict: ActionDecision = { level: "allow" }
    for (const classifier of this.classifiers) {
      const result = classifier.classify(action)
      if (result) {
        verdict = result
        break
      }
    }

    // The single safety invariant: a hard_block returns here, before ANY
    // downgrade path below. Neither the allowlist nor the sandbox can reach it.
    if (verdict.level === "hard_block") return verdict

    // Local backend (not a container): the approval gate is the ONLY guard, so
    // the policy TIGHTENS — a benign `allow` is upgraded to require_approval so
    // everything the agent does on the user's own machine is opt-in. This is the
    // mirror of the sandbox downgrade below: a container's isolation lets it
    // relax, a bare machine has no isolation so it asks. File READS never reach
    // the engine (they build no ToolAction), so they stay auto — the one thing
    // still allowed outright. Ordinary shell commands and file writes/edits now
    // prompt. The upgrade runs BEFORE the allowlist check below, so an "always
    // allow this action" rule remains the per-action escape hatch.
    //
    // CARVE-OUT: `browser` interactions (click/type/back) stay auto even on a
    // local backend. Opening a page (browser_navigate) already prompted via the
    // browser classifier's require_approval; once the user approved the page,
    // prompting on every click/keystroke would make verifying a multi-step flow
    // unusable. Navigation isn't affected — it's already require_approval, not
    // allow, so it never reaches this upgrade branch.
    if (!ctx.sandboxed && verdict.level === "allow" && action.kind !== "browser") {
      verdict = {
        level: "require_approval",
        reason:
          action.kind === "shell"
            ? "command requires approval (local backend)"
            : `${action.kind} requires approval (local backend)`,
      }
    }

    if (verdict.level === "require_approval") {
      // An allowlist rule ("always allow this") downgrades to allow.
      if (this.allowlist?.isAllowed(action, ctx)) {
        return { level: "allow", reason: "allowlisted" }
      }
      // In a sandbox, the sandbox policy may auto-approve selected categories —
      // the container's isolation is what makes this safe. Hardline already
      // returned above, so this can only ever relax the recoverable tier.
      if (ctx.sandboxed && this.sandboxPolicy?.autoApproves(verdict.category)) {
        return { level: "allow", reason: "sandboxed" }
      }
    }

    return verdict
  }
}

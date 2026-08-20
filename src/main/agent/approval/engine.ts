import { PolicyEngine, type AllowlistLookup, type SandboxPolicyLookup } from "./policy"
import type { ToolAction } from "./types"
import { RegexCommandClassifier } from "./regex-classifier"
import { FileActionClassifier } from "./file-classifier"
import { DelegationClassifier } from "./delegation-classifier"
import { BrowserActionClassifier } from "./browser-classifier"
import { WebActionClassifier } from "./web-classifier"
import { McpActionClassifier } from "./mcp-classifier"
import { actionAllowlist } from "../../db/repositories"
import * as settingsService from "../../settings/service"

// Builds the shared approval PolicyEngine — the single source of truth for
// "is this action allowed?" It is constructed identically wherever a side effect
// is authorized: the live agent loop (agent/index.ts) and the deterministic
// dashboard-refresh executor (plan 033.3), which re-runs a stored recipe headless
// and must respect the SAME hard_block + allowlist rules the origin tool did.
//
// The allowlist lookup is backed by the action_allowlist table; the sandbox
// policy reads live settings at decision time (so a settings change takes effect
// on the next action without rebuilding the engine). Classifiers are tried in
// order (file first since it returns null for shell, then the regex command
// classifier). A hard_block always wins — no allowlist rule or sandbox can
// resurrect a catastrophic command.
export function makePolicyEngine(): PolicyEngine {
  const allowlistLookup: AllowlistLookup = {
    isAllowed(action: ToolAction, ctx) {
      return !!actionAllowlist.findMatch(action.kind, action.identity, {
        workspacePath: ctx.workspacePath,
        conversationId: ctx.conversationId,
      })
    },
  }
  const sandboxPolicy: SandboxPolicyLookup = {
    autoApproves(category) {
      return settingsService.sandboxAutoApproves(category)
    },
  }
  return new PolicyEngine(
    [
      // Delegation first: a `delegate` action always requires approval and is
      // never sandbox-downgraded or allowlisted (no category), so classify it
      // before the file/shell classifiers (which return null for it anyway).
      new DelegationClassifier(),
      // Browser navigation always prompts (no category → never sandbox-
      // downgraded); returns null for non-browser kinds, so placement is flexible.
      new BrowserActionClassifier(),
      // web_fetch always prompts (no category → never sandbox-downgraded), like
      // browser navigation; returns null for non-web kinds.
      new WebActionClassifier(),
      // MCP tool calls always prompt (no category → never sandbox-downgraded),
      // like web_fetch; returns null for non-mcp kinds.
      new McpActionClassifier(),
      new FileActionClassifier(() => settingsService.getPermissions()),
      new RegexCommandClassifier(),
    ],
    allowlistLookup,
    sandboxPolicy
  )
}

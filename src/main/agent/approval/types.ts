// The generic approval pipeline. Every gated tool — run_shell_tool,
// write_file_tool, edit_file_tool, and future tools — describes what it wants
// to do as a `ToolAction`, and a single `PolicyEngine` decides whether to
// allow, require approval, or hard-block it, regardless of which tool produced
// it. There is ONE pipeline, not one for shell and another for files.

// The kind of side effect a tool wants to perform. Classifiers register against
// these; the allowlist persists rules keyed by kind + identity. `delegate` is
// not a filesystem/shell side effect — it's handing the remaining work off to a
// background task (run_todos_in_background). It always requires approval and is
// never allowlisted or sandbox-downgraded (see DelegationClassifier).
export type ActionKind =
  | "shell"
  | "file_write"
  | "file_edit"
  | "delegate"
  | "browser"

// A tool's request to do something gated. Tool-agnostic.
export interface ToolAction {
  // The tool requesting the action, e.g. "run_shell_tool".
  tool: string
  kind: ActionKind
  // Human-readable summary shown in the approval card, e.g. "$ rm -rf build"
  // or "overwrite src/index.ts".
  summary: string
  // Stable identity for allowlist matching — the normalized command for shell,
  // or e.g. `${kind}:${relativePath}` for file actions. Conservative: matching
  // is exact equality, never a broad prefix/glob.
  identity: string
  // Optional structured detail (command string, path, etc.) for classifiers.
  detail?: Record<string, unknown>
}

// A classifier's verdict for an action. A `require_approval` verdict may carry a
// `category` (e.g. "workspace_mutation", "destructive_fs") so a sandbox policy
// can choose to auto-approve *selected* categories inside a container — see
// PolicyEngine.decide. `hard_block` has no category: it is never downgradable.
export type ActionDecision =
  | { level: "allow"; reason?: string }
  | { level: "require_approval"; reason: string; category?: string }
  | { level: "hard_block"; reason: string }

// Classifies a tool action. A classifier returns null for action kinds it
// doesn't handle, so the PolicyEngine can try the next one. The LLM is never a
// classifier — classification is deterministic, offline, and testable.
export interface ActionClassifier {
  classify(action: ToolAction): ActionDecision | null
}

// The single entry point every gated tool calls. Returns the resolved outcome:
// "approved" (allowed outright or approved by the human), "denied" (the human
// declined), or "blocked" (hard-blocked by policy — never runs). A tool never
// talks to the classifier, allowlist, or IPC directly.
export type GateOutcome = "approved" | "denied" | "blocked"
export type Gate = (action: ToolAction) => Promise<GateOutcome>

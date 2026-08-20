import type { ActionClassifier, ActionDecision, ToolAction } from "./types"

// Classifier for `mcp` actions — a tool call routed to an external MCP server.
// Invoking a third-party server is a network/subprocess side effect (it can read,
// write, or act on the user's behalf on a remote system), so it always requires
// approval, exactly like web_fetch and browser navigation.
//
// Like those, it deliberately carries NO `category`, so the sandbox auto-approve
// downgrade (which keys on category) never silences the prompt. Auto mode still
// auto-approves it (handled in the gate), and the user can grant "once" or "for
// this session" via the allowlist (keyed by the identity = the prefixed tool name).
export class McpActionClassifier implements ActionClassifier {
  classify(action: ToolAction): ActionDecision | null {
    if (action.kind !== "mcp") return null
    return {
      level: "require_approval",
      reason: "Calling an external MCP server",
    }
  }
}

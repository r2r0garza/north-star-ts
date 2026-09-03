import type { ActionClassifier, ActionDecision, ToolAction } from "./types"

// Classifier for `mcp` actions — a tool call routed to an external MCP server.
// Invoking a third-party server is a network/subprocess side effect (it can read,
// write, or act on the user's behalf on a remote system), so it always requires
// approval, exactly like web_fetch and browser navigation.
//
// This uses the explicit approval tier because MCP servers can perform protected
// external effects under the user's connected account. Ordinary allowlist rules
// and sandbox policy must not silently cover it.
export class McpActionClassifier implements ActionClassifier {
  classify(action: ToolAction): ActionDecision | null {
    if (action.kind !== "mcp") return null
    return {
      level: "require_explicit_approval",
      reason: "Calling an external MCP server",
    }
  }
}

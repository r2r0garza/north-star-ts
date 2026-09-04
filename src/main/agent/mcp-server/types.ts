import type { Question } from "../tools/types"

export type CliMcpProvider = "claude_code" | "codex_cli"

// The bare North Star tool names the bridge knows how to serve. A grant's
// allowlist is intersected with these, so an unknown name can never register.
export const CLI_MCP_TOOLS = ["ask_user_question"] as const
export type CliMcpToolName = (typeof CLI_MCP_TOOLS)[number]

// The MCP server name both CLIs see. Claude namespaces its tools as
// `mcp__<server>__<tool>`; Codex uses `<server>__<tool>`.
export const CLI_MCP_SERVER_NAME = "north-star"

// The child environment variable carrying the per-turn bearer token. Never in
// argv, where a process listing would expose it.
export const CLI_MCP_TOKEN_ENV = "NORTH_STAR_MCP_TOKEN"

// A question the bridge surfaces on behalf of a CLI turn, plus the abort signal
// that turn is running under. Supplied by the CLI runner when it mints a grant
// so the MCP adapter never reaches back into the agent loop.
export interface CliMcpQuestionSink {
  emit: (event: {
    type: "question"
    id: string
    requestId: string
    questions: Question[]
  }) => void
  signal: AbortSignal
}

// Everything the server needs to authorize and scope one CLI turn. The token
// (not MCP arguments) determines all of it.
export interface CliMcpGrant {
  conversationId: string
  workingDirectory: string
  workspace: string | null
  provider: CliMcpProvider
  allowedTools: ReadonlySet<CliMcpToolName>
  expiresAt: number
  question: CliMcpQuestionSink | null
}

// What a runner needs to inject the bridge into a child process.
export interface CliMcpInjection {
  url: string
  tokenEnv: string
  token: string
  // Fully-qualified, provider-namespaced tool names, for Claude's --allowedTools.
  allowedTools: string[]
  // Short steer naming the granted tools, for Claude's --append-system-prompt.
  // null when the grant is empty. See buildSystemPromptSteering for why this
  // exists at all when a tool description and MCP server instructions already do.
  systemPromptSteering: string | null
  // Release the grant. Idempotent; called from the runner's `finally`.
  revoke: () => void
}

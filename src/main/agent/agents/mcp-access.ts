import type { AgentDefinition } from "./types"

// Resolve which MCP servers a running agent may use, given the names of all
// currently-ENABLED servers. Parallels agentToolAllowlist in tool-categories.ts,
// but for the separate `mcpServers` tri-state field:
//   agent === null (no custom agent) → all enabled servers (default behavior)
//   agent.mcpServers === undefined   → all enabled servers
//   agent.mcpServers === []          → none
//   agent.mcpServers === [list]      → the intersection of the list with enabled
//
// The result is always a subset of `enabledNames`, so a server the agent lists
// but that is toggled off (or deleted) is silently excluded — an agent can only
// ever narrow access, never resurrect a disabled server.
export function resolveMcpServers(
  agent: AgentDefinition | null,
  enabledNames: string[]
): string[] {
  if (!agent || agent.mcpServers === undefined) return [...enabledNames]
  if (agent.mcpServers.length === 0) return []
  const allow = new Set(agent.mcpServers)
  return enabledNames.filter((name) => allow.has(name))
}

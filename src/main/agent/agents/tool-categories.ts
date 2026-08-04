import type { AgentDefinition } from "./types"

// Maps the friendly tool CATEGORIES an agent declares in its `tools` frontmatter
// to the internal tool `function.name` values the agent loop offers. A custom
// agent narrows its toolset by category; this is where a category expands.
const CATEGORY_TOOLS: Record<string, string[]> = {
  read: ["read_file_tool", "list_files_tool"],
  search: ["search_tool", "index_query_tool"],
  edit: ["edit_file_tool", "write_file_tool"],
  execute: ["run_shell_tool"],
  web: ["web_search", "web_fetch"],
  browser: [
    "browser_navigate",
    "browser_snapshot",
    "browser_screenshot",
    "browser_click",
    "browser_type",
    "browser_back",
    "browser_close",
    "browser_handoff",
  ],
  todo: ["todo_write", "run_todos_in_background"],
  // `agent` → the subagent-spawn tool. Its OFFERING has an extra gate (children
  // must also be present) applied in buildTools; this mapping just records the
  // name so an agent-scoped allowlist admits it.
  agent: ["spawn_subagent"],
}

// The read-only floor: offered even for `tools: []`, per the tri-state contract
// (empty list → read + search only). These names are always admitted.
const FLOOR = new Set([...CATEGORY_TOOLS.read, ...CATEGORY_TOOLS.search])

// Universal infrastructure: never gated by an agent's `tools` list. Clarifying
// (ask_user_question), reading skills (read_skill), and the plan-mode handoff
// tools (write_plan/present_plan) are capabilities every agent keeps.
const UNIVERSAL = new Set([
  "ask_user_question",
  "read_skill",
  "write_plan",
  "present_plan",
])

export function isUniversalTool(name: string): boolean {
  return UNIVERSAL.has(name)
}

// Whether a category name is a recognized tool category (for `agent` gating).
export function agentToolsIncludeCategory(
  agent: AgentDefinition,
  category: string
): boolean {
  return !!agent.tools?.includes(category)
}

// Compute the set of internal tool names a custom agent is allowed to be offered,
// or `null` when the agent applies NO tool restriction (`tools` frontmatter
// omitted → full mode-appropriate toolset). Universal tools bypass this set and
// are handled by the caller (buildTools). When present, the set always includes
// the read-only floor.
export function agentToolAllowlist(
  agent: AgentDefinition | null
): Set<string> | null {
  if (!agent || agent.tools === undefined) return null
  const allowed = new Set<string>(FLOOR)
  for (const category of agent.tools) {
    const names = CATEGORY_TOOLS[category]
    if (names) for (const n of names) allowed.add(n)
  }
  return allowed
}

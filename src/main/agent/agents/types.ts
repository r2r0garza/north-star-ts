// Maximum subagent-tree depth: a top-level turn is depth 0, and each
// spawn_subagent increments it. A run at this depth may not spawn further. Bounds
// runaway recursion independently of the ancestor-cycle check (which only catches
// exact re-entry). Shared by runAgentLoop (offers the tool) and the spawn tool
// (rejects at the boundary).
export const MAX_AGENT_DEPTH = 5

// Parsed definition of a custom "fleet" agent, read from a `<name>.agent.md`
// file (YAML frontmatter + a markdown body that IS the agent's system prompt).
// Discovered under ~/.<system>/agents, <workspace>/.github/agents, and
// <workspace>/.<system>/agents (see sources.ts), mirroring how skills are found.
//
// TRI-STATE fields (tools / skills / children): the distinction between
// `undefined` (key omitted) and `[]` (key present but empty) is load-bearing and
// must be preserved by the parser — the two mean different things (see the table
// in each field's comment). Never collapse `undefined` to `[]`.
export interface AgentDefinition {
  // Agent identifier: lowercase alphanumeric + single hyphens, must match the
  // file's `<name>.agent.md` stem.
  name: string
  // What the agent does AND when to use it. Shown in the picker and to a parent
  // agent choosing which child to spawn.
  description: string
  // Allowed tool CATEGORIES (friendly names: read, search, edit, execute, agent,
  // web, browser, todo — see the category map in ../tools). Tri-state:
  //   undefined → all tools (default main-agent toolset for the mode)
  //   []        → the read-only floor only (read + search)
  //   [list]    → only the listed categories (plus the universal floor)
  tools?: string[]
  // Allowed skill names. Tri-state:
  //   undefined → all applicable skills (as today)
  //   []        → no skills
  //   [list]    → only the listed skills
  skills?: string[]
  // Which agents this one may spawn as subagents. Requires `agent` in `tools`
  // to have any effect. Tri-state:
  //   undefined → cannot spawn (even if `agent` is in tools)
  //   []        → may spawn ANY loadable agent
  //   [list]    → may spawn only the listed agents
  children?: string[]
  // Whether the user may pick this agent directly in the UI. A non-invocable
  // agent is still loadable as another agent's child. Defaults to false when the
  // frontmatter key is omitted.
  userInvocable: boolean
  // The markdown body (frontmatter stripped) — prepended to the mode system
  // prompt when this agent is selected.
  body: string
  // Absolute path to the `.agent.md` file, for diagnostics/editing.
  path: string
  // Which source dir this agent came from, for diagnostics.
  source: string
}

// One agent-source directory as surfaced to the Settings → Capabilities table.
// `kind` distinguishes the built-in dirs from user-registered custom folders:
//   user      — ~/.<system>/agents
//   custom    — a folder the user registered in Settings (removable)
//   github    — <workspace>/.github/agents (zero-config, workspace-scoped)
//   workspace — <workspace>/.<system>/agents
export type AgentSourceKind = "user" | "custom" | "github" | "workspace"
export interface AgentSourceRow {
  path: string
  kind: AgentSourceKind
  agentCount: number
}

// One agent-source folder as a node in the Agents view's nested tree: a source dir
// with a display label and its loaded agents. Mirrors the skills view's SkillFolder.
// `kind` drives writability in the UI (user/custom editable; github/workspace
// read-only).
export interface AgentFolder {
  path: string
  label: string
  kind: AgentSourceKind
  agents: AgentDefinition[]
}

// The nested catalog for the Agents view. Global is the user dir; Workspace and
// Custom each expand to a list of folders (one per known repo / registered custom
// folder). Enumerates ALL known workspaces, not just the active conversation's, so
// the view works with no active session. Mirrors SkillTree.
export interface AgentTree {
  global: AgentFolder[]
  workspaces: Array<{ label: string; path: string; folders: AgentFolder[] }>
  custom: AgentFolder[]
}

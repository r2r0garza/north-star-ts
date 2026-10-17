import type { AgentDefinition, AgentRef } from "../../agent/agents/types"

// The built-in planner for a fan-out phase's decomposition pass. It lives in
// code only (never in an agents folder, never user-pickable) and is passed to
// the agent loop as its agentOverride. `tools: []` is the read+search floor: it
// may inspect the workspace to plan, but never edits.
const ref: AgentRef = {
  sourceKind: "north_star",
  scope: "custom",
  definitionPath: "builtin:process-planner",
  nativeName: "process-planner",
}

export const PROCESS_PLANNER_AGENT: AgentDefinition = {
  name: "process-planner",
  nativeName: "process-planner",
  description:
    "Plans a fan-out process phase: splits its work into assignments with an owner agent and file ownership.",
  tools: [],
  skills: [],
  mcpServers: [],
  userInvocable: false,
  body:
    "You are the planner for one fan-out phase of a multi-phase process. You " +
    "do not do the work yourself. You list every work item the phase must " +
    "deliver, then split the items into assignments for the available agents.\n\n" +
    "Rules:\n" +
    "- Every work item goes to exactly one assignment. Never drop an item and " +
    "never give one item to two assignments.\n" +
    "- Each assignment owns the files it writes. Two assignments must never " +
    "write the same file or a file inside a directory the other owns.\n" +
    "- Pick each assignment's agent from the available agents by its " +
    "description.\n" +
    "- If the work cannot be split without workers touching the same files, " +
    "return a single assignment.",
  path: ref.definitionPath,
  source: "builtin",
  ref,
  refId: `${ref.sourceKind}:${ref.scope}:${ref.definitionPath}`,
  sourceKind: ref.sourceKind,
  scope: ref.scope,
  label: "Built-in: process-planner",
  diagnostics: [],
}

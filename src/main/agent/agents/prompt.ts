import type { AgentDefinition } from "./types"

// Builds the "you may delegate to these child agents" section, appended to the
// system prompt when spawn_subagent is offered. Lists each spawnable child's
// name + description so the parent knows what it can delegate to (progressive
// disclosure: the child's full prompt/tools stay hidden until spawned). `spawnable`
// is the already-resolved set of children this agent may spawn (respecting its
// `children` tri-state and what's actually loadable).
export function buildSubagentsPrompt(spawnable: AgentDefinition[]): string {
  if (spawnable.length === 0) return ""

  const list = spawnable
    .map((a) => `- **${a.name}**: ${a.description}`)
    .join("\n")

  return `
## Subagents

You can delegate one self-contained task with \`spawn_subagent\`, or run 1-4 independent children concurrently with \`spawn_subagents\`. Batch assignments may use an ephemeral profile (\`clone\`, \`general\`, \`planner\`, or \`explore\`) or a named child below. Children cannot see this conversation, so include all required context. Prefer read-only parallel exploration. Writing children use Git worktrees, must commit before returning, and may fail preflight; if so, do the work yourself. The parent alone integrates returned branches.

**Agents you can spawn:**

${list}

Delegate when a task matches a child's specialty; otherwise do it yourself.
`.trim()
}

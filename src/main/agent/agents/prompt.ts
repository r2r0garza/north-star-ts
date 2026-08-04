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

You can delegate a self-contained task to a specialized child agent with the \`spawn_subagent\` tool. It runs the child with its own system prompt, tools, and skills, then returns the child's final answer. The child cannot see this conversation, so give it a complete, self-contained prompt.

**Agents you can spawn:**

${list}

Delegate when a task matches a child's specialty; otherwise do it yourself.
`.trim()
}

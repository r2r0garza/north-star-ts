import type { SkillMetadata } from "./types"

// Builds the Skills System section of the system prompt. Only name +
// description (+ light annotations) go in the prompt — the body stays out until
// the model calls read_skill. This is the progressive-disclosure pattern.
export function buildSkillsPrompt(skills: SkillMetadata[]): string {
  if (skills.length === 0) return ""

  const list = skills
    .map((s) => {
      const annotations = [
        s.license && `License: ${s.license}`,
        s.compatibility && `Compatibility: ${s.compatibility}`,
      ]
        .filter(Boolean)
        .join(", ")
      let line = `- **${s.name}**: ${s.description}${annotations ? ` (${annotations})` : ""}`
      if (s.allowedTools.length) line += `\n  → Recommended tools: ${s.allowedTools.join(", ")}`
      line += `\n  → Call \`read_skill("${s.name}")\` for full instructions`
      return line
    })
    .join("\n")

  return `
## Skills System

You have access to a skills library providing specialized capabilities and domain knowledge.

**Available Skills:**

${list}

**How to Use Skills (Progressive Disclosure):**

You see each skill's name and description above, but only read full instructions when needed:

1. **Recognize when a skill applies** — check if the user's task matches a skill's description.
2. **Read the full instructions** — call \`read_skill\` with the skill's name.
3. **Follow the instructions** — SKILL.md contains step-by-step workflows, best practices, and examples.

When in doubt, check if a skill exists for the task.
`.trim()
}

import type { Tool } from "../tools/types"
import type { SkillMetadata } from "./types"

// Builds a read_skill tool scoped to the given skills. Taking a name (not a
// path) keeps the model from fumbling path resolution or wandering the
// filesystem — the body is returned from memory, loaded eagerly at startup.
export function createReadSkillTool(skills: SkillMetadata[]): Tool {
  const index = new Map(skills.map((s) => [s.name, s]))
  return {
    definition: {
      type: "function",
      function: {
        name: "read_skill",
        description:
          "Read the full instructions (SKILL.md body) for a named skill from the skills library. " +
          "Call this when a skill's description matches the current task.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "The skill's name, exactly as listed in the Skills System section.",
            },
          },
          required: ["name"],
        },
      },
    },
    execute: async (args) => {
      const name = typeof args.name === "string" ? args.name : ""
      const skill = index.get(name)
      if (!skill) {
        const available = [...index.keys()].join(", ") || "(none)"
        return `No skill named "${name}". Available skills: ${available}`
      }
      return skill.body
    },
  }
}

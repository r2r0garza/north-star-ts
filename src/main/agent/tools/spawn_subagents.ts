import { TOOL_EFFECTS, type Tool, type ToolContext } from "./types"
import { toolError } from "./output"
import {
  serializeSubagentResults,
  validateSpawnSubagentsInput,
} from "../subagents/contracts"

export const spawnSubagentsTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "spawn_subagents",
      description:
        "Run 1-4 independent named or ephemeral subagents concurrently and return their ordered results. Prompts must be self-contained because children cannot see this conversation. Use read access for parallel exploration. Write access is available only when isolated writer worktrees are supported.",
      parameters: {
        type: "object",
        properties: {
          assignments: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                agent: {
                  oneOf: [
                    {
                      type: "object",
                      properties: {
                        type: { type: "string", enum: ["ephemeral"] },
                        profile: {
                          type: "string",
                          enum: ["clone", "general", "planner", "explore"],
                        },
                      },
                      required: ["type", "profile"],
                    },
                    {
                      type: "object",
                      properties: {
                        type: { type: "string", enum: ["named"] },
                        name: { type: "string" },
                      },
                      required: ["type", "name"],
                    },
                  ],
                },
                prompt: { type: "string" },
                access: { type: "string", enum: ["read", "write"] },
                instruction_uri: { type: "string" },
              },
              required: ["id", "agent", "prompt", "access"],
            },
          },
          prepare_integration: { type: "boolean" },
        },
        required: ["assignments"],
      },
    },
  },
  execute: async (args, ctx) => {
    if (!ctx.spawnSubagents)
      return toolError("unavailable", "Subagent batches are unavailable here.")
    const parsed = validateSpawnSubagentsInput(args, {
      planMode: ctx.planMode === true,
      writeEnabled: ctx.writeSubagentsEnabled === true,
    })
    if (!parsed.ok) {
      const code =
        parsed.error === "write_subagents_unavailable"
          ? "write_subagents_unavailable"
          : "bad_args"
      return toolError(code, parsed.error)
    }
    const results = await ctx.spawnSubagents(parsed.value)
    return serializeSubagentResults(results)
  },
}

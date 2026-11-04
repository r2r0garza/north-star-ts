import { validateArtifactPresentation } from "../../../shared/conversation-artifacts"
import { executionArguments } from "../../../shared/tool-activity"
import { TOOL_EFFECTS, type Tool } from "./types"
import { toolError } from "./output"

export const presentTableTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "present_table",
      description:
        "Save a bounded table snapshot using already obtained data; does not fetch, calculate, execute code or create a dashboard. Source labels are attribution, not verification. Readers without inline support retain a textual acknowledgement. Supply typed columns and flat scalar rows, with explicit null for missing values. Supplied row order is preserved; sorting is local presentation only. Percent values are fractions. Limits: 1000 rows, 24 columns, 500 characters per text cell, 256 KiB; aggregate larger datasets first. To revise, supply artifactId and expectedBaseRevision together; conflicts fail without overwriting history.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", maxLength: 200 },
          description: { type: "string", maxLength: 2000 },
          source: { type: "string", maxLength: 200 },
          dataAsOf: { type: "string", maxLength: 200 },
          artifactId: { type: "string", maxLength: 128 },
          expectedBaseRevision: { type: "integer", minimum: 1 },
          columns: {
            type: "array",
            minItems: 1,
            maxItems: 24,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                key: {
                  type: "string",
                  maxLength: 64,
                  pattern: "^[A-Za-z][A-Za-z0-9_]*$",
                  description:
                    "Safe row key such as completedTasks; start with a letter, then letters/digits/underscores only. No spaces or reserved __proto__/constructor/prototype keys. Put display wording in label.",
                },
                label: { type: "string", maxLength: 200 },
                valueType: {
                  type: "string",
                  enum: ["string", "number", "boolean"],
                  description:
                    'Only string, number or boolean. For integer counts use valueType="number" and numberFormat="integer"; "integer" is not a valueType.',
                },
                numberFormat: {
                  type: "string",
                  enum: ["number", "integer", "percent"],
                },
                unit: {
                  type: "string",
                  maxLength: 200,
                  description:
                    'When numberFormat="percent", omit unit or use "%" only. Values are fractions.',
                },
              },
              required: ["key", "label", "valueType"],
            },
          },
          data: { type: "array", maxItems: 1000, items: { type: "object" } },
        },
        required: ["title", "columns", "data"],
      },
    },
  },
  execute: async (args, ctx) => {
    if (!ctx.conversationId || !ctx.invocationId || !ctx.emitArtifact)
      return toolError(
        "unavailable",
        "Table presentation requires a durable conversation runtime; this context does not support it."
      )
    if (ctx.planMode)
      return toolError(
        "unavailable",
        "Table presentation is unavailable in plan mode."
      )
    if (ctx.signal?.aborted)
      return toolError("cancelled", "Table presentation was cancelled.")
    try {
      ctx.emitArtifact(
        validateArtifactPresentation(executionArguments(args), "table")
      )
      return "Table validated; awaiting durable presentation storage."
    } catch (error) {
      return toolError(
        "bad_args",
        error instanceof Error ? error.message : "Invalid table specification."
      )
    }
  },
}

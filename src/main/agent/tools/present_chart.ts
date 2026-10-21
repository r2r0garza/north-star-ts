import { validateArtifactPresentation } from "../../../shared/conversation-artifacts"
import { executionArguments } from "../../../shared/tool-activity"
import { TOOL_EFFECTS, type Tool } from "./types"
import { toolError } from "./output"

export const presentChartTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "present_chart",
      description:
        "Save a bounded chart snapshot for conversation presentation using data already obtained through other tools. Does not fetch, calculate, execute code or create a live dashboard. Source labels are attribution, not verification. Supported conversation readers show the saved chart inline; the acknowledgement confirms storage, not that the user saw it. Use explicit null for missing numeric observations (gaps); category order is preserved. Percent values are fractions. Limits: 1000 rows, 12 series, 256 KiB. Aggregate larger datasets first. To revise a saved chart, supply artifactId and expectedBaseRevision together; conflicts fail without overwriting history.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          artifactId: { type: "string", maxLength: 128 },
          expectedBaseRevision: { type: "integer", minimum: 1 },
          title: { type: "string", maxLength: 200 },
          description: { type: "string", maxLength: 2000 },
          source: { type: "string", maxLength: 200 },
          dataAsOf: { type: "string", maxLength: 200 },
          chartKind: { type: "string", enum: ["line", "bar", "area"] },
          xKey: { type: "string", maxLength: 64 },
          unit: { type: "string", maxLength: 200 },
          numberFormat: {
            type: "string",
            enum: ["number", "integer", "percent"],
          },
          series: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                key: { type: "string", maxLength: 64 },
                label: { type: "string", maxLength: 200 },
              },
              required: ["key", "label"],
            },
          },
          data: { type: "array", maxItems: 1000, items: { type: "object" } },
        },
        required: ["title", "chartKind", "xKey", "series", "data"],
      },
    },
  },
  execute: async (args, ctx) => {
    if (!ctx.conversationId || !ctx.invocationId || !ctx.emitArtifact)
      return toolError(
        "unavailable",
        "Chart presentation requires a durable conversation runtime; this context does not support it."
      )
    if (ctx.planMode)
      return toolError(
        "unavailable",
        "Chart presentation is unavailable in plan mode."
      )
    if (ctx.signal?.aborted)
      return toolError("cancelled", "Chart presentation was cancelled.")
    try {
      ctx.emitArtifact(
        validateArtifactPresentation(executionArguments(args), "chart")
      )
      return "Chart validated; awaiting durable presentation storage."
    } catch (error) {
      return toolError(
        "bad_args",
        error instanceof Error ? error.message : "Invalid chart specification."
      )
    }
  },
}

import { validateArtifactPresentation } from "../../../shared/conversation-artifacts"
import { executionArguments } from "../../../shared/tool-activity"
import { presentChartTool } from "./present_chart"
import { presentTableTool } from "./present_table"
import { TOOL_EFFECTS, type Tool } from "./types"
import { toolError } from "./output"

export const visualSpikeEnabled = () =>
  process.env.NORTH_STAR_OPENUI_SPIKE === "1"
export const presentVisualTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "present_visual",
      description:
        'Experimental static composed answer using already obtained data, never fetching, executing or creating a dashboard. Prefer prose unless composition helps. Supply library="north-star-static-v1", document and datasets. Document is exactly root = Component(...); with inline calls only: Stack([children]), Row([children]), Text("text"), Card("title",[children]), Metric("label",number,"number"|"integer"|"percent"), Chart("datasetId"), DataTable("datasetId"), Tabs([Tab("label",[children]),...]). These are exact positional signatures, not illustrative overloads: Text takes exactly ONE string argument; do not add role/style arguments such as "body" or "muted". Use only needed wrappers; a root Tabs is allowed. Balance every bracket/parenthesis, keep all Tab calls inside the same Tabs array, and end the single root assignment with a literal semicolon. Complete minimal example: root = Tabs([Tab("Overview",[Metric("Completion",0.75,"percent")]),Tab("Evidence",[Text("Synthetic data"),Chart("rates"),DataTable("tasks")])]); (requires matching rates chart and tasks table datasets). No references, objects, expressions, state, actions, URLs, tools or code. Tabs are local display state only. Dataset entries are {id,snapshot}; snapshot is an existing chart/table contract with explicit kind and schemaVersion:1. Percent values are fractions (0.75 means 75%). Whenever numberFormat is "percent", omit unit or set unit to "%"; never use descriptive units such as "completion rate". This applies to chart snapshots and individual table columns. Put descriptive wording in titles/labels instead. Missing observations are null, source labels are attribution. Limits: 8 datasets, 200 nodes, depth 12, 2000 total rendered dataset rows, 256 KiB. Saves an immutable conversation artifact; acknowledgement confirms storage, not viewing. Revisions require artifactId and expectedBaseRevision together. Concepts and design choices remain on present_ui.',
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
          library: { type: "string", enum: ["north-star-static-v1"] },
          document: {
            type: "string",
            maxLength: 65536,
            description:
              'One complete root assignment ending with ;. Exact signatures only: Text("text") has no second role/style argument. Keep all tabs inside Tabs([Tab(...),Tab(...)]). Example: root = Tabs([Tab("Overview",[Metric("Rate",0.75,"percent")]),Tab("Evidence",[Text("Synthetic data")])]);',
          },
          datasets: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", maxLength: 64 },
                snapshot: {
                  description:
                    'Chart/table snapshot using supplied data. Percent values are fractions; when numberFormat="percent", omit unit or use "%" only, including on table columns. Use titles/labels for descriptive wording.',
                  anyOf: [presentChartTool, presentTableTool].map((tool, i) => {
                    const params = tool.definition.function.parameters as {
                      properties: Record<string, unknown>
                      required: string[]
                    }
                    const {
                      artifactId: _id,
                      expectedBaseRevision: _rev,
                      ...properties
                    } = params.properties
                    return {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        ...properties,
                        kind: {
                          type: "string",
                          enum: [i === 0 ? "chart" : "table"],
                        },
                        schemaVersion: { type: "integer", enum: [1] },
                      },
                      required: [...params.required, "kind", "schemaVersion"],
                    }
                  }),
                },
              },
              required: ["id", "snapshot"],
            },
          },
        },
        required: ["title", "library", "document", "datasets"],
      },
    },
  },
  execute: async (args, ctx) => {
    if (
      !visualSpikeEnabled() ||
      !ctx.conversationId ||
      !ctx.invocationId ||
      !ctx.emitArtifact ||
      ctx.planMode
    )
      return toolError(
        "unavailable",
        "Visual presentation requires the opt-in durable runtime outside plan mode."
      )
    if (ctx.signal?.aborted)
      return toolError("cancelled", "Visual presentation was cancelled.")
    try {
      ctx.emitArtifact(
        validateArtifactPresentation(executionArguments(args), "visual")
      )
      return "Visual answer validated; awaiting durable presentation storage."
    } catch (error) {
      return toolError(
        "bad_args",
        error instanceof Error ? error.message : "Invalid visual answer."
      )
    }
  },
}

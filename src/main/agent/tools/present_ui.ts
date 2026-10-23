import { validateArtifactPresentation } from "../../../shared/conversation-artifacts"
import { executionArguments } from "../../../shared/tool-activity"
import { TOOL_EFFECTS, type Tool } from "./types"
import { toolError } from "./output"

export const presentUiTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "present_ui",
      description:
        "Show a rendered UI concept (a mockup of a screen) inline in the conversation, for redesign or layout questions where a picture beats prose or ASCII. It is a design sketch only: it does not edit files, run code, or reflect the user's real app, and its buttons and controls do nothing beyond local demo state. Use illustrative sample content, not claims about the workspace. Describe `tree` as nested nodes, each with a `type` and only the listed fields (unknown fields are rejected):\n" +
        "- stack {gap?, align?, children} — vertical layout; row {gap?, align?, justify?: start|center|end|between, wrap?: boolean, children}; grid {columns: 1-4, gap?, children}. gap: none|sm|md|lg; align: start|center|end|stretch.\n" +
        "- text {text, role?: heading|subheading|body|muted, emphasis?: normal|strong}; separator {}; badge {text, variant?: default|secondary|outline|destructive}; button {text, variant?: default|secondary|outline|ghost|destructive, size?: sm|default, goTo?: state id}.\n" +
        "- card {title?, description?, surface?: default|muted, children?}; tabs {tabs: [{label, children}] (2-6 tabs)}; table {caption?, columns: [header text], rows: [[cell text]] (≤12 columns, ≤50 rows)}.\n" +
        "- field {label, description?, orientation?: vertical|horizontal, control} where control is one of: input {inputType?: text|email|number|search, placeholder?, defaultValue?}, select {options: [text] (1-20), defaultValue?}, switch {defaultChecked?: boolean}. Controls only appear inside a field.\n" +
        'Optional `states`: up to 8 alternate screens [{id, label, tree}] (ids start with a letter, then letters/digits/underscore; unique; not "initial"). A button with goTo switches the preview to that state, or back with goTo "initial"; this is the only button behavior — there are no actions, submissions or navigation outside the preview. Each screen starts with fresh demo values.\n' +
        "Optional top-level `density` (compact|comfortable|spacious) and `typeScale` (sm|md|lg) set overall spacing and text size.\n" +
        "Limits: 200 nodes across all screens, depth 12, 500 characters per text. No HTML, CSS, class names, URLs, scripts or event handlers. Present distinct alternatives as separate calls. To revise, supply artifactId and expectedBaseRevision together; conflicts fail without overwriting history.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", maxLength: 200 },
          description: { type: "string", maxLength: 2000 },
          density: {
            type: "string",
            enum: ["compact", "comfortable", "spacious"],
          },
          typeScale: { type: "string", enum: ["sm", "md", "lg"] },
          artifactId: { type: "string", maxLength: 128 },
          expectedBaseRevision: { type: "integer", minimum: 1 },
          tree: {
            type: "object",
            description:
              "Root node, usually a stack. See the tool description for node types.",
          },
          states: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", maxLength: 64 },
                label: { type: "string", maxLength: 200 },
                tree: { type: "object" },
              },
              required: ["id", "label", "tree"],
            },
          },
        },
        required: ["title", "tree"],
      },
    },
  },
  execute: async (args, ctx) => {
    if (!ctx.conversationId || !ctx.invocationId || !ctx.emitArtifact)
      return toolError(
        "unavailable",
        "UI concept presentation requires a durable conversation runtime; this context does not support it."
      )
    if (ctx.planMode)
      return toolError(
        "unavailable",
        "UI concept presentation is unavailable in plan mode."
      )
    if (ctx.signal?.aborted)
      return toolError("cancelled", "UI concept presentation was cancelled.")
    try {
      ctx.emitArtifact(
        validateArtifactPresentation(executionArguments(args), "ui_concept")
      )
      return "UI concept validated; awaiting durable presentation storage."
    } catch (error) {
      return toolError(
        "bad_args",
        error instanceof Error
          ? error.message
          : "Invalid UI concept specification."
      )
    }
  },
}

import { writeFile } from "fs/promises"
import { TOOL_EFFECTS, type Tool } from "./types"
import { toolError } from "./output"
import { ensurePlansDir } from "./plan-file"

// Plan-mode's ONLY write capability: save/overwrite the turn's plan document at
// ~/.<name>/plans/<conversationId>.md. There is deliberately no path parameter —
// the path is fixed and computed server-side from the conversation, so the model
// can only ever write its own plan file (never the workspace). This bypasses the
// workspace sandbox on purpose; it's offered only while plan mode is active.
export const writePlanTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "write_plan",
      description:
        "Save your implementation plan (Markdown) to the conversation's plan file. " +
        "This is the ONLY write available in plan mode. Call it whenever you want to " +
        "record or revise the plan as your research progresses — each call overwrites " +
        "the whole document, so pass the complete plan every time. When the plan is " +
        "ready for the user, call present_plan to get their approval.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "The full plan document as Markdown (replaces the file).",
          },
        },
        required: ["content"],
      },
    },
  },
  execute: async (args, ctx) => {
    if (!ctx.conversationId) {
      return toolError(
        "unavailable",
        "Saving a plan isn't available in this context."
      )
    }
    const content = (args as { content?: unknown }).content
    if (typeof content !== "string" || content.trim() === "") {
      return toolError("bad_args", "`content` must be a non-empty string.")
    }
    const file = await ensurePlansDir(ctx.conversationId)
    await writeFile(file, content, "utf-8")
    return `Plan saved to ${file}. When it's ready for review, call present_plan.`
  },
}

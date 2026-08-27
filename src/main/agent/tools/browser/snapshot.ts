import { TOOL_EFFECTS, type Tool, type ToolContext } from "../types"
import { toolError, truncateForModel } from "../output"

// Read the current page as a compact accessibility outline (roles + names). This
// is the model's primary "what's on the page" perception — it works even when
// screenshots can't be shown to the model. Not gated (observation, not a side
// effect), mirroring how file reads never reach the approval gate.
export const browserSnapshotTool: Tool = {
  effects: TOOL_EFFECTS.openWorldRead,
  definition: {
    type: "function",
    function: {
      name: "browser_snapshot",
      description:
        "Read the current page in the agent browser as a text outline of its " +
        "accessible elements (headings, links, buttons, form fields) plus the URL " +
        "and title. Use this to understand page structure and verify a flow. Call " +
        "browser_navigate first to open a page.",
      parameters: { type: "object", properties: {} },
    },
  },
  execute: async (_args: Record<string, unknown>, ctx: ToolContext) => {
    if (!ctx.browser) {
      return toolError("no_browser", "The agent browser is unavailable.")
    }
    try {
      const outline = await ctx.browser.snapshot()
      return truncateForModel(outline).text
    } catch (err) {
      return toolError(
        "snapshot_failed",
        err instanceof Error ? err.message : String(err)
      )
    }
  },
}

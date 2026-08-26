import { TOOL_EFFECTS, type Tool, type ToolContext } from "../types"
import type { ToolAction } from "../../approval/types"
import { toolError } from "../output"

// Close the agent browser when done with it. Frees the browser's renderer
// process and hides its window; a later browser_navigate opens a fresh one.
// Gated as a `browser` interaction (auto-allowed — closing the agent's own
// browser is not a side effect on the user's system).
export const browserCloseTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "browser_close",
      description:
        "Close the agent browser when you're finished with it (e.g. after " +
        "verifying a flow or viewing a page). This frees resources and closes the " +
        "window. A later browser_navigate reopens a fresh browser. Safe to call " +
        "even if the browser isn't open.",
      parameters: { type: "object", properties: {} },
    },
  },
  execute: async (_args: Record<string, unknown>, ctx: ToolContext) => {
    if (!ctx.browser) {
      return toolError("no_browser", "The agent browser is unavailable.")
    }

    const action: ToolAction = {
      tool: "browser_close",
      kind: "browser",
      summary: "Close the browser",
      identity: "browser_close",
    }
    const outcome = ctx.gate ? await ctx.gate(action) : ("denied" as const)
    if (outcome === "blocked") {
      return toolError("blocked", "This action was blocked.")
    }
    if (outcome === "denied") {
      return toolError("denied", "The user denied approval for this action.")
    }

    const wasOpen = ctx.browser.close()
    return wasOpen
      ? "Closed the browser."
      : "The browser was not open; nothing to close."
  },
}

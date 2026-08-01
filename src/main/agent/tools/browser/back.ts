import type { Tool, ToolContext } from "../types"
import type { ToolAction } from "../../approval/types"
import { toolError } from "../output"

// Go back one page in the agent browser's history. Gated as a `browser`
// interaction (auto-allowed; only forward navigation to a new URL prompts) —
// going back stays within pages already visited/approved.
export const browserBackTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "browser_back",
      description:
        "Go back to the previous page in the agent browser's history. Useful " +
        "after clicking into a section to return and try another. Call " +
        "browser_snapshot afterward to see the current elements.",
      parameters: { type: "object", properties: {} },
    },
  },
  execute: async (_args: Record<string, unknown>, ctx: ToolContext) => {
    if (!ctx.browser) {
      return toolError("no_browser", "The agent browser is unavailable.")
    }

    const action: ToolAction = {
      tool: "browser_back",
      kind: "browser",
      summary: "Go back in the browser",
      identity: "browser_back",
    }
    const outcome = ctx.gate ? await ctx.gate(action) : ("denied" as const)
    if (outcome === "blocked") {
      return toolError("blocked", "This action was blocked.")
    }
    if (outcome === "denied") {
      return toolError("denied", "The user denied approval for this action.")
    }

    try {
      const { url, title } = await ctx.browser.back()
      return `Went back. Page is now ${url} (title: ${title || "untitled"}). Call browser_snapshot to see the current elements.`
    } catch (err) {
      return toolError(
        "back_failed",
        err instanceof Error ? err.message : String(err)
      )
    }
  },
}

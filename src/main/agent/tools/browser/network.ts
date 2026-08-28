import { TOOL_EFFECTS, type Tool, type ToolContext } from "../types"
import { toolError } from "../output"
import { numberArg } from "./console"

export const browserNetworkTool: Tool = {
  effects: TOOL_EFFECTS.openWorldRead,
  definition: {
    type: "function",
    function: {
      name: "browser_network",
      description:
        "Read the current conversation tab's bounded network event buffer. URLs are sanitized and response bodies are never returned.",
      parameters: {
        type: "object",
        properties: {
          cursor: {
            type: "number",
            description: "Return entries after this id.",
          },
          status: {
            type: "number",
            description: "Optional exact HTTP status filter.",
          },
          limit: { type: "number", description: "Maximum entries to return." },
          sinceMs: {
            type: "number",
            description: "Only entries from this recent window.",
          },
        },
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    if (!ctx.browser)
      return toolError("no_browser", "The agent browser is unavailable.")
    const page = ctx.browser.network({
      cursor: numberArg(args.cursor),
      status: numberArg(args.status),
      limit: numberArg(args.limit),
      sinceMs: numberArg(args.sinceMs),
    })
    return JSON.stringify(page, null, 2)
  },
}

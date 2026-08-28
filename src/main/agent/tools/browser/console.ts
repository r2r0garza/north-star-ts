import { TOOL_EFFECTS, type Tool, type ToolContext } from "../types"
import { toolError } from "../output"

export const browserConsoleTool: Tool = {
  effects: TOOL_EFFECTS.openWorldRead,
  definition: {
    type: "function",
    function: {
      name: "browser_console",
      description:
        "Read the current conversation tab's bounded console log buffer. Results are redacted and paginated.",
      parameters: {
        type: "object",
        properties: {
          cursor: {
            type: "number",
            description: "Return entries after this id.",
          },
          level: {
            type: "string",
            description: "Optional exact level filter.",
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
    const page = ctx.browser.console({
      cursor: numberArg(args.cursor),
      level: typeof args.level === "string" ? args.level : undefined,
      limit: numberArg(args.limit),
      sinceMs: numberArg(args.sinceMs),
    })
    return JSON.stringify(page, null, 2)
  },
}

export function numberArg(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

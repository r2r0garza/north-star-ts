import { TOOL_EFFECTS, type Tool, type ToolContext } from "../types"
import type { ToolAction } from "../../approval/types"
import { toolError } from "../output"
import { browserOrigin, hashBrowserPayload } from "./approval"

export const browserEvaluateTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "browser_evaluate",
      description:
        "Approval-required advanced escape hatch: evaluate a bounded JavaScript expression in the current page world only. No Node/Electron APIs, handles, or unbounded output.",
      parameters: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: "A JavaScript expression, not a function body.",
          },
        },
        required: ["expression"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    const expression =
      typeof args.expression === "string" ? args.expression.trim() : ""
    if (!expression) return toolError("bad_args", "`expression` is required.")
    if (!ctx.browser)
      return toolError("no_browser", "The agent browser is unavailable.")
    const url = ctx.browser.state()?.url ?? ""
    const origin = browserOrigin(url)
    const action: ToolAction = {
      tool: "browser_evaluate",
      kind: "browser",
      summary: `Evaluate page JavaScript on ${origin}`,
      identity: [
        "browser_evaluate",
        origin,
        url || "unknown url",
        `expr_sha256=${hashBrowserPayload(expression)}`,
      ].join(":"),
      detail: {
        url,
        origin,
        expression,
        actionType: "evaluate",
        interactionKind: "consequential_commit",
      },
    }
    const outcome = ctx.gate ? await ctx.gate(action) : ("denied" as const)
    if (outcome === "blocked")
      return toolError("blocked", "This evaluation was blocked.")
    if (outcome === "denied")
      return toolError(
        "denied",
        "The user denied approval for this evaluation."
      )
    try {
      return JSON.stringify(await ctx.browser.evaluate(expression), null, 2)
    } catch (err) {
      return toolError(
        "evaluate_failed",
        err instanceof Error ? err.message : String(err)
      )
    }
  },
}

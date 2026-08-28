import { TOOL_EFFECTS, type Tool, type ToolContext } from "../types"
import type { ToolAction } from "../../approval/types"
import { toolError } from "../output"
import { browserActionIdentity, browserOrigin } from "./approval"

export const browserHoverTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "browser_hover",
      description:
        "Hover an element in the agent browser using a `ref` from browser_snapshot. " +
        "Use this for hover menus, tooltips, and controls revealed on hover.",
      parameters: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description: 'The element ref from browser_snapshot, e.g. "e3".',
          },
        },
        required: ["ref"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    const ref = typeof args.ref === "string" ? args.ref.trim() : ""
    if (!ref) return toolError("bad_args", "A `ref` is required.")
    if (!ctx.browser)
      return toolError("no_browser", "The agent browser is unavailable.")

    let target = `element ${ref}`
    let targetFingerprint = `ref=${ref}`
    try {
      const described = ctx.browser.describeRef(ref)
      target = described.target
      targetFingerprint = described.targetFingerprint
    } catch (err) {
      return toolError(
        "hover_failed",
        err instanceof Error ? err.message : String(err)
      )
    }
    const url = ctx.browser.state()?.url ?? ""
    const origin = browserOrigin(url)
    const action: ToolAction = {
      tool: "browser_hover",
      kind: "browser",
      summary: `Hover ${target} on ${origin}`,
      identity: browserActionIdentity({
        action: "hover",
        url,
        origin,
        target,
        ref,
        targetFingerprint,
      }),
      detail: {
        ref,
        target,
        url,
        origin,
        actionType: "hover",
        interactionKind: "reversible_interaction",
      },
    }
    const outcome = ctx.gate ? await ctx.gate(action) : ("denied" as const)
    if (outcome === "blocked")
      return toolError("blocked", "This hover was blocked.")
    if (outcome === "denied")
      return toolError("denied", "The user denied approval for this hover.")
    try {
      const { target, url, title } = await ctx.browser.hover(ref)
      return `Hovered ${target}. Page is now ${url} (title: ${title || "untitled"}). Call browser_snapshot to see current elements.`
    } catch (err) {
      return toolError(
        "hover_failed",
        err instanceof Error ? err.message : String(err)
      )
    }
  },
}

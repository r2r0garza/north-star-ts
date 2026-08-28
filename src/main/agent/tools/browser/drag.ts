import { TOOL_EFFECTS, type Tool, type ToolContext } from "../types"
import type { ToolAction } from "../../approval/types"
import { toolError } from "../output"
import { browserActionIdentity, browserOrigin } from "./approval"

export const browserDragTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "browser_drag",
      description:
        "Drag one browser_snapshot element ref onto another. Use only for page drag/drop interactions.",
      parameters: {
        type: "object",
        properties: {
          fromRef: { type: "string", description: 'Starting ref, e.g. "e2".' },
          toRef: { type: "string", description: 'Drop target ref, e.g. "e7".' },
        },
        required: ["fromRef", "toRef"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    const fromRef = typeof args.fromRef === "string" ? args.fromRef.trim() : ""
    const toRef = typeof args.toRef === "string" ? args.toRef.trim() : ""
    if (!fromRef || !toRef) {
      return toolError("bad_args", "`fromRef` and `toRef` are required.")
    }
    if (!ctx.browser)
      return toolError("no_browser", "The agent browser is unavailable.")

    let fromTarget = `element ${fromRef}`
    let toTarget = `element ${toRef}`
    let targetFingerprint = `from=${fromRef};to=${toRef}`
    try {
      const from = ctx.browser.describeRef(fromRef)
      const to = ctx.browser.describeRef(toRef)
      fromTarget = from.target
      toTarget = to.target
      targetFingerprint = `${from.targetFingerprint}->${to.targetFingerprint}`
    } catch (err) {
      return toolError(
        "drag_failed",
        err instanceof Error ? err.message : String(err)
      )
    }
    const target = `${fromTarget} to ${toTarget}`
    const url = ctx.browser.state()?.url ?? ""
    const origin = browserOrigin(url)
    const action: ToolAction = {
      tool: "browser_drag",
      kind: "browser",
      summary: `Drag ${target} on ${origin}`,
      identity: browserActionIdentity({
        action: "drag",
        url,
        origin,
        target,
        ref: `${fromRef}->${toRef}`,
        targetFingerprint,
      }),
      detail: {
        fromRef,
        toRef,
        target,
        url,
        origin,
        actionType: "drag",
        interactionKind: "reversible_interaction",
      },
    }
    const outcome = ctx.gate ? await ctx.gate(action) : ("denied" as const)
    if (outcome === "blocked")
      return toolError("blocked", "This drag was blocked.")
    if (outcome === "denied")
      return toolError("denied", "The user denied approval for this drag.")
    try {
      const { target, url, title } = await ctx.browser.drag(fromRef, toRef)
      return `Dragged ${target}. Page is now ${url} (title: ${title || "untitled"}). Call browser_snapshot to see current elements.`
    } catch (err) {
      return toolError(
        "drag_failed",
        err instanceof Error ? err.message : String(err)
      )
    }
  },
}

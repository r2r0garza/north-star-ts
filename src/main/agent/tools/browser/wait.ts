import { TOOL_EFFECTS, type Tool, type ToolContext } from "../types"
import type { ToolAction } from "../../approval/types"
import { toolError } from "../output"
import { browserActionIdentity, browserOrigin } from "./approval"

const CONDITIONS = new Set([
  "duration",
  "url_changed",
  "title_changed",
  "ref_visible",
  "ref_hidden",
  "network_idle",
])

export const browserWaitTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "browser_wait",
      description:
        "Wait for a bounded browser condition: duration, url_changed, title_changed, ref_visible, ref_hidden, or network_idle.",
      parameters: {
        type: "object",
        properties: {
          condition: {
            type: "string",
            enum: [...CONDITIONS],
          },
          ref: {
            type: "string",
            description: "Required for ref_visible/ref_hidden waits.",
          },
          timeoutMs: {
            type: "number",
            description:
              "Maximum wait time in milliseconds, capped internally.",
          },
          idleMs: {
            type: "number",
            description: "Stable idle period for network_idle waits.",
          },
        },
        required: ["condition", "timeoutMs"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    const condition = typeof args.condition === "string" ? args.condition : ""
    if (!CONDITIONS.has(condition))
      return toolError("bad_args", "Unsupported wait condition.")
    const timeoutMs = Number(args.timeoutMs)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return toolError("bad_args", "`timeoutMs` must be a positive number.")
    }
    if (!ctx.browser)
      return toolError("no_browser", "The agent browser is unavailable.")

    const ref = typeof args.ref === "string" ? args.ref.trim() : undefined
    if ((condition === "ref_visible" || condition === "ref_hidden") && !ref) {
      return toolError("bad_args", "`ref` is required for this wait condition.")
    }
    let target = condition
    let targetFingerprint = condition
    if (ref) {
      try {
        const described = ctx.browser.describeRef(ref)
        target = `${condition} ${described.target}`
        targetFingerprint = described.targetFingerprint
      } catch (err) {
        return toolError(
          "wait_failed",
          err instanceof Error ? err.message : String(err)
        )
      }
    }
    const url = ctx.browser.state()?.url ?? ""
    const origin = browserOrigin(url)
    const action: ToolAction = {
      tool: "browser_wait",
      kind: "browser",
      summary: `Wait for ${target} on ${origin}`,
      identity: browserActionIdentity({
        action: "wait",
        url,
        origin,
        target,
        ref,
        targetFingerprint,
      }),
      detail: {
        condition,
        ref,
        url,
        origin,
        timeoutMs,
        actionType: "wait",
        interactionKind: "reversible_interaction",
      },
    }
    const outcome = ctx.gate ? await ctx.gate(action) : ("denied" as const)
    if (outcome === "blocked")
      return toolError("blocked", "This wait was blocked.")
    if (outcome === "denied")
      return toolError("denied", "The user denied approval for this wait.")
    try {
      const result = await ctx.browser.wait({
        condition: condition as Parameters<
          typeof ctx.browser.wait
        >[0]["condition"],
        ref,
        timeoutMs,
        idleMs: Number.isFinite(Number(args.idleMs))
          ? Number(args.idleMs)
          : undefined,
      })
      return `Wait completed. Page is now ${result.url} (title: ${result.title || "untitled"}).`
    } catch (err) {
      return toolError(
        "wait_failed",
        err instanceof Error ? err.message : String(err)
      )
    }
  },
}

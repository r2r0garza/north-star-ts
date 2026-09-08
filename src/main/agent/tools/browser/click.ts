import { TOOL_EFFECTS, type Tool, type ToolContext } from "../types"
import type { ToolAction } from "../../approval/types"
import { toolError } from "../output"
import {
  browserActionIdentity,
  browserOrigin,
  classifyBrowserClickTarget,
} from "./approval"

// Click an element in the agent browser, targeted by a `ref` from the most
// recent browser_snapshot. Routes through the approval gate as a `browser`
// action. Clearly reversible clicks stay automatic, but likely commit actions
// (delete, purchase, send, grant, publish, etc.) require distinct approval.
export const browserClickTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "browser_click",
      description:
        "Click an element in the agent browser. Target it with a `ref` from the " +
        'most recent browser_snapshot (e.g. "e3"). If the page changed since ' +
        "your last snapshot, call browser_snapshot again first to get fresh refs. " +
        "Use this to walk through and verify a flow in an app. For setting a " +
        "dropdown/listbox/combobox value, prefer browser_select_option.",
      parameters: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description:
              'The element ref from browser_snapshot output, e.g. "e3".',
          },
        },
        required: ["ref"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    const ref = typeof args.ref === "string" ? args.ref.trim() : ""
    if (!ref) return toolError("bad_args", "A `ref` is required.")
    if (!ctx.browser) {
      return toolError("no_browser", "The agent browser is unavailable.")
    }

    let target = `element ${ref}`
    let targetFingerprint = `ref=${ref}`
    try {
      const described = ctx.browser.describeRef(ref)
      target = described.target
      targetFingerprint = described.targetFingerprint
    } catch (err) {
      return toolError(
        "click_failed",
        err instanceof Error ? err.message : String(err)
      )
    }
    const state = ctx.browser.state()
    const url = state?.url ?? ""
    const origin = browserOrigin(url)
    const interactionKind = classifyBrowserClickTarget(target)

    const action: ToolAction = {
      tool: "browser_click",
      kind: "browser",
      summary: `Click ${target} on ${origin}`,
      identity: browserActionIdentity({
        action: "click",
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
        actionType: "click",
        interactionKind,
      },
    }
    const outcome = ctx.gate ? await ctx.gate(action) : ("denied" as const)
    if (outcome === "blocked") {
      return toolError("blocked", "This click was blocked.")
    }
    if (outcome === "denied") {
      return toolError("denied", "The user denied approval for this click.")
    }

    try {
      const { target, url, title } = await ctx.browser.click(ref)
      return `Clicked ${target}. Page is now ${url} (title: ${title || "untitled"}). Call browser_snapshot to see the current elements.`
    } catch (err) {
      return toolError(
        "click_failed",
        err instanceof Error ? err.message : String(err)
      )
    }
  },
}

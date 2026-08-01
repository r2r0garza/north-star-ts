import type { Tool, ToolContext } from "../types"
import type { ToolAction } from "../../approval/types"
import { toolError } from "../output"

// Click an element in the agent browser, targeted by a `ref` from the most
// recent browser_snapshot. Routes through the approval gate as a `browser`
// action; the classifier auto-allows interactions within an already-opened page
// (only navigation prompts), so this normally runs without a prompt.
export const browserClickTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "browser_click",
      description:
        "Click an element in the agent browser. Target it with a `ref` from the " +
        "most recent browser_snapshot (e.g. \"e3\"). If the page changed since " +
        "your last snapshot, call browser_snapshot again first to get fresh refs. " +
        "Use this to walk through and verify a flow in an app.",
      parameters: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description:
              "The element ref from browser_snapshot output, e.g. \"e3\".",
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

    const action: ToolAction = {
      tool: "browser_click",
      kind: "browser",
      summary: `Click element ${ref} in the browser`,
      identity: `browser_click:${ref}`,
      detail: { ref },
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

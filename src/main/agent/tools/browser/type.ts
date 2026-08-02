import type { Tool, ToolContext } from "../types"
import type { ToolAction } from "../../approval/types"
import { toolError } from "../output"

// Type text into an element (input, textarea, search box) in the agent browser,
// targeted by a `ref` from the most recent browser_snapshot. Optionally presses
// Enter afterward to submit. Gated as a `browser` interaction (auto-allowed;
// only navigation prompts).
export const browserTypeTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "browser_type",
      description:
        "Type text into a form field in the agent browser. Target it with a " +
        "`ref` from the most recent browser_snapshot (e.g. \"e5\"). Set `submit` " +
        "true to press Enter after typing (e.g. to submit a search or form). If " +
        "the page changed since your last snapshot, call browser_snapshot again " +
        "first to get fresh refs.",
      parameters: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description:
              "The element ref from browser_snapshot output, e.g. \"e5\".",
          },
          text: { type: "string", description: "The text to type." },
          submit: {
            type: "boolean",
            description:
              "Press Enter after typing (submit the field). Defaults to false.",
          },
        },
        required: ["ref", "text"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    const ref = typeof args.ref === "string" ? args.ref.trim() : ""
    if (!ref) return toolError("bad_args", "A `ref` is required.")
    const text = typeof args.text === "string" ? args.text : ""
    const submit = args.submit === true
    if (!ctx.browser) {
      return toolError("no_browser", "The agent browser is unavailable.")
    }

    const action: ToolAction = {
      tool: "browser_type",
      kind: "browser",
      summary: `Type into element ${ref} in the browser`,
      identity: `browser_type:${ref}`,
      detail: { ref, submit },
    }
    const outcome = ctx.gate ? await ctx.gate(action) : ("denied" as const)
    if (outcome === "blocked") {
      return toolError("blocked", "This action was blocked.")
    }
    if (outcome === "denied") {
      return toolError("denied", "The user denied approval for this action.")
    }

    try {
      const { target, url, title } = await ctx.browser.type(ref, text, submit)
      const submitted = submit ? " and submitted" : ""
      return `Typed into ${target}${submitted}. Page is now ${url} (title: ${title || "untitled"}). Call browser_snapshot to see the current elements.`
    } catch (err) {
      return toolError(
        "type_failed",
        err instanceof Error ? err.message : String(err)
      )
    }
  },
}

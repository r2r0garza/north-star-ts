import { TOOL_EFFECTS, type Tool, type ToolContext } from "../types"
import type { ToolAction } from "../../approval/types"
import { toolError } from "../output"
import {
  browserActionIdentity,
  browserOrigin,
  hashBrowserPayload,
  summarizeBrowserPayload,
} from "./approval"

export const browserSelectOptionTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "browser_select_option",
      description:
        "Select an option from a native select, combobox, or listbox in the " +
        "agent browser. Target the selection control with a `ref` from the most " +
        'recent browser_snapshot (e.g. "e8") and provide the visible option ' +
        "label exactly. This tool verifies the committed value and never types " +
        "into the page's current focus as a fallback.",
      parameters: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description:
              'The selection control ref from browser_snapshot output, e.g. "e8".',
          },
          option: {
            type: "string",
            description:
              "The exact visible/accessibility label of the option to choose.",
          },
        },
        required: ["ref", "option"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    const ref = typeof args.ref === "string" ? args.ref.trim() : ""
    const option = typeof args.option === "string" ? args.option.trim() : ""
    if (!ref) return toolError("bad_args", "A `ref` is required.")
    if (!option)
      return toolError("bad_args", "A non-empty `option` is required.")
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
        "select_option_failed",
        err instanceof Error ? err.message : String(err)
      )
    }

    const state = ctx.browser.state()
    const url = state?.url ?? ""
    const origin = browserOrigin(url)
    const optionSummary = summarizeBrowserPayload(option)
    const optionHash = hashBrowserPayload(option)

    const action: ToolAction = {
      tool: "browser_select_option",
      kind: "browser",
      summary: `Select ${optionSummary} in ${target} on ${origin}`,
      identity: browserActionIdentity({
        action: "select_option",
        url,
        origin,
        target,
        ref,
        targetFingerprint,
        payloadHash: optionHash,
      }),
      detail: {
        ref,
        target,
        url,
        origin,
        optionSummary,
        actionType: "select_option",
        interactionKind: "consequential_commit",
      },
    }
    const outcome = ctx.gate ? await ctx.gate(action) : ("denied" as const)
    if (outcome === "blocked") {
      return toolError("blocked", "This selection was blocked.")
    }
    if (outcome === "denied") {
      return toolError("denied", "The user denied approval for this selection.")
    }

    try {
      const result = await ctx.browser.selectOption(ref, option)
      const value = result.value ? ` (value: ${result.value})` : ""
      return `Selected "${result.option}" in ${result.target}${value}. Page is now ${result.url} (title: ${result.title || "untitled"}). Call browser_snapshot to see the current elements.`
    } catch (err) {
      return toolError(
        "select_option_failed",
        err instanceof Error ? err.message : String(err)
      )
    }
  },
}

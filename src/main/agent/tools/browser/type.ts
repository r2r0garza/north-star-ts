import { TOOL_EFFECTS, type Tool, type ToolContext } from "../types"
import type { ToolAction } from "../../approval/types"
import { toolError } from "../output"
import {
  browserActionIdentity,
  browserOrigin,
  hashBrowserPayload,
  summarizeBrowserPayload,
} from "./approval"

// Type text into an editable text element in the agent browser, targeted by a
// `ref` from the most recent browser_snapshot. Dropdown values belong to
// browser_select_option instead.
export const browserTypeTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "browser_type",
      description:
        "Type text into an editable text field in the agent browser. Target it with a " +
        '`ref` from the most recent browser_snapshot (e.g. "e5"). Set `submit` ' +
        "true to press Enter after typing (e.g. to submit a search or form). If " +
        "the page changed since your last snapshot, call browser_snapshot again " +
        "first to get fresh refs. For dropdown/listbox/combobox choices, use " +
        "browser_select_option instead.",
      parameters: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description:
              'The element ref from browser_snapshot output, e.g. "e5".',
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

    let target = `element ${ref}`
    let targetFingerprint = `ref=${ref}`
    try {
      const described = ctx.browser.describeRef(ref)
      target = described.target
      targetFingerprint = described.targetFingerprint
    } catch (err) {
      return toolError(
        "type_failed",
        err instanceof Error ? err.message : String(err)
      )
    }
    const state = ctx.browser.state()
    const url = state?.url ?? ""
    const origin = browserOrigin(url)
    const payloadSummary = summarizeBrowserPayload(text)
    const interactionKind = submit
      ? "consequential_commit"
      : "reversible_interaction"

    const action: ToolAction = {
      tool: "browser_type",
      kind: "browser",
      summary: submit
        ? `Type into ${target} on ${origin} and submit`
        : `Type into ${target} on ${origin}`,
      identity: browserActionIdentity({
        action: submit ? "type_submit" : "type",
        url,
        origin,
        target,
        ref,
        targetFingerprint,
        payloadHash: submit ? hashBrowserPayload(text) : undefined,
      }),
      detail: {
        ref,
        target,
        url,
        origin,
        submit,
        actionType: submit ? "type_submit" : "type",
        interactionKind,
        payloadSummary,
      },
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

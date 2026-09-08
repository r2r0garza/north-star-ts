import { TOOL_EFFECTS, type Tool, type ToolContext } from "../types"
import type { ToolAction } from "../../approval/types"
import { toolError } from "../output"
import { browserActionIdentity, browserOrigin } from "./approval"

export const browserHandleDialogTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "browser_handle_dialog",
      description:
        "Inspect or handle a pending JavaScript alert/confirm/prompt in the current browser tab. Use action=inspect to read it.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["inspect", "accept", "dismiss"],
          },
          promptText: {
            type: "string",
            description: "Optional text for prompt dialogs when accepting.",
          },
        },
        required: ["action"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    const action = typeof args.action === "string" ? args.action : ""
    if (!["inspect", "accept", "dismiss"].includes(action)) {
      return toolError(
        "bad_args",
        "`action` must be inspect, accept, or dismiss."
      )
    }
    if (!ctx.browser)
      return toolError("no_browser", "The agent browser is unavailable.")
    const dialog = ctx.browser.dialog()
    if (action === "inspect") {
      return dialog
        ? JSON.stringify(dialog, null, 2)
        : "No browser dialog is pending."
    }
    if (!dialog)
      return toolError("dialog_failed", "No browser dialog is pending.")

    const url = ctx.browser.state()?.url ?? dialog.url
    const origin = browserOrigin(url)
    const target = `${dialog.type} dialog`
    const toolAction: ToolAction = {
      tool: "browser_handle_dialog",
      kind: "browser",
      summary: `${action} ${target} on ${origin}`,
      identity: browserActionIdentity({
        action: "dialog",
        url,
        origin,
        target,
        targetFingerprint: `${dialog.type}:${dialog.message}`,
      }),
      detail: {
        action,
        dialogType: dialog.type,
        message: dialog.message,
        url,
        origin,
        actionType: "dialog",
        interactionKind: "consequential_commit",
      },
    }
    const outcome = ctx.gate ? await ctx.gate(toolAction) : ("denied" as const)
    if (outcome === "blocked")
      return toolError("blocked", "This dialog action was blocked.")
    if (outcome === "denied")
      return toolError(
        "denied",
        "The user denied approval for this dialog action."
      )
    try {
      const result = await ctx.browser.handleDialog(
        action as "accept" | "dismiss",
        typeof args.promptText === "string" ? args.promptText : undefined
      )
      return `Handled ${target}. Page is now ${result.url} (title: ${result.title || "untitled"}).`
    } catch (err) {
      return toolError(
        "dialog_failed",
        err instanceof Error ? err.message : String(err)
      )
    }
  },
}

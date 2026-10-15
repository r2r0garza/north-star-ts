import { TOOL_EFFECTS, type Tool, type ToolContext } from "../types"
import type { ToolAction } from "../../approval/types"
import { toolError } from "../output"
import { PRESSABLE_KEYS, parseKeyCombo } from "../../../browser/session"
import { browserFailure } from "./errors"
import { browserActionIdentity, browserOrigin } from "./approval"

// Keyboard-only use (plan 110): press a key at whatever has focus, the way a
// user without a pointer moves (Tab) and acts (Enter, Space). Enter and Space
// can submit a form or activate a button, so they're consequential like a
// click; moving focus isn't.
export const browserPressKeyTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "browser_press_key",
      description:
        "Press a key in the agent browser at whatever currently has focus, optionally with modifiers " +
        '(e.g. "Tab", "Shift+Tab", "Enter", "Space", "Escape", "ArrowDown"). Use it to test keyboard-only ' +
        "use: Tab through controls, then Enter or Space to activate them. The result names the element " +
        "that has focus afterwards and whether it shows a visible focus indicator.",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: `The key, optionally with modifiers joined by "+": ${PRESSABLE_KEYS}. Modifiers: Shift, Ctrl, Alt, Meta.`,
          },
        },
        required: ["key"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    const key = typeof args.key === "string" ? args.key.trim() : ""
    if (!key) return toolError("bad_args", "A `key` is required.")
    let parsed: ReturnType<typeof parseKeyCombo>
    try {
      parsed = parseKeyCombo(key)
    } catch (err) {
      return toolError(
        "bad_args",
        err instanceof Error ? err.message : String(err)
      )
    }
    if (!ctx.browser)
      return toolError("no_browser", "The agent browser is unavailable.")
    const url = ctx.browser.state()?.url ?? ""
    const origin = browserOrigin(url)
    const commits = parsed.key === "Enter" || parsed.key === " "
    const action: ToolAction = {
      tool: "browser_press_key",
      kind: "browser",
      summary: `Press ${key} on ${origin}`,
      identity: browserActionIdentity({
        action: "press_key",
        url,
        origin,
        target: key,
        ref: "",
        targetFingerprint: `key=${key}`,
      }),
      detail: {
        key,
        url,
        origin,
        actionType: "press_key",
        interactionKind: commits
          ? "consequential_commit"
          : "reversible_interaction",
      },
    }
    const outcome = ctx.gate ? await ctx.gate(action) : ("denied" as const)
    if (outcome === "blocked")
      return toolError("blocked", "This key press was blocked.")
    if (outcome === "denied")
      return toolError("denied", "The user denied approval for this key press.")
    try {
      const { url, title, focused } = await ctx.browser.pressKey(key)
      return `Pressed ${key}. Focus is now on ${focused}. Page is ${url} (title: ${title || "untitled"}).`
    } catch (err) {
      return browserFailure("press_key_failed", err)
    }
  },
}

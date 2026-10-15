import { TOOL_EFFECTS, type Tool, type ToolContext } from "../types"
import type { ToolAction } from "../../approval/types"
import { toolError } from "../output"
import { browserFailure } from "./errors"
import { browserActionIdentity, browserOrigin } from "./approval"

const MIN = 200
const MAX = 4000

// Responsive layout (plan 110): emulate a viewport size for this tab, as
// device emulation does (window.resizeTo can't resize a tab). Reports whether
// the page then overflows horizontally.
export const browserSetViewportTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "browser_set_viewport",
      description:
        "Set the agent browser's viewport to a width and height in CSS pixels (e.g. 375 × 812 for a phone, " +
        "768 × 1024 for a tablet, 1280 × 800 for a laptop) to check responsive layout, or pass 0 × 0 to restore " +
        "the real size. The page re-lays out at that size; the result says whether it overflows horizontally. " +
        "Take a browser_screenshot afterwards for evidence.",
      parameters: {
        type: "object",
        properties: {
          width: {
            type: "number",
            description: `Viewport width in CSS pixels (${MIN}–${MAX}), or 0 to restore.`,
          },
          height: {
            type: "number",
            description: `Viewport height in CSS pixels (${MIN}–${MAX}), or 0 to restore.`,
          },
        },
        required: ["width", "height"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    const width = typeof args.width === "number" ? Math.round(args.width) : NaN
    const height =
      typeof args.height === "number" ? Math.round(args.height) : NaN
    const restore = width === 0 && height === 0
    const inRange = (n: number) => n >= MIN && n <= MAX
    if (!restore && !(inRange(width) && inRange(height)))
      return toolError(
        "bad_args",
        `Give a width and height between ${MIN} and ${MAX} CSS pixels, or 0 × 0 to restore the real size.`
      )
    if (!ctx.browser)
      return toolError("no_browser", "The agent browser is unavailable.")
    const url = ctx.browser.state()?.url ?? ""
    const origin = browserOrigin(url)
    const size = restore ? "the real size" : `${width} × ${height}`
    const action: ToolAction = {
      tool: "browser_set_viewport",
      kind: "browser",
      summary: `Set the viewport to ${size} on ${origin}`,
      identity: browserActionIdentity({
        action: "set_viewport",
        url,
        origin,
        target: size,
        ref: "",
        targetFingerprint: `viewport=${width}x${height}`,
      }),
      detail: {
        width,
        height,
        url,
        origin,
        actionType: "set_viewport",
        interactionKind: "reversible_interaction",
      },
    }
    const outcome = ctx.gate ? await ctx.gate(action) : ("denied" as const)
    if (outcome === "blocked")
      return toolError("blocked", "This viewport change was blocked.")
    if (outcome === "denied")
      return toolError(
        "denied",
        "The user denied approval for this viewport change."
      )
    try {
      const result = await ctx.browser.setViewport(width, height)
      return restore
        ? `Restored the real viewport (${result.innerWidth}px wide).`
        : `Viewport is ${width} × ${height}. The page is ${result.scrollWidth}px wide in a ${result.innerWidth}px viewport: ${result.overflowsHorizontally ? "it overflows horizontally" : "no horizontal overflow"}.`
    } catch (err) {
      return browserFailure("set_viewport_failed", err)
    }
  },
}

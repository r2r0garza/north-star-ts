import { TOOL_EFFECTS, type Tool, type ToolContext } from "../types"
import { toolError } from "../output"

// Capture the current page as an image for the vision model. The tool result
// itself is text (results are persisted/replayed as strings), so the image is
// handed to the loop via ctx.emitImage, which injects it as a follow-up user
// message with an image content part. Not gated (observation, not a side effect).
export const browserScreenshotTool: Tool = {
  effects: TOOL_EFFECTS.openWorldRead,
  definition: {
    type: "function",
    function: {
      name: "browser_screenshot",
      description:
        "Take a screenshot of the current page in the agent browser and see it. " +
        "Use this to visually verify layout, styling, or that a UI looks right — " +
        "when the accessibility outline from browser_snapshot isn't enough. Call " +
        "browser_navigate first to open a page.",
      parameters: { type: "object", properties: {} },
    },
  },
  execute: async (_args: Record<string, unknown>, ctx: ToolContext) => {
    if (!ctx.browser) {
      return toolError("no_browser", "The agent browser is unavailable.")
    }
    try {
      const { jpeg, width, height } = await ctx.browser.screenshot()
      if (ctx.emitImage) {
        ctx.emitImage({
          jpegBase64: jpeg.toString("base64"),
          alt: "Screenshot of the current browser page",
        })
        return `Screenshot captured (${width}×${height}); it is attached below.`
      }
      // No image channel (e.g. a headless context): report the capture so the
      // model still knows the page rendered, even without the pixels.
      return `Screenshot captured (${width}×${height}), but this context can't display images to you. Use browser_snapshot to read the page instead.`
    } catch (err) {
      return toolError(
        "screenshot_failed",
        err instanceof Error ? err.message : String(err)
      )
    }
  },
}

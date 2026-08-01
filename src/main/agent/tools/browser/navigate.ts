import type { Tool, ToolContext } from "../types"
import type { ToolAction } from "../../approval/types"
import { toolError } from "../output"

// Navigate the agent's browser to a URL. This is a real network side effect
// (fetches an arbitrary origin), so it routes through the approval gate. Reading
// the page afterwards (browser_snapshot / browser_screenshot) is not gated.
export const browserNavigateTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "browser_navigate",
      description:
        "Open a URL in the agent browser — a real, visible browser window the " +
        "user may be watching. Use it to view an artifact you created or to open " +
        "an app you built so you can verify its behavior. After navigating, call " +
        "browser_snapshot to read the page or browser_screenshot to see it. " +
        "Navigating prompts the user for approval; reading the page does not.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "Absolute URL to open (e.g. http://localhost:3000 or a file:// URL).",
          },
        },
        required: ["url"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    const url = typeof args.url === "string" ? args.url.trim() : ""
    if (!url) return toolError("bad_args", "A `url` is required.")
    if (!ctx.browser) {
      return toolError("no_browser", "The agent browser is unavailable.")
    }

    const action: ToolAction = {
      tool: "browser_navigate",
      kind: "browser",
      summary: `Open ${url} in the browser`,
      identity: `browser_navigate:${url}`,
      detail: { url },
    }
    // Fail-closed like the other gated tools: no gate wired ⇒ treat as denied.
    const outcome = ctx.gate ? await ctx.gate(action) : ("denied" as const)
    if (outcome === "blocked") {
      return toolError("blocked", "Navigating to this URL was blocked.")
    }
    if (outcome === "denied") {
      return toolError("denied", "The user denied approval to open this URL.")
    }

    try {
      const { url: finalUrl, title } = await ctx.browser.navigate(url)
      return `Opened ${finalUrl} (title: ${title || "untitled"}). Use browser_snapshot to read the page or browser_screenshot to see it.`
    } catch (err) {
      return toolError(
        "navigation_failed",
        err instanceof Error ? err.message : String(err)
      )
    }
  },
}

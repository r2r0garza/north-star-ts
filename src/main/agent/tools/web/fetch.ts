import { TOOL_EFFECTS, type Tool, type ToolContext } from "../types"
import type { ToolAction } from "../../approval/types"
import { toolError, truncateForModel } from "../output"
import { extractReadable } from "./extract"
import { safeFetch } from "./safe-fetch"

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"

// Fetch a web page headlessly (no visible browser) and return its main content
// as clean markdown. This makes a real network request to an ARBITRARY origin —
// a genuine side effect — so, like browser_navigate, it routes through the
// approval gate (auto-approved in Auto mode; grant "once" or "for this session"
// in Default mode). To DISCOVER pages, use web_search (which is not gated).
export const webFetchTool: Tool = {
  effects: TOOL_EFFECTS.openWorldRead,
  definition: {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch a web page by URL and read its main content as clean text/markdown " +
        "— without opening the visible browser. Use after web_search to read a " +
        "result in depth, or on any known URL. Only http(s) pages are supported " +
        "(not file:// or local dev servers — use the browser for those). The user " +
        "approves each fetch; issue the call rather than declining on your own.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Absolute http(s) URL to fetch.",
          },
        },
        required: ["url"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    const raw = typeof args.url === "string" ? args.url.trim() : ""
    if (!raw) return toolError("bad_args", "A `url` is required.")

    // Only allow http(s). file://, data:, localhost dev servers, etc. are the
    // visible browser's job — this tool is for public web pages.
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      return toolError("bad_args", `Not a valid URL: ${raw}`)
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return toolError(
        "unsupported_scheme",
        `Only http(s) URLs are supported (got ${parsed.protocol}).`,
        "Use the agent browser for file:// or local URLs."
      )
    }

    // Gate the fetch — arbitrary-origin network access, like browser_navigate.
    const action: ToolAction = {
      tool: "web_fetch",
      kind: "web",
      summary: `Fetch ${parsed.href}`,
      identity: `web_fetch:${parsed.href}`,
      detail: { url: parsed.href },
    }
    // Fail-closed like the other gated tools: no gate wired ⇒ treat as denied.
    const outcome = ctx.gate ? await ctx.gate(action) : ("denied" as const)
    if (outcome === "blocked") {
      return toolError("blocked", "Fetching this URL was blocked.")
    }
    if (outcome === "denied") {
      return toolError("denied", "The user denied approval to fetch this URL.")
    }

    try {
      const res = await safeFetch(parsed.href, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
        signal: ctx.signal,
      })
      if (!res.ok) {
        return toolError(
          "http_error",
          `HTTP ${res.status} fetching ${parsed.href}`
        )
      }
      const contentType = res.headers.get("content-type") ?? ""
      const text = await res.text()

      // Non-HTML (JSON, plain text, etc.): return the body as-is (truncated).
      if (!contentType.includes("html")) {
        return truncateForModel(
          `Fetched ${parsed.href} (${contentType || "unknown type"}):\n\n${text}`
        ).text
      }

      const { title, markdown } = extractReadable(text)
      if (!markdown) {
        return `Fetched ${parsed.href}${
          title ? ` (title: ${title})` : ""
        }, but no readable text content was found.`
      }
      const header = `# ${title || parsed.href}\nSource: ${parsed.href}\n\n`
      return truncateForModel(header + markdown).text
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return toolError("aborted", "The fetch was cancelled.")
      }
      return toolError(
        "fetch_failed",
        err instanceof Error ? err.message : String(err)
      )
    }
  },
}

import { TOOL_EFFECTS, type Tool, type ToolContext } from "../types"
import { toolError, truncateForModel } from "../output"
import { renderContextEnvelope } from "../../context/provenance"
import { extractReadable } from "./extract"
import {
  SafeFetchBodyTooLargeError,
  SafeFetchCrossOriginRedirectError,
  SafeFetchTimeoutError,
  safeFetchText,
} from "./safe-fetch"
import { webFetchAction } from "./approval"

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
const FETCH_TIMEOUT_MS = 30_000
const MAX_FETCH_BODY_BYTES = 2 * 1024 * 1024

// Fetch a web page headlessly (no visible browser) and return its main content
// as clean markdown. This makes a real network request to an ARBITRARY origin —
// a genuine side effect — so, like browser_navigate, it routes through the
// approval gate (auto-approved in Auto mode; grant once or per-origin for the
// conversation in Default/Plan mode). To DISCOVER pages, use web_search.
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
        "approves each new origin; issue the call rather than declining on your own.",
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

    // Gate by normalized origin. A conversation-scoped approval therefore covers
    // subsequent paths on this exact scheme + host + effective port, while
    // approve-once still authorizes only this execution.
    let current = parsed
    for (let redirects = 0; ; redirects++) {
      const outcome = ctx.gate
        ? await ctx.gate(webFetchAction(current))
        : ("denied" as const)
      if (outcome === "blocked") {
        return toolError("blocked", `Fetching ${current.href} was blocked.`)
      }
      if (outcome === "denied") {
        return toolError(
          "denied",
          `The user denied approval to fetch ${current.href}.`
        )
      }

      try {
        const { response: res, text } = await safeFetchText(current.href, {
          headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
          signal: ctx.signal,
          stopAtCrossOriginRedirect: true,
          timeoutMs: FETCH_TIMEOUT_MS,
          maxBodyBytes: MAX_FETCH_BODY_BYTES,
        })
        if (!res.ok) {
          return toolError(
            "http_error",
            `HTTP ${res.status} fetching ${current.href}`
          )
        }
        const contentType = res.headers.get("content-type") ?? ""

        // Non-HTML (JSON, plain text, etc.): return the body as-is (truncated).
        if (!contentType.includes("html")) {
          const body = truncateForModel(
            `Fetched ${current.href} (${contentType || "unknown type"}):\n\n${text}`
          ).text
          return renderContextEnvelope(
            { trust: "untrusted_data", channel: "web", source: current.href },
            body
          )
        }

        const { title, markdown } = extractReadable(text)
        if (!markdown) {
          return `Fetched ${current.href}${
            title ? ` (title: ${title})` : ""
          }, but no readable text content was found.`
        }
        const header = `# ${title || current.href}\nSource: ${current.href}\n\n`
        return renderContextEnvelope(
          { trust: "untrusted_data", channel: "web", source: current.href },
          truncateForModel(header + markdown).text
        )
      } catch (err) {
        if (err instanceof SafeFetchCrossOriginRedirectError) {
          if (redirects >= 10) {
            return toolError("fetch_failed", "Too many cross-origin redirects.")
          }
          current = err.url
          continue
        }
        if (err instanceof SafeFetchTimeoutError) {
          return toolError("timeout", err.message)
        }
        if (err instanceof SafeFetchBodyTooLargeError) {
          return toolError("response_too_large", err.message)
        }
        if (err instanceof Error && err.name === "AbortError") {
          return toolError("aborted", "The fetch was cancelled.")
        }
        return toolError(
          "fetch_failed",
          err instanceof Error ? err.message : String(err)
        )
      }
    }
  },
}

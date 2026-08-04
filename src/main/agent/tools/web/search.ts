import type { Tool, ToolContext } from "../types"
import { toolError, truncateForModel } from "../output"
import {
  DuckDuckGoProvider,
  type WebSearchProvider,
} from "./providers"

// The active search provider. A single default (DuckDuckGo) for now; swap or
// make configurable later without touching the tool below.
const provider: WebSearchProvider = new DuckDuckGoProvider()

// How many results to return by default / at most. Bounded so a search can't
// flood the model's context.
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10

// Search the web (headless — no visible browser). Read-only from the user's
// machine's perspective: it only hits the configured, trusted search provider,
// so — like file reads and browser interactions — it builds NO ToolAction and is
// never gated. (Reading a specific arbitrary page IS gated: see web_fetch.)
export const webSearchTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web and get back a ranked list of results (title, URL, and " +
        "a short snippet) — without opening the visible browser. Use this to find " +
        "current information, documentation, or pages relevant to a query. To read " +
        "the full contents of a specific result, follow up with web_fetch on its URL.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query.",
          },
          limit: {
            type: "number",
            description: `Max results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
          },
        },
        required: ["query"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    const query = typeof args.query === "string" ? args.query.trim() : ""
    if (!query) return toolError("bad_args", "A `query` is required.")
    const limit = clampLimit(args.limit)

    try {
      const results = await provider.search(query, {
        limit,
        signal: ctx.signal,
      })
      if (results.length === 0) {
        return `No results found for "${query}".`
      }
      const formatted = results
        .map(
          (r, i) =>
            `${i + 1}. ${r.title}\n   ${r.url}${
              r.snippet ? `\n   ${r.snippet}` : ""
            }`
        )
        .join("\n\n")
      return truncateForModel(
        `Search results for "${query}":\n\n${formatted}`
      ).text
    } catch (err) {
      // Aborted (Stop/timeout) surfaces as an AbortError — report it plainly.
      if (err instanceof Error && err.name === "AbortError") {
        return toolError("aborted", "The search was cancelled.")
      }
      return toolError(
        "search_failed",
        err instanceof Error ? err.message : String(err),
        "The search provider may be rate-limiting or unavailable; try again or rephrase."
      )
    }
  },
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" ? Math.floor(raw) : DEFAULT_LIMIT
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(n, MAX_LIMIT)
}

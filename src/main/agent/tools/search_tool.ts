import { relative } from "path"
import type { Tool } from "./types"
import { LocalEnvironment } from "../env/local"
import { truncateForModel, toolError } from "./output"

// Directories never worth searching. Keeps the walk fast and the results clean.
const SKIP_DIRS = [".git", "node_modules", "dist", "out", ".cache"]

// Don't read files larger than this when scanning for matches.
const MAX_FILE_BYTES = 1024 * 1024 // 1 MB

// Searches file contents under the workspace for a regex pattern. The actual scan
// is a first-class Environment operation (env.search): Local does a Node/fs walk,
// Container runs one in-container rg/grep — a per-file walk there would be
// hundreds of slow exec round-trips. Returns `relpath:line: text` hits, bounded
// by max_results and truncated so large result sets can't blow the context window.
export const searchTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "search_tool",
      description:
        "Search file contents under the workspace for a regular-expression " +
        "pattern. Returns matching lines as `path:line: text`.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "JavaScript regular expression to match against each line.",
          },
          path: {
            type: "string",
            description:
              "Subdirectory to search within, relative to the workspace root. " +
              "Defaults to the whole workspace.",
          },
          glob: {
            type: "string",
            description:
              "Optional case-insensitive substring or extension filter on file " +
              "names (e.g. \".ts\"). Only matching files are searched.",
          },
          max_results: {
            type: "integer",
            description: "Maximum number of matching lines to return. Defaults to 100.",
          },
        },
        required: ["pattern"],
      },
    },
  },
  execute: async (args, ctx) => {
    const pattern = typeof args.pattern === "string" ? args.pattern : ""
    if (!pattern) return toolError("bad_args", "A `pattern` is required.")

    try {
      new RegExp(pattern)
    } catch (err) {
      return toolError(
        "bad_regex",
        `Invalid regular expression: ${err instanceof Error ? err.message : pattern}`
      )
    }

    const env = ctx.env ?? new LocalEnvironment(ctx.workspace)
    const sub = typeof args.path === "string" ? args.path : ""
    const root = await env.resolve(sub)
    // Display hits relative to the workspace root (resolved in the env's own
    // filesystem view), so the path reads identically whether matches come back
    // as host paths or in-container paths under the bind mount.
    const displayRoot = await env.resolve("")
    const glob =
      typeof args.glob === "string" && args.glob ? args.glob.toLowerCase() : ""
    const maxResults =
      typeof args.max_results === "number" && args.max_results > 0
        ? Math.floor(args.max_results)
        : 100

    const { matches, capped } = await env.search({
      root,
      pattern,
      glob: glob || undefined,
      maxResults,
      skipDirs: SKIP_DIRS,
      maxFileBytes: MAX_FILE_BYTES,
    })

    if (matches.length === 0) {
      return `No matches for /${pattern}/.`
    }
    let out = matches
      .map((m) => `${relative(displayRoot, m.path)}:${m.line}: ${m.text}`)
      .join("\n")
    if (capped) {
      out += `\n[stopped at ${maxResults} matches — narrow the pattern or path for more]`
    }
    return truncateForModel(out).text
  },
}

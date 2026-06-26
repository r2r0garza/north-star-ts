import { readdir, readFile, stat } from "fs/promises"
import { join, relative } from "path"
import type { Tool } from "./types"
import { resolveInWorkspaceReal } from "./workspace"
import { truncateForModel, toolError } from "./output"

// Directories never worth searching. Keeps the walk fast and the results clean.
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "out", ".cache"])

// Don't read files larger than this when scanning for matches.
const MAX_FILE_BYTES = 1024 * 1024 // 1 MB

// Searches file contents under the workspace for a regex pattern (pure Node, no
// shell, no ripgrep dependency). Returns `relpath:line: text` hits, bounded by
// max_results and truncated so large result sets can't blow the context window.
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

    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch (err) {
      return toolError(
        "bad_regex",
        `Invalid regular expression: ${err instanceof Error ? err.message : pattern}`
      )
    }

    const sub = typeof args.path === "string" ? args.path : ""
    const root = await resolveInWorkspaceReal(ctx.workspace, sub)
    const glob =
      typeof args.glob === "string" && args.glob ? args.glob.toLowerCase() : ""
    const maxResults =
      typeof args.max_results === "number" && args.max_results > 0
        ? Math.floor(args.max_results)
        : 100

    const hits: string[] = []
    let capped = false

    const walk = async (dir: string): Promise<void> => {
      if (capped) return
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return // unreadable dir — skip rather than fail the whole search
      }
      for (const entry of entries) {
        if (capped) return
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue
          await walk(full)
          continue
        }
        if (!entry.isFile()) continue
        if (glob && !entry.name.toLowerCase().includes(glob)) continue

        try {
          const info = await stat(full)
          if (info.size > MAX_FILE_BYTES) continue
          const buf = await readFile(full)
          if (buf.subarray(0, 8000).includes(0)) continue // binary
          const lines = buf.toString("utf8").split("\n")
          const rel = relative(ctx.workspace, full)
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              hits.push(`${rel}:${i + 1}: ${lines[i].trim()}`)
              if (hits.length >= maxResults) {
                capped = true
                return
              }
            }
          }
        } catch {
          // Unreadable file — skip.
        }
      }
    }

    await walk(root)

    if (hits.length === 0) {
      return `No matches for /${pattern}/.`
    }
    let out = hits.join("\n")
    if (capped) {
      out += `\n[stopped at ${maxResults} matches — narrow the pattern or path for more]`
    }
    return truncateForModel(out).text
  },
}

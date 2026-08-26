import { TOOL_EFFECTS, type Tool } from "./types"
import { LocalEnvironment } from "../env/local"
import { legacyGlobToRipgrepGlob } from "../env/ripgrep"
import { truncateForModel, toolError } from "./output"
import type {
  SearchCase,
  SearchMode,
  SearchResult,
  SearchResultMode,
} from "../env/types"

const MAX_FILE_BYTES = 1024 * 1024 // 1 MB
const MAX_RESULTS_CAP = 500
const MAX_CONTEXT_LINES = 5

// Searches file contents under the workspace through Environment.search. Local
// uses packaged ripgrep; containers use in-container rg or an explicit reduced
// fallback when rg is absent. Patterns and globs are passed as argv data.
export const searchTool: Tool = {
  effects: TOOL_EFFECTS.readOnlyParallel,
  definition: {
    type: "function",
    function: {
      name: "search_tool",
      description:
        "Search file contents under the workspace. Supports fixed or regex " +
        "queries, smart case, real include/exclude globs, context, files, and counts.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Text or regex to search for.",
          },
          pattern: {
            type: "string",
            description: "Deprecated alias for query. Prefer query.",
          },
          mode: {
            type: "string",
            enum: ["fixed", "regex"],
            description: "Search mode. Defaults to fixed.",
          },
          case: {
            type: "string",
            enum: ["smart", "sensitive", "insensitive"],
            description: "Case matching. Defaults to smart.",
          },
          path: {
            type: "string",
            description:
              "Subdirectory to search within, relative to the workspace root. " +
              "Defaults to the whole workspace.",
          },
          globs: {
            type: "array",
            items: { type: "string" },
            description:
              'Ripgrep include/exclude globs, e.g. ["*.ts", "!dist/**"].',
          },
          glob: {
            type: "string",
            description:
              'Deprecated single glob/substring filter, e.g. ".ts". Prefer globs.',
          },
          result: {
            type: "string",
            enum: ["content", "files", "count"],
            description:
              "Result shape: matching lines, matching files, or per-file counts. Defaults to content.",
          },
          before_context: {
            type: "integer",
            description: "Lines of context before each match. Capped at 5.",
          },
          after_context: {
            type: "integer",
            description: "Lines of context after each match. Capped at 5.",
          },
          include_hidden: {
            type: "boolean",
            description:
              "Include hidden files and directories. Defaults to false.",
          },
          respect_ignore: {
            type: "boolean",
            description: "Respect .gitignore/.ignore rules. Defaults to true.",
          },
          max_results: {
            type: "integer",
            description:
              "Maximum number of result items to return. Server-capped at 500.",
          },
        },
        required: [],
      },
    },
  },
  execute: async (args, ctx) => {
    const query =
      typeof args.query === "string"
        ? args.query
        : typeof args.pattern === "string"
          ? args.pattern
          : ""
    if (!query) return toolError("bad_args", "A `query` is required.")

    const mode = enumArg<SearchMode>(args.mode, ["fixed", "regex"], "fixed")
    const caseMode = enumArg<SearchCase>(
      args.case,
      ["smart", "sensitive", "insensitive"],
      "smart"
    )
    const result = enumArg<SearchResultMode>(
      args.result,
      ["content", "files", "count"],
      "content"
    )
    const beforeContext = boundedInt(
      args.before_context,
      0,
      MAX_CONTEXT_LINES,
      0
    )
    const afterContext = boundedInt(args.after_context, 0, MAX_CONTEXT_LINES, 0)
    const maxResults = boundedInt(args.max_results, 1, MAX_RESULTS_CAP, 100)
    const includeHidden = args.include_hidden === true
    const respectIgnore = args.respect_ignore !== false

    const env = ctx.env ?? new LocalEnvironment(ctx.workspace)
    const sub = typeof args.path === "string" ? args.path : ""
    const root = await env.resolve(sub)
    const displayRoot = await env.resolve("")
    const globs = normalizeGlobs(args)

    try {
      const search = await env.search({
        root,
        query,
        mode,
        case: caseMode,
        globs,
        result,
        beforeContext,
        afterContext,
        includeHidden,
        respectIgnore,
        maxResults,
        maxFileBytes: MAX_FILE_BYTES,
        signal: ctx.signal,
      })

      const body = renderSearchResult(search, displayRoot, query, maxResults)
      return truncateForModel(body, {
        recoveryHint: recoveryHint(result),
        metadata: {
          engine: search.engine,
          result,
          capped: search.capped,
          reducedFeatures: search.reducedFeatures,
        },
      }).text
    } catch (err) {
      if (mode === "regex") {
        return toolError(
          "bad_regex",
          `Invalid regular expression or regex engine error: ${
            err instanceof Error ? err.message : query
          }`
        )
      }
      throw err
    }
  },
}

function normalizeGlobs(args: Record<string, unknown>): string[] {
  const globs = Array.isArray(args.globs)
    ? args.globs.filter(
        (g): g is string => typeof g === "string" && g.length > 0
      )
    : []
  if (typeof args.glob === "string" && args.glob.length > 0) {
    globs.push(legacyGlobToRipgrepGlob(args.glob))
  }
  return globs
}

function enumArg<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return typeof value === "string" && allowed.includes(value as T)
    ? (value as T)
    : fallback
}

function boundedInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function renderSearchResult(
  search: SearchResult,
  displayRoot: string,
  query: string,
  maxResults: number
): string {
  if (search.result === "files") {
    if (search.files.length === 0)
      return `No files matched ${JSON.stringify(query)}.`
    return appendNotes(
      search.files.map((p) => relPath(displayRoot, p)).join("\n"),
      search,
      maxResults
    )
  }

  if (search.result === "count") {
    if (search.counts.length === 0)
      return `No matches for ${JSON.stringify(query)}.`
    const rows = search.counts.map(
      (c) => `${relPath(displayRoot, c.path)}: ${c.matches}`
    )
    rows.push(`total: ${search.totalMatches ?? 0}`)
    return appendNotes(rows.join("\n"), search, maxResults)
  }

  if (search.matches.length === 0)
    return `No matches for ${JSON.stringify(query)}.`
  const rows = search.matches.map((m) => {
    const column = m.column ? `:${m.column}` : ""
    const prefix = m.kind === "context" ? "-" : ":"
    return `${relPath(displayRoot, m.path)}:${m.line}${column}${prefix} ${m.text}`
  })
  return appendNotes(rows.join("\n"), search, maxResults)
}

function appendNotes(
  text: string,
  search: SearchResult,
  maxResults: number
): string {
  const notes: string[] = []
  if (search.capped) {
    notes.push(`stopped at ${maxResults} ${search.result} results`)
  }
  if (search.reducedFeatures?.length) {
    notes.push(`engine=${search.engine}; ${search.reducedFeatures.join("; ")}`)
  } else {
    notes.push(`engine=${search.engine}`)
  }
  return `${text}\n[${notes.join(" | ")}]`
}

function recoveryHint(result: SearchResultMode): string {
  if (result === "files") return "narrow globs/path or switch to content/count"
  if (result === "count") return "narrow globs/path or switch to files/content"
  return "narrow query/path/globs or use result='files'/'count'"
}

function relPath(root: string, path: string): string {
  const rel = path.startsWith(root)
    ? path.slice(root.length).replace(/^[/\\]/, "")
    : path
  return rel ? rel.split(/[\\/]/).join("/") : "."
}

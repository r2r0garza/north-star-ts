import { TOOL_EFFECTS, type Tool } from "./types"
import { truncateForModel, toolError } from "./output"
import { getWorkspaceByPath } from "../../db/repositories/workspaces"
import { getRunByWorkspace } from "../../db/repositories/index-runs"
import * as indexFilesRepo from "../../db/repositories/index-files"
import { listMetadata } from "../../db/repositories/index-metadata"
import * as indexSymbolsRepo from "../../db/repositories/index-symbols"
import type { IndexMetadata } from "../../db/types"

const RESULT_LIMITS = {
  find_symbol: { default: 50, max: 100 },
  what_imports: { default: 50, max: 100 },
  list_files: { default: 500, max: 1_000 },
} as const

// Query the pre-built workspace index (plan 008/014). Advisory + fast: it answers
// "where is X defined", "what imports Y", "what files match Z", and "what's the
// package/framework metadata" from the persisted index instead of walking the
// tree. The index may be PARTIAL or STALE — a miss means "not indexed (yet)", NOT
// "does not exist"; the tool says so and points back to search_tool/read_file for
// authoritative answers. Read-only, so it never gates.
export const indexQueryTool: Tool = {
  effects: TOOL_EFFECTS.readOnlyParallel,
  definition: {
    type: "function",
    function: {
      name: "index_query_tool",
      description:
        "Query the workspace index for fast orientation. Operations: " +
        "`find_symbol` (where a function/class/interface/type/enum/const is declared), " +
        "`what_imports` (which files import a module), " +
        "`list_files` (files whose path matches a substring/extension), " +
        "`metadata` (parsed package.json/tsconfig/framework/git-branch). " +
        "The index is advisory and may be partial or stale: a miss means 'not indexed yet', " +
        "not 'absent' — fall back to search_tool / read_file_tool for authoritative answers.",
      parameters: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: ["find_symbol", "what_imports", "list_files", "metadata"],
            description: "Which query to run.",
          },
          query: {
            type: "string",
            description:
              "For find_symbol: the symbol name. For what_imports: the module specifier " +
              "(e.g. 'react', './util'). For list_files: a path substring or extension " +
              "(e.g. '.ts', 'components/'). Ignored for metadata.",
          },
          kind: {
            type: "string",
            description:
              "Optional filter for find_symbol (e.g. 'function', 'class', 'interface', " +
              "'type', 'enum', 'const').",
          },
          limit: {
            type: "integer",
            description:
              "Max returned results. Defaults: find_symbol/what_imports 50, list_files 500. " +
              "Hard caps: find_symbol/what_imports 100, list_files 1000.",
          },
        },
        required: ["op"],
      },
    },
  },

  execute: async (args, ctx) => {
    const op = typeof args.op === "string" ? args.op : ""
    const query = typeof args.query === "string" ? args.query.trim() : ""
    const kind =
      typeof args.kind === "string" && args.kind ? args.kind : undefined

    if (!ctx.workspace) {
      return toolError(
        "no_workspace",
        "The index is only available with a workspace."
      )
    }
    const ws = getWorkspaceByPath(ctx.workspace)
    if (!ws) {
      return notIndexed("This workspace has no index yet.")
    }
    const run = getRunByWorkspace(ws.id)
    if (!run || run.filesScanned === 0) {
      return notIndexed("This workspace has not been indexed yet.")
    }
    // A staleness/partial banner appended to results so the model calibrates trust.
    const partial =
      run.stage !== "symbols" ||
      (run.filesTotal > 0 && run.filesScanned < run.filesTotal)

    switch (op) {
      case "find_symbol": {
        if (!query)
          return toolError("bad_args", "`query` (symbol name) is required.")
        const limit = normalizeLimit(args.limit, RESULT_LIMITS.find_symbol)
        const hits = indexSymbolsRepo.findSymbolsByName(ws.id, query, {
          kind,
          limit: limit.query,
        })
        if (hits.length === 0) {
          return notIndexed(
            `No indexed symbol named "${query}"${kind ? ` of kind ${kind}` : ""}.`,
            partial
          )
        }
        const capped = hits.length > limit.returned
        const shown = capped ? hits.slice(0, limit.returned) : hits
        const lines = shown.map((s) => {
          const exported = (s.detail as { exported?: boolean } | null)?.exported
            ? " (exported)"
            : ""
          const at = s.line != null ? `:${s.line}` : ""
          return `${s.kind} ${s.name}${exported} — ${s.path}${at}`
        })
        if (capped) lines.push(moreMatchesHint(limit.returned, "symbols"))
        return withBanner(lines.join("\n"), partial)
      }

      case "what_imports": {
        if (!query)
          return toolError(
            "bad_args",
            "`query` (module specifier) is required."
          )
        const limit = normalizeLimit(args.limit, RESULT_LIMITS.what_imports)
        const importers = indexSymbolsRepo.findImportsOf(
          ws.id,
          query,
          limit.query
        )
        if (importers.length === 0) {
          return notIndexed(`No indexed file imports "${query}".`, partial)
        }
        const capped = importers.length > limit.returned
        const shown = capped ? importers.slice(0, limit.returned) : importers
        const lines = shown.map(
          (i) =>
            `${i.path}${i.line != null ? `:${i.line}` : ""} — imports ${i.name}`
        )
        if (capped) lines.push(moreMatchesHint(limit.returned, "imports"))
        return withBanner(lines.join("\n"), partial)
      }

      case "list_files": {
        if (!query) {
          // No filter → summarize the file map by extension. Honest totals: the
          // per-ext lines PLUS a total and an explicit remainder for extensionless
          // files / buckets past the shown ones, so the numbers always reconcile.
          const all = indexFilesRepo.countByExt(ws.id)
          const total = all.reduce((sum, r) => sum + r.count, 0)
          if (total === 0) return withBanner("No files indexed.", partial)
          const TOP = 20
          const withExt = all.filter((r) => r.ext)
          const shown = withExt.slice(0, TOP)
          const shownSum = shown.reduce((sum, r) => sum + r.count, 0)
          const other = total - shownSum
          const lines = shown.map((r) => `${r.ext}: ${r.count}`)
          if (other > 0) {
            lines.push(`(other, incl. extensionless: ${other})`)
          }
          lines.push(`total: ${total}`)
          return withBanner(`Files by extension:\n${lines.join("\n")}`, partial)
        }
        // Over-fetch by one to detect (and honestly report) truncation, the way
        // search_tool does — the agent must never think a capped list is complete.
        const limit = normalizeLimit(args.limit, RESULT_LIMITS.list_files)
        const files = indexFilesRepo.listFilesMatching(
          ws.id,
          query,
          limit.query
        )
        if (files.length === 0) {
          return notIndexed(`No indexed file path matches "${query}".`, partial)
        }
        const capped = files.length > limit.returned
        const shown = capped ? files.slice(0, limit.returned) : files
        let body = shown.map((f) => f.path).join("\n")
        if (capped) {
          body += `\n${moreMatchesHint(limit.returned, "files")}`
        }
        return withBanner(body, partial)
      }

      case "metadata": {
        const meta = listMetadata(ws.id)
        if (meta.length === 0)
          return notIndexed("No metadata indexed yet.", partial)
        return withBanner(renderMetadata(meta), partial)
      }

      default:
        return toolError(
          "bad_args",
          `Unknown op "${op}". Use find_symbol, what_imports, list_files, or metadata.`
        )
    }
  },
}

function normalizeLimit(
  input: unknown,
  limits: { default: number; max: number }
): { returned: number; query: number } {
  const requested =
    typeof input === "number" && Number.isFinite(input) && input > 0
      ? Math.max(1, Math.floor(input))
      : limits.default
  const returned = Math.min(requested, limits.max)
  return { returned, query: returned + 1 }
}

function moreMatchesHint(limit: number, noun: string): string {
  return `[stopped at ${limit} ${noun} — more matches may exist; narrow the query for more]`
}

// A compact, bounded digest of the parsed metadata — NOT a raw JSON dump. Full
// package.json (every dep/devDep) + a README excerpt would blow the token cap and
// bury the signal, so each known kind is summarized to its high-value fields; any
// unrecognized kind falls back to a short JSON snippet.
function renderMetadata(meta: IndexMetadata[]): string {
  const byKind = new Map(meta.map((m) => [m.kind, m]))
  const lines: string[] = []

  const pkg = byKind.get("package_json")?.value as
    | {
        name?: string
        version?: string
        packageManager?: string
        scripts?: Record<string, string>
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
    | undefined
  if (pkg) {
    const bits: string[] = []
    if (pkg.name) bits.push(`name ${pkg.name}`)
    if (pkg.version) bits.push(`v${pkg.version}`)
    if (pkg.packageManager) bits.push(`packageManager ${pkg.packageManager}`)
    lines.push(`package.json: ${bits.join(", ") || "(present)"}`)
    if (pkg.scripts) {
      lines.push(`  scripts: ${Object.keys(pkg.scripts).join(", ")}`)
    }
    const deps = Object.keys(pkg.dependencies ?? {})
    if (deps.length)
      lines.push(`  dependencies (${deps.length}): ${capList(deps, 30)}`)
    const dev = Object.keys(pkg.devDependencies ?? {})
    if (dev.length)
      lines.push(`  devDependencies (${dev.length}): ${capList(dev, 30)}`)
  }

  const git = byKind.get("git")?.value as
    | { branch?: string; sha?: string }
    | undefined
  if (git?.branch) lines.push(`git: branch ${git.branch}`)
  else if (git?.sha) lines.push(`git: detached at ${git.sha}`)

  // Config presence (name only — contents aren't useful inline).
  const configs: string[] = []
  if (byKind.has("tsconfig")) configs.push("tsconfig.json")
  if (byKind.has("pnpm_workspace"))
    configs.push("pnpm-workspace.yaml (monorepo)")
  const vite = byKind.get("vite_config")?.value as
    | { config?: string }
    | undefined
  if (vite?.config) configs.push(vite.config)
  if (configs.length) lines.push(`config: ${configs.join(", ")}`)

  const readme = byKind.get("readme")?.value as { excerpt?: string } | undefined
  if (readme?.excerpt) {
    const firstLine = readme.excerpt
      .split("\n")
      .find((l) => l.trim().length > 0)
    if (firstLine) lines.push(`README: ${firstLine.trim().slice(0, 160)}`)
  }

  // Any other kinds we didn't special-case: a short snippet so nothing is hidden.
  const known = new Set([
    "package_json",
    "git",
    "tsconfig",
    "pnpm_workspace",
    "vite_config",
    "readme",
  ])
  for (const m of meta) {
    if (!known.has(m.kind)) {
      lines.push(`${m.kind}: ${JSON.stringify(m.value).slice(0, 160)}`)
    }
  }

  return lines.length ? lines.join("\n") : "No recognizable metadata indexed."
}

// Join a list, capping the count with a "+N more" suffix so a big dep list can't
// dominate the output.
function capList(items: string[], max: number): string {
  if (items.length <= max) return items.join(", ")
  return `${items.slice(0, max).join(", ")}, +${items.length - max} more`
}

// A miss is advisory, not authoritative — always steer to the real tools.
function notIndexed(message: string, partial = false): string {
  const staleness = partial
    ? " The index is still building or partial, so this may just be un-indexed."
    : ""
  return `${message}${staleness} The index is advisory — use search_tool or read_file_tool to confirm.`
}

function withBanner(body: string, partial: boolean): string {
  const banner = partial
    ? "\n\n[index partial/building — treat misses as un-indexed, not absent]"
    : ""
  return truncateForModel(body + banner).text
}

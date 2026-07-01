import type { Tool } from "./types"
import { truncateForModel, toolError } from "./output"
import { getWorkspaceByPath } from "../../db/repositories/workspaces"
import { getRunByWorkspace } from "../../db/repositories/index-runs"
import { listFilesMatching, countByExt } from "../../db/repositories/index-files"
import { listMetadata } from "../../db/repositories/index-metadata"
import { findSymbolsByName, findImportsOf } from "../../db/repositories/index-symbols"

// Query the pre-built workspace index (plan 008/014). Advisory + fast: it answers
// "where is X defined", "what imports Y", "what files match Z", and "what's the
// package/framework metadata" from the persisted index instead of walking the
// tree. The index may be PARTIAL or STALE — a miss means "not indexed (yet)", NOT
// "does not exist"; the tool says so and points back to search_tool/read_file for
// authoritative answers. Read-only, so it never gates.
export const indexQueryTool: Tool = {
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
            description: "Max results (default 50).",
          },
        },
        required: ["op"],
      },
    },
  },

  execute: async (args, ctx) => {
    const op = typeof args.op === "string" ? args.op : ""
    const query = typeof args.query === "string" ? args.query.trim() : ""
    const kind = typeof args.kind === "string" && args.kind ? args.kind : undefined
    const limit =
      typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 50

    if (!ctx.workspace) {
      return toolError("no_workspace", "The index is only available with a workspace.")
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
      run.stage !== "symbols" || (run.filesTotal > 0 && run.filesScanned < run.filesTotal)

    switch (op) {
      case "find_symbol": {
        if (!query) return toolError("bad_args", "`query` (symbol name) is required.")
        const hits = findSymbolsByName(ws.id, query, { kind, limit })
        if (hits.length === 0) {
          return notIndexed(
            `No indexed symbol named "${query}"${kind ? ` of kind ${kind}` : ""}.`,
            partial
          )
        }
        const lines = hits.map((s) => {
          const exported = (s.detail as { exported?: boolean } | null)?.exported ? " (exported)" : ""
          const at = s.line != null ? `:${s.line}` : ""
          return `${s.kind} ${s.name}${exported} — ${s.path}${at}`
        })
        return withBanner(lines.join("\n"), partial)
      }

      case "what_imports": {
        if (!query) return toolError("bad_args", "`query` (module specifier) is required.")
        const importers = findImportsOf(ws.id, query, limit)
        if (importers.length === 0) {
          return notIndexed(`No indexed file imports "${query}".`, partial)
        }
        const lines = importers.map(
          (i) => `${i.path}${i.line != null ? `:${i.line}` : ""} — imports ${i.name}`
        )
        return withBanner(lines.join("\n"), partial)
      }

      case "list_files": {
        if (!query) {
          // No filter → summarize the file map by extension.
          const counts = countByExt(ws.id)
            .filter((r) => r.ext)
            .slice(0, 20)
            .map((r) => `${r.ext}: ${r.count}`)
          return withBanner(
            counts.length ? `Files by extension:\n${counts.join("\n")}` : "No files indexed.",
            partial
          )
        }
        const files = listFilesMatching(ws.id, query, limit)
        if (files.length === 0) {
          return notIndexed(`No indexed file path matches "${query}".`, partial)
        }
        return withBanner(files.map((f) => f.path).join("\n"), partial)
      }

      case "metadata": {
        const meta = listMetadata(ws.id)
        if (meta.length === 0) return notIndexed("No metadata indexed yet.", partial)
        const lines = meta.map((m) => `${m.kind}${m.path ? ` (${m.path})` : ""}: ${JSON.stringify(m.value)}`)
        return withBanner(lines.join("\n"), partial)
      }

      default:
        return toolError(
          "bad_args",
          `Unknown op "${op}". Use find_symbol, what_imports, list_files, or metadata.`
        )
    }
  },
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

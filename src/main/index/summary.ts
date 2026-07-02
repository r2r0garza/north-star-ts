import { getRunByWorkspace } from "../db/repositories/index-runs"
import { countByExt } from "../db/repositories/index-files"
import { listMetadata } from "../db/repositories/index-metadata"
import { countSymbols } from "../db/repositories/index-symbols"

// Build the compact workspace-index summary injected into the interactive/
// north_star system prompt (plan 008, gated by the "use index for context"
// setting). Advisory only — it accelerates orientation; the agent still uses the
// real file tools for exact reads/searches. Returns null when there's nothing
// indexed yet (no run), so the caller appends nothing.
export function buildIndexSummary(workspaceId: string): string | null {
  const run = getRunByWorkspace(workspaceId)
  if (!run) return null

  const lines: string[] = ["## Workspace index"]

  // Indexing status / progress.
  if (run.filesTotal > 0 && run.filesScanned < run.filesTotal) {
    lines.push(
      `Status: indexing in progress (${run.filesScanned}/${run.filesTotal} files, stage: ${run.stage}).`
    )
  } else if (run.filesScanned > 0) {
    lines.push(`Status: indexed (${run.filesScanned} files).`)
  } else {
    lines.push("Status: not yet indexed.")
  }

  // File counts by extension (top handful) — with a remainder so the numbers
  // reconcile with the status-line total (which counts extensionless files and
  // buckets past the top handful too; otherwise the two lines contradict).
  const all = countByExt(workspaceId)
  const total = all.reduce((sum, r) => sum + r.count, 0)
  const withExt = all.filter((r) => r.ext)
  const shown = withExt.slice(0, 8)
  const shownSum = shown.reduce((sum, r) => sum + r.count, 0)
  const other = total - shownSum
  if (shown.length > 0) {
    const parts = shown.map((r) => `${r.ext} ${r.count}`)
    if (other > 0) parts.push(`other ${other}`)
    lines.push(`Files by type: ${parts.join(", ")} (total ${total}).`)
  }

  // Key metadata: package manager / name, framework hints, git branch, configs.
  const meta = new Map(listMetadata(workspaceId).map((m) => [m.kind, m.value]))

  const pkg = meta.get("package_json") as
    | {
        name?: string
        packageManager?: string
        scripts?: Record<string, string>
      }
    | undefined
  if (pkg) {
    const bits: string[] = []
    if (pkg.name) bits.push(`name: ${pkg.name}`)
    if (pkg.packageManager) bits.push(`package manager: ${pkg.packageManager}`)
    const scripts = pkg.scripts ? Object.keys(pkg.scripts) : []
    if (scripts.length > 0)
      bits.push(`scripts: ${scripts.slice(0, 8).join(", ")}`)
    if (bits.length > 0) lines.push(`package.json — ${bits.join("; ")}.`)
  }

  const configs: string[] = []
  if (meta.get("pnpm_workspace")) configs.push("pnpm-workspace.yaml (monorepo)")
  if (meta.get("tsconfig")) configs.push("tsconfig.json")
  const vite = meta.get("vite_config") as { config?: string } | undefined
  if (vite?.config) configs.push(vite.config)
  if (configs.length > 0) lines.push(`Config: ${configs.join(", ")}.`)

  const git = meta.get("git") as { branch?: string; sha?: string } | undefined
  if (git?.branch) lines.push(`Git branch: ${git.branch}.`)
  else if (git?.sha) lines.push(`Git: detached at ${git.sha}.`)

  const readme = meta.get("readme") as { excerpt?: string } | undefined
  if (readme?.excerpt) {
    const firstLine = readme.excerpt
      .split("\n")
      .find((l) => l.trim().length > 0)
    if (firstLine)
      lines.push(`README starts: ${firstLine.trim().slice(0, 200)}`)
  }

  // Symbol coverage — signals that index_query_tool can answer symbol lookups.
  const symbols = countSymbols(workspaceId)
  if (symbols > 0)
    lines.push(`Indexed symbols: ${symbols} (queryable via index_query_tool).`)

  lines.push(
    "This is an advisory summary. Use index_query_tool to find symbols, list files, or see what " +
      "imports a module; use the normal file tools for exact reads and full-text search. The index " +
      "may be partial or stale — treat misses as 'not indexed yet', not 'does not exist'."
  )

  return lines.join("\n")
}

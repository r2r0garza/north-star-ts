import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type { IndexSymbol } from "../types"

interface IndexSymbolRow {
  id: string
  workspace_id: string
  file_id: string
  name: string
  kind: string
  line: number | null
  detail: string | null
  updated_at: number
}

function toIndexSymbol(row: IndexSymbolRow): IndexSymbol {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    fileId: row.file_id,
    name: row.name,
    kind: row.kind,
    line: row.line,
    detail: row.detail ? JSON.parse(row.detail) : null,
    updatedAt: row.updated_at,
  }
}

export interface SymbolInput {
  name: string
  kind: string
  line?: number | null
  detail?: unknown
}

// Replace all symbols for one file in a single transaction (delete-then-insert).
// A re-index of a changed file overwrites its symbols wholesale; file deletion is
// handled by the ON DELETE CASCADE from index_files, so this is only the
// re-extraction path.
export function replaceSymbolsForFile(
  workspaceId: string,
  fileId: string,
  symbols: SymbolInput[]
): void {
  const db = getDb()
  const now = Date.now()
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM index_symbols WHERE file_id = ?").run(fileId)
    const insert = db.prepare(
      "INSERT INTO index_symbols (id, workspace_id, file_id, name, kind, line, detail, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    for (const s of symbols) {
      insert.run(
        randomUUID(),
        workspaceId,
        fileId,
        s.name,
        s.kind,
        s.line ?? null,
        s.detail !== undefined ? JSON.stringify(s.detail) : null,
        now
      )
    }
  })
  tx()
}

// A symbol hit carrying its file path (joined from index_files) so callers don't
// need a second lookup to render "name — path:line".
export interface SymbolHit extends IndexSymbol {
  path: string
}

// Find symbols by (case-insensitive) name within a workspace, optionally filtered
// by kind. Imports are excluded by default (they're noise for "where is X
// defined"); pass includeImports to keep them. Ordered so declarations come
// before references. Capped by `limit`. Joins index_files for the path.
export function findSymbolsByName(
  workspaceId: string,
  name: string,
  opts: { kind?: string; includeImports?: boolean; limit?: number } = {}
): SymbolHit[] {
  const clauses = ["s.workspace_id = ?", "s.name = ? COLLATE NOCASE"]
  const values: unknown[] = [workspaceId, name]
  if (opts.kind) {
    clauses.push("s.kind = ?")
    values.push(opts.kind)
  }
  if (!opts.includeImports) {
    clauses.push("s.kind != 'import'")
  }
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 50
  const rows = getDb()
    .prepare(
      `SELECT s.*, f.path AS path FROM index_symbols s
       JOIN index_files f ON f.id = s.file_id
       WHERE ${clauses.join(" AND ")} ORDER BY s.kind ASC LIMIT ?`
    )
    .all(...values, limit) as Array<IndexSymbolRow & { path: string }>
  return rows.map((r) => ({ ...toIndexSymbol(r), path: r.path }))
}

// The file paths that import a given module (matches on the import symbol's
// detail.module, stored as JSON). Returns distinct file paths + the imported
// name, so the agent can answer "what imports X".
export function findImportsOf(
  workspaceId: string,
  module: string,
  limit = 100
): Array<{ path: string; name: string; line: number | null }> {
  const rows = getDb()
    .prepare(
      `SELECT f.path AS path, s.name AS name, s.line AS line
       FROM index_symbols s
       JOIN index_files f ON f.id = s.file_id
       WHERE s.workspace_id = ? AND s.kind = 'import'
         AND json_extract(s.detail, '$.module') = ?
       ORDER BY f.path ASC
       LIMIT ?`
    )
    .all(workspaceId, module, Math.floor(limit)) as Array<{
    path: string
    name: string
    line: number | null
  }>
  return rows
}

export function countSymbols(workspaceId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS c FROM index_symbols WHERE workspace_id = ?")
    .get(workspaceId) as { c: number }
  return row.c
}

export function deleteSymbolsByWorkspace(workspaceId: string): void {
  getDb()
    .prepare("DELETE FROM index_symbols WHERE workspace_id = ?")
    .run(workspaceId)
}

import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type { IndexFile, IndexStage } from "../types"

interface IndexFileRow {
  id: string
  workspace_id: string
  path: string
  ext: string | null
  size: number
  mtime: number
  hash: string
  indexed_stage: IndexStage
  updated_at: number
}

function toIndexFile(row: IndexFileRow): IndexFile {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    path: row.path,
    ext: row.ext,
    size: row.size,
    mtime: row.mtime,
    hash: row.hash,
    indexedStage: row.indexed_stage,
    updatedAt: row.updated_at,
  }
}

export function getFileByPath(
  workspaceId: string,
  path: string
): IndexFile | undefined {
  const row = getDb()
    .prepare("SELECT * FROM index_files WHERE workspace_id = ? AND path = ?")
    .get(workspaceId, path) as IndexFileRow | undefined
  return row ? toIndexFile(row) : undefined
}

export interface UpsertFileInput {
  workspaceId: string
  path: string
  ext?: string | null
  size: number
  mtime: number
  hash: string
  indexedStage: IndexStage
}

// Insert-or-replace a file row keyed by (workspace_id, path). Returns the row.
export function upsertFile(input: UpsertFileInput): IndexFile {
  const existing = getFileByPath(input.workspaceId, input.path)
  const now = Date.now()
  if (existing) {
    getDb()
      .prepare(
        "UPDATE index_files SET ext = ?, size = ?, mtime = ?, hash = ?, indexed_stage = ?, updated_at = ? WHERE id = ?"
      )
      .run(
        input.ext ?? null,
        input.size,
        input.mtime,
        input.hash,
        input.indexedStage,
        now,
        existing.id
      )
    return getFileByPath(input.workspaceId, input.path)!
  }
  getDb()
    .prepare(
      "INSERT INTO index_files (id, workspace_id, path, ext, size, mtime, hash, indexed_stage, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      randomUUID(),
      input.workspaceId,
      input.path,
      input.ext ?? null,
      input.size,
      input.mtime,
      input.hash,
      input.indexedStage,
      now
    )
  return getFileByPath(input.workspaceId, input.path)!
}

// Bulk upsert in one transaction — the Stage-1 batch write path. better-sqlite3
// transactions are the perf lever for hundreds of rows.
export function upsertFiles(inputs: UpsertFileInput[]): void {
  const db = getDb()
  const tx = db.transaction((rows: UpsertFileInput[]) => {
    for (const row of rows) upsertFile(row)
  })
  tx(inputs)
}

export function listFiles(workspaceId: string): IndexFile[] {
  const rows = getDb()
    .prepare("SELECT * FROM index_files WHERE workspace_id = ? ORDER BY path ASC")
    .all(workspaceId) as IndexFileRow[]
  return rows.map(toIndexFile)
}

// Files at a given indexed_stage — the Stage 3 dirty set is everything still at
// 'file_map' (new or content-changed; unchanged files that already reached
// 'symbols' are skipped). Ordered by path for stable, resumable processing.
export function listFilesByStage(workspaceId: string, stage: IndexStage): IndexFile[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM index_files WHERE workspace_id = ? AND indexed_stage = ? ORDER BY path ASC"
    )
    .all(workspaceId, stage) as IndexFileRow[]
  return rows.map(toIndexFile)
}

// Bump a file's highest-completed stage (e.g. after symbol extraction).
export function setIndexedStage(fileId: string, stage: IndexStage): void {
  getDb()
    .prepare("UPDATE index_files SET indexed_stage = ?, updated_at = ? WHERE id = ?")
    .run(stage, Date.now(), fileId)
}

// List files matching a case-insensitive glob substring on the path (e.g.
// ".ts", "components/"), for the index_query_tool's list-files op. Capped.
export function listFilesMatching(
  workspaceId: string,
  glob: string,
  limit = 200
): IndexFile[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM index_files WHERE workspace_id = ? AND path LIKE ? COLLATE NOCASE ORDER BY path ASC LIMIT ?"
    )
    .all(workspaceId, `%${glob}%`, Math.floor(limit)) as IndexFileRow[]
  return rows.map(toIndexFile)
}

// The set of tracked paths, for diffing against a fresh walk to find deletions.
export function listPaths(workspaceId: string): Set<string> {
  const rows = getDb()
    .prepare("SELECT path FROM index_files WHERE workspace_id = ?")
    .all(workspaceId) as Array<{ path: string }>
  return new Set(rows.map((r) => r.path))
}

export function countByExt(workspaceId: string): Array<{ ext: string | null; count: number }> {
  return getDb()
    .prepare(
      "SELECT ext, COUNT(*) AS count FROM index_files WHERE workspace_id = ? GROUP BY ext ORDER BY count DESC"
    )
    .all(workspaceId) as Array<{ ext: string | null; count: number }>
}

export function deleteFile(workspaceId: string, path: string): void {
  getDb()
    .prepare("DELETE FROM index_files WHERE workspace_id = ? AND path = ?")
    .run(workspaceId, path)
}

export function deleteFilesByWorkspace(workspaceId: string): void {
  getDb().prepare("DELETE FROM index_files WHERE workspace_id = ?").run(workspaceId)
}

import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type { IndexMetadata } from "../types"

interface IndexMetadataRow {
  id: string
  workspace_id: string
  kind: string
  path: string | null
  value: string
  updated_at: number
}

function toIndexMetadata(row: IndexMetadataRow): IndexMetadata {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    path: row.path,
    value: JSON.parse(row.value),
    updatedAt: row.updated_at,
  }
}

// Replace-by-(workspace, kind): the metadata set is small and one row per kind,
// so a re-parse overwrites the prior value rather than accumulating.
export function upsertMetadata(input: {
  workspaceId: string
  kind: string
  path?: string | null
  value: unknown
}): IndexMetadata {
  const now = Date.now()
  const serialized = JSON.stringify(input.value)
  const existing = getDb()
    .prepare("SELECT * FROM index_metadata WHERE workspace_id = ? AND kind = ?")
    .get(input.workspaceId, input.kind) as IndexMetadataRow | undefined
  if (existing) {
    getDb()
      .prepare(
        "UPDATE index_metadata SET path = ?, value = ?, updated_at = ? WHERE id = ?"
      )
      .run(input.path ?? null, serialized, now, existing.id)
  } else {
    getDb()
      .prepare(
        "INSERT INTO index_metadata (id, workspace_id, kind, path, value, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        randomUUID(),
        input.workspaceId,
        input.kind,
        input.path ?? null,
        serialized,
        now
      )
  }
  const row = getDb()
    .prepare("SELECT * FROM index_metadata WHERE workspace_id = ? AND kind = ?")
    .get(input.workspaceId, input.kind) as IndexMetadataRow
  return toIndexMetadata(row)
}

export function listMetadata(workspaceId: string): IndexMetadata[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM index_metadata WHERE workspace_id = ? ORDER BY kind ASC"
    )
    .all(workspaceId) as IndexMetadataRow[]
  return rows.map(toIndexMetadata)
}

export function deleteMetadataByWorkspace(workspaceId: string): void {
  getDb()
    .prepare("DELETE FROM index_metadata WHERE workspace_id = ?")
    .run(workspaceId)
}

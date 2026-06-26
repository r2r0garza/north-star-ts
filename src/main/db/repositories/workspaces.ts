import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type { Workspace } from "../types"

interface WorkspaceRow {
  id: string
  path: string
  name: string | null
  created_at: number
  updated_at: number
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// Last segment of a path, e.g. "/Users/me/proj" -> "proj". Used as a default name.
function lastSegment(path: string): string {
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/)
  return parts[parts.length - 1] || path
}

export function getWorkspace(id: string): Workspace | undefined {
  const row = getDb()
    .prepare("SELECT * FROM workspaces WHERE id = ?")
    .get(id) as WorkspaceRow | undefined
  return row ? toWorkspace(row) : undefined
}

export function getWorkspaceByPath(path: string): Workspace | undefined {
  const row = getDb()
    .prepare("SELECT * FROM workspaces WHERE path = ?")
    .get(path) as WorkspaceRow | undefined
  return row ? toWorkspace(row) : undefined
}

// Return the existing workspace for `path` (deduped on the UNIQUE path) or
// create one. Bumps `name` if a new one is supplied for an existing row.
export function upsertWorkspace(path: string, name?: string): Workspace {
  const existing = getWorkspaceByPath(path)
  const now = Date.now()
  if (existing) {
    if (name && name !== existing.name) {
      getDb()
        .prepare("UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?")
        .run(name, now, existing.id)
      return { ...existing, name, updatedAt: now }
    }
    return existing
  }
  const id = randomUUID()
  getDb()
    .prepare(
      "INSERT INTO workspaces (id, path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(id, path, name ?? lastSegment(path), now, now)
  return getWorkspace(id)!
}

export function listWorkspaces(): Workspace[] {
  const rows = getDb()
    .prepare("SELECT * FROM workspaces ORDER BY updated_at DESC")
    .all() as WorkspaceRow[]
  return rows.map(toWorkspace)
}

export function updateWorkspace(id: string, patch: { name?: string }): Workspace {
  const now = Date.now()
  if (patch.name !== undefined) {
    getDb()
      .prepare("UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?")
      .run(patch.name, now, id)
  }
  return getWorkspace(id)!
}

export function deleteWorkspace(id: string): void {
  getDb().prepare("DELETE FROM workspaces WHERE id = ?").run(id)
}

import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type { Project } from "../types"

interface ProjectRow {
  id: string
  name: string
  workspace_id: string | null
  created_at: number
  updated_at: number
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    workspaceId: row.workspace_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createProject(input: {
  name: string
  workspaceId?: string | null
}): Project {
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      "INSERT INTO projects (id, name, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(id, input.name, input.workspaceId ?? null, now, now)
  return getProject(id)!
}

export function getProject(id: string): Project | undefined {
  const row = getDb()
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(id) as ProjectRow | undefined
  return row ? toProject(row) : undefined
}

export function listProjects(): Project[] {
  const rows = getDb()
    .prepare("SELECT * FROM projects ORDER BY updated_at DESC")
    .all() as ProjectRow[]
  return rows.map(toProject)
}

// Partial update. `workspaceId` accepts null to clear the project's default
// directory (making it Chat-only again), so it uses the explicit-key check
// rather than a truthiness test — matching updateConversation's SET-builder.
export function updateProject(
  id: string,
  patch: { name?: string; workspaceId?: string | null }
): Project {
  const now = Date.now()
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.name !== undefined) {
    sets.push("name = ?")
    values.push(patch.name)
  }
  if (patch.workspaceId !== undefined) {
    sets.push("workspace_id = ?")
    values.push(patch.workspaceId)
  }
  if (sets.length > 0) {
    sets.push("updated_at = ?")
    values.push(now, id)
    getDb()
      .prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values)
  }
  return getProject(id)!
}

// Delete a project. Conversations' project_id is ON DELETE SET NULL, so they
// survive and fall back to the "No Project" bucket (runtime FK enforcement is ON).
export function deleteProject(id: string): void {
  getDb().prepare("DELETE FROM projects WHERE id = ?").run(id)
}

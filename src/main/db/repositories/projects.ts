import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type { Project } from "../types"

interface ProjectRow {
  id: string
  name: string
  workspace_id: string | null
  position: number
  created_at: number
  updated_at: number
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    workspaceId: row.workspace_id,
    position: row.position,
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
  const nextPosition =
    ((
      getDb()
        .prepare("SELECT MIN(position) AS position FROM projects")
        .get() as { position: number | null }
    ).position ?? 0) - 1
  getDb()
    .prepare(
      "INSERT INTO projects (id, name, workspace_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(id, input.name, input.workspaceId ?? null, nextPosition, now, now)
  return getProject(id)!
}

export function getProject(id: string): Project | undefined {
  const row = getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id) as
    | ProjectRow
    | undefined
  return row ? toProject(row) : undefined
}

export function listProjects(): Project[] {
  const rows = getDb()
    .prepare("SELECT * FROM projects ORDER BY position ASC, updated_at DESC")
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

export function reorderProjects(ids: string[]): Project[] {
  const uniqueIds = Array.from(new Set(ids))
  const existing = new Set(listProjects().map((project) => project.id))
  if (uniqueIds.length !== existing.size) {
    throw new Error("Project reorder must include every project exactly once")
  }
  for (const id of uniqueIds) {
    if (!existing.has(id)) {
      throw new Error(`Unknown project id: ${id}`)
    }
  }

  const update = getDb().prepare(
    "UPDATE projects SET position = ?, updated_at = ? WHERE id = ?"
  )
  const now = Date.now()
  getDb().transaction(() => {
    uniqueIds.forEach((id, position) => update.run(position, now, id))
  })()
  return listProjects()
}

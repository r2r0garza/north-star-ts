import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type {
  SubagentArtifact,
  SubagentArtifactStatus,
} from "../types"

interface Row {
  id: string
  repository_id: string
  session_id: string
  assignment_id: string
  backend: string
  branch: string
  worktree_path: string
  marker_path: string
  status: SubagentArtifactStatus
  detail: string | null
  created_at: number
  updated_at: number
  resolved_at: number | null
}

const toArtifact = (row: Row): SubagentArtifact => ({
  id: row.id,
  repositoryId: row.repository_id,
  sessionId: row.session_id,
  assignmentId: row.assignment_id,
  backend: row.backend,
  branch: row.branch,
  worktreePath: row.worktree_path,
  markerPath: row.marker_path,
  status: row.status,
  detail: row.detail ? JSON.parse(row.detail) : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  resolvedAt: row.resolved_at,
})

export function createSubagentArtifact(input: {
  repositoryId: string
  sessionId: string
  assignmentId: string
  backend: string
  branch: string
  worktreePath: string
  markerPath: string
  detail?: unknown
}): SubagentArtifact {
  const id = randomUUID()
  const now = Date.now()
  getDb().prepare(`
    INSERT INTO subagent_artifacts
      (id, repository_id, session_id, assignment_id, backend, branch,
       worktree_path, marker_path, status, detail, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(
    id,
    input.repositoryId,
    input.sessionId,
    input.assignmentId,
    input.backend,
    input.branch,
    input.worktreePath,
    input.markerPath,
    input.detail === undefined ? null : JSON.stringify(input.detail),
    now,
    now
  )
  return getSubagentArtifact(id)!
}

export function getSubagentArtifact(id: string): SubagentArtifact | undefined {
  const row = getDb().prepare("SELECT * FROM subagent_artifacts WHERE id = ?").get(id) as Row | undefined
  return row ? toArtifact(row) : undefined
}

export function listSubagentArtifacts(input: {
  repositoryId?: string
  unresolved?: boolean
} = {}): SubagentArtifact[] {
  const clauses: string[] = []
  const values: unknown[] = []
  if (input.repositoryId) {
    clauses.push("repository_id = ?")
    values.push(input.repositoryId)
  }
  if (input.unresolved) clauses.push("status <> 'resolved'")
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  return (getDb().prepare(`SELECT * FROM subagent_artifacts ${where} ORDER BY created_at DESC`).all(...values) as Row[]).map(toArtifact)
}

export function settleSubagentArtifact(
  id: string,
  status: Exclude<SubagentArtifactStatus, "active">,
  detail?: unknown
): SubagentArtifact {
  const now = Date.now()
  getDb().prepare(`
    UPDATE subagent_artifacts
    SET status = ?, detail = COALESCE(?, detail), updated_at = ?, resolved_at = ?
    WHERE id = ?
  `).run(
    status,
    detail === undefined ? null : JSON.stringify(detail),
    now,
    status === "resolved" ? now : null,
    id
  )
  return getSubagentArtifact(id)!
}

import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type { IndexPriority, IndexRun, IndexStage } from "../types"

interface IndexRunRow {
  id: string
  workspace_id: string
  task_id: string | null
  enabled: number
  stage: IndexStage
  priority: IndexPriority
  cursor: string | null
  files_scanned: number
  files_total: number
  error: string | null
  created_at: number
  updated_at: number
}

function toIndexRun(row: IndexRunRow): IndexRun {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    enabled: row.enabled === 1,
    stage: row.stage,
    priority: row.priority,
    cursor: row.cursor,
    filesScanned: row.files_scanned,
    filesTotal: row.files_total,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function getRunByWorkspace(workspaceId: string): IndexRun | undefined {
  const row = getDb()
    .prepare("SELECT * FROM index_runs WHERE workspace_id = ?")
    .get(workspaceId) as IndexRunRow | undefined
  return row ? toIndexRun(row) : undefined
}

// Insert-or-update the single run row for a workspace (UNIQUE(workspace_id)).
// Fields left undefined keep their current value (or the insert default). Passing
// a field explicitly to null clears it (task_id, cursor, error).
export function upsertRun(
  workspaceId: string,
  patch: {
    taskId?: string | null
    enabled?: boolean
    stage?: IndexStage
    priority?: IndexPriority
    cursor?: string | null
    filesScanned?: number
    filesTotal?: number
    error?: string | null
  } = {}
): IndexRun {
  const existing = getRunByWorkspace(workspaceId)
  const now = Date.now()
  if (!existing) {
    const id = randomUUID()
    getDb()
      .prepare(
        "INSERT INTO index_runs (id, workspace_id, task_id, enabled, stage, priority, cursor, files_scanned, files_total, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        id,
        workspaceId,
        patch.taskId ?? null,
        patch.enabled === false ? 0 : 1,
        patch.stage ?? "file_map",
        patch.priority ?? "low",
        patch.cursor ?? null,
        patch.filesScanned ?? 0,
        patch.filesTotal ?? 0,
        patch.error ?? null,
        now,
        now
      )
    return getRunByWorkspace(workspaceId)!
  }
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.taskId !== undefined) {
    sets.push("task_id = ?")
    values.push(patch.taskId)
  }
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?")
    values.push(patch.enabled ? 1 : 0)
  }
  if (patch.stage !== undefined) {
    sets.push("stage = ?")
    values.push(patch.stage)
  }
  if (patch.priority !== undefined) {
    sets.push("priority = ?")
    values.push(patch.priority)
  }
  if (patch.cursor !== undefined) {
    sets.push("cursor = ?")
    values.push(patch.cursor)
  }
  if (patch.filesScanned !== undefined) {
    sets.push("files_scanned = ?")
    values.push(patch.filesScanned)
  }
  if (patch.filesTotal !== undefined) {
    sets.push("files_total = ?")
    values.push(patch.filesTotal)
  }
  if (patch.error !== undefined) {
    sets.push("error = ?")
    values.push(patch.error)
  }
  if (sets.length > 0) {
    sets.push("updated_at = ?")
    values.push(now, workspaceId)
    getDb()
      .prepare(
        `UPDATE index_runs SET ${sets.join(", ")} WHERE workspace_id = ?`
      )
      .run(...values)
  }
  return getRunByWorkspace(workspaceId)!
}

// The hot path: write scanned/total + stage + resume cursor as a run progresses.
export function updateProgress(
  workspaceId: string,
  progress: {
    filesScanned?: number
    filesTotal?: number
    stage?: IndexStage
    cursor?: string | null
  }
): void {
  upsertRun(workspaceId, progress)
}

export function setEnabled(workspaceId: string, enabled: boolean): IndexRun {
  return upsertRun(workspaceId, { enabled })
}

// Reset a run to idle after a Clear Index: counts/cursor → 0, stage → file_map,
// task link + error cleared. Keeps the `enabled` flag.
export function resetRun(workspaceId: string): IndexRun {
  return upsertRun(workspaceId, {
    taskId: null,
    stage: "file_map",
    cursor: null,
    filesScanned: 0,
    filesTotal: 0,
    error: null,
  })
}

export function listEnabledRuns(): IndexRun[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM index_runs WHERE enabled = 1 ORDER BY created_at ASC"
    )
    .all() as IndexRunRow[]
  return rows.map(toIndexRun)
}

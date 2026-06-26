import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type { TaskCheckpoint } from "../types"

// Storage-only this phase: resumable state snapshots. The runtime that reads
// these to resume a task is out of scope for now.

interface TaskCheckpointRow {
  id: string
  task_id: string
  label: string | null
  state: string
  created_at: number
}

function toCheckpoint(row: TaskCheckpointRow): TaskCheckpoint {
  return {
    id: row.id,
    taskId: row.task_id,
    label: row.label,
    state: JSON.parse(row.state),
    createdAt: row.created_at,
  }
}

export function createCheckpoint(input: {
  taskId: string
  label?: string | null
  state: unknown
}): TaskCheckpoint {
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      "INSERT INTO task_checkpoints (id, task_id, label, state, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(id, input.taskId, input.label ?? null, JSON.stringify(input.state), now)
  return getCheckpoint(id)!
}

export function getCheckpoint(id: string): TaskCheckpoint | undefined {
  const row = getDb()
    .prepare("SELECT * FROM task_checkpoints WHERE id = ?")
    .get(id) as TaskCheckpointRow | undefined
  return row ? toCheckpoint(row) : undefined
}

export function listCheckpoints(taskId: string): TaskCheckpoint[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM task_checkpoints WHERE task_id = ? ORDER BY created_at ASC"
    )
    .all(taskId) as TaskCheckpointRow[]
  return rows.map(toCheckpoint)
}

export function deleteCheckpoint(id: string): void {
  getDb().prepare("DELETE FROM task_checkpoints WHERE id = ?").run(id)
}

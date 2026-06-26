import { getDb } from "../connection"
import type { TaskEvent } from "../types"

// Append-only event log for a task. Storage-only this phase — the future runner
// defines the `type` vocabulary (task_created, tool_call_requested, etc.).

interface TaskEventRow {
  id: number
  task_id: string
  type: string
  payload: string | null
  created_at: number
}

function toTaskEvent(row: TaskEventRow): TaskEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    type: row.type,
    payload: row.payload ? JSON.parse(row.payload) : null,
    createdAt: row.created_at,
  }
}

export function appendEvent(input: {
  taskId: string
  type: string
  payload?: unknown
}): TaskEvent {
  const now = Date.now()
  const result = getDb()
    .prepare(
      "INSERT INTO task_events (task_id, type, payload, created_at) VALUES (?, ?, ?, ?)"
    )
    .run(
      input.taskId,
      input.type,
      input.payload !== undefined ? JSON.stringify(input.payload) : null,
      now
    )
  const row = getDb()
    .prepare("SELECT * FROM task_events WHERE id = ?")
    .get(result.lastInsertRowid) as TaskEventRow
  return toTaskEvent(row)
}

export function listEvents(
  taskId: string,
  opts?: { afterId?: number; limit?: number }
): TaskEvent[] {
  const clauses = ["task_id = ?"]
  const values: unknown[] = [taskId]
  if (opts?.afterId !== undefined) {
    clauses.push("id > ?")
    values.push(opts.afterId)
  }
  let sql = `SELECT * FROM task_events WHERE ${clauses.join(" AND ")} ORDER BY id ASC`
  if (opts?.limit !== undefined) {
    sql += " LIMIT ?"
    values.push(opts.limit)
  }
  const rows = getDb().prepare(sql).all(...values) as TaskEventRow[]
  return rows.map(toTaskEvent)
}

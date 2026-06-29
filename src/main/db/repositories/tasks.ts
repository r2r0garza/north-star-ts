import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type { Task, TaskStatus } from "../types"

interface TaskRow {
  id: string
  conversation_id: string
  source_conversation_id: string | null
  title: string | null
  status: TaskStatus
  input: string | null
  result: string | null
  error: string | null
  created_at: number
  updated_at: number
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sourceConversationId: row.source_conversation_id,
    title: row.title,
    status: row.status,
    input: row.input ? JSON.parse(row.input) : null,
    result: row.result ? JSON.parse(row.result) : null,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createTask(input: {
  // The task's private worker transcript (a forked conversation).
  conversationId: string
  // The live conversation the task was started from. Defaults to conversationId
  // (self-sourced) when omitted.
  sourceConversationId?: string | null
  title?: string | null
  status?: TaskStatus
  input?: unknown
}): Task {
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      "INSERT INTO tasks (id, conversation_id, source_conversation_id, title, status, input, result, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      id,
      input.conversationId,
      input.sourceConversationId ?? input.conversationId,
      input.title ?? null,
      input.status ?? "queued",
      input.input !== undefined ? JSON.stringify(input.input) : null,
      null,
      null,
      now,
      now
    )
  return getTask(id)!
}

export function getTask(id: string): Task | undefined {
  const row = getDb()
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(id) as TaskRow | undefined
  return row ? toTask(row) : undefined
}

export function listTasks(opts?: {
  conversationId?: string
  sourceConversationId?: string
  status?: TaskStatus
}): Task[] {
  const clauses: string[] = []
  const values: unknown[] = []
  if (opts?.conversationId) {
    clauses.push("conversation_id = ?")
    values.push(opts.conversationId)
  }
  if (opts?.sourceConversationId) {
    clauses.push("source_conversation_id = ?")
    values.push(opts.sourceConversationId)
  }
  if (opts?.status) {
    clauses.push("status = ?")
    values.push(opts.status)
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  const rows = getDb()
    .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC`)
    .all(...values) as TaskRow[]
  return rows.map(toTask)
}

export function updateTask(
  id: string,
  patch: {
    title?: string | null
    status?: TaskStatus
    result?: unknown
    error?: string | null
  }
): Task {
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.title !== undefined) {
    sets.push("title = ?")
    values.push(patch.title)
  }
  if (patch.status !== undefined) {
    sets.push("status = ?")
    values.push(patch.status)
  }
  if (patch.result !== undefined) {
    sets.push("result = ?")
    values.push(patch.result === null ? null : JSON.stringify(patch.result))
  }
  if (patch.error !== undefined) {
    sets.push("error = ?")
    values.push(patch.error)
  }
  if (sets.length > 0) {
    sets.push("updated_at = ?")
    values.push(Date.now(), id)
    getDb().prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values)
  }
  return getTask(id)!
}

export function deleteTask(id: string): void {
  getDb().prepare("DELETE FROM tasks WHERE id = ?").run(id)
}

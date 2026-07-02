import { getDb } from "../connection"
import type { Todo, TodoStatus } from "../types"

// The agent's per-conversation task list. The model writes the whole list at
// once (replace-all) or updates items by id (merge); `runChat` re-injects the
// current list into the prompt each turn so a multi-step plan survives context
// compression. Bounds are enforced HERE so the tool, IPC, and any future caller
// share one definition of "valid".

// Caps mirror hermes todo_tool.py. The list is re-read after every compression
// event, so unbounded content/count would defeat the compression it rides
// through. Generous for real plans — a todo is a short task line, active lists
// are a handful of items.
export const MAX_TODO_ITEMS = 256
export const MAX_TODO_CONTENT_CHARS = 4000
const TRUNCATION_MARKER = "… [truncated]"
const VALID_STATUSES: ReadonlySet<TodoStatus> = new Set([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
])

// The shape a caller hands in for a write — loosely typed because it comes from
// model-supplied tool args. `normalizeItems` validates it into clean rows.
export interface TodoInput {
  id?: unknown
  content?: unknown
  status?: unknown
}

interface TodoRow {
  conversation_id: string
  item_id: string
  seq: number
  content: string
  status: TodoStatus
  created_at: number
  updated_at: number
}

function toTodo(row: TodoRow): Todo {
  return {
    conversationId: row.conversation_id,
    itemId: row.item_id,
    seq: row.seq,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function capContent(content: string): string {
  if (content.length <= MAX_TODO_CONTENT_CHARS) return content
  return (
    content.slice(0, MAX_TODO_CONTENT_CHARS - TRUNCATION_MARKER.length) +
    TRUNCATION_MARKER
  )
}

function normalizeStatus(status: unknown): TodoStatus {
  const s = String(status ?? "")
    .trim()
    .toLowerCase()
  return VALID_STATUSES.has(s as TodoStatus) ? (s as TodoStatus) : "pending"
}

// Clean a list of model-supplied items into valid {itemId, content, status}
// triples: coerce status, cap content, drop blank-content items, dedupe by id
// (last write wins, keeping its position), and cap total count. Items without
// an id get a synthetic positional one so a malformed write still records.
export function normalizeItems(
  items: TodoInput[]
): Array<{ itemId: string; content: string; status: TodoStatus }> {
  const byId = new Map<
    string,
    { itemId: string; content: string; status: TodoStatus }
  >()
  items.forEach((raw, i) => {
    const item = raw && typeof raw === "object" ? raw : {}
    const itemId = String(item.id ?? "").trim() || `item_${i + 1}`
    const content = capContent(String(item.content ?? "").trim())
    if (!content) return // drop items with no description
    byId.set(itemId, { itemId, content, status: normalizeStatus(item.status) })
  })
  return [...byId.values()].slice(0, MAX_TODO_ITEMS)
}

export function listTodos(conversationId: string): Todo[] {
  const rows = getDb()
    .prepare("SELECT * FROM todos WHERE conversation_id = ? ORDER BY seq ASC")
    .all(conversationId) as TodoRow[]
  return rows.map(toTodo)
}

// Replace the entire list for a conversation in one transaction: delete all
// rows, then insert the normalized items with seq = index (array order is
// priority). Passing [] clears the list.
export function replaceTodos(
  conversationId: string,
  items: TodoInput[]
): Todo[] {
  const clean = normalizeItems(items)
  const now = Date.now()
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM todos WHERE conversation_id = ?").run(
      conversationId
    )
    const insert = db.prepare(
      "INSERT INTO todos (conversation_id, item_id, seq, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    clean.forEach((item, i) => {
      insert.run(
        conversationId,
        item.itemId,
        i,
        item.content,
        item.status,
        now,
        now
      )
    })
  })
  tx()
  return listTodos(conversationId)
}

// Update existing items by id (content + status) and append new ones to the end
// in one transaction. Existing items not mentioned are left untouched. Honors
// the item cap when appending.
export function mergeTodos(conversationId: string, items: TodoInput[]): Todo[] {
  const clean = normalizeItems(items)
  const now = Date.now()
  const db = getDb()
  const tx = db.transaction(() => {
    const existing = new Map(
      (
        db
          .prepare("SELECT item_id, seq FROM todos WHERE conversation_id = ?")
          .all(conversationId) as Array<{ item_id: string; seq: number }>
      ).map((r) => [r.item_id, r.seq])
    )
    let nextSeq = existing.size ? Math.max(...existing.values()) + 1 : 0
    let total = existing.size
    const update = db.prepare(
      "UPDATE todos SET content = ?, status = ?, updated_at = ? WHERE conversation_id = ? AND item_id = ?"
    )
    const insert = db.prepare(
      "INSERT INTO todos (conversation_id, item_id, seq, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    for (const item of clean) {
      if (existing.has(item.itemId)) {
        update.run(item.content, item.status, now, conversationId, item.itemId)
      } else if (total < MAX_TODO_ITEMS) {
        // Cap appends so a merge can't grow the list past MAX_TODO_ITEMS.
        insert.run(
          conversationId,
          item.itemId,
          nextSeq++,
          item.content,
          item.status,
          now,
          now
        )
        total++
      }
    }
  })
  tx()
  return listTodos(conversationId)
}

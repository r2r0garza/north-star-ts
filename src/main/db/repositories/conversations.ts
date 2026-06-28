import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type { Conversation, Mode } from "../types"

interface ConversationRow {
  id: string
  mode: Mode
  title: string | null
  workspace_id: string | null
  account_id: string | null
  model_id: string | null
  created_at: number
  updated_at: number
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    mode: row.mode,
    title: row.title,
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    modelId: row.model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createConversation(input: {
  mode: Mode
  workspaceId?: string | null
  title?: string | null
  accountId?: string | null
  modelId?: string | null
}): Conversation {
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      "INSERT INTO conversations (id, mode, title, workspace_id, account_id, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      id,
      input.mode,
      input.title ?? null,
      input.workspaceId ?? null,
      input.accountId ?? null,
      input.modelId ?? null,
      now,
      now
    )
  return getConversation(id)!
}

export function getConversation(id: string): Conversation | undefined {
  const row = getDb()
    .prepare("SELECT * FROM conversations WHERE id = ?")
    .get(id) as ConversationRow | undefined
  return row ? toConversation(row) : undefined
}

export function listConversations(opts?: { mode?: Mode }): Conversation[] {
  const rows = opts?.mode
    ? (getDb()
        .prepare(
          "SELECT * FROM conversations WHERE mode = ? ORDER BY updated_at DESC"
        )
        .all(opts.mode) as ConversationRow[])
    : (getDb()
        .prepare("SELECT * FROM conversations ORDER BY updated_at DESC")
        .all() as ConversationRow[])
  return rows.map(toConversation)
}

export function updateConversation(
  id: string,
  patch: {
    title?: string | null
    workspaceId?: string | null
    accountId?: string | null
    modelId?: string | null
  }
): Conversation {
  const now = Date.now()
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.title !== undefined) {
    sets.push("title = ?")
    values.push(patch.title)
  }
  if (patch.workspaceId !== undefined) {
    sets.push("workspace_id = ?")
    values.push(patch.workspaceId)
  }
  if (patch.accountId !== undefined) {
    sets.push("account_id = ?")
    values.push(patch.accountId)
  }
  if (patch.modelId !== undefined) {
    sets.push("model_id = ?")
    values.push(patch.modelId)
  }
  if (sets.length > 0) {
    sets.push("updated_at = ?")
    values.push(now, id)
    getDb()
      .prepare(`UPDATE conversations SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values)
  }
  return getConversation(id)!
}

// Bump updated_at — called when a message is appended so the sidebar orders
// conversations by recent activity.
export function touchConversation(id: string): void {
  getDb()
    .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
    .run(Date.now(), id)
}

export function deleteConversation(id: string): void {
  getDb().prepare("DELETE FROM conversations WHERE id = ?").run(id)
}

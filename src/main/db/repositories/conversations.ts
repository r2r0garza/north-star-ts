import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type { Conversation, Mode } from "../types"

interface ConversationRow {
  id: string
  mode: Mode
  title: string | null
  workspace_id: string | null
  project_id: string | null
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
    projectId: row.project_id,
    accountId: row.account_id,
    modelId: row.model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createConversation(input: {
  mode: Mode
  workspaceId?: string | null
  projectId?: string | null
  title?: string | null
  accountId?: string | null
  modelId?: string | null
}): Conversation {
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      "INSERT INTO conversations (id, mode, title, workspace_id, project_id, account_id, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      id,
      input.mode,
      input.title ?? null,
      input.workspaceId ?? null,
      input.projectId ?? null,
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

// Lists user-facing conversations for the sidebar. Excludes private task
// transcripts (a conversation that backs a durable task — i.e. is referenced by
// tasks.conversation_id): those are background workers shown in the Workspace
// Activity panel, not standalone chats. A task's progress surfaces under its
// source conversation, so its forked transcript must not clutter the list.
export function listConversations(opts?: { mode?: Mode }): Conversation[] {
  const notTaskTranscript =
    "id NOT IN (SELECT conversation_id FROM tasks WHERE conversation_id IS NOT NULL)"
  const rows = opts?.mode
    ? (getDb()
        .prepare(
          `SELECT * FROM conversations WHERE mode = ? AND ${notTaskTranscript} ORDER BY updated_at DESC`
        )
        .all(opts.mode) as ConversationRow[])
    : (getDb()
        .prepare(
          `SELECT * FROM conversations WHERE ${notTaskTranscript} ORDER BY updated_at DESC`
        )
        .all() as ConversationRow[])
  return rows.map(toConversation)
}

export function updateConversation(
  id: string,
  patch: {
    title?: string | null
    workspaceId?: string | null
    projectId?: string | null
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
  if (patch.projectId !== undefined) {
    sets.push("project_id = ?")
    values.push(patch.projectId)
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

// Delete several conversations in one transaction. Used by the runner's
// session-delete cascade (plan 022): a deleted session and every worker
// conversation of the tasks it sourced are removed together, so ON DELETE
// CASCADE reaps their tasks + messages + todos + approvals + task_events +
// task_checkpoints. Runtime FK enforcement is ON, so each delete cascades (unlike
// migrations, which run with foreign_keys OFF). Ids are deduped — a self-sourced
// task's worker conversation IS the source, so the list can carry duplicates.
export function deleteConversations(ids: string[]): void {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return
  const db = getDb()
  const stmt = db.prepare("DELETE FROM conversations WHERE id = ?")
  db.transaction((rows: string[]) => {
    for (const id of rows) stmt.run(id)
  })(unique)
}

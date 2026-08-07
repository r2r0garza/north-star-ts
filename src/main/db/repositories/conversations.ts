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
  agent_name: string | null
  pinned: number
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
    agentName: row.agent_name,
    pinned: row.pinned === 1,
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
  agentName?: string | null
}): Conversation {
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      "INSERT INTO conversations (id, mode, title, workspace_id, project_id, account_id, model_id, agent_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      id,
      input.mode,
      input.title ?? null,
      input.workspaceId ?? null,
      input.projectId ?? null,
      input.accountId ?? null,
      input.modelId ?? null,
      input.agentName ?? null,
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
// transcripts — the FORKED worker conversations that back durable tasks (todo_run,
// workspace_index, summarize, subagent, …), shown in the Workspace Activity panel,
// not as standalone chats.
//
// The one exception is `inline_todos`: unlike every other kind, that task does not
// fork a worker — it's a completed history marker written onto the REAL, live
// conversation when it finishes an inline todo list (see agent/index.ts). So its
// `conversation_id` is a genuine user conversation. The old filter hid every
// conversation referenced by any task, which wrongly hid these real conversations
// after a todo list ran (they vanished from the sidebar on the next load). Keying
// on the task kind — hide task transcripts EXCEPT inline_todos markers — keeps the
// forks hidden while leaving the real conversations visible. COALESCE mirrors the
// default-kind handling in schema.ts (a missing kind is treated as agent_chat, a
// fork, so it stays hidden).
export function listConversations(opts?: { mode?: Mode }): Conversation[] {
  const notTaskTranscript =
    "id NOT IN (SELECT conversation_id FROM tasks WHERE conversation_id IS NOT NULL AND COALESCE(json_extract(input, '$.kind'), 'agent_chat') <> 'inline_todos')"
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
    agentName?: string | null
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
  if (patch.agentName !== undefined) {
    sets.push("agent_name = ?")
    values.push(patch.agentName)
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

// Pin or unpin a conversation. Deliberately updates ONLY the `pinned` column and
// leaves `updated_at` untouched — unlike updateConversation, which bumps recency
// on every write. That's the whole point: unpinning must return the conversation
// to its natural recency position, which a bumped updated_at would destroy.
export function setConversationPinned(
  id: string,
  pinned: boolean
): Conversation {
  getDb()
    .prepare("UPDATE conversations SET pinned = ? WHERE id = ?")
    .run(pinned ? 1 : 0, id)
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

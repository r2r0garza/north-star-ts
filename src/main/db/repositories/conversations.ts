import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type { Conversation, ConversationSearchResult, Mode } from "../types"

const SEARCH_LIMIT_DEFAULT = 30
const SEARCH_LIMIT_MAX = 50
const MAX_QUERY_LENGTH = 500
const MAX_QUERY_TERMS = 12
const MAX_CONTENT_HITS_PER_TERM = 200
const SNIPPET_START = "\u0001"
const SNIPPET_END = "\u0002"

export const USER_FACING_CONVERSATION_PREDICATE =
  "c.id NOT IN (SELECT conversation_id FROM tasks WHERE conversation_id IS NOT NULL AND COALESCE(json_extract(input, '$.kind'), 'agent_chat') <> 'inline_todos')"

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

export interface ConversationChangeEvent {
  conversationIds: string[]
}

type ConversationChangeListener = (event: ConversationChangeEvent) => void
const conversationChangeListeners = new Set<ConversationChangeListener>()

export function subscribeConversationChanges(
  listener: ConversationChangeListener
): () => void {
  conversationChangeListeners.add(listener)
  return () => {
    conversationChangeListeners.delete(listener)
  }
}

function publishConversationChange(conversationIds: string[]): void {
  if (conversationIds.length === 0) return
  const event = { conversationIds }
  for (const listener of conversationChangeListeners) {
    listener(event)
  }
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
  const conversation = getConversation(id)!
  publishConversationChange([id])
  return conversation
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
  const predicate = USER_FACING_CONVERSATION_PREDICATE.replaceAll("c.", "")
  const rows = opts?.mode
    ? (getDb()
        .prepare(
          `SELECT * FROM conversations WHERE mode = ? AND ${predicate} ORDER BY updated_at DESC`
        )
        .all(opts.mode) as ConversationRow[])
    : (getDb()
        .prepare(
          `SELECT * FROM conversations WHERE ${predicate} ORDER BY updated_at DESC`
        )
        .all() as ConversationRow[])
  return rows.map(toConversation)
}

interface SearchConversationRow {
  id: string
  mode: Mode
  title: string | null
  project_id: string | null
  project_name: string | null
  updated_at: number
}

interface ContentSearchRow {
  message_id: string
  content: string
  relevance: number
}

interface SearchCandidate extends SearchConversationRow {
  titleTerms: Set<number>
  contentTerms: Set<number>
  snippet: string | null
  targetMessageId: string | null
  contentRelevance: number
}

export function searchConversations(
  query: string,
  opts: { limit?: number } = {}
): ConversationSearchResult[] {
  const normalizedQuery = String(query ?? "")
    .normalize("NFKC")
    .slice(0, MAX_QUERY_LENGTH)
    .trim()
  const terms = normalizedQuery
    .match(/[\p{L}\p{N}]+/gu)
    ?.slice(0, MAX_QUERY_TERMS)
    .map((term) => term.toLocaleLowerCase())
  if (!terms?.length) return []

  const limit = normalizeSearchLimit(opts.limit)
  const db = getDb()
  const titleClauses = terms.map(
    () => "LOWER(COALESCE(c.title, '')) LIKE ? ESCAPE '\\'"
  )
  const titleRows = db
    .prepare(
      `SELECT c.id, c.mode, c.title, c.project_id, p.name AS project_name, c.updated_at
       FROM conversations c
       LEFT JOIN projects p ON p.id = c.project_id
       WHERE ${USER_FACING_CONVERSATION_PREDICATE}
         AND (${titleClauses.join(" OR ")})`
    )
    .all(
      ...terms.map((term) => `%${escapeLike(term)}%`)
    ) as SearchConversationRow[]

  const candidates = new Map<string, SearchCandidate>()
  const ensureCandidate = (row: SearchConversationRow): SearchCandidate => {
    let candidate = candidates.get(row.id)
    if (!candidate) {
      candidate = {
        ...row,
        titleTerms: new Set(),
        contentTerms: new Set(),
        snippet: null,
        targetMessageId: null,
        contentRelevance: Number.POSITIVE_INFINITY,
      }
      candidates.set(row.id, candidate)
    }
    return candidate
  }

  for (const row of titleRows) {
    const candidate = ensureCandidate(row)
    const title = (row.title ?? "").normalize("NFKC").toLocaleLowerCase()
    terms.forEach((term, index) => {
      if (title.includes(term)) candidate.titleTerms.add(index)
    })
  }

  const contentStatement = db.prepare(
    `SELECT c.id, c.mode, c.title, c.project_id, p.name AS project_name,
            c.updated_at, m.id AS message_id, m.content,
            bm25(message_fts) AS relevance
     FROM message_fts
     JOIN messages m ON m.id = message_fts.message_id
     JOIN conversations c ON c.id = message_fts.conversation_id
     LEFT JOIN projects p ON p.id = c.project_id
     WHERE message_fts MATCH ?
       AND m.role IN ('user', 'assistant')
       AND m.content IS NOT NULL
       AND ${USER_FACING_CONVERSATION_PREDICATE}
     ORDER BY relevance, m.created_at DESC
     LIMIT ?`
  )

  terms.forEach((term, termIndex) => {
    const rows = contentStatement.all(
      `"${term.replaceAll('"', '""')}"*`,
      MAX_CONTENT_HITS_PER_TERM
    ) as Array<SearchConversationRow & ContentSearchRow>
    for (const row of rows) {
      if (!row.content.normalize("NFKC").toLocaleLowerCase().includes(term)) {
        continue
      }
      const candidate = ensureCandidate(row)
      candidate.contentTerms.add(termIndex)
      if (row.relevance < candidate.contentRelevance) {
        candidate.contentRelevance = row.relevance
        candidate.snippet = createSearchSnippet(row.content, terms)
        candidate.targetMessageId = row.message_id
      }
    }
  })

  const normalizedLower = normalizedQuery.toLocaleLowerCase()
  return [...candidates.values()]
    .filter((candidate) => {
      const covered = new Set([
        ...candidate.titleTerms,
        ...candidate.contentTerms,
      ])
      return covered.size === terms.length
    })
    .map((candidate) => {
      const title = (candidate.title ?? "")
        .normalize("NFKC")
        .toLocaleLowerCase()
      const hasTitle = candidate.titleTerms.size > 0
      const hasContent = candidate.contentTerms.size > 0
      let rank = 400
      if (title === normalizedLower) rank = 0
      else if (title.startsWith(normalizedLower)) rank = 100
      else if (title.includes(normalizedLower)) rank = 200
      else if (hasTitle) rank = 300
      if (!hasTitle && Number.isFinite(candidate.contentRelevance)) {
        rank += candidate.contentRelevance
      }
      return {
        conversationId: candidate.id,
        mode: candidate.mode,
        title: candidate.title,
        projectId: candidate.project_id,
        projectName: candidate.project_name,
        updatedAt: candidate.updated_at,
        matchKind:
          hasTitle && hasContent
            ? ("title_and_content" as const)
            : hasTitle
              ? ("title" as const)
              : ("content" as const),
        snippet: candidate.snippet,
        targetMessageId: candidate.targetMessageId,
        rank,
      }
    })
    .sort((a, b) => a.rank - b.rank || b.updatedAt - a.updatedAt)
    .slice(0, limit)
}

function normalizeSearchLimit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), SEARCH_LIMIT_MAX)
    : SEARCH_LIMIT_DEFAULT
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

function createSearchSnippet(content: string, terms: string[]): string {
  const normalized = content.replace(/\s+/g, " ").trim()
  const lower = normalized.toLocaleLowerCase()
  let matchStart = normalized.length
  let matchLength = 0
  for (const term of terms) {
    const index = lower.indexOf(term)
    if (index >= 0 && index < matchStart) {
      matchStart = index
      matchLength = term.length
    }
  }
  const start = Math.max(0, matchStart - 55)
  const end = Math.min(
    normalized.length,
    matchStart + Math.max(matchLength, 1) + 95
  )
  let snippet = normalized.slice(start, end)
  const snippetLower = snippet.toLocaleLowerCase()
  const ranges = terms
    .map((term) => ({ start: snippetLower.indexOf(term), length: term.length }))
    .filter((range) => range.start >= 0)
    .sort((a, b) => b.start - a.start)
  for (const range of ranges) {
    snippet = `${snippet.slice(0, range.start)}${SNIPPET_START}${snippet.slice(range.start, range.start + range.length)}${SNIPPET_END}${snippet.slice(range.start + range.length)}`
  }
  return `${start > 0 ? "…" : ""}${snippet}${end < normalized.length ? "…" : ""}`
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
    const result = getDb()
      .prepare(`UPDATE conversations SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values)
    if (result.changes > 0) publishConversationChange([id])
  }
  return getConversation(id)!
}

export function setConversationTitleIfUntitled(
  id: string,
  title: string
): Conversation | undefined {
  const result = getDb()
    .prepare(
      "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND (title IS NULL OR title = '')"
    )
    .run(title, Date.now(), id)
  if (result.changes > 0) publishConversationChange([id])
  return getConversation(id)
}

// Pin or unpin a conversation. Deliberately updates ONLY the `pinned` column and
// leaves `updated_at` untouched — unlike updateConversation, which bumps recency
// on every write. That's the whole point: unpinning must return the conversation
// to its natural recency position, which a bumped updated_at would destroy.
export function setConversationPinned(
  id: string,
  pinned: boolean
): Conversation {
  const result = getDb()
    .prepare("UPDATE conversations SET pinned = ? WHERE id = ?")
    .run(pinned ? 1 : 0, id)
  if (result.changes > 0) publishConversationChange([id])
  return getConversation(id)!
}

// Bump updated_at — called when a message is appended so the sidebar orders
// conversations by recent activity.
export function touchConversation(id: string): void {
  const result = getDb()
    .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
    .run(Date.now(), id)
  if (result.changes > 0) publishConversationChange([id])
}

export function deleteConversation(id: string): void {
  const result = getDb()
    .prepare("DELETE FROM conversations WHERE id = ?")
    .run(id)
  if (result.changes > 0) publishConversationChange([id])
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
  const deleted = db.transaction((rows: string[]) => {
    const changed: string[] = []
    for (const id of rows) {
      if (stmt.run(id).changes > 0) changed.push(id)
    }
    return changed
  })(unique)
  publishConversationChange(deleted)
}

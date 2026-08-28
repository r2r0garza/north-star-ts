import { getDb } from "../connection"
import type { Message, MessageRole, ToolCallRecord } from "../types"

const SEARCH_LIMIT_DEFAULT = 20
const SEARCH_LIMIT_MAX = 50
const READ_LIMIT_DEFAULT = 50
const READ_LIMIT_MAX = 100
const MAX_QUERY_TERMS = 12

export interface ConversationSearchOptions {
  roles?: MessageRole[]
  beforeSeq?: number
  afterSeq?: number
  limit?: number
}

export interface ConversationSearchHit {
  conversationId: string
  source: "current" | "task" | "subagent"
  seq: number
  role: MessageRole
  createdAt: number
  toolName: string | null
  snippet: string
}

interface SearchRow {
  conversation_id: string
  source: "current" | "task" | "subagent"
  seq: number
  role: MessageRole
  created_at: number
  tool_name: string | null
  snippet: string
}

interface MessageRow {
  id: string
  conversation_id: string
  seq: number
  role: MessageRole
  content: string | null
  tool_calls: string | null
  tool_call_id: string | null
  tool_name: string | null
  token_estimate: number | null
  created_at: number
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    seq: row.seq,
    role: row.role,
    content: row.content,
    toolCalls: row.tool_calls
      ? (JSON.parse(row.tool_calls) as ToolCallRecord[])
      : null,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    tokenEstimate: row.token_estimate,
    createdAt: row.created_at,
  }
}

export function conversationSearch(
  conversationId: string,
  query: string,
  opts: ConversationSearchOptions = {}
): ConversationSearchHit[] {
  return searchScoped(
    `scope(conversation_id, source) AS (
       SELECT ? AS conversation_id, 'current' AS source
     )`,
    [conversationId],
    query,
    opts
  )
}

export function conversationTreeSearch(
  conversationId: string,
  query: string,
  opts: ConversationSearchOptions & {
    includeTasks?: boolean
    includeSubagents?: boolean
  } = {}
): ConversationSearchHit[] {
  const includeTasks = opts.includeTasks !== false
  const includeSubagents = opts.includeSubagents !== false
  const sourceFilter = ["tree.source = 'current'"]
  if (includeTasks) sourceFilter.push("tree.source = 'task'")
  if (includeSubagents) sourceFilter.push("tree.source = 'subagent'")

  return searchScoped(
    `RECURSIVE tree(conversation_id, source, depth, path) AS (
       SELECT ? AS conversation_id, 'current' AS source, 0 AS depth, ',' || ? || ',' AS path
       UNION ALL
       SELECT
         t.conversation_id,
         CASE
           WHEN json_extract(t.input, '$.kind') = 'subagent' THEN 'subagent'
           ELSE 'task'
         END AS source,
         tree.depth + 1,
         tree.path || t.conversation_id || ','
       FROM tasks t
       JOIN tree ON t.source_conversation_id = tree.conversation_id
       WHERE t.conversation_id IS NOT NULL
         AND t.conversation_id <> tree.conversation_id
         AND instr(tree.path, ',' || t.conversation_id || ',') = 0
         AND tree.depth < 16
     )
     ,
     scope(conversation_id, source) AS (
       SELECT conversation_id, source FROM tree WHERE ${sourceFilter.join(" OR ")}
     )`,
    [conversationId, conversationId],
    query,
    opts
  )
}

export function conversationRead(
  conversationId: string,
  startSeq: number,
  endSeq?: number,
  maxMessages?: number
): Message[] {
  const start = Math.max(1, Math.floor(startSeq))
  const end =
    typeof endSeq === "number" && Number.isFinite(endSeq)
      ? Math.max(start, Math.floor(endSeq))
      : start
  const limit = normalizeLimit(maxMessages, READ_LIMIT_DEFAULT, READ_LIMIT_MAX)
  const rows = getDb()
    .prepare(
      `SELECT * FROM messages
       WHERE conversation_id = ?
         AND seq >= ?
         AND seq <= ?
       ORDER BY seq ASC
       LIMIT ?`
    )
    .all(conversationId, start, end, limit + 1) as MessageRow[]
  return rows.slice(0, limit).map(toMessage)
}

function searchScoped(
  scopeCteSql: string,
  scopeArgs: unknown[],
  query: string,
  opts: ConversationSearchOptions
): ConversationSearchHit[] {
  const match = toFtsQuery(query)
  const limit = normalizeLimit(opts.limit, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX)
  const roleClause = roleFilter(opts.roles)
  const seqClause = sequenceFilter(opts)
  const sql = `WITH ${scopeCteSql}
    SELECT
      f.conversation_id,
      scope.source,
      CAST(f.seq AS INTEGER) AS seq,
      f.role,
      CAST(f.created_at AS INTEGER) AS created_at,
      f.tool_name,
      snippet(message_fts, 6, '[', ']', '...', 16) AS snippet
    FROM message_fts f
    JOIN scope ON scope.conversation_id = f.conversation_id
    WHERE message_fts MATCH ?
      ${roleClause.sql}
      ${seqClause.sql}
    ORDER BY rank, created_at ASC, seq ASC
    LIMIT ?`
  const rows = getDb()
    .prepare(sql)
    .all(
      ...scopeArgs,
      match,
      ...roleClause.args,
      ...seqClause.args,
      limit
    ) as SearchRow[]
  return rows.map((row) => ({
    conversationId: row.conversation_id,
    source: row.source,
    seq: row.seq,
    role: row.role,
    createdAt: row.created_at,
    toolName: row.tool_name,
    snippet: row.snippet,
  }))
}

function toFtsQuery(query: string): string {
  const terms = query
    .match(/[\p{L}\p{N}_@./:-]+/gu)
    ?.slice(0, MAX_QUERY_TERMS)
  if (!terms?.length) {
    throw new Error("Search query must contain at least one searchable term.")
  }
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ")
}

function roleFilter(roles?: MessageRole[]): { sql: string; args: unknown[] } {
  const valid = (roles ?? []).filter((role): role is MessageRole =>
    ["system", "user", "assistant", "tool"].includes(role)
  )
  if (valid.length === 0) return { sql: "", args: [] }
  return {
    sql: `AND f.role IN (${valid.map(() => "?").join(", ")})`,
    args: valid,
  }
}

function sequenceFilter(opts: ConversationSearchOptions): {
  sql: string
  args: unknown[]
} {
  const clauses: string[] = []
  const args: unknown[] = []
  if (typeof opts.afterSeq === "number" && Number.isFinite(opts.afterSeq)) {
    clauses.push("AND CAST(f.seq AS INTEGER) > ?")
    args.push(Math.floor(opts.afterSeq))
  }
  if (typeof opts.beforeSeq === "number" && Number.isFinite(opts.beforeSeq)) {
    clauses.push("AND CAST(f.seq AS INTEGER) < ?")
    args.push(Math.floor(opts.beforeSeq))
  }
  return { sql: clauses.join("\n"), args }
}

function normalizeLimit(
  value: unknown,
  fallback: number,
  max: number
): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), max)
    : fallback
}

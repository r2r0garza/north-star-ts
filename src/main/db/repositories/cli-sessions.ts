import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type { CliSession } from "../types"

interface CliSessionRow {
  conversation_id: string
  provider: "claude_code"
  session_id: string
  created_at: number
  updated_at: number
}

function toSession(row: CliSessionRow): CliSession {
  return {
    conversationId: row.conversation_id,
    provider: row.provider,
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function getCliSession(
  conversationId: string,
  provider: "claude_code"
): CliSession | undefined {
  const row = getDb()
    .prepare(
      "SELECT * FROM cli_sessions WHERE conversation_id = ? AND provider = ?"
    )
    .get(conversationId, provider) as CliSessionRow | undefined
  return row ? toSession(row) : undefined
}

export function ensureCliSession(
  conversationId: string,
  provider: "claude_code"
): { session: CliSession; created: boolean } {
  const existing = getCliSession(conversationId, provider)
  if (existing) return { session: existing, created: false }
  const now = Date.now()
  const sessionId = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO cli_sessions
       (conversation_id, provider, session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(conversationId, provider, sessionId, now, now)
  return { session: getCliSession(conversationId, provider)!, created: true }
}

export function touchCliSession(
  conversationId: string,
  provider: "claude_code"
): void {
  getDb()
    .prepare(
      "UPDATE cli_sessions SET updated_at = ? WHERE conversation_id = ? AND provider = ?"
    )
    .run(Date.now(), conversationId, provider)
}

export function deleteCliSession(
  conversationId: string,
  provider: "claude_code"
): void {
  getDb()
    .prepare(
      "DELETE FROM cli_sessions WHERE conversation_id = ? AND provider = ?"
    )
    .run(conversationId, provider)
}

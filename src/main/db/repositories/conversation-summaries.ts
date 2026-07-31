import { getDb } from "../connection"
import type { ConversationSummary } from "../types"

// The rolling conversation summary (plan 019). One row per conversation, upserted
// by the out-of-band `summarize` task and read by the ContextBuilder's summary
// section. History lives in `messages`; this is a single derived, regenerated
// digest — not versioned.

interface ConversationSummaryRow {
  conversation_id: string
  summary: string
  covers_through: number
  message_count: number
  token_estimate: number | null
  updated_at: number
}

function toSummary(row: ConversationSummaryRow): ConversationSummary {
  return {
    conversationId: row.conversation_id,
    summary: row.summary,
    coversThrough: row.covers_through,
    messageCount: row.message_count,
    tokenEstimate: row.token_estimate,
    updatedAt: row.updated_at,
  }
}

// The current rolling summary for a conversation, or undefined if none exists
// yet. Read by the summary section each turn and by the summarizer to fold the
// prior digest into the next regeneration.
export function getConversationSummary(
  conversationId: string
): ConversationSummary | undefined {
  const row = getDb()
    .prepare("SELECT * FROM conversation_summaries WHERE conversation_id = ?")
    .get(conversationId) as ConversationSummaryRow | undefined
  return row ? toSummary(row) : undefined
}

export interface UpsertConversationSummaryInput {
  conversationId: string
  summary: string
  coversThrough: number
  messageCount: number
  tokenEstimate?: number | null
}

// Write (or replace) the rolling summary for a conversation. The summary is not
// versioned — a regeneration overwrites the single row, advancing coversThrough.
export function upsertConversationSummary(
  input: UpsertConversationSummaryInput
): ConversationSummary {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO conversation_summaries
         (conversation_id, summary, covers_through, message_count, token_estimate, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         summary = excluded.summary,
         covers_through = excluded.covers_through,
         message_count = excluded.message_count,
         token_estimate = excluded.token_estimate,
         updated_at = excluded.updated_at`
    )
    .run(
      input.conversationId,
      input.summary,
      input.coversThrough,
      input.messageCount,
      input.tokenEstimate ?? null,
      now
    )
  return getConversationSummary(input.conversationId)!
}

export function deleteConversationSummary(conversationId: string): void {
  getDb()
    .prepare("DELETE FROM conversation_summaries WHERE conversation_id = ?")
    .run(conversationId)
}

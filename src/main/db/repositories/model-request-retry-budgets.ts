import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type {
  ModelRequestRetryBudget,
  ModelRequestRetryBudgetSource,
  ModelRequestRetryBudgetStatus,
} from "../types"

interface BudgetRow {
  id: string
  conversation_id: string
  logical_round_id: string
  parent_budget_id: string | null
  retry_sequence: number
  source: ModelRequestRetryBudgetSource
  status: ModelRequestRetryBudgetStatus
  attempts_consumed: number
  max_attempts: number
  first_attempt_at: number
  deadline_at: number
  last_error: string | null
  completed_at: number | null
  exhausted_at: number | null
  created_at: number
  updated_at: number
}

function toBudget(row: BudgetRow): ModelRequestRetryBudget {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    logicalRoundId: row.logical_round_id,
    parentBudgetId: row.parent_budget_id,
    retrySequence: row.retry_sequence,
    source: row.source,
    status: row.status,
    attemptsConsumed: row.attempts_consumed,
    maxAttempts: row.max_attempts,
    firstAttemptAt: row.first_attempt_at,
    deadlineAt: row.deadline_at,
    lastError: row.last_error,
    completedAt: row.completed_at,
    exhaustedAt: row.exhausted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function getBudgetById(id: string): ModelRequestRetryBudget | undefined {
  const row = getDb()
    .prepare("SELECT * FROM model_request_retry_budgets WHERE id = ?")
    .get(id) as BudgetRow | undefined
  return row ? toBudget(row) : undefined
}

export function getBudget(
  conversationId: string,
  logicalRoundId: string
): ModelRequestRetryBudget | undefined {
  const row = getDb()
    .prepare(
      "SELECT * FROM model_request_retry_budgets WHERE conversation_id = ? AND logical_round_id = ?"
    )
    .get(conversationId, logicalRoundId) as BudgetRow | undefined
  return row ? toBudget(row) : undefined
}

export function listBudgetsForConversation(
  conversationId: string
): ModelRequestRetryBudget[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM model_request_retry_budgets WHERE conversation_id = ? ORDER BY created_at ASC"
    )
    .all(conversationId) as BudgetRow[]
  return rows.map(toBudget)
}

export function latestExhaustedBudget(
  conversationId: string
): ModelRequestRetryBudget | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM model_request_retry_budgets
       WHERE conversation_id = ? AND status = 'exhausted'
       ORDER BY COALESCE(exhausted_at, updated_at) DESC, created_at DESC
       LIMIT 1`
    )
    .get(conversationId) as BudgetRow | undefined
  return row ? toBudget(row) : undefined
}

export function createLinkedRetryBudget(input: {
  conversationId: string
  logicalRoundId: string
  parentBudgetId?: string
  maxAttempts?: number
  maxElapsedMs?: number
  now?: number
}): ModelRequestRetryBudget | undefined {
  const now = input.now ?? Date.now()
  const maxAttempts = input.maxAttempts ?? 3
  const maxElapsedMs = input.maxElapsedMs ?? 120_000
  const db = getDb()
  const tx = db.transaction(() => {
    const existing = getBudget(input.conversationId, input.logicalRoundId)
    if (existing) return existing

    const parent = input.parentBudgetId
      ? getBudgetById(input.parentBudgetId)
      : latestExhaustedBudget(input.conversationId)
    if (!parent || parent.status !== "exhausted") return undefined

    const id = randomUUID()
    db.prepare(
      `INSERT INTO model_request_retry_budgets
        (id, conversation_id, logical_round_id, parent_budget_id,
         retry_sequence, source, status, attempts_consumed, max_attempts,
         first_attempt_at, deadline_at, last_error, completed_at,
         exhausted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'user_retry', 'in_progress', 0, ?, ?, ?,
         NULL, NULL, NULL, ?, ?)`
    ).run(
      id,
      input.conversationId,
      input.logicalRoundId,
      parent.id,
      parent.retrySequence + 1,
      maxAttempts,
      now,
      now + maxElapsedMs,
      now,
      now
    )
    return getBudget(input.conversationId, input.logicalRoundId)
  })
  return tx()
}

export function consumeAttempt(input: {
  conversationId: string
  logicalRoundId: string
  maxAttempts: number
  maxElapsedMs: number
  now?: number
}): ModelRequestRetryBudget {
  const now = input.now ?? Date.now()
  const db = getDb()
  const tx = db.transaction(() => {
    const existing = getBudget(input.conversationId, input.logicalRoundId)
    if (!existing) {
      const id = randomUUID()
      db.prepare(
        `INSERT INTO model_request_retry_budgets
          (id, conversation_id, logical_round_id, status, attempts_consumed,
           max_attempts, first_attempt_at, deadline_at, last_error,
           completed_at, exhausted_at, created_at, updated_at)
         VALUES (?, ?, ?, 'in_progress', 1, ?, ?, ?, NULL, NULL, NULL, ?, ?)`
      ).run(
        id,
        input.conversationId,
        input.logicalRoundId,
        input.maxAttempts,
        now,
        now + input.maxElapsedMs,
        now,
        now
      )
      return getBudget(input.conversationId, input.logicalRoundId)!
    }
    if (existing.status !== "in_progress") return existing
    if (
      existing.attemptsConsumed >= existing.maxAttempts ||
      now >= existing.deadlineAt
    ) {
      exhaustBudget({
        conversationId: input.conversationId,
        logicalRoundId: input.logicalRoundId,
        error: existing.lastError ?? "Retry budget exhausted before transport",
        now,
      })
      return getBudget(input.conversationId, input.logicalRoundId)!
    }
    db.prepare(
      `UPDATE model_request_retry_budgets
       SET attempts_consumed = attempts_consumed + 1,
           updated_at = ?
       WHERE conversation_id = ? AND logical_round_id = ?`
    ).run(now, input.conversationId, input.logicalRoundId)
    return getBudget(input.conversationId, input.logicalRoundId)!
  })
  return tx()
}

export function recordFailure(input: {
  conversationId: string
  logicalRoundId: string
  error: string
  now?: number
}): ModelRequestRetryBudget {
  const now = input.now ?? Date.now()
  getDb()
    .prepare(
      `UPDATE model_request_retry_budgets
       SET last_error = ?, updated_at = ?
       WHERE conversation_id = ? AND logical_round_id = ?`
    )
    .run(input.error, now, input.conversationId, input.logicalRoundId)
  return getBudget(input.conversationId, input.logicalRoundId)!
}

export function completeBudget(input: {
  conversationId: string
  logicalRoundId: string
  now?: number
}): ModelRequestRetryBudget {
  const now = input.now ?? Date.now()
  getDb()
    .prepare(
      `UPDATE model_request_retry_budgets
       SET status = 'completed',
           completed_at = COALESCE(completed_at, ?),
           updated_at = ?
       WHERE conversation_id = ? AND logical_round_id = ?`
    )
    .run(now, now, input.conversationId, input.logicalRoundId)
  return getBudget(input.conversationId, input.logicalRoundId)!
}

export function exhaustBudget(input: {
  conversationId: string
  logicalRoundId: string
  error: string
  now?: number
}): ModelRequestRetryBudget {
  const now = input.now ?? Date.now()
  getDb()
    .prepare(
      `UPDATE model_request_retry_budgets
       SET status = 'exhausted',
           last_error = ?,
           exhausted_at = COALESCE(exhausted_at, ?),
           updated_at = ?
       WHERE conversation_id = ? AND logical_round_id = ?`
    )
    .run(input.error, now, now, input.conversationId, input.logicalRoundId)
  return getBudget(input.conversationId, input.logicalRoundId)!
}

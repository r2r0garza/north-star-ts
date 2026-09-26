import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type {
  RigDecisionRight,
  SeatMessage,
  SeatMessageKind,
  SeatMessageStatus,
  SeatThread,
  SeatThreadAnchorKind,
} from "../types"

// The Mission Control message bus's storage (plan 106.4). Threads anchor a
// conversation to work; messages move queued → delivered → replied |
// acknowledged | expired, or are stored as refused so the refusal stays visible
// in Comms. Every status transition is a conditional UPDATE, so a replayed
// delivery (crash, double dispatch) changes nothing the second time.

interface SeatThreadRow {
  id: string
  feature_id: string
  anchor_kind: SeatThreadAnchorKind | null
  anchor_id: string | null
  subject: string
  created_at: number
}

interface SeatMessageRow {
  id: string
  thread_id: string
  feature_id: string
  from_address: string
  to_address: string
  in_reply_to: string | null
  hop: number
  body: string
  kind: SeatMessageKind
  status: SeatMessageStatus
  expects_reply: number
  needs_decision: RigDecisionRight | null
  refusal_reason: string | null
  answer_only: number
  wake_task_id: string | null
  delivered_conversation_id: string | null
  delivered_message_id: string | null
  created_at: number
  delivered_at: number | null
}

function toThread(row: SeatThreadRow): SeatThread {
  return {
    id: row.id,
    featureId: row.feature_id,
    anchorKind: row.anchor_kind,
    anchorId: row.anchor_id,
    subject: row.subject,
    createdAt: row.created_at,
  }
}

function toMessage(row: SeatMessageRow): SeatMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    featureId: row.feature_id,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    inReplyTo: row.in_reply_to,
    hop: row.hop,
    body: row.body,
    kind: row.kind,
    status: row.status,
    expectsReply: row.expects_reply === 1,
    needsDecision: row.needs_decision,
    refusalReason: row.refusal_reason,
    answerOnly: row.answer_only === 1,
    wakeTaskId: row.wake_task_id,
    deliveredConversationId: row.delivered_conversation_id,
    deliveredMessageId: row.delivered_message_id,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  }
}

// ── threads ─────────────────────────────────────────────────────────────────

export function createThread(input: {
  featureId: string
  anchorKind: SeatThreadAnchorKind | null
  anchorId: string | null
  subject: string
}): SeatThread {
  const id = randomUUID()
  getDb()
    .prepare(
      "INSERT INTO seat_threads (id, feature_id, anchor_kind, anchor_id, subject, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(
      id,
      input.featureId,
      input.anchorKind,
      input.anchorId,
      input.subject,
      Date.now()
    )
  return getThread(id)!
}

export function getThread(id: string): SeatThread | undefined {
  const row = getDb()
    .prepare("SELECT * FROM seat_threads WHERE id = ?")
    .get(id) as SeatThreadRow | undefined
  return row ? toThread(row) : undefined
}

export function findThreadBySubject(
  featureId: string,
  subject: string
): SeatThread | undefined {
  const row = getDb()
    .prepare(
      "SELECT * FROM seat_threads WHERE feature_id = ? AND subject = ? ORDER BY created_at ASC LIMIT 1"
    )
    .get(featureId, subject) as SeatThreadRow | undefined
  return row ? toThread(row) : undefined
}

export function listThreads(featureId: string): SeatThread[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM seat_threads WHERE feature_id = ? ORDER BY created_at ASC"
    )
    .all(featureId) as SeatThreadRow[]
  return rows.map(toThread)
}

// ── messages ────────────────────────────────────────────────────────────────

export function insertMessage(input: {
  threadId: string
  featureId: string
  fromAddress: string
  toAddress: string
  inReplyTo?: string | null
  hop: number
  body: string
  kind: SeatMessageKind
  status: "queued" | "delivered" | "refused"
  expectsReply?: boolean
  needsDecision?: RigDecisionRight | null
  refusalReason?: string | null
}): SeatMessage {
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      "INSERT INTO seat_messages (id, thread_id, feature_id, from_address, to_address, in_reply_to, hop, body, kind, status, expects_reply, needs_decision, refusal_reason, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      id,
      input.threadId,
      input.featureId,
      input.fromAddress,
      input.toAddress,
      input.inReplyTo ?? null,
      input.hop,
      input.body,
      input.kind,
      input.status,
      input.expectsReply ? 1 : 0,
      input.needsDecision ?? null,
      input.refusalReason ?? null,
      now,
      input.status === "delivered" ? now : null
    )
  return getMessage(id)!
}

export function getMessage(id: string): SeatMessage | undefined {
  const row = getDb()
    .prepare("SELECT * FROM seat_messages WHERE id = ?")
    .get(id) as SeatMessageRow | undefined
  return row ? toMessage(row) : undefined
}

export function listMessages(filter: {
  featureId: string
  threadId?: string
  toAddress?: string
  statuses?: SeatMessageStatus[]
  limit?: number
}): SeatMessage[] {
  const where = ["feature_id = ?"]
  const values: unknown[] = [filter.featureId]
  if (filter.threadId) {
    where.push("thread_id = ?")
    values.push(filter.threadId)
  }
  if (filter.toAddress) {
    where.push("to_address = ?")
    values.push(filter.toAddress)
  }
  if (filter.statuses?.length) {
    where.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`)
    values.push(...filter.statuses)
  }
  // Newest N, returned oldest first (a feed reads top to bottom).
  const limit = filter.limit ?? 1000
  const rows = getDb()
    .prepare(
      `SELECT * FROM (SELECT *, rowid AS seq FROM seat_messages WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at ASC, seq ASC`
    )
    .all(...values, limit) as SeatMessageRow[]
  return rows.map(toMessage)
}

export function countQueued(featureId: string, toAddress: string): number {
  return getDb()
    .prepare(
      "SELECT COUNT(*) FROM seat_messages WHERE feature_id = ? AND to_address = ? AND status = 'queued'"
    )
    .pluck()
    .get(featureId, toAddress) as number
}

// Refusals count against the thread rate too: a sender hammering a bound is
// exactly the ceremony the limit exists to stop.
export function countThreadMessagesSince(threadId: string, since: number): number {
  return getDb()
    .prepare(
      "SELECT COUNT(*) FROM seat_messages WHERE thread_id = ? AND created_at >= ?"
    )
    .pluck()
    .get(threadId, since) as number
}

// Seat addresses in a feature that have queued mail, for dispatch.
export function listQueuedRecipients(): Array<{
  featureId: string
  toAddress: string
}> {
  return getDb()
    .prepare(
      "SELECT DISTINCT feature_id AS featureId, to_address AS toAddress FROM seat_messages WHERE status = 'queued'"
    )
    .all() as Array<{ featureId: string; toAddress: string }>
}

// Claim queued messages for one delivery. Only rows still `queued` flip, so a
// second claimant (a racing wake, a replayed dispatch) gets nothing.
export function claimQueued(input: {
  ids: string[]
  conversationId: string
  wakeTaskId: string | null
  answerOnly: boolean
}): SeatMessage[] {
  const now = Date.now()
  const stmt = getDb().prepare(
    "UPDATE seat_messages SET status = 'delivered', delivered_at = ?, delivered_conversation_id = ?, wake_task_id = ?, answer_only = ? WHERE id = ? AND status = 'queued'"
  )
  const claimed: SeatMessage[] = []
  for (const id of input.ids) {
    const result = stmt.run(
      now,
      input.conversationId,
      input.wakeTaskId,
      input.answerOnly ? 1 : 0,
      id
    )
    if (result.changes === 1) claimed.push(getMessage(id)!)
  }
  return claimed
}

export function setDeliveredMessageId(ids: string[], messageId: string): void {
  const stmt = getDb().prepare(
    "UPDATE seat_messages SET delivered_message_id = ? WHERE id = ?"
  )
  for (const id of ids) stmt.run(messageId, id)
}

export function listByWakeTask(taskId: string): SeatMessage[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM seat_messages WHERE wake_task_id = ? ORDER BY created_at ASC"
    )
    .all(taskId) as SeatMessageRow[]
  return rows.map(toMessage)
}

// Move a message on only from the statuses it may leave, so a late event can
// never reopen a settled message.
export function transitionMessage(
  id: string,
  to: SeatMessageStatus,
  from: SeatMessageStatus[]
): boolean {
  const result = getDb()
    .prepare(
      `UPDATE seat_messages SET status = ? WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`
    )
    .run(to, id, ...from)
  return result.changes === 1
}

export function hasReplyFrom(messageId: string, fromAddress: string): boolean {
  return !!getDb()
    .prepare(
      "SELECT 1 FROM seat_messages WHERE in_reply_to = ? AND from_address = ? AND status <> 'refused' LIMIT 1"
    )
    .get(messageId, fromAddress)
}

export function expireQueued(featureId: string): number {
  return getDb()
    .prepare(
      "UPDATE seat_messages SET status = 'expired' WHERE feature_id = ? AND status = 'queued'"
    )
    .run(featureId).changes
}

// Supersede a sender's undelivered mail to one seat (plan 106.6): a newer
// Navigator direction replaces the one still waiting, so a lead reads the
// current position rather than a backlog of stale ones.
export function expireQueuedFrom(
  featureId: string,
  fromAddress: string,
  toAddress: string
): number {
  return getDb()
    .prepare(
      "UPDATE seat_messages SET status = 'expired' WHERE feature_id = ? AND from_address = ? AND to_address = ? AND status = 'queued'"
    )
    .run(featureId, fromAddress, toAddress).changes
}

// Seat-sent messages in a feature since a time, for the hourly message
// budget. The user and the Navigator don't count; refusals don't either.
export function countSeatMessagesSince(featureId: string, since: number): number {
  return getDb()
    .prepare(
      "SELECT COUNT(*) FROM seat_messages WHERE feature_id = ? AND created_at >= ? AND status <> 'refused' AND from_address NOT IN ('user@rig', 'navigator@rig')"
    )
    .pluck()
    .get(featureId, since) as number
}

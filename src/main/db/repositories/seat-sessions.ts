import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type {
  SeatSession,
  SeatSessionScope,
  SeatSessionStatus,
} from "../types"

// Mission Control seat sessions (plan 106.4). A seat's conversation for one
// scope: the whole initiative (`scope_key` = 'initiative'), or one playbook run
// (`scope_key` = its id). Each scope rotates into numbered generations; at most
// one generation per (seat, scope) is live (idle or busy) at a time, and older
// ones are `rotated` or `closed` and stay readable.

export const INITIATIVE_SCOPE_KEY = "initiative"

interface SeatSessionRow {
  id: string
  initiative_id: string
  seat_address: string
  scope: SeatSessionScope
  scope_key: string
  playbook_run_id: string | null
  generation: number
  conversation_id: string | null
  status: SeatSessionStatus
  handoff_summary: string | null
  rotation_reason: string | null
  failure_count: number
  created_at: number
  last_activity_at: number | null
  rotated_at: number | null
}

const LIVE_STATUSES = "('idle', 'busy')"

function toSession(row: SeatSessionRow): SeatSession {
  return {
    id: row.id,
    initiativeId: row.initiative_id,
    seatAddress: row.seat_address,
    scope: row.scope,
    playbookRunId: row.scope === "slice" ? row.scope_key : null,
    generation: row.generation,
    conversationId: row.conversation_id,
    status: row.status,
    handoffSummary: row.handoff_summary,
    rotationReason: row.rotation_reason,
    failureCount: row.failure_count,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    rotatedAt: row.rotated_at,
  }
}

export function getSeatSession(id: string): SeatSession | undefined {
  const row = getDb()
    .prepare("SELECT * FROM seat_sessions WHERE id = ?")
    .get(id) as SeatSessionRow | undefined
  return row ? toSession(row) : undefined
}

// The live session for one scope: the initiative's by default, or a playbook
// run's slice session when `playbookRunId` is given.
export function getLiveSeatSession(
  initiativeId: string,
  seatAddress: string,
  playbookRunId: string | null = null
): SeatSession | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM seat_sessions WHERE initiative_id = ? AND seat_address = ? AND scope_key = ? AND status IN ${LIVE_STATUSES} ORDER BY generation DESC LIMIT 1`
    )
    .get(
      initiativeId,
      seatAddress,
      playbookRunId ?? INITIATIVE_SCOPE_KEY
    ) as SeatSessionRow | undefined
  return row ? toSession(row) : undefined
}

export function getSeatSessionByConversation(
  conversationId: string
): SeatSession | undefined {
  const row = getDb()
    .prepare(
      "SELECT * FROM seat_sessions WHERE conversation_id = ? ORDER BY generation DESC LIMIT 1"
    )
    .get(conversationId) as SeatSessionRow | undefined
  return row ? toSession(row) : undefined
}

export function listSeatSessions(filter: {
  initiativeId: string
  seatAddress?: string
  liveOnly?: boolean
  // Only the initiative scope (null), or only one playbook run's sessions.
  playbookRunId?: string | null
}): SeatSession[] {
  const where = ["initiative_id = ?"]
  const values: unknown[] = [filter.initiativeId]
  if (filter.seatAddress) {
    where.push("seat_address = ?")
    values.push(filter.seatAddress)
  }
  if (filter.playbookRunId !== undefined) {
    where.push("scope_key = ?")
    values.push(filter.playbookRunId ?? INITIATIVE_SCOPE_KEY)
  }
  if (filter.liveOnly) where.push(`status IN ${LIVE_STATUSES}`)
  const rows = getDb()
    .prepare(
      `SELECT * FROM seat_sessions WHERE ${where.join(" AND ")} ORDER BY seat_address ASC, created_at DESC, generation DESC`
    )
    .all(...values) as SeatSessionRow[]
  return rows.map(toSession)
}

function nextGeneration(
  initiativeId: string,
  seatAddress: string,
  scopeKey: string
): number {
  const max = getDb()
    .prepare(
      "SELECT MAX(generation) FROM seat_sessions WHERE initiative_id = ? AND seat_address = ? AND scope_key = ?"
    )
    .pluck()
    .get(initiativeId, seatAddress, scopeKey) as number | null
  return (max ?? 0) + 1
}

export function createSeatSession(input: {
  initiativeId: string
  seatAddress: string
  conversationId: string
  handoffSummary?: string | null
  // Set for a slice session: the playbook run it belongs to.
  playbookRunId?: string | null
}): SeatSession {
  const id = randomUUID()
  const now = Date.now()
  const scopeKey = input.playbookRunId ?? INITIATIVE_SCOPE_KEY
  getDb()
    .prepare(
      "INSERT INTO seat_sessions (id, initiative_id, seat_address, scope, scope_key, playbook_run_id, generation, conversation_id, status, handoff_summary, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?)"
    )
    .run(
      id,
      input.initiativeId,
      input.seatAddress,
      input.playbookRunId ? "slice" : "initiative",
      scopeKey,
      input.playbookRunId ?? null,
      nextGeneration(input.initiativeId, input.seatAddress, scopeKey),
      input.conversationId,
      input.handoffSummary ?? null,
      now,
      now
    )
  return getSeatSession(id)!
}

// Only a live session changes between idle and busy; a rotated or closed one
// never comes back.
export function setSeatSessionStatus(
  id: string,
  status: "idle" | "busy"
): void {
  getDb()
    .prepare(
      `UPDATE seat_sessions SET status = ?, last_activity_at = ? WHERE id = ? AND status IN ${LIVE_STATUSES}`
    )
    .run(status, Date.now(), id)
}

export function recordSeatSessionTurn(id: string, failed: boolean): SeatSession {
  getDb()
    .prepare(
      `UPDATE seat_sessions SET failure_count = ${failed ? "failure_count + 1" : "0"}, last_activity_at = ? WHERE id = ?`
    )
    .run(Date.now(), id)
  return getSeatSession(id)!
}

// Retire a live generation. Returns false when it was already retired, so a
// racing rotation cannot start two successors.
export function retireSeatSession(
  id: string,
  status: "rotated" | "closed",
  reason: string
): boolean {
  const result = getDb()
    .prepare(
      `UPDATE seat_sessions SET status = ?, rotation_reason = ?, rotated_at = ? WHERE id = ? AND status IN ${LIVE_STATUSES}`
    )
    .run(status, reason, Date.now(), id)
  return result.changes === 1
}

// A finished playbook run's slice sessions close; their transcripts stay.
export function closeRunSessions(playbookRunId: string): SeatSession[] {
  const live = getDb()
    .prepare(
      `SELECT * FROM seat_sessions WHERE scope_key = ? AND status IN ${LIVE_STATUSES}`
    )
    .all(playbookRunId) as SeatSessionRow[]
  for (const row of live)
    retireSeatSession(row.id, "closed", "The slice run finished")
  return live.map(toSession)
}

// Boot: nothing is mid-turn after a restart, so a `busy` session is idle.
export function resetBusySeatSessions(): void {
  getDb()
    .prepare("UPDATE seat_sessions SET status = 'idle' WHERE status = 'busy'")
    .run()
}

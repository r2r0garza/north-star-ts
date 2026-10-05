import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type {
  SeatMemory,
  SeatMemoryExposure,
  SeatMemoryKind,
  SeatMemorySource,
  SeatMemoryStatus,
} from "../types"

// Seat memory (plan 106.7): lessons attached to a seat of a rig, with
// provenance (where each was learned), lineage (which lesson a shared copy came
// from), and exposures (which conversations were shown it), so a bad lesson
// can be retracted along with every copy and every session that saw it told.

export const SEAT_MEMORY_MAX_CHARS = 500

interface SeatMemoryRow {
  id: string
  rig_id: string
  seat_address: string
  content: string
  kind: SeatMemoryKind
  status: SeatMemoryStatus
  source: SeatMemorySource
  origin_feature_id: string | null
  origin_conversation_id: string | null
  origin_session_id: string | null
  origin_user_story_id: string | null
  origin_message_id: string | null
  derived_from: string | null
  use_count: number
  last_used_at: number | null
  created_at: number
  reviewed_at: number | null
  retracted_at: number | null
  retract_reason: string | null
  exposure_count?: number
}

function toMemory(row: SeatMemoryRow): SeatMemory {
  return {
    id: row.id,
    rigId: row.rig_id,
    seatAddress: row.seat_address,
    content: row.content,
    kind: row.kind,
    status: row.status,
    source: row.source,
    originFeatureId: row.origin_feature_id,
    originConversationId: row.origin_conversation_id,
    originSessionId: row.origin_session_id,
    originUserStoryId: row.origin_user_story_id,
    originMessageId: row.origin_message_id,
    derivedFrom: row.derived_from,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    retractedAt: row.retracted_at,
    retractReason: row.retract_reason,
    ...(row.exposure_count !== undefined
      ? { exposureCount: row.exposure_count }
      : {}),
  }
}

export function clampSeatMemory(content: string): string {
  const text = content.replace(/\s+/g, " ").trim()
  return text.length > SEAT_MEMORY_MAX_CHARS
    ? `${text.slice(0, SEAT_MEMORY_MAX_CHARS - 1).trimEnd()}…`
    : text
}

export interface CreateSeatMemoryInput {
  rigId: string
  seatAddress: string
  content: string
  kind: SeatMemoryKind
  status: Exclude<SeatMemoryStatus, "retracted">
  source?: SeatMemorySource
  originFeatureId?: string | null
  originConversationId?: string | null
  originSessionId?: string | null
  originUserStoryId?: string | null
  originMessageId?: string | null
  derivedFrom?: string | null
}

export function createSeatMemory(input: CreateSeatMemoryInput): SeatMemory {
  const content = clampSeatMemory(input.content)
  if (!content) throw new Error("A seat lesson needs content.")
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO seat_memories
        (id, rig_id, seat_address, content, kind, status, source, origin_feature_id,
         origin_conversation_id, origin_session_id, origin_user_story_id, origin_message_id,
         derived_from, created_at, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.rigId,
      input.seatAddress,
      content,
      input.kind,
      input.status,
      input.source ?? "learned",
      input.originFeatureId ?? null,
      input.originConversationId ?? null,
      input.originSessionId ?? null,
      input.originUserStoryId ?? null,
      input.originMessageId ?? null,
      input.derivedFrom ?? null,
      now,
      input.status === "active" ? now : null
    )
  return getSeatMemory(id)!
}

const SELECT_WITH_EXPOSURES = `
  SELECT m.*, (SELECT COUNT(*) FROM seat_memory_exposures e WHERE e.memory_id = m.id) AS exposure_count
  FROM seat_memories m`

export function getSeatMemory(id: string): SeatMemory | null {
  const row = getDb()
    .prepare(`${SELECT_WITH_EXPOSURES} WHERE m.id = ?`)
    .get(id) as SeatMemoryRow | undefined
  return row ? toMemory(row) : null
}

export function listSeatMemories(filter: {
  rigId: string
  seatAddress?: string
  status?: SeatMemoryStatus
}): SeatMemory[] {
  const where = ["m.rig_id = ?"]
  const args: unknown[] = [filter.rigId]
  if (filter.seatAddress) {
    where.push("m.seat_address = ?")
    args.push(filter.seatAddress)
  }
  if (filter.status) {
    where.push("m.status = ?")
    args.push(filter.status)
  }
  const rows = getDb()
    .prepare(
      `${SELECT_WITH_EXPOSURES} WHERE ${where.join(" AND ")} ORDER BY m.created_at DESC, m.id`
    )
    .all(...args) as SeatMemoryRow[]
  return rows.map(toMemory)
}

// The lessons injected into a seat's turns: active ones, most used and most
// recent first, capped.
export function activeSeatMemories(
  rigId: string,
  seatAddress: string,
  limit = 20
): SeatMemory[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM seat_memories
       WHERE rig_id = ? AND seat_address = ? AND status = 'active'
       ORDER BY COALESCE(last_used_at, reviewed_at, created_at) DESC, use_count DESC, id
       LIMIT ?`
    )
    .all(rigId, seatAddress, limit) as SeatMemoryRow[]
  return rows.map(toMemory)
}

export function countPendingSeatMemories(rigId: string): number {
  return (
    getDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM seat_memories WHERE rig_id = ? AND status = 'pending_review'"
      )
      .get(rigId) as { n: number }
  ).n
}

// Review: approve (optionally with edited content) or reject a pending lesson.
// Rejecting deletes it: it was never shown to anyone.
export function reviewSeatMemory(
  id: string,
  decision: "approve" | "reject",
  content?: string
): SeatMemory | null {
  const db = getDb()
  const current = getSeatMemory(id)
  if (!current) throw new Error("That lesson no longer exists.")
  if (current.status !== "pending_review")
    throw new Error(
      `That lesson is already ${current.status.replace(/_/g, " ")}.`
    )
  if (decision === "reject") {
    db.prepare(
      "DELETE FROM seat_memories WHERE id = ? AND status = 'pending_review'"
    ).run(id)
    return null
  }
  const text =
    content === undefined ? current.content : clampSeatMemory(content)
  if (!text) throw new Error("A seat lesson needs content.")
  db.prepare(
    "UPDATE seat_memories SET status = 'active', content = ?, reviewed_at = ? WHERE id = ? AND status = 'pending_review'"
  ).run(text, Date.now(), id)
  return getSeatMemory(id)
}

// A lesson and every copy shared from it, transitively.
export function descendantIds(id: string): string[] {
  const rows = getDb()
    .prepare(
      `WITH RECURSIVE lineage(id) AS (
         SELECT ?
         UNION
         SELECT m.id FROM seat_memories m JOIN lineage l ON m.derived_from = l.id
       )
       SELECT id FROM lineage`
    )
    .all(id) as Array<{ id: string }>
  return rows.map((row) => row.id)
}

// The chain a shared copy came from, nearest ancestor first.
export function ancestorsOf(id: string): SeatMemory[] {
  const chain: SeatMemory[] = []
  const seen = new Set<string>([id])
  let next = getSeatMemory(id)?.derivedFrom ?? null
  while (next && !seen.has(next)) {
    seen.add(next)
    const memory = getSeatMemory(next)
    if (!memory) break
    chain.push(memory)
    next = memory.derivedFrom
  }
  return chain
}

// Retract a lesson and every copy of it. Returns the rows it retracted (those
// not retracted already).
export function retractSeatMemories(id: string, reason: string): SeatMemory[] {
  const db = getDb()
  return db.transaction(() => {
    const ids = descendantIds(id)
    const now = Date.now()
    const retract = db.prepare(
      "UPDATE seat_memories SET status = 'retracted', retracted_at = ?, retract_reason = ? WHERE id = ? AND status != 'retracted'"
    )
    const changed = ids.filter(
      (memoryId) => retract.run(now, reason, memoryId).changes > 0
    )
    return changed.map((memoryId) => getSeatMemory(memoryId)!)
  })()
}

// Record that these lessons were shown in a conversation (contact tracing),
// and count the use.
export function recordExposures(
  memoryIds: string[],
  exposure: {
    conversationId: string
    featureId: string | null
    seatAddress: string
  }
): void {
  if (!memoryIds.length) return
  const db = getDb()
  const now = Date.now()
  const insert = db.prepare(
    `INSERT INTO seat_memory_exposures (memory_id, conversation_id, feature_id, seat_address, injected_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (memory_id, conversation_id) DO NOTHING`
  )
  const use = db.prepare(
    "UPDATE seat_memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?"
  )
  db.transaction(() => {
    for (const memoryId of memoryIds) {
      if (
        insert.run(
          memoryId,
          exposure.conversationId,
          exposure.featureId,
          exposure.seatAddress,
          now
        ).changes > 0
      )
        use.run(now, memoryId)
    }
  })()
}

export function listExposures(memoryIds: string[]): SeatMemoryExposure[] {
  if (!memoryIds.length) return []
  const rows = getDb()
    .prepare(
      `SELECT memory_id, conversation_id, feature_id, seat_address, injected_at
       FROM seat_memory_exposures
       WHERE memory_id IN (${memoryIds.map(() => "?").join(",")})
       ORDER BY injected_at`
    )
    .all(...memoryIds) as Array<{
    memory_id: string
    conversation_id: string
    feature_id: string | null
    seat_address: string
    injected_at: number
  }>
  return rows.map((row) => ({
    memoryId: row.memory_id,
    conversationId: row.conversation_id,
    featureId: row.feature_id,
    seatAddress: row.seat_address,
    injectedAt: row.injected_at,
  }))
}

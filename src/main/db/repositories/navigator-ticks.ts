import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type {
  NavigatorTick,
  NavigatorTickAction,
  NavigatorTickState,
} from "../types"

// The Navigator's tick log (plan 106.6). A row is written only when the
// position changed, so the log reads as "what the Navigator saw and did". It
// is bounded per initiative.

export const MAX_TICKS_PER_INITIATIVE = 200

interface TickRow {
  id: string
  initiative_id: string
  position_hash: string
  summary: string
  actions: string
  decision_keys: string
  state: string
  created_at: number
}

function list<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function object<T>(value: string): T {
  try {
    const parsed = JSON.parse(value) as unknown
    return (parsed && typeof parsed === "object" ? parsed : {}) as T
  } catch {
    return {} as T
  }
}

function toTick(row: TickRow): NavigatorTick {
  return {
    id: row.id,
    initiativeId: row.initiative_id,
    positionHash: row.position_hash,
    summary: row.summary,
    actions: list<NavigatorTickAction>(row.actions),
    decisionKeys: list<string>(row.decision_keys),
    state: object<NavigatorTickState>(row.state),
    createdAt: row.created_at,
  }
}

export function lastTick(initiativeId: string): NavigatorTick | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM navigator_ticks WHERE initiative_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"
    )
    .get(initiativeId) as TickRow | undefined
  return row ? toTick(row) : null
}

export function listTicks(initiativeId: string, limit = 50): NavigatorTick[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM navigator_ticks WHERE initiative_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?"
      )
      .all(initiativeId, Math.max(1, Math.min(MAX_TICKS_PER_INITIATIVE, limit))) as TickRow[]
  ).map(toTick)
}

export function recordTick(input: {
  initiativeId: string
  positionHash: string
  summary: string
  actions: NavigatorTickAction[]
  decisionKeys: string[]
  state: NavigatorTickState
  createdAt?: number
}): NavigatorTick {
  const id = randomUUID()
  getDb().transaction(() => {
    getDb()
      .prepare(
        "INSERT INTO navigator_ticks (id, initiative_id, position_hash, summary, actions, decision_keys, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        id,
        input.initiativeId,
        input.positionHash,
        input.summary,
        JSON.stringify(input.actions),
        JSON.stringify(input.decisionKeys),
        JSON.stringify(input.state),
        input.createdAt ?? Date.now()
      )
    getDb()
      .prepare(
        `DELETE FROM navigator_ticks WHERE initiative_id = ? AND id NOT IN (
           SELECT id FROM navigator_ticks WHERE initiative_id = ?
           ORDER BY created_at DESC, rowid DESC LIMIT ?)`
      )
      .run(input.initiativeId, input.initiativeId, MAX_TICKS_PER_INITIATIVE)
  })()
  return lastTick(input.initiativeId)!
}

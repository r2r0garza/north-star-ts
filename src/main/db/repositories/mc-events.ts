import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type { McEvent, McEventClass } from "../types"
import {
  HEALTH_EVENTS,
  type HealthEventType,
} from "../../../shared/mission-control/health-weights"

// The progress/ceremony event stream (plan 106.8). One append-only row per
// durable Mission Control event, written at the existing write sites through
// recordEvent(). Nothing here parses transcripts. A row derived from another
// row carries its id as ref_id, unique per type, so a replayed write (crash
// recovery, a double dispatch) records nothing the second time.

interface McEventRow {
  id: string
  feature_id: string
  milestone_id: string | null
  user_story_id: string | null
  seat_address: string | null
  class: McEventClass
  type: string
  weight: number
  ref_id: string | null
  detail: string | null
  created_at: number
}

function toEvent(row: McEventRow): McEvent {
  let detail: Record<string, unknown> | null = null
  if (row.detail)
    try {
      detail = JSON.parse(row.detail) as Record<string, unknown>
    } catch {
      detail = null
    }
  return {
    id: row.id,
    featureId: row.feature_id,
    milestoneId: row.milestone_id,
    userStoryId: row.user_story_id,
    seatAddress: row.seat_address,
    class: row.class,
    type: row.type,
    weight: row.weight,
    refId: row.ref_id,
    detail,
    createdAt: row.created_at,
  }
}

type Listener = (featureId: string) => void
const listeners = new Set<Listener>()

// Fires with the feature id after a new event is recorded (the health monitor
// re-evaluates, debounced).
export function onEventRecorded(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export interface RecordEventInput {
  featureId: string
  type: HealthEventType
  milestoneId?: string | null
  userStoryId?: string | null
  seatAddress?: string | null
  refId?: string | null
  detail?: Record<string, unknown> | null
  createdAt?: number
}

// Record one event. Never throws: health instrumentation must not break the
// write it observes. Returns false when nothing was recorded (a replay, or
// the feature is gone).
export function recordEvent(input: RecordEventInput): boolean {
  try {
    const spec = HEALTH_EVENTS[input.type]
    const milestoneId =
      input.milestoneId ??
      (input.userStoryId ? milestoneOfUserStory(input.userStoryId) : null)
    const result = getDb()
      .prepare(
        `INSERT OR IGNORE INTO mc_events (id, feature_id, milestone_id, user_story_id, seat_address, class, type, weight, ref_id, detail, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM features WHERE id = ?)`
      )
      .run(
        randomUUID(),
        input.featureId,
        milestoneId,
        input.userStoryId ?? null,
        input.seatAddress ?? null,
        spec.class,
        input.type,
        spec.weight,
        input.refId ?? null,
        input.detail ? JSON.stringify(input.detail) : null,
        input.createdAt ?? Date.now(),
        input.featureId
      )
    if (result.changes !== 1) return false
    for (const listener of listeners) {
      try {
        listener(input.featureId)
      } catch (err) {
        console.error("Health event listener failed:", err)
      }
    }
    return true
  } catch (err) {
    console.warn(`[health] could not record ${input.type}:`, err)
    return false
  }
}

export function listEvents(
  featureId: string,
  options: { since?: number; types?: string[] } = {}
): McEvent[] {
  const where = ["feature_id = ?"]
  const values: unknown[] = [featureId]
  if (options.since !== undefined) {
    where.push("created_at >= ?")
    values.push(options.since)
  }
  if (options.types?.length) {
    where.push(`type IN (${options.types.map(() => "?").join(", ")})`)
    values.push(...options.types)
  }
  return (
    getDb()
      .prepare(
        `SELECT * FROM mc_events WHERE ${where.join(" AND ")} ORDER BY created_at ASC, rowid ASC`
      )
      .all(...values) as McEventRow[]
  ).map(toEvent)
}

export function getEvents(ids: string[]): McEvent[] {
  if (!ids.length) return []
  return (
    getDb()
      .prepare(
        `SELECT * FROM mc_events WHERE id IN (${ids.map(() => "?").join(", ")}) ORDER BY created_at ASC`
      )
      .all(...ids) as McEventRow[]
  ).map(toEvent)
}

// ── where a write belongs in Mission Control ────────────────────────────────

function milestoneOfUserStory(userStoryId: string): string | null {
  return (
    (getDb()
      .prepare("SELECT milestone_id FROM user_stories WHERE id = ?")
      .pluck()
      .get(userStoryId) as string | undefined) ?? null
  )
}

export interface MissionControlContext {
  featureId: string
  milestoneId: string | null
  userStoryId: string | null
  playbookRunId: string
  hook: string
}

// The playbook run a Process run executes, if any (a user story attempt or a
// hook): how process-engine writes (validator rounds, rework, approvals) find
// the feature they count against.
export function contextForProcessRun(
  processRunId: string
): MissionControlContext | null {
  const row = getDb()
    .prepare(
      "SELECT id, feature_id, milestone_id, user_story_id, hook FROM playbook_runs WHERE process_run_id = ? LIMIT 1"
    )
    .get(processRunId) as
    | {
        id: string
        feature_id: string
        milestone_id: string | null
        user_story_id: string | null
        hook: string
      }
    | undefined
  return row
    ? {
        featureId: row.feature_id,
        milestoneId: row.milestone_id,
        userStoryId: row.user_story_id,
        playbookRunId: row.id,
        hook: row.hook,
      }
    : null
}

export function contextForTask(taskId: string): MissionControlContext | null {
  const runId = getDb()
    .prepare("SELECT id FROM process_runs WHERE task_id = ? LIMIT 1")
    .pluck()
    .get(taskId) as string | undefined
  return runId ? contextForProcessRun(runId) : null
}

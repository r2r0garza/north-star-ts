import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type { MergeQueueEntry, MergeQueueStatus } from "../types"

// The Mission Control merge queue (plan 106.5). One row per slice attempt whose
// proof was accepted; the integration service moves it through
// queued → merging → merged, or parks it at conflict / resolving. Every
// transition is conditional on the current status, so a replay after a crash
// or a race between the live path and boot reconcile applies once.

interface MergeQueueRow {
  id: string
  mission_id: string
  slice_id: string
  playbook_run_id: string | null
  status: MergeQueueStatus
  attempt: number
  slice_head: string | null
  conflict_files: string
  merge_commit: string | null
  touched_files: string
  outside_hints: string
  note: string | null
  escalated: number
  resolution_run_id: string | null
  resolution_worktree: string | null
  resolution_start_oid: string | null
  resolution_attempts: number
  proof_accepted_at: number
  created_at: number
  updated_at: number
  started_at: number | null
  finished_at: number | null
}

export const OPEN_MERGE_STATUSES: readonly MergeQueueStatus[] = [
  "queued",
  "merging",
  "conflict",
  "resolving",
]

function list(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []
  } catch {
    return []
  }
}

function toEntry(row: MergeQueueRow): MergeQueueEntry {
  return {
    id: row.id,
    missionId: row.mission_id,
    sliceId: row.slice_id,
    playbookRunId: row.playbook_run_id,
    status: row.status,
    attempt: row.attempt,
    sliceHead: row.slice_head,
    conflictFiles: list(row.conflict_files),
    mergeCommit: row.merge_commit,
    touchedFiles: list(row.touched_files),
    outsideHints: list(row.outside_hints),
    note: row.note,
    escalated: row.escalated === 1,
    resolutionRunId: row.resolution_run_id,
    resolutionWorktree: row.resolution_worktree,
    resolutionStartOid: row.resolution_start_oid,
    resolutionAttempts: row.resolution_attempts,
    proofAcceptedAt: row.proof_accepted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

export function getMergeEntry(id: string): MergeQueueEntry | null {
  const row = getDb().prepare("SELECT * FROM merge_queue WHERE id = ?").get(id) as
    | MergeQueueRow
    | undefined
  return row ? toEntry(row) : null
}

export function listMergeEntries(filter: {
  missionId?: string
  sliceId?: string
  initiativeId?: string
  statuses?: readonly MergeQueueStatus[]
}): MergeQueueEntry[] {
  const clauses: string[] = []
  const values: unknown[] = []
  if (filter.missionId) {
    clauses.push("mission_id = ?")
    values.push(filter.missionId)
  }
  if (filter.sliceId) {
    clauses.push("slice_id = ?")
    values.push(filter.sliceId)
  }
  if (filter.initiativeId) {
    clauses.push(
      "mission_id IN (SELECT id FROM missions WHERE initiative_id = ?)"
    )
    values.push(filter.initiativeId)
  }
  if (filter.statuses?.length) {
    clauses.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`)
    values.push(...filter.statuses)
  }
  return (
    getDb()
      .prepare(
        `SELECT * FROM merge_queue ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at, id`
      )
      .all(...values) as MergeQueueRow[]
  ).map(toEntry)
}

export function openMergeEntryForSlice(sliceId: string): MergeQueueEntry | null {
  return listMergeEntries({ sliceId, statuses: OPEN_MERGE_STATUSES }).at(0) ?? null
}

export function getMergeEntryByResolutionRun(
  playbookRunId: string
): MergeQueueEntry | null {
  const row = getDb()
    .prepare("SELECT * FROM merge_queue WHERE resolution_run_id = ?")
    .get(playbookRunId) as MergeQueueRow | undefined
  return row ? toEntry(row) : null
}

export function enqueueMerge(input: {
  missionId: string
  sliceId: string
  playbookRunId: string | null
  proofAcceptedAt: number
}): MergeQueueEntry {
  const existing = openMergeEntryForSlice(input.sliceId)
  if (existing) return existing
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      "INSERT INTO merge_queue (id, mission_id, slice_id, playbook_run_id, status, proof_accepted_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)"
    )
    .run(
      id,
      input.missionId,
      input.sliceId,
      input.playbookRunId,
      input.proofAcceptedAt,
      now,
      now
    )
  return getMergeEntry(id)!
}

export interface MergeEntryPatch {
  status?: MergeQueueStatus
  attempt?: number
  sliceHead?: string | null
  conflictFiles?: string[]
  mergeCommit?: string | null
  touchedFiles?: string[]
  outsideHints?: string[]
  note?: string | null
  escalated?: boolean
  resolutionRunId?: string | null
  resolutionWorktree?: string | null
  resolutionStartOid?: string | null
  resolutionAttempts?: number
  startedAt?: number | null
  finishedAt?: number | null
}

// Apply a patch only while the entry is in one of `from` (when given).
// Returns the updated entry, or null when the guard did not match.
export function updateMergeEntry(
  id: string,
  patch: MergeEntryPatch,
  from?: readonly MergeQueueStatus[]
): MergeQueueEntry | null {
  const sets: string[] = []
  const values: unknown[] = []
  const add = (column: string, value: unknown) => {
    sets.push(`${column} = ?`)
    values.push(value)
  }
  if (patch.status !== undefined) add("status", patch.status)
  if (patch.attempt !== undefined) add("attempt", patch.attempt)
  if (patch.sliceHead !== undefined) add("slice_head", patch.sliceHead)
  if (patch.conflictFiles !== undefined)
    add("conflict_files", JSON.stringify(patch.conflictFiles))
  if (patch.mergeCommit !== undefined) add("merge_commit", patch.mergeCommit)
  if (patch.touchedFiles !== undefined)
    add("touched_files", JSON.stringify(patch.touchedFiles))
  if (patch.outsideHints !== undefined)
    add("outside_hints", JSON.stringify(patch.outsideHints))
  if (patch.note !== undefined) add("note", patch.note)
  if (patch.escalated !== undefined) add("escalated", patch.escalated ? 1 : 0)
  if (patch.resolutionRunId !== undefined)
    add("resolution_run_id", patch.resolutionRunId)
  if (patch.resolutionWorktree !== undefined)
    add("resolution_worktree", patch.resolutionWorktree)
  if (patch.resolutionStartOid !== undefined)
    add("resolution_start_oid", patch.resolutionStartOid)
  if (patch.resolutionAttempts !== undefined)
    add("resolution_attempts", patch.resolutionAttempts)
  if (patch.startedAt !== undefined) add("started_at", patch.startedAt)
  if (patch.finishedAt !== undefined) add("finished_at", patch.finishedAt)
  add("updated_at", Date.now())
  values.push(id)
  let where = "id = ?"
  if (from?.length) {
    where += ` AND status IN (${from.map(() => "?").join(", ")})`
    values.push(...from)
  }
  const result = getDb()
    .prepare(`UPDATE merge_queue SET ${sets.join(", ")} WHERE ${where}`)
    .run(...values)
  return result.changes === 1 ? getMergeEntry(id) : null
}

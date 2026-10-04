import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type { WaveGate, WaveGateStatus } from "../types"

// Wave acceptance gates (plan 110). One row per gate a milestone ran over its
// merged user stories. A gate's batch is fixed when it opens, so membership
// never depends on re-deriving waves after the plan changes. Status changes
// are conditional on the current status, so a replay applies once.

interface WaveGateRow {
  id: string
  milestone_id: string
  round: number
  story_ids: string
  status: WaveGateStatus
  playbook_run_id: string | null
  report: string | null
  checks_commit: string | null
  created_at: number
  finished_at: number | null
}

export const OPEN_WAVE_GATE_STATUSES: readonly WaveGateStatus[] = [
  "running",
  "fixing",
  "escalated",
]

function parse(value: string | null): unknown {
  if (value === null) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function toGate(row: WaveGateRow): WaveGate {
  const ids = parse(row.story_ids)
  return {
    id: row.id,
    milestoneId: row.milestone_id,
    round: row.round,
    storyIds: Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === "string")
      : [],
    status: row.status,
    playbookRunId: row.playbook_run_id,
    report: parse(row.report),
    checksCommit: row.checks_commit,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  }
}

export function getWaveGate(id: string): WaveGate | null {
  const row = getDb()
    .prepare("SELECT * FROM wave_gates WHERE id = ?")
    .get(id) as WaveGateRow | undefined
  return row ? toGate(row) : null
}

export function getWaveGateByRun(playbookRunId: string): WaveGate | null {
  const row = getDb()
    .prepare("SELECT * FROM wave_gates WHERE playbook_run_id = ?")
    .get(playbookRunId) as WaveGateRow | undefined
  return row ? toGate(row) : null
}

// A milestone's gates, oldest round first.
export function listWaveGates(milestoneId: string): WaveGate[] {
  return (
    getDb()
      .prepare("SELECT * FROM wave_gates WHERE milestone_id = ? ORDER BY round")
      .all(milestoneId) as WaveGateRow[]
  ).map(toGate)
}

export function listFeatureWaveGates(featureId: string): WaveGate[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM wave_gates WHERE milestone_id IN (SELECT id FROM milestones WHERE feature_id = ?) ORDER BY milestone_id, round"
      )
      .all(featureId) as WaveGateRow[]
  ).map(toGate)
}

// Open the milestone's next gate over `storyIds`.
export function createWaveGate(input: {
  milestoneId: string
  storyIds: string[]
  playbookRunId: string | null
}): WaveGate {
  const id = randomUUID()
  const { next } = getDb()
    .prepare(
      "SELECT COALESCE(MAX(round), 0) + 1 AS next FROM wave_gates WHERE milestone_id = ?"
    )
    .get(input.milestoneId) as { next: number }
  getDb()
    .prepare(
      "INSERT INTO wave_gates (id, milestone_id, round, story_ids, status, playbook_run_id, created_at) VALUES (?, ?, ?, ?, 'running', ?, ?)"
    )
    .run(
      id,
      input.milestoneId,
      next,
      JSON.stringify(input.storyIds),
      input.playbookRunId,
      Date.now()
    )
  return getWaveGate(id)!
}

// Move a gate to `status` while it is in one of `from`. Returns the updated
// gate, or null when the guard did not match.
export function finishWaveGate(
  id: string,
  status: Exclude<WaveGateStatus, "running">,
  patch: { report?: unknown; checksCommit?: string | null } = {},
  from: readonly WaveGateStatus[] = ["running"]
): WaveGate | null {
  const sets = ["status = ?", "finished_at = ?"]
  const values: unknown[] = [status, Date.now()]
  if (patch.report !== undefined) {
    sets.push("report = ?")
    values.push(JSON.stringify(patch.report))
  }
  if (patch.checksCommit !== undefined) {
    sets.push("checks_commit = ?")
    values.push(patch.checksCommit)
  }
  const result = getDb()
    .prepare(
      `UPDATE wave_gates SET ${sets.join(", ")} WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`
    )
    .run(...values, id, ...from)
  return result.changes === 1 ? getWaveGate(id) : null
}

// QA's record (plan 110.02) on a gate that is still running. The latest
// record wins until the gate finishes.
export function setRunningWaveGateReport(id: string, report: unknown): boolean {
  return (
    getDb()
      .prepare(
        "UPDATE wave_gates SET report = ? WHERE id = ? AND status = 'running'"
      )
      .run(JSON.stringify(report), id).changes === 1
  )
}

// Replace a gate's report while it is in one of `from`, keeping its status
// (an escalation decided while others still wait, plan 110.03).
export function setWaveGateReport(
  id: string,
  report: unknown,
  from: readonly WaveGateStatus[]
): WaveGate | null {
  const result = getDb()
    .prepare(
      `UPDATE wave_gates SET report = ? WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`
    )
    .run(JSON.stringify(report), id, ...from)
  return result.changes === 1 ? getWaveGate(id) : null
}

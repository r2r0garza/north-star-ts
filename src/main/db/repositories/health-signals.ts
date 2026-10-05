import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type {
  HealthAnchorKind,
  HealthEvidence,
  HealthSeverity,
  HealthSignal,
  HealthSignalStatus,
} from "../types"

// Health signals (plan 106.8): one row per (detector, anchor) episode. A
// signal is open while its detector keeps firing, resolves when it stops,
// and moves to acknowledged or muted only by the user.

interface HealthSignalRow {
  id: string
  feature_id: string
  detector: string
  anchor_kind: HealthAnchorKind
  anchor_id: string
  anchor_label: string
  severity: HealthSeverity
  status: HealthSignalStatus
  summary: string
  evidence: string
  fire_count: number
  first_seen_at: number
  last_seen_at: number
  alerted_at: number | null
  alerted_to: string | null
  critical_at: number | null
  acknowledged_at: number | null
  resolved_at: number | null
  refocus_count: number
  last_refocus_at: number | null
  refocus_conversations: string
  ignored_count: number
}

function list<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function toSignal(row: HealthSignalRow): HealthSignal {
  return {
    id: row.id,
    featureId: row.feature_id,
    detector: row.detector,
    anchorKind: row.anchor_kind,
    anchorId: row.anchor_id,
    anchorLabel: row.anchor_label,
    severity: row.severity,
    status: row.status,
    summary: row.summary,
    evidence: list<HealthEvidence>(row.evidence),
    fireCount: row.fire_count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    alertedAt: row.alerted_at,
    alertedTo: row.alerted_to,
    criticalAt: row.critical_at,
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at,
    refocusCount: row.refocus_count,
    lastRefocusAt: row.last_refocus_at,
    refocusConversations: list<string>(row.refocus_conversations),
    ignoredCount: row.ignored_count,
  }
}

export function getSignal(id: string): HealthSignal | null {
  const row = getDb()
    .prepare("SELECT * FROM health_signals WHERE id = ?")
    .get(id) as HealthSignalRow | undefined
  return row ? toSignal(row) : null
}

// Newest first.
export function listSignals(
  featureId: string,
  options: { statuses?: HealthSignalStatus[] } = {}
): HealthSignal[] {
  const where = ["feature_id = ?"]
  const values: unknown[] = [featureId]
  if (options.statuses?.length) {
    where.push(`status IN (${options.statuses.map(() => "?").join(", ")})`)
    values.push(...options.statuses)
  }
  return (
    getDb()
      .prepare(
        `SELECT * FROM health_signals WHERE ${where.join(" AND ")} ORDER BY last_seen_at DESC, rowid DESC`
      )
      .all(...values) as HealthSignalRow[]
  ).map(toSignal)
}

// The latest signal for one (detector, anchor), whatever its status.
export function latestSignal(
  featureId: string,
  detector: string,
  anchorKind: HealthAnchorKind,
  anchorId: string
): HealthSignal | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM health_signals WHERE feature_id = ? AND detector = ? AND anchor_kind = ? AND anchor_id = ? ORDER BY first_seen_at DESC, rowid DESC LIMIT 1"
    )
    .get(featureId, detector, anchorKind, anchorId) as
    | HealthSignalRow
    | undefined
  return row ? toSignal(row) : null
}

export function createSignal(input: {
  featureId: string
  detector: string
  anchorKind: HealthAnchorKind
  anchorId: string
  anchorLabel: string
  severity: HealthSeverity
  summary: string
  evidence: HealthEvidence[]
  now: number
}): HealthSignal {
  const id = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO health_signals (id, feature_id, detector, anchor_kind, anchor_id, anchor_label, severity, status, summary, evidence, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
    )
    .run(
      id,
      input.featureId,
      input.detector,
      input.anchorKind,
      input.anchorId,
      input.anchorLabel,
      input.severity,
      input.summary,
      JSON.stringify(input.evidence),
      input.now,
      input.now
    )
  return getSignal(id)!
}

export interface SignalPatch {
  severity?: HealthSeverity
  status?: HealthSignalStatus
  summary?: string
  anchorLabel?: string
  evidence?: HealthEvidence[]
  fireCount?: number
  lastSeenAt?: number
  alertedAt?: number | null
  alertedTo?: string | null
  criticalAt?: number | null
  acknowledgedAt?: number | null
  resolvedAt?: number | null
  refocusCount?: number
  lastRefocusAt?: number | null
  refocusConversations?: string[]
  ignoredCount?: number
}

const COLUMNS: Record<keyof SignalPatch, string> = {
  severity: "severity",
  status: "status",
  summary: "summary",
  anchorLabel: "anchor_label",
  evidence: "evidence",
  fireCount: "fire_count",
  lastSeenAt: "last_seen_at",
  alertedAt: "alerted_at",
  alertedTo: "alerted_to",
  criticalAt: "critical_at",
  acknowledgedAt: "acknowledged_at",
  resolvedAt: "resolved_at",
  refocusCount: "refocus_count",
  lastRefocusAt: "last_refocus_at",
  refocusConversations: "refocus_conversations",
  ignoredCount: "ignored_count",
}

export function updateSignal(id: string, patch: SignalPatch): HealthSignal {
  const sets: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(patch) as Array<
    [keyof SignalPatch, unknown]
  >) {
    if (value === undefined) continue
    sets.push(`${COLUMNS[key]} = ?`)
    values.push(Array.isArray(value) ? JSON.stringify(value) : value)
  }
  if (sets.length)
    getDb()
      .prepare(`UPDATE health_signals SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values, id)
  return getSignal(id)!
}

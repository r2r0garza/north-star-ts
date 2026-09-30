import { getDb } from "../connection"
import type {
  Finding,
  WorkspaceAnalysis,
} from "../../../shared/mission-control/workspace-analysis"

// A Feature's workspace setup analysis (plan 106.11). The analysis itself is
// derived and replaced on each run; dismissals, check results, and command
// approvals are the user's and survive re-analysis.

export interface CommandApproval {
  command: string
  cwd: string
  fingerprint: string | null
  findingKey: string
  at: number
}

export interface StoredCheckResult {
  ok: boolean
  detail: string
  at: number
  fingerprint: string
}

export interface StoredAnalysis {
  analysis: WorkspaceAnalysis
  // The finding drafts the analysis produced (before resolving against the
  // current settings), so a settings change re-resolves without re-probing.
  // Typed loosely here: the shape belongs to the analysis service.
  drafts: unknown[]
  lastRuns: Record<string, NonNullable<Finding["lastRun"]>>
  dismissals: Record<string, string>
  checkResults: Record<string, StoredCheckResult>
  approvals: CommandApproval[]
}

interface Row {
  feature_id: string
  workspace_id: string
  data: string
  dismissals: string
  check_results: string
  approvals: string
  updated_at: number
}

function parse<T>(value: string | null | undefined, fallback: T): T {
  try {
    return value ? (JSON.parse(value) as T) : fallback
  } catch {
    return fallback
  }
}

export function getStoredAnalysis(featureId: string): StoredAnalysis | null {
  const row = getDb()
    .prepare("SELECT * FROM workspace_analyses WHERE feature_id = ?")
    .get(featureId) as Row | undefined
  if (!row) return null
  const data = parse<{
    analysis?: WorkspaceAnalysis
    drafts?: unknown[]
    lastRuns?: StoredAnalysis["lastRuns"]
  } | null>(row.data, null)
  if (!data?.analysis) return null
  return {
    analysis: data.analysis,
    drafts: Array.isArray(data.drafts) ? data.drafts : [],
    lastRuns: data.lastRuns ?? {},
    dismissals: parse(row.dismissals, {}),
    checkResults: parse(row.check_results, {}),
    approvals: parse(row.approvals, []),
  }
}

export function saveStoredAnalysis(
  featureId: string,
  stored: StoredAnalysis
): void {
  getDb()
    .prepare(
      `INSERT INTO workspace_analyses (feature_id, workspace_id, data, dismissals, check_results, approvals, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM features WHERE id = ?)
       ON CONFLICT(feature_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         data = excluded.data,
         dismissals = excluded.dismissals,
         check_results = excluded.check_results,
         approvals = excluded.approvals,
         updated_at = excluded.updated_at`
    )
    .run(
      featureId,
      stored.analysis.workspaceId,
      JSON.stringify({
        analysis: stored.analysis,
        drafts: stored.drafts,
        lastRuns: stored.lastRuns,
      }),
      JSON.stringify(stored.dismissals),
      JSON.stringify(stored.checkResults),
      JSON.stringify(stored.approvals.slice(-200)),
      Date.now(),
      featureId
    )
}

export function deleteStoredAnalysis(featureId: string): void {
  getDb()
    .prepare("DELETE FROM workspace_analyses WHERE feature_id = ?")
    .run(featureId)
}

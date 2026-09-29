import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type { PlanProposal } from "../types"
import type {
  PlanChange,
  ProposalFollowup,
  ProposalKind,
  ProposalStatus,
} from "../../../shared/mission-control/plan-changes"
import { emitWorkChanged } from "../../mission-control/work-events"

// Plan proposals (plan 106.6): every plan change outside a seat's decision
// rights or the active milestone waits here for the user to apply or reject.

interface ProposalRow {
  id: string
  feature_id: string
  milestone_id: string | null
  kind: ProposalKind
  changes: string
  proposer: string
  reason: string
  followup: string | null
  status: ProposalStatus
  resolved_by: string | null
  resolution_note: string | null
  created_at: number
  resolved_at: number | null
}

function toProposal(row: ProposalRow): PlanProposal {
  let changes: PlanChange[] = []
  try {
    changes = JSON.parse(row.changes) as PlanChange[]
  } catch {
    changes = []
  }
  let followup: ProposalFollowup | null = null
  try {
    followup = row.followup
      ? (JSON.parse(row.followup) as ProposalFollowup)
      : null
  } catch {
    followup = null
  }
  return {
    id: row.id,
    featureId: row.feature_id,
    milestoneId: row.milestone_id,
    kind: row.kind,
    changes,
    proposer: row.proposer,
    reason: row.reason,
    followup,
    status: row.status,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}

export function createProposal(input: {
  featureId: string
  milestoneId: string | null
  kind: ProposalKind
  changes: PlanChange[]
  proposer: string
  reason: string
  followup?: ProposalFollowup | null
}): PlanProposal {
  const id = randomUUID()
  getDb()
    .prepare(
      "INSERT INTO plan_proposals (id, feature_id, milestone_id, kind, changes, proposer, reason, followup, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)"
    )
    .run(
      id,
      input.featureId,
      input.milestoneId,
      input.kind,
      JSON.stringify(input.changes),
      input.proposer,
      input.reason.trim(),
      input.followup ? JSON.stringify(input.followup) : null,
      Date.now()
    )
  emitWorkChanged(input.featureId)
  return getProposal(id)!
}

export function getProposal(id: string): PlanProposal | null {
  const row = getDb()
    .prepare("SELECT * FROM plan_proposals WHERE id = ?")
    .get(id) as ProposalRow | undefined
  return row ? toProposal(row) : null
}

export function listProposals(
  featureId: string,
  status?: ProposalStatus
): PlanProposal[] {
  const rows = (
    status
      ? getDb()
          .prepare(
            "SELECT * FROM plan_proposals WHERE feature_id = ? AND status = ? ORDER BY created_at, id"
          )
          .all(featureId, status)
      : getDb()
          .prepare(
            "SELECT * FROM plan_proposals WHERE feature_id = ? ORDER BY created_at DESC, id DESC"
          )
          .all(featureId)
  ) as ProposalRow[]
  return rows.map(toProposal)
}

// Pending follow-ups anchored in a milestone (its user stories or itself), for
// the milestone review.
export function listPendingFollowups(
  featureId: string,
  milestoneId: string
): PlanProposal[] {
  return listProposals(featureId, "pending").filter(
    (p) => p.kind === "followup" && p.milestoneId === milestoneId
  )
}

// Record the changes a follow-up turned into when it was applied.
export function setProposalChanges(id: string, changes: PlanChange[]): void {
  getDb()
    .prepare(
      "UPDATE plan_proposals SET changes = ? WHERE id = ? AND status = 'pending'"
    )
    .run(JSON.stringify(changes), id)
}

// Resolve a pending proposal. Compare-and-swap on status, so applying and
// rejecting the same proposal can never both win.
export function resolveProposal(
  id: string,
  status: Exclude<ProposalStatus, "pending">,
  by: string,
  note: string | null
): PlanProposal | null {
  const result = getDb()
    .prepare(
      "UPDATE plan_proposals SET status = ?, resolved_by = ?, resolution_note = ?, resolved_at = ? WHERE id = ? AND status = 'pending'"
    )
    .run(status, by, note?.trim() || null, Date.now(), id)
  if (!result.changes) return null
  const proposal = getProposal(id)!
  emitWorkChanged(proposal.featureId)
  return proposal
}

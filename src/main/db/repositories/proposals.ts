import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type { PlanProposal } from "../types"
import type {
  PlanChange,
  ProposalKind,
  ProposalStatus,
} from "../../../shared/mission-control/plan-changes"
import { emitWorkChanged } from "../../mission-control/work-events"

// Plan proposals (plan 106.6): every plan change outside a seat's decision
// rights or the active mission waits here for the user to apply or reject.

interface ProposalRow {
  id: string
  initiative_id: string
  mission_id: string | null
  kind: ProposalKind
  changes: string
  proposer: string
  reason: string
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
  return {
    id: row.id,
    initiativeId: row.initiative_id,
    missionId: row.mission_id,
    kind: row.kind,
    changes,
    proposer: row.proposer,
    reason: row.reason,
    status: row.status,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}

export function createProposal(input: {
  initiativeId: string
  missionId: string | null
  kind: ProposalKind
  changes: PlanChange[]
  proposer: string
  reason: string
}): PlanProposal {
  const id = randomUUID()
  getDb()
    .prepare(
      "INSERT INTO plan_proposals (id, initiative_id, mission_id, kind, changes, proposer, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)"
    )
    .run(
      id,
      input.initiativeId,
      input.missionId,
      input.kind,
      JSON.stringify(input.changes),
      input.proposer,
      input.reason.trim(),
      Date.now()
    )
  emitWorkChanged(input.initiativeId)
  return getProposal(id)!
}

export function getProposal(id: string): PlanProposal | null {
  const row = getDb()
    .prepare("SELECT * FROM plan_proposals WHERE id = ?")
    .get(id) as ProposalRow | undefined
  return row ? toProposal(row) : null
}

export function listProposals(
  initiativeId: string,
  status?: ProposalStatus
): PlanProposal[] {
  const rows = (
    status
      ? getDb()
          .prepare(
            "SELECT * FROM plan_proposals WHERE initiative_id = ? AND status = ? ORDER BY created_at, id"
          )
          .all(initiativeId, status)
      : getDb()
          .prepare(
            "SELECT * FROM plan_proposals WHERE initiative_id = ? ORDER BY created_at DESC, id DESC"
          )
          .all(initiativeId)
  ) as ProposalRow[]
  return rows.map(toProposal)
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
  emitWorkChanged(proposal.initiativeId)
  return proposal
}

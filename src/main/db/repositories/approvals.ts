import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type { Approval, ApprovalStatus } from "../types"

// Storage-only this phase: human-in-the-loop gate records. No runner requests
// or blocks on these yet.

interface ApprovalRow {
  id: string
  task_id: string
  status: ApprovalStatus
  request: string | null
  decision: string | null
  requested_at: number
  resolved_at: number | null
}

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status,
    request: row.request ? JSON.parse(row.request) : null,
    decision: row.decision ? JSON.parse(row.decision) : null,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
  }
}

export function createApproval(input: {
  taskId: string
  request?: unknown
}): Approval {
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      "INSERT INTO approvals (id, task_id, status, request, decision, requested_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      id,
      input.taskId,
      "pending",
      input.request !== undefined ? JSON.stringify(input.request) : null,
      null,
      now,
      null
    )
  return getApproval(id)!
}

export function getApproval(id: string): Approval | undefined {
  const row = getDb()
    .prepare("SELECT * FROM approvals WHERE id = ?")
    .get(id) as ApprovalRow | undefined
  return row ? toApproval(row) : undefined
}

export function listApprovals(opts?: {
  taskId?: string
  status?: ApprovalStatus
}): Approval[] {
  const clauses: string[] = []
  const values: unknown[] = []
  if (opts?.taskId) {
    clauses.push("task_id = ?")
    values.push(opts.taskId)
  }
  if (opts?.status) {
    clauses.push("status = ?")
    values.push(opts.status)
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  const rows = getDb()
    .prepare(`SELECT * FROM approvals ${where} ORDER BY requested_at DESC`)
    .all(...values) as ApprovalRow[]
  return rows.map(toApproval)
}

export function resolveApproval(
  id: string,
  decision: { status: "approved" | "denied"; decision?: unknown }
): Approval {
  getDb()
    .prepare(
      "UPDATE approvals SET status = ?, decision = ?, resolved_at = ? WHERE id = ?"
    )
    .run(
      decision.status,
      decision.decision !== undefined ? JSON.stringify(decision.decision) : null,
      Date.now(),
      id
    )
  return getApproval(id)!
}

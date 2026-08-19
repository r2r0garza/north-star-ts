import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { runMigrations } from "../migrations"

let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

let sqliteLoads = true
try {
  new Database(":memory:").close()
} catch {
  sqliteLoads = false
}

import {
  createApproval,
  listApprovals,
  deleteApprovalsForPhaseRuns,
} from "./approvals"

// A backing task row so approvals (FK to tasks) attach.
function freshTask(): string {
  const convId = randomUUID()
  const taskId = randomUUID()
  const now = Date.now()
  db.prepare(
    "INSERT INTO conversations (id, mode, title, workspace_id, created_at, updated_at) VALUES (?, 'interactive', NULL, NULL, ?, ?)"
  ).run(convId, now, now)
  db.prepare(
    "INSERT INTO tasks (id, conversation_id, source_conversation_id, title, status, input, result, error, created_at, updated_at) VALUES (?, ?, ?, NULL, 'running', NULL, NULL, NULL, ?, ?)"
  ).run(taskId, convId, convId, now, now)
  return taskId
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)(
  "deleteApprovalsForPhaseRuns (plan 038.2)",
  () => {
    it("deletes only rows whose request targets a listed phase-run", () => {
      const taskId = freshTask()
      createApproval({
        taskId,
        request: { requestId: "r1", phaseRunId: "prA" },
      })
      createApproval({
        taskId,
        request: { requestId: "r2", phaseRunId: "prB" },
      })
      createApproval({
        taskId,
        request: { requestId: "r3", phaseRunId: "prC" },
      })

      deleteApprovalsForPhaseRuns(taskId, ["prA", "prC"])

      const remaining = listApprovals({ taskId })
      expect(remaining).toHaveLength(1)
      expect((remaining[0].request as { phaseRunId?: string }).phaseRunId).toBe(
        "prB"
      )
    })

    it("is a no-op for an empty id set", () => {
      const taskId = freshTask()
      createApproval({
        taskId,
        request: { requestId: "r1", phaseRunId: "pr1" },
      })
      deleteApprovalsForPhaseRuns(taskId, [])
      expect(listApprovals({ taskId })).toHaveLength(1)
    })

    it("ignores rows on other tasks", () => {
      const t1 = freshTask()
      const t2 = freshTask()
      createApproval({
        taskId: t1,
        request: { requestId: "r1", phaseRunId: "pr1" },
      })
      createApproval({
        taskId: t2,
        request: { requestId: "r2", phaseRunId: "pr1" },
      })
      // Same phaseRunId string, but scoped to t1 — t2's row survives.
      deleteApprovalsForPhaseRuns(t1, ["pr1"])
      expect(listApprovals({ taskId: t1 })).toHaveLength(0)
      expect(listApprovals({ taskId: t2 })).toHaveLength(1)
    })
  }
)

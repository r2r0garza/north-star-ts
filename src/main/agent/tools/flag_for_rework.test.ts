import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { runMigrations } from "../../db/migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../../db/connection", () => ({ getDb: () => db }))

import * as processes from "../../db/repositories/processes"
import { flagForReworkTool, MAX_FLAGS_PER_RUN } from "./flag_for_rework"
import type { ToolContext } from "./types"

// A minimal ToolContext carrying the process phase context the tool needs.
function ctxFor(
  processRunId?: string,
  processPhaseRunId?: string
): ToolContext {
  return { workspace: "", processRunId, processPhaseRunId }
}

// a → b (on_complete). Returns ids + the two top-level phase-runs (a completed,
// b running — b is the flagging phase).
function seed() {
  const def = processes.createProcessDefinition({ name: "T" })
  const a = processes.createPhase({
    processId: def.id,
    key: "a",
    name: "A",
    position: 0,
  })
  const b = processes.createPhase({
    processId: def.id,
    key: "b",
    name: "B",
    position: 1,
  })
  processes.createEdge({
    processId: def.id,
    fromPhaseId: a.id,
    toPhaseId: b.id,
  })
  const convId = randomUUID()
  const now = Date.now()
  db.prepare(
    "INSERT INTO conversations (id, mode, title, workspace_id, created_at, updated_at) VALUES (?, 'interactive', NULL, NULL, ?, ?)"
  ).run(convId, now, now)
  const taskId = randomUUID()
  db.prepare(
    "INSERT INTO tasks (id, conversation_id, source_conversation_id, title, status, input, result, error, created_at, updated_at) VALUES (?, ?, ?, NULL, 'running', NULL, NULL, NULL, ?, ?)"
  ).run(taskId, convId, convId, now, now)
  const run = processes.createProcessRun({
    processId: def.id,
    sourceConversationId: null,
    taskId,
    objective: "o",
    status: "running",
  })
  const aRun = processes.createPhaseRun({
    runId: run.id,
    phaseId: a.id,
    status: "completed",
  })
  const bRun = processes.createPhaseRun({
    runId: run.id,
    phaseId: b.id,
    status: "running",
  })
  return { run, aRun, bRun }
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)("flag_for_rework tool (plan 031.2)", () => {
  it("records a pending flag for a valid upstream target", async () => {
    const { run, bRun } = seed()
    const res = await flagForReworkTool.execute(
      { target: "a", reason: "the bug is in A" },
      ctxFor(run.id, bRun.id)
    )
    expect(res).toContain("Flag recorded")
    const flags = processes.listFlags({ runId: run.id, status: "pending" })
    expect(flags).toHaveLength(1)
    expect(flags[0].reason).toBe("the bug is in A")
  })

  it("rejects a forward / unknown / self target", async () => {
    const { run, aRun, bRun } = seed()
    // a (flagging) → b is FORWARD.
    const fwd = await flagForReworkTool.execute(
      { target: "b", reason: "x" },
      ctxFor(run.id, aRun.id)
    )
    expect(fwd).toContain("ERROR[bad_target]")
    // unknown key.
    const unknown = await flagForReworkTool.execute(
      { target: "zzz", reason: "x" },
      ctxFor(run.id, bRun.id)
    )
    expect(unknown).toContain("ERROR[bad_target]")
    // No flags were recorded.
    expect(processes.listFlags({ runId: run.id })).toHaveLength(0)
  })

  it("is unavailable without process context", async () => {
    const res = await flagForReworkTool.execute(
      { target: "a", reason: "x" },
      ctxFor(undefined, undefined)
    )
    expect(res).toContain("ERROR[unavailable]")
  })

  it("enforces the per-run flag budget", async () => {
    const { run, bRun } = seed()
    // Pre-fill the budget with dummy flags.
    for (let i = 0; i < MAX_FLAGS_PER_RUN; i++)
      processes.createFlag({
        runId: run.id,
        flaggingPhaseRunId: bRun.id,
        targetPhaseId: processes.getPhaseRun(bRun.id)!.phaseId,
        reason: `f${i}`,
      })
    const res = await flagForReworkTool.execute(
      { target: "a", reason: "one more" },
      ctxFor(run.id, bRun.id)
    )
    expect(res).toContain("ERROR[flag_budget]")
  })

  it("requires target and reason", async () => {
    const { run, bRun } = seed()
    expect(
      await flagForReworkTool.execute({ reason: "x" }, ctxFor(run.id, bRun.id))
    ).toContain("ERROR[bad_args]")
    expect(
      await flagForReworkTool.execute({ target: "a" }, ctxFor(run.id, bRun.id))
    ).toContain("ERROR[bad_args]")
  })
})

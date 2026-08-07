import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { runMigrations } from "../../db/migrations"

let db: Database.Database
vi.mock("../../db/connection", () => ({ getDb: () => db }))

// better-sqlite3's native binary is built for the Electron ABI here; under
// plain-Node vitest it may not load (see native-module-rebuild note). SQLite-
// backed tests skip rather than fail when the ABI mismatches.
let sqliteLoads = true
try {
  new Database(":memory:").close()
} catch {
  sqliteLoads = false
}

import * as processes from "../../db/repositories/processes"
import { listApprovals, resolveApproval } from "../../db/repositories/approvals"
import {
  runScheduler,
  GateBlockedError,
  type RunPhase,
  type SchedulerCtx,
} from "./scheduler"
import type { TaskEventPayload } from "../runner"

// Create a backing task row so approvals/checkpoints (FK to tasks) can attach.
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

// Build a process definition from a compact phase/edge spec.
function buildProcess(spec: {
  phases: Array<{ key: string; gate?: "auto" | "approve" }>
  edges?: Array<[string, string]>
}): string {
  const def = processes.createProcessDefinition({ name: "T" })
  const byKey = new Map<string, string>()
  spec.phases.forEach((p, i) => {
    const phase = processes.createPhase({
      processId: def.id,
      key: p.key,
      name: p.key.toUpperCase(),
      gatePolicy: p.gate ?? "auto",
      position: i,
    })
    byKey.set(p.key, phase.id)
    processes.createPhaseAgent({
      phaseId: phase.id,
      agentName: `${p.key}-agent`,
      position: 0,
    })
  })
  for (const [from, to] of spec.edges ?? []) {
    processes.createEdge({
      processId: def.id,
      fromPhaseId: byKey.get(from)!,
      toPhaseId: byKey.get(to)!,
    })
  }
  return def.id
}

// Assemble a SchedulerCtx over a run of `processId`, with an injected runPhase
// and an event sink.
function makeCtx(
  processId: string,
  runPhase: RunPhase,
  opts?: { abort?: AbortController }
): { ctx: SchedulerCtx; events: TaskEventPayload[]; runId: string } {
  const taskId = freshTask()
  const run = processes.createProcessRun({
    processId,
    sourceConversationId: null,
    taskId,
    objective: "obj",
    status: "running",
  })
  const graph = processes.getProcessGraph(processId)!
  const events: TaskEventPayload[] = []
  const abort = opts?.abort ?? new AbortController()
  const ctx: SchedulerCtx = {
    run,
    graph,
    taskId,
    signal: abort.signal,
    emit: (e) => events.push(e),
    runPhase,
  }
  return { ctx, events, runId: run.id }
}

const statusByKey = (
  runId: string,
  processId: string
): Record<string, string> => {
  const graph = processes.getProcessGraph(processId)!
  const runs = processes.listPhaseRuns({ runId, parentId: null })
  const byId = new Map(runs.map((r) => [r.phaseId, r]))
  const out: Record<string, string> = {}
  for (const p of graph.phases) out[p.key] = byId.get(p.id)?.status ?? "?"
  return out
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)("scheduler — sequential chain", () => {
  it("runs phases in dependency order", async () => {
    const pid = buildProcess({
      phases: [{ key: "a" }, { key: "b" }, { key: "c" }],
      edges: [
        ["a", "b"],
        ["b", "c"],
      ],
    })
    const order: string[] = []
    const runPhase: RunPhase = async ({ phase }) => {
      order.push(phase.key)
      return { content: `${phase.key} done` }
    }
    const { ctx, runId } = makeCtx(pid, runPhase)
    await runScheduler(ctx)
    expect(order).toEqual(["a", "b", "c"])
    expect(statusByKey(runId, pid)).toEqual({
      a: "completed",
      b: "completed",
      c: "completed",
    })
  })
})

describe.skipIf(!sqliteLoads)("scheduler — parallelism", () => {
  it("dispatches independent phases concurrently", async () => {
    // a -> b, a -> c : b and c are independent and should run concurrently.
    const pid = buildProcess({
      phases: [{ key: "a" }, { key: "b" }, { key: "c" }],
      edges: [
        ["a", "b"],
        ["a", "c"],
      ],
    })
    let concurrent = 0
    let maxConcurrent = 0
    const gate = { b: null as (() => void) | null, c: null as (() => void) | null }
    const runPhase: RunPhase = async ({ phase }) => {
      if (phase.key === "a") return { content: "a" }
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      // Hold b and c open until both have started, proving concurrency.
      await new Promise<void>((resolve) => {
        gate[phase.key as "b" | "c"] = resolve
        if (gate.b && gate.c) {
          gate.b()
          gate.c()
        }
      })
      concurrent--
      return { content: phase.key }
    }
    const { ctx, runId } = makeCtx(pid, runPhase)
    await runScheduler(ctx)
    expect(maxConcurrent).toBe(2)
    expect(statusByKey(runId, pid).b).toBe("completed")
    expect(statusByKey(runId, pid).c).toBe("completed")
  })
})

describe.skipIf(!sqliteLoads)("scheduler — multi-dependency join", () => {
  it("waits for BOTH parents before dispatching the join", async () => {
    // b, c -> d. d must not start until both b and c complete.
    const pid = buildProcess({
      phases: [{ key: "b" }, { key: "c" }, { key: "d" }],
      edges: [
        ["b", "d"],
        ["c", "d"],
      ],
    })
    const startedBeforeD: string[] = []
    let bDone = false
    let cDone = false
    const runPhase: RunPhase = async ({ phase }) => {
      if (phase.key === "d") {
        expect(bDone).toBe(true)
        expect(cDone).toBe(true)
      } else {
        startedBeforeD.push(phase.key)
      }
      if (phase.key === "b") bDone = true
      if (phase.key === "c") cDone = true
      return { content: phase.key }
    }
    const { ctx, runId } = makeCtx(pid, runPhase)
    await runScheduler(ctx)
    expect(statusByKey(runId, pid).d).toBe("completed")
    expect(startedBeforeD.sort()).toEqual(["b", "c"])
  })
})

describe.skipIf(!sqliteLoads)("scheduler — approval gate", () => {
  it("blocks dependents until the gate is approved, then releases", async () => {
    // a (approve) -> b. The scheduler should throw GateBlockedError after a
    // completes, before b runs. After approving, a resume runs b.
    const pid = buildProcess({
      phases: [{ key: "a", gate: "approve" }, { key: "b" }],
      edges: [["a", "b"]],
    })
    const ran: string[] = []
    const runPhase: RunPhase = async ({ phase }) => {
      ran.push(phase.key)
      return { content: phase.key }
    }
    const { ctx, runId } = makeCtx(pid, runPhase)
    await expect(runScheduler(ctx)).rejects.toBeInstanceOf(GateBlockedError)
    expect(ran).toEqual(["a"]) // b blocked
    expect(statusByKey(runId, pid).a).toBe("completed")
    expect(statusByKey(runId, pid).b).toBe("pending")

    // A gate approval row exists as pending; approve it.
    const pending = listApprovals({ taskId: ctx.taskId, status: "pending" })
    expect(pending).toHaveLength(1)
    resolveApproval(pending[0].id, { status: "approved" })

    // Resume: re-run the scheduler over the same run (fresh ctx, same taskId/run).
    const graph = processes.getProcessGraph(pid)!
    const run2 = processes.getProcessRun(runId)!
    const events2: TaskEventPayload[] = []
    await runScheduler({
      run: run2,
      graph,
      taskId: ctx.taskId,
      signal: new AbortController().signal,
      emit: (e) => events2.push(e),
      runPhase,
    })
    expect(ran).toEqual(["a", "b"])
    expect(statusByKey(runId, pid).b).toBe("completed")
  })
})

describe.skipIf(!sqliteLoads)("scheduler — resume", () => {
  it("does not re-run already-completed phases", async () => {
    const pid = buildProcess({
      phases: [{ key: "a" }, { key: "b" }],
      edges: [["a", "b"]],
    })
    const { ctx, runId } = makeCtx(
      pid,
      async ({ phase }) => ({ content: phase.key }) // unused; we pre-seed below
    )
    // Pre-seed: a already completed (as if from a prior run before a crash).
    const graph = processes.getProcessGraph(pid)!
    const aPhase = graph.phases.find((p) => p.key === "a")!
    const aRun = processes.createPhaseRun({
      runId,
      phaseId: aPhase.id,
      status: "completed",
    })
    void aRun

    const ran: string[] = []
    await runScheduler({
      ...ctx,
      runPhase: async ({ phase }) => {
        ran.push(phase.key)
        return { content: phase.key }
      },
    })
    // a was already completed → only b runs.
    expect(ran).toEqual(["b"])
    expect(statusByKey(runId, pid)).toEqual({ a: "completed", b: "completed" })
  })
})

describe.skipIf(!sqliteLoads)("scheduler — cancellation", () => {
  it("stops scheduling when the signal aborts", async () => {
    const pid = buildProcess({
      phases: [{ key: "a" }, { key: "b" }],
      edges: [["a", "b"]],
    })
    const abort = new AbortController()
    const ran: string[] = []
    const runPhase: RunPhase = async ({ phase, signal }) => {
      ran.push(phase.key)
      // a aborts the run mid-flight; its own worker observes the signal.
      abort.abort()
      if (signal.aborted) return { stopped: true }
      return { content: phase.key }
    }
    const { ctx, runId } = makeCtx(pid, runPhase, { abort })
    await runScheduler(ctx)
    // a ran (and was cancelled); b never dispatched.
    expect(ran).toEqual(["a"])
    expect(statusByKey(runId, pid).b).toBe("pending")
  })
})

describe.skipIf(!sqliteLoads)("scheduler — failed phase", () => {
  it("throws when a phase fails and blocks the DAG", async () => {
    const pid = buildProcess({
      phases: [{ key: "a" }, { key: "b" }],
      edges: [["a", "b"]],
    })
    const runPhase: RunPhase = async ({ phase }) => {
      if (phase.key === "a") return { error: "boom", retryable: false }
      return { content: phase.key }
    }
    const { ctx, runId } = makeCtx(pid, runPhase)
    await expect(runScheduler(ctx)).rejects.toThrow(/failed/)
    expect(statusByKey(runId, pid).a).toBe("failed")
    expect(statusByKey(runId, pid).b).toBe("pending")
  })
})

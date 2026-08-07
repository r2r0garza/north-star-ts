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
  type Decompose,
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
  phases: Array<{ key: string; gate?: "auto" | "approve"; fanOut?: boolean }>
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
      fanOut: p.fanOut ?? false,
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
  opts?: { abort?: AbortController; decompose?: Decompose }
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
    decompose: opts?.decompose,
  }
  return { ctx, events, runId: run.id }
}

// All phase-run rows for a phase key (parent + fan-out children), for assertions.
const runsForKey = (
  runId: string,
  processId: string,
  key: string
): ReturnType<typeof processes.listPhaseRuns> => {
  const graph = processes.getProcessGraph(processId)!
  const phase = graph.phases.find((p) => p.key === key)!
  return processes.listPhaseRuns({ runId, phaseId: phase.id })
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

describe.skipIf(!sqliteLoads)("scheduler — fan-out", () => {
  it("spawns N children and completes the parent only when all terminal", async () => {
    const pid = buildProcess({
      phases: [{ key: "c", fanOut: true }, { key: "d" }],
      edges: [["c", "d"]],
    })
    const decompose: Decompose = async () => ({
      subtasks: ["piece 1", "piece 2", "piece 3"],
    })
    const ranPrompts: string[] = []
    const runPhase: RunPhase = async ({ phase, subtaskPrompt }) => {
      if (phase.key === "c") ranPrompts.push(subtaskPrompt ?? "(none)")
      return { content: phase.key }
    }
    const { ctx, runId } = makeCtx(pid, runPhase, { decompose })
    await runScheduler(ctx)
    // Three children ran, each with its own sub-task prompt.
    expect(ranPrompts.sort()).toEqual(["piece 1", "piece 2", "piece 3"])
    const cRuns = runsForKey(runId, pid, "c")
    const children = cRuns.filter((r) => r.parentId !== null)
    const parent = cRuns.find((r) => r.parentId === null)!
    expect(children).toHaveLength(3)
    expect(children.every((r) => r.status === "completed")).toBe(true)
    expect(parent.status).toBe("completed")
    // The downstream phase ran only after the fan-out parent completed.
    expect(statusByKey(runId, pid).d).toBe("completed")
  })

  it("fails the parent when a child fails", async () => {
    const pid = buildProcess({
      phases: [{ key: "c", fanOut: true }],
    })
    const decompose: Decompose = async () => ({ subtasks: ["ok", "boom"] })
    const runPhase: RunPhase = async ({ subtaskPrompt }) => {
      if (subtaskPrompt === "boom")
        return { error: "child blew up", retryable: false }
      return { content: "ok" }
    }
    const { ctx, runId } = makeCtx(pid, runPhase, { decompose })
    await expect(runScheduler(ctx)).rejects.toThrow(/failed/)
    const parent = runsForKey(runId, pid, "c").find((r) => r.parentId === null)!
    expect(parent.status).toBe("failed")
  })

  it("fails the parent on empty/malformed decomposition (R2)", async () => {
    const pid = buildProcess({ phases: [{ key: "c", fanOut: true }] })
    // Empty result, non-retryable → the parent fails without spawning children.
    const decompose: Decompose = async () => ({
      subtasks: [],
      error: "no parseable sub-tasks",
      retryable: false,
    })
    const ran: string[] = []
    const runPhase: RunPhase = async ({ phase }) => {
      ran.push(phase.key)
      return { content: phase.key }
    }
    const { ctx, runId } = makeCtx(pid, runPhase, { decompose })
    await expect(runScheduler(ctx)).rejects.toThrow(/failed/)
    const cRuns = runsForKey(runId, pid, "c")
    expect(cRuns.filter((r) => r.parentId !== null)).toHaveLength(0) // no children
    expect(cRuns.find((r) => r.parentId === null)!.status).toBe("failed")
    expect(ran).toEqual([]) // no child worker ever ran
  })

  it("does not prematurely settle a parent while decompose is in flight (R1)", async () => {
    const pid = buildProcess({ phases: [{ key: "c", fanOut: true }] })
    let releaseDecompose: (() => void) | null = null
    let parentStatusDuringDecompose: string | null = null
    const decompose: Decompose = async ({ phaseRun }) => {
      // Hold decomposition open, then peek at the parent's status BEFORE any
      // children exist. The R1 guard must keep it `running`, not settle it.
      await new Promise<void>((resolve) => {
        releaseDecompose = resolve
        // Let the scheduler loop spin once (deriveFanoutParents runs) before we
        // release; a microtask defer is enough since the loop awaits the race.
        setTimeout(() => {
          parentStatusDuringDecompose =
            runsForKey(runId, pid, "c").find((r) => r.parentId === null)
              ?.status ?? null
          resolve()
        }, 5)
      })
      void releaseDecompose
      return { subtasks: ["x"] }
    }
    const runPhase: RunPhase = async ({ phase }) => ({ content: phase.key })
    const { ctx, runId } = makeCtx(pid, runPhase, { decompose })
    await runScheduler(ctx)
    // While decompose was in flight (no children yet), the parent stayed running.
    expect(parentStatusDuringDecompose).toBe("running")
    const parent = runsForKey(runId, pid, "c").find((r) => r.parentId === null)!
    expect(parent.status).toBe("completed")
  })

  it("stops in-flight children and cancels the parent on abort", async () => {
    const pid = buildProcess({
      phases: [{ key: "c", fanOut: true }, { key: "d" }],
      edges: [["c", "d"]],
    })
    const abort = new AbortController()
    const decompose: Decompose = async () => ({ subtasks: ["p1", "p2"] })
    const runPhase: RunPhase = async ({ subtaskPrompt, signal }) => {
      // The first child aborts the run; both children observe the signal.
      abort.abort()
      if (signal.aborted) return { stopped: true }
      return { content: subtaskPrompt }
    }
    const { ctx, runId } = makeCtx(pid, runPhase, { abort, decompose })
    await runScheduler(ctx)
    const parent = runsForKey(runId, pid, "c").find((r) => r.parentId === null)!
    expect(parent.status).toBe("cancelled")
    // The downstream phase never dispatched.
    expect(statusByKey(runId, pid).d).toBe("pending")
  })

  it("resumes without re-decomposing an already-fanned-out parent", async () => {
    const pid = buildProcess({ phases: [{ key: "c", fanOut: true }] })
    const graph = processes.getProcessGraph(pid)!
    const cPhase = graph.phases.find((p) => p.key === "c")!

    // Simulate a prior run that decomposed (parent running, children pending) and
    // then crashed. Seed the parent + two children + the fan-out checkpoint.
    const taskId = freshTask()
    const run = processes.createProcessRun({
      processId: pid,
      sourceConversationId: null,
      taskId,
      objective: "obj",
      status: "running",
    })
    const parent = processes.createPhaseRun({
      runId: run.id,
      phaseId: cPhase.id,
      status: "running",
    })
    const child1 = processes.createPhaseRun({
      runId: run.id,
      phaseId: cPhase.id,
      parentId: parent.id,
      status: "pending",
    })
    const child2 = processes.createPhaseRun({
      runId: run.id,
      phaseId: cPhase.id,
      parentId: parent.id,
      status: "pending",
    })
    // The fan-out checkpoint carrying the children's prompts.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createCheckpoint } = await import(
      "../../db/repositories/task-checkpoints"
    )
    createCheckpoint({
      taskId,
      label: `fanout:${parent.id}`,
      state: {
        parentPhaseRunId: parent.id,
        subtasks: [
          { phaseRunId: child1.id, prompt: "resumed 1" },
          { phaseRunId: child2.id, prompt: "resumed 2" },
        ],
      },
    })

    let decomposeCalls = 0
    const decompose: Decompose = async () => {
      decomposeCalls++
      return { subtasks: ["should-not-happen"] }
    }
    const ranPrompts: string[] = []
    const runPhase: RunPhase = async ({ subtaskPrompt }) => {
      ranPrompts.push(subtaskPrompt ?? "(none)")
      return { content: "done" }
    }

    await runScheduler({
      run: processes.getProcessRun(run.id)!,
      graph,
      taskId,
      signal: new AbortController().signal,
      emit: () => {},
      runPhase,
      decompose,
    })

    expect(decomposeCalls).toBe(0) // never re-decomposed
    expect(ranPrompts.sort()).toEqual(["resumed 1", "resumed 2"]) // resumed prompts
    expect(processes.getPhaseRun(parent.id)!.status).toBe("completed")
  })
})

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
  subtaskTitle,
  GateBlockedError,
  type BuildEachSubtaskPrompt,
  type Decompose,
  type RunPhase,
  type SchedulerCtx,
  type Validate,
} from "./scheduler"
import type { TaskEventPayload } from "../runner"
import type { ProcessFlag } from "../../db/types"

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

// Build a process definition from a compact phase/edge spec. An edge may carry a
// trigger as a 3rd tuple element (defaults to 'on_complete').
function buildProcess(spec: {
  phases: Array<{
    key: string
    gate?: "auto" | "approve"
    fanOut?: boolean
    validator?: boolean
    validatorMaxIterations?: number
  }>
  edges?: Array<[string, string] | [string, string, "on_each_subtask"]>
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
      validator: p.validator ?? false,
      validatorMaxIterations: p.validatorMaxIterations ?? 0,
      position: i,
    })
    byKey.set(p.key, phase.id)
    processes.createPhaseAgent({
      phaseId: phase.id,
      agentName: `${p.key}-agent`,
      position: 0,
    })
  })
  for (const [from, to, trigger] of spec.edges ?? []) {
    processes.createEdge({
      processId: def.id,
      fromPhaseId: byKey.get(from)!,
      toPhaseId: byKey.get(to)!,
      trigger,
    })
  }
  return def.id
}

// Assemble a SchedulerCtx over a run of `processId`, with an injected runPhase
// and an event sink.
function makeCtx(
  processId: string,
  runPhase: RunPhase,
  opts?: {
    abort?: AbortController
    decompose?: Decompose
    buildEachSubtaskPrompt?: BuildEachSubtaskPrompt
    validate?: Validate
    requireFlagApproval?: boolean
    applyFlag?: (flag: ProcessFlag) => void
  }
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
    buildEachSubtaskPrompt: opts?.buildEachSubtaskPrompt,
    validate: opts?.validate,
    requireFlagApproval: opts?.requireFlagApproval,
    applyFlag: opts?.applyFlag,
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

  it("re-gates after a request-changes re-run, then releases (plan 029)", async () => {
    // a (approve) -> b. Simulate "Request changes": settle the gate denied, reset
    // a to pending, and re-run. needsGate must re-fire (a re-completed past its
    // last gate row), block b again, then release once the fresh gate is approved.
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

    // First pass: a completes, gate raised, b blocked.
    await expect(runScheduler(ctx)).rejects.toBeInstanceOf(GateBlockedError)
    expect(ran).toEqual(["a"])
    const gate1 = listApprovals({ taskId: ctx.taskId, status: "pending" })
    expect(gate1).toHaveLength(1)

    // Request changes: settle the gate denied + reset a to pending (mirrors
    // ProcessService.requestChanges' DB writes).
    resolveApproval(gate1[0].id, {
      status: "denied",
      decision: { feedback: "tighten it", rework: true },
    })
    const aRun = runsForKey(runId, pid, "a").find((r) => r.parentId === null)!
    processes.updatePhaseRun(aRun.id, {
      status: "pending",
      error: null,
      startedAt: null,
      finishedAt: null,
      reworkNote: "tighten it",
      reworkRound: 1,
    })

    // Resume: a re-runs, and needsGate re-fires (new finishedAt > denied row).
    const run2 = processes.getProcessRun(runId)!
    await expect(
      runScheduler({
        run: run2,
        graph: processes.getProcessGraph(pid)!,
        taskId: ctx.taskId,
        signal: new AbortController().signal,
        emit: () => {},
        runPhase,
      })
    ).rejects.toBeInstanceOf(GateBlockedError)
    expect(ran).toEqual(["a", "a"]) // a re-ran
    expect(statusByKey(runId, pid).b).toBe("pending") // b still blocked
    const gate2 = listApprovals({ taskId: ctx.taskId, status: "pending" })
    expect(gate2).toHaveLength(1)
    expect(gate2[0].id).not.toBe(gate1[0].id) // a FRESH gate row

    // Approve the fresh gate → b releases.
    resolveApproval(gate2[0].id, { status: "approved" })
    const run3 = processes.getProcessRun(runId)!
    await runScheduler({
      run: run3,
      graph: processes.getProcessGraph(pid)!,
      taskId: ctx.taskId,
      signal: new AbortController().signal,
      emit: () => {},
      runPhase,
    })
    expect(ran).toEqual(["a", "a", "b"])
    expect(statusByKey(runId, pid).b).toBe("completed")
  })

  it("does not re-raise a gate for a denied-then-not-rerun phase (plan 029)", async () => {
    // A stale denied row with NO re-run (finishedAt older than the row) must not
    // re-fire the gate — the guard is `latestGate.requestedAt < finishedAt`.
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
    const gate = listApprovals({ taskId: ctx.taskId, status: "pending" })[0]
    // Deny WITHOUT resetting a (no re-run): a stays completed, finishedAt < the
    // (now denied) row's requestedAt.
    resolveApproval(gate.id, { status: "denied" })

    const run2 = processes.getProcessRun(runId)!
    // Should NOT throw (no fresh gate raised) and b stays blocked (denied ≠ approved).
    await runScheduler({
      run: run2,
      graph: processes.getProcessGraph(pid)!,
      taskId: ctx.taskId,
      signal: new AbortController().signal,
      emit: () => {},
      runPhase,
    })
    expect(ran).toEqual(["a"]) // a not re-run, b never ran
    expect(statusByKey(runId, pid).b).toBe("pending")
    // No new pending gate row.
    expect(listApprovals({ taskId: ctx.taskId, status: "pending" })).toHaveLength(
      0
    )
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
    // Each child carries a display title derived from its sub-task briefing
    // (plan 026 pass 1) — not the retry counter.
    expect(children.map((r) => r.title).sort()).toEqual([
      "piece 1",
      "piece 2",
      "piece 3",
    ])
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

  it("threads a 1-based, incrementing attempt into decompose across retries", async () => {
    const pid = buildProcess({ phases: [{ key: "c", fanOut: true }] })
    const attempts: number[] = []
    // Fail (retryable) on the first attempt, succeed on the second — so the
    // runner retries and we observe the attempt counter advance.
    const decompose: Decompose = async ({ attempt }) => {
      attempts.push(attempt)
      if (attempt === 1)
        return { subtasks: [], error: "unparseable", retryable: true }
      return { subtasks: ["p1"] }
    }
    const runPhase: RunPhase = async ({ phase }) => ({ content: phase.key })
    const { ctx } = makeCtx(pid, runPhase, { decompose })
    await runScheduler(ctx)
    expect(attempts).toEqual([1, 2]) // 1-based, incremented on retry
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

describe.skipIf(!sqliteLoads)("scheduler — on_each_subtask (025.2)", () => {
  // A trivial per-sub-task briefing builder for the tests.
  const buildEachSubtaskPrompt: BuildEachSubtaskPrompt = ({ sourceChildRun }) =>
    `validate:${sourceChildRun.id}`

  it("fires one consumer instance per completed fan-out child", async () => {
    // c (fanOut, 3 subtasks) --on_each_subtask--> v.
    const pid = buildProcess({
      phases: [{ key: "c", fanOut: true }, { key: "v" }],
      edges: [["c", "v", "on_each_subtask"]],
    })
    const decompose: Decompose = async () => ({
      subtasks: ["p1", "p2", "p3"],
    })
    let cParentSettled = false
    const vStartedWhileCRunning: boolean[] = []
    const runPhase: RunPhase = async ({ phase }) => {
      if (phase.key === "v") {
        // Record whether c's PARENT is still running when v starts — proving v
        // fires per-child, not after the whole c phase completes.
        vStartedWhileCRunning.push(!cParentSettled)
      }
      return { content: phase.key }
    }
    const { ctx, runId } = makeCtx(pid, runPhase, {
      decompose,
      buildEachSubtaskPrompt,
    })
    // Observe the parent's settle via events (completed on the c parent row).
    const graph = processes.getProcessGraph(pid)!
    const cParentId = processes
      .listPhaseRuns({ runId, parentId: null })
      .find(
        (r) => r.phaseId === graph.phases.find((p) => p.key === "c")!.id
      )
    void cParentId
    await runScheduler(ctx)

    // Three v instances ran (one per completed c child).
    const vRuns = runsForKey(runId, pid, "v")
    const vInstances = vRuns.filter((r) => r.parentId !== null)
    expect(vInstances).toHaveLength(3)
    expect(vInstances.every((r) => r.status === "completed")).toBe(true)
    // At least one v instance started before c's whole phase settled.
    expect(vStartedWhileCRunning.some(Boolean)).toBe(true)
    // The v CONTAINER completes once all instances are terminal.
    expect(statusByKey(runId, pid).v).toBe("completed")
    expect(statusByKey(runId, pid).c).toBe("completed")
  })

  it("settles the consumer only when every completed child has a terminal instance", async () => {
    const pid = buildProcess({
      phases: [{ key: "c", fanOut: true }, { key: "v" }],
      edges: [["c", "v", "on_each_subtask"]],
    })
    const decompose: Decompose = async () => ({ subtasks: ["p1", "p2", "p3"] })
    let vContainerStatusesSeen: string[] = []
    const runPhase: RunPhase = async ({ phase }) => {
      if (phase.key === "v") {
        // Snapshot the v container's status while an instance runs — it must be
        // `running`, never prematurely `completed`.
        vContainerStatusesSeen.push(statusByKey(runId, pid).v)
      }
      return { content: phase.key }
    }
    const { ctx, runId } = makeCtx(pid, runPhase, {
      decompose,
      buildEachSubtaskPrompt,
    })
    await runScheduler(ctx)
    expect(vContainerStatusesSeen.every((s) => s === "running")).toBe(true)
    expect(statusByKey(runId, pid).v).toBe("completed")
    const vInstances = runsForKey(runId, pid, "v").filter(
      (r) => r.parentId !== null
    )
    expect(vInstances).toHaveLength(3)
  })

  it("skips the consumer when the source has no completed children", async () => {
    // Every c child fails → c fails, no completed children → v is skipped.
    const pid = buildProcess({
      phases: [{ key: "c", fanOut: true }, { key: "v" }],
      edges: [["c", "v", "on_each_subtask"]],
    })
    const decompose: Decompose = async () => ({ subtasks: ["p1", "p2"] })
    const runPhase: RunPhase = async ({ phase, subtaskPrompt }) => {
      if (phase.key === "c" && subtaskPrompt !== undefined)
        return { error: "child failed", retryable: false }
      return { content: phase.key }
    }
    const { ctx, runId } = makeCtx(pid, runPhase, {
      decompose,
      buildEachSubtaskPrompt,
    })
    // c fails → the DAG surfaces a run failure; v should be `skipped`, not run.
    await expect(runScheduler(ctx)).rejects.toThrow(/failed/)
    const vRuns = runsForKey(runId, pid, "v")
    expect(vRuns.filter((r) => r.parentId !== null)).toHaveLength(0) // no instances
    expect(statusByKey(runId, pid).v).toBe("skipped")
  })

  it("propagates a failed consumer instance to the consumer's derived status", async () => {
    const pid = buildProcess({
      phases: [{ key: "c", fanOut: true }, { key: "v" }],
      edges: [["c", "v", "on_each_subtask"]],
    })
    const decompose: Decompose = async () => ({ subtasks: ["p1", "p2"] })
    const runPhase: RunPhase = async ({ phase, subtaskPrompt }) => {
      // The v instance triggered by the 2nd child fails.
      if (phase.key === "v" && subtaskPrompt?.length)
        return { error: "validate blew up", retryable: false }
      return { content: phase.key }
    }
    const { ctx, runId } = makeCtx(pid, runPhase, {
      decompose,
      buildEachSubtaskPrompt,
    })
    await expect(runScheduler(ctx)).rejects.toThrow(/failed/)
    expect(statusByKey(runId, pid).v).toBe("failed")
  })

  it("passes each triggering child's own briefing to its consumer instance", async () => {
    const pid = buildProcess({
      phases: [{ key: "c", fanOut: true }, { key: "v" }],
      edges: [["c", "v", "on_each_subtask"]],
    })
    const decompose: Decompose = async () => ({ subtasks: ["p1", "p2"] })
    const vPrompts: string[] = []
    const runPhase: RunPhase = async ({ phase, subtaskPrompt }) => {
      if (phase.key === "v") vPrompts.push(subtaskPrompt ?? "(none)")
      return { content: phase.key }
    }
    const { ctx, runId } = makeCtx(pid, runPhase, {
      decompose,
      buildEachSubtaskPrompt,
    })
    await runScheduler(ctx)
    // Each instance got a distinct validate:<childRunId> briefing.
    expect(vPrompts).toHaveLength(2)
    expect(new Set(vPrompts).size).toBe(2)
    expect(vPrompts.every((p) => p.startsWith("validate:"))).toBe(true)
    void runId
  })

  it("does not double-fire consumer instances on resume", async () => {
    const pid = buildProcess({
      phases: [{ key: "c", fanOut: true }, { key: "v" }],
      edges: [["c", "v", "on_each_subtask"]],
    })
    const graph = processes.getProcessGraph(pid)!
    const cPhase = graph.phases.find((p) => p.key === "c")!
    const vPhase = graph.phases.find((p) => p.key === "v")!

    // Simulate a prior run: c completed with two completed children; v container
    // running with one already-triggered instance (child1) that completed. On
    // resume, only child2 should trigger a fresh v instance — child1 must not.
    const taskId = freshTask()
    const run = processes.createProcessRun({
      processId: pid,
      sourceConversationId: null,
      taskId,
      objective: "obj",
      status: "running",
    })
    const cParent = processes.createPhaseRun({
      runId: run.id,
      phaseId: cPhase.id,
      status: "completed",
    })
    const cChild1 = processes.createPhaseRun({
      runId: run.id,
      phaseId: cPhase.id,
      parentId: cParent.id,
      status: "completed",
    })
    const cChild2 = processes.createPhaseRun({
      runId: run.id,
      phaseId: cPhase.id,
      parentId: cParent.id,
      status: "completed",
    })
    const vContainer = processes.createPhaseRun({
      runId: run.id,
      phaseId: vPhase.id,
      status: "running",
    })
    const vInstance1 = processes.createPhaseRun({
      runId: run.id,
      phaseId: vPhase.id,
      parentId: vContainer.id,
      status: "completed",
    })
    const { createCheckpoint } = await import(
      "../../db/repositories/task-checkpoints"
    )
    createCheckpoint({
      taskId,
      label: `eachsubtask:${vContainer.id}`,
      state: {
        containerPhaseRunId: vContainer.id,
        sourceChildRunId: cChild1.id,
        instanceRunId: vInstance1.id,
        prompt: "resumed validate 1",
      },
    })

    const vRanPrompts: string[] = []
    const runPhase: RunPhase = async ({ phase, subtaskPrompt }) => {
      if (phase.key === "v") vRanPrompts.push(subtaskPrompt ?? "(none)")
      return { content: phase.key }
    }
    await runScheduler({
      run: processes.getProcessRun(run.id)!,
      graph,
      taskId,
      signal: new AbortController().signal,
      emit: () => {},
      runPhase,
      buildEachSubtaskPrompt,
    })

    // child1's instance was NOT re-run (it was already completed); only child2's
    // fresh instance ran. Total v instances = 2 (no duplicate for child1).
    const vInstances = runsForKey(run.id, pid, "v").filter(
      (r) => r.parentId !== null
    )
    expect(vInstances).toHaveLength(2)
    expect(vRanPrompts).toEqual([`validate:${cChild2.id}`])
    expect(processes.getPhaseRun(vContainer.id)!.status).toBe("completed")
  })

  it("cancels a non-terminal consumer container on abort", async () => {
    const pid = buildProcess({
      phases: [{ key: "c", fanOut: true }, { key: "v" }],
      edges: [["c", "v", "on_each_subtask"]],
    })
    const abort = new AbortController()
    const decompose: Decompose = async () => ({ subtasks: ["p1", "p2"] })
    const runPhase: RunPhase = async ({ phase, signal }) => {
      // The first v instance aborts the run.
      if (phase.key === "v") {
        abort.abort()
        if (signal.aborted) return { stopped: true }
      }
      return { content: phase.key }
    }
    const { ctx, runId } = makeCtx(pid, runPhase, {
      abort,
      decompose,
      buildEachSubtaskPrompt,
    })
    await runScheduler(ctx)
    // The v container settled cancelled, not left dangling `running`.
    expect(statusByKey(runId, pid).v).toBe("cancelled")
  })
})

describe.skipIf(!sqliteLoads)("scheduler — validator (plan 031.1)", () => {
  it("re-runs the phase once when the validator rejects, then completes on approve", async () => {
    // a (validator) -> b. The reviewer rejects the first attempt with feedback,
    // approves the second. a's worker runs twice; b runs once, after a completes.
    const pid = buildProcess({
      phases: [{ key: "a", validator: true }, { key: "b" }],
      edges: [["a", "b"]],
    })
    const ran: string[] = []
    const runPhase: RunPhase = async ({ phase, phaseRun }) => {
      // Record whether the re-run saw the injected feedback (via reworkNote).
      const fresh = processes.getPhaseRun(phaseRun.id)
      ran.push(`${phase.key}${fresh?.reworkNote ? "*" : ""}`)
      return { content: phase.key }
    }
    let reviews = 0
    const validate: Validate = async () => {
      reviews++
      return reviews === 1
        ? { approved: false, feedback: "add error handling" }
        : { approved: true }
    }
    const { ctx, runId } = makeCtx(pid, runPhase, { validate })
    await runScheduler(ctx)
    // a ran twice (2nd time with the feedback stamped), b once.
    expect(ran).toEqual(["a", "a*", "b"])
    expect(reviews).toBe(2)
    expect(statusByKey(runId, pid)).toEqual({ a: "completed", b: "completed" })
    // The validator's own counter advanced; the 029 rework counter is untouched.
    const aRun = runsForKey(runId, pid, "a").find((r) => r.parentId === null)!
    expect(aRun.validatorRound).toBe(1)
    expect(aRun.reworkRound).toBe(0)
  })

  it("escalates to a human gate when the validator exhausts its cap", async () => {
    // a (validator, cap 2) -> b. The reviewer always rejects. a re-runs up to the
    // cap, then the scheduler raises a gate (throws) and b never runs.
    const pid = buildProcess({
      phases: [
        { key: "a", validator: true, validatorMaxIterations: 2 },
        { key: "b" },
      ],
      edges: [["a", "b"]],
    })
    const ran: string[] = []
    const runPhase: RunPhase = async ({ phase }) => {
      ran.push(phase.key)
      return { content: phase.key }
    }
    let reviews = 0
    const validate: Validate = async () => {
      reviews++
      return { approved: false, feedback: `round ${reviews}` }
    }
    const { ctx, runId } = makeCtx(pid, runPhase, { validate })
    await expect(runScheduler(ctx)).rejects.toBeInstanceOf(GateBlockedError)
    // The worker ran twice (round 1 re-run, then round 2 hits the cap → gate).
    expect(ran).toEqual(["a", "a"])
    expect(reviews).toBe(2)
    const aRun = runsForKey(runId, pid, "a").find((r) => r.parentId === null)!
    expect(aRun.status).toBe("waiting_for_approval")
    expect(aRun.validatorRound).toBe(2)
    expect(aRun.reworkNote).toBe("round 2")
    expect(statusByKey(runId, pid).b).toBe("pending") // b held

    // The escalation raised exactly one pending gate.
    const pending = listApprovals({ taskId: ctx.taskId, status: "pending" })
    expect(pending).toHaveLength(1)
  })

  it("releases dependents after a human approves the exhaustion gate", async () => {
    const pid = buildProcess({
      phases: [
        { key: "a", validator: true, validatorMaxIterations: 1 },
        { key: "b" },
      ],
      edges: [["a", "b"]],
    })
    const ran: string[] = []
    const runPhase: RunPhase = async ({ phase }) => {
      ran.push(phase.key)
      return { content: phase.key }
    }
    // cap 1 → the very first rejection exhausts and escalates.
    const validate: Validate = async () => ({
      approved: false,
      feedback: "not good enough",
    })
    const { ctx, runId } = makeCtx(pid, runPhase, { validate })
    await expect(runScheduler(ctx)).rejects.toBeInstanceOf(GateBlockedError)
    expect(ran).toEqual(["a"]) // one attempt, then straight to the gate
    expect(statusByKey(runId, pid).a).toBe("waiting_for_approval")

    // Approve the exhaustion gate.
    const pending = listApprovals({ taskId: ctx.taskId, status: "pending" })
    expect(pending).toHaveLength(1)
    resolveApproval(pending[0].id, { status: "approved" })

    // Resume: reconcileValidatorGates flips a → completed, releasing b. The
    // validator does NOT re-run (a is no longer re-running its worker).
    const graph = processes.getProcessGraph(pid)!
    const run2 = processes.getProcessRun(runId)!
    await runScheduler({
      run: run2,
      graph,
      taskId: ctx.taskId,
      signal: new AbortController().signal,
      emit: () => {},
      runPhase,
      validate,
    })
    expect(ran).toEqual(["a", "b"])
    expect(statusByKey(runId, pid)).toEqual({ a: "completed", b: "completed" })
  })

  it("uses the engine default cap when no per-phase override is set", async () => {
    // a (validator, no cap → DEFAULT_VALIDATOR_ITERATIONS = 3). Always-reject →
    // the worker runs 3 times, then escalates.
    const pid = buildProcess({
      phases: [{ key: "a", validator: true }, { key: "b" }],
      edges: [["a", "b"]],
    })
    let runs = 0
    const runPhase: RunPhase = async ({ phase }) => {
      if (phase.key === "a") runs++
      return { content: phase.key }
    }
    const validate: Validate = async () => ({ approved: false, feedback: "no" })
    const { ctx } = makeCtx(pid, runPhase, { validate })
    await expect(runScheduler(ctx)).rejects.toBeInstanceOf(GateBlockedError)
    expect(runs).toBe(3) // DEFAULT_VALIDATOR_ITERATIONS
  })

  it("fails open (completes) when the reviewer itself errors", async () => {
    // A broken reviewer (error result) must not wedge the run — the phase settles
    // completed and dependents proceed.
    const pid = buildProcess({
      phases: [{ key: "a", validator: true }, { key: "b" }],
      edges: [["a", "b"]],
    })
    const runPhase: RunPhase = async ({ phase }) => ({ content: phase.key })
    const validate: Validate = async () => ({
      approved: false,
      error: "reviewer blew up",
    })
    const { ctx, runId } = makeCtx(pid, runPhase, { validate })
    await runScheduler(ctx)
    expect(statusByKey(runId, pid)).toEqual({ a: "completed", b: "completed" })
  })

  it("does not review a phase with the validator toggle off", async () => {
    const pid = buildProcess({
      phases: [{ key: "a" }, { key: "b" }],
      edges: [["a", "b"]],
    })
    const runPhase: RunPhase = async ({ phase }) => ({ content: phase.key })
    let reviews = 0
    const validate: Validate = async () => {
      reviews++
      return { approved: true }
    }
    const { ctx, runId } = makeCtx(pid, runPhase, { validate })
    await runScheduler(ctx)
    expect(reviews).toBe(0)
    expect(statusByKey(runId, pid)).toEqual({ a: "completed", b: "completed" })
  })
})

describe.skipIf(!sqliteLoads)("scheduler — flag routing (plan 031.2)", () => {
  // Helper: the phase id for a key in a run's graph.
  const pidOf = (processId: string, key: string) =>
    processes.getProcessGraph(processId)!.phases.find((p) => p.key === key)!.id

  it("autonomous mode applies a pending flag inline and re-runs", async () => {
    // a → b, both complete; b flags a. requireFlagApproval false → applyFlag runs
    // at quiescence, and (since our stub resets a to pending) a re-runs.
    const pid = buildProcess({
      phases: [{ key: "a" }, { key: "b" }],
      edges: [["a", "b"]],
    })
    const ran: string[] = []
    const runPhase: RunPhase = async ({ phase }) => {
      ran.push(phase.key)
      return { content: phase.key }
    }
    const applied: string[] = []
    const { ctx, runId } = makeCtx(pid, runPhase, {
      requireFlagApproval: false,
      applyFlag: (flag) => {
        applied.push(flag.id)
      },
    })
    // Seed run rows + a pending flag from b → a. (The scheduler also seeds top-level
    // rows idempotently; these completed rows satisfy the flag's FKs and let the
    // walk reach quiescence with everything terminal.)
    processes.createPhaseRun({ runId, phaseId: pidOf(pid, "a"), status: "completed" })
    const bRun = processes.createPhaseRun({ runId, phaseId: pidOf(pid, "b"), status: "completed" })
    processes.createFlag({
      runId,
      flaggingPhaseRunId: bRun.id,
      targetPhaseId: pidOf(pid, "a"),
      reason: "fix it",
    })

    await runScheduler(ctx)
    // The flag was applied inline and marked applied (no gate raised).
    expect(applied).toHaveLength(1)
    expect(processes.listFlags({ runId, status: "applied" })).toHaveLength(1)
    expect(processes.listFlags({ runId, status: "pending" })).toHaveLength(0)
    expect(listApprovals({ taskId: ctx.taskId, status: "pending" })).toHaveLength(0)
  })

  it("confirm mode raises a process_flag_gate and pauses", async () => {
    const pid = buildProcess({
      phases: [{ key: "a" }, { key: "b" }],
      edges: [["a", "b"]],
    })
    const runPhase: RunPhase = async ({ phase }) => ({ content: phase.key })
    const { ctx, runId } = makeCtx(pid, runPhase, {
      requireFlagApproval: true,
      applyFlag: () => {
        throw new Error("applyFlag must NOT run in confirm mode")
      },
    })
    // Seed run rows + a pending flag.
    processes.createPhaseRun({ runId, phaseId: pidOf(pid, "a"), status: "completed" })
    const bRun = processes.createPhaseRun({ runId, phaseId: pidOf(pid, "b"), status: "completed" })
    processes.createFlag({
      runId,
      flaggingPhaseRunId: bRun.id,
      targetPhaseId: pidOf(pid, "a"),
      reason: "please fix",
    })

    await expect(runScheduler(ctx)).rejects.toBeInstanceOf(GateBlockedError)
    // A pending process_flag_gate approval was raised, carrying target + reason.
    const pending = listApprovals({ taskId: ctx.taskId, status: "pending" })
    expect(pending).toHaveLength(1)
    const req = pending[0].request as {
      kind: string
      flagTargetKey?: string
      flagReason?: string
    }
    expect(req.kind).toBe("process_flag_gate")
    expect(req.flagTargetKey).toBe("a")
    expect(req.flagReason).toBe("please fix")
    // The flag stays pending (confirmFlag applies it later).
    expect(processes.listFlags({ runId, status: "pending" })).toHaveLength(1)
  })

  it("holds the flagging phase's dependents until the flag routes (no early dispatch)", async () => {
    // a → b → c. When b's worker raises a flag against a, c must NOT dispatch — the
    // walk stops dispatching new phases while a flag is pending, drains to
    // quiescence, and (confirm mode) raises the gate. Regression for the bug where
    // c (Publish) ran before the flag routed.
    const pid = buildProcess({
      phases: [{ key: "a" }, { key: "b" }, { key: "c" }],
      edges: [
        ["a", "b"],
        ["b", "c"],
      ],
    })
    const ran: string[] = []
    const runPhase: RunPhase = async ({ phase, phaseRun }) => {
      ran.push(phase.key)
      // b flags a as soon as it runs (simulating flag_for_rework mid-phase).
      if (phase.key === "b")
        processes.createFlag({
          runId: phaseRun.runId,
          flaggingPhaseRunId: phaseRun.id,
          targetPhaseId: pidOf(pid, "a"),
          reason: "a is broken",
        })
      return { content: phase.key }
    }
    const { ctx, runId } = makeCtx(pid, runPhase, { requireFlagApproval: true })

    await expect(runScheduler(ctx)).rejects.toBeInstanceOf(GateBlockedError)
    // c NEVER ran; only a and b did.
    expect(ran).toEqual(["a", "b"])
    expect(statusByKey(runId, pid).c).toBe("pending")
    // A flag gate was raised.
    expect(
      listApprovals({ taskId: ctx.taskId, status: "pending" })
    ).toHaveLength(1)
  })

  it("does nothing when there are no pending flags", async () => {
    const pid = buildProcess({
      phases: [{ key: "a" }, { key: "b" }],
      edges: [["a", "b"]],
    })
    const runPhase: RunPhase = async ({ phase }) => ({ content: phase.key })
    const { ctx, runId } = makeCtx(pid, runPhase, {
      requireFlagApproval: false,
      applyFlag: () => {
        throw new Error("applyFlag must not run with no flags")
      },
    })
    await runScheduler(ctx)
    expect(statusByKey(runId, pid)).toEqual({ a: "completed", b: "completed" })
  })
})

// Pure helper — no SQLite, so it runs regardless of the native ABI.
describe("subtaskTitle", () => {
  it("takes the first non-empty line", () => {
    expect(subtaskTitle("Build the login form\n\nmore detail here")).toBe(
      "Build the login form"
    )
  })

  it("strips a leading list/heading marker", () => {
    expect(subtaskTitle("- Add the /session API route")).toBe(
      "Add the /session API route"
    )
    expect(subtaskTitle("1. First task")).toBe("First task")
    expect(subtaskTitle("## Heading task")).toBe("Heading task")
  })

  it("caps long briefings on a word boundary with an ellipsis", () => {
    const long =
      "Implement the character counter component with a red over-limit state and full accessibility"
    const out = subtaskTitle(long)
    expect(out.length).toBeLessThanOrEqual(61) // 60 + the ellipsis
    expect(out.endsWith("…")).toBe(true)
    expect(out.startsWith("Implement the character counter")).toBe(true)
  })

  it("handles leading blank lines and whitespace", () => {
    expect(subtaskTitle("\n\n   Trimmed title  \n")).toBe("Trimmed title")
  })
})

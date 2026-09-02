import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { runMigrations } from "../../db/migrations"
import { appendMessage } from "../../db/repositories/messages"
import { sqliteLoadsForTests } from "../../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../../db/connection", () => ({ getDb: () => db }))

// better-sqlite3's native binary is built for the Electron ABI here; under
// plain-Node vitest it may not load (see native-module-rebuild note). SQLite-
// backed tests skip rather than fail when the ABI mismatches.

import * as processes from "../../db/repositories/processes"
import {
  createApproval,
  listApprovals,
  resolveApproval,
} from "../../db/repositories/approvals"
import {
  runScheduler,
  subtaskTitle,
  GateBlockedError,
  FailurePersistenceError,
  MAX_PROCESS_DEPTH,
  type BuildEachSubtaskPrompt,
  type Decompose,
  type RunPhase,
  type RunSubProcess,
  type SchedulerCtx,
  type Validate,
} from "./scheduler"
import { PAUSE_ABORT_REASON, SHUTDOWN_ABORT_REASON } from "../../agent/abort"
import type { TaskEventPayload } from "../runner"
import type { FailureContext, FailureStage, ProcessFlag } from "../../db/types"

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
    subprocessId?: string
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
      subprocessId: p.subprocessId,
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
    runSubProcess?: RunSubProcess
    processDepth?: number
    failureDiagnosticDir?: string | null
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
    runSubProcess: opts?.runSubProcess,
    processDepth: opts?.processDepth,
    failureDiagnosticDir: opts?.failureDiagnosticDir,
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

function injectedFailure(input: {
  stage: FailureStage
  code?: string
  message?: string
  workerTaskId?: string
  agentName?: string
}): FailureContext {
  return {
    code: input.code ?? `${input.stage}_injected`,
    stage: input.stage,
    message: input.message ?? `${input.stage} failed`,
    retryable: false,
    attempt: null,
    maxAttempts: null,
    runId: null,
    phaseRunId: null,
    phaseId: null,
    taskId: null,
    workerTaskId: input.workerTaskId ?? null,
    agentName: input.agentName ?? null,
    cause: "FaultInjection",
    occurredAt: 123,
  }
}

function expectStructuredFailure(input: {
  runId: string
  processId: string
  phaseKey: string
  events: TaskEventPayload[]
  phaseRunStatus?: "failed" | "waiting_for_approval"
  eventStatus?: "failed" | "waiting_for_approval"
  stage: FailureStage
  code: string
  message: string
  attempt: number | null
  maxAttempts: number | null
  workerTaskId: string | null
  agentName: string | null
}): void {
  const phase = processes
    .getProcessGraph(input.processId)!
    .phases.find((p) => p.key === input.phaseKey)!
  const phaseRunStatus = input.phaseRunStatus ?? "failed"
  const eventStatus = input.eventStatus ?? phaseRunStatus
  const phaseRun = runsForKey(
    input.runId,
    input.processId,
    input.phaseKey
  ).find((r) => r.status === phaseRunStatus && r.parentId === null)!
  const expected = {
    code: input.code,
    stage: input.stage,
    message: input.message,
    retryable: false,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    runId: input.runId,
    phaseRunId: phaseRun.id,
    phaseId: phase.id,
    taskId: expect.any(String),
    workerTaskId: input.workerTaskId,
    agentName: input.agentName,
  }

  expect(phaseRun.failure).toMatchObject(expected)

  const attemptRows = processes.listPhaseAttempts({ phaseRunId: phaseRun.id })
  expect(attemptRows).toHaveLength(1)
  expect(attemptRows[0]).toMatchObject({
    runId: input.runId,
    phaseRunId: phaseRun.id,
    phaseId: phase.id,
    taskId: expected.taskId,
    workerTaskId: input.workerTaskId,
    agentName: input.agentName,
    stage: input.stage,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    error: input.message,
    failure: expected,
  })

  const failedEvent = input.events.find(
    (event) =>
      event.type === "process_phase" &&
      event.status === eventStatus &&
      event.phaseRunId === phaseRun.id
  )
  expect(failedEvent).toMatchObject({
    type: "process_phase",
    runId: input.runId,
    phaseRunId: phaseRun.id,
    phaseKey: input.phaseKey,
    status: eventStatus,
    failure: expected,
  })
}

function expectNoFailureRecorded(phaseRunId: string): void {
  const phaseRun = processes.getPhaseRun(phaseRunId)!
  expect(phaseRun.error).toBeNull()
  expect(phaseRun.failure).toBeNull()
  expect(processes.listPhaseAttempts({ phaseRunId })).toHaveLength(0)
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
    const gate = {
      b: null as (() => void) | null,
      c: null as (() => void) | null,
    }
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
    const aRun = runsForKey(runId, pid, "a").find((r) => r.parentId === null)!
    expectNoFailureRecorded(aRun.id)

    // A gate approval row exists as pending; approve it.
    const pending = listApprovals({ taskId: ctx.taskId, status: "pending" })
    expect(pending).toHaveLength(1)
    expect(pending[0].request).toMatchObject({
      kind: "process_phase_gate",
      phaseRunId: aRun.id,
      approvalPacket: {
        phaseRunId: aRun.id,
        reworkRound: 0,
        summary: {
          outcome: "A completed and is ready for approval.",
          validationSummary:
            "No validation commands or diagnostics were recorded.",
        },
        downstream: [{ name: "B" }],
      },
    })
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

  it("persists attributed artifacts and validation in the approval packet", async () => {
    const pid = buildProcess({
      phases: [{ key: "a", gate: "approve" }, { key: "b" }],
      edges: [["a", "b"]],
    })
    const runPhase: RunPhase = async ({ phaseRun }) => {
      const workerTaskId = freshTask()
      const worker = processes.updatePhaseRun(phaseRun.id, {
        taskId: workerTaskId,
      })
      const task = db
        .prepare("SELECT conversation_id FROM tasks WHERE id = ?")
        .get(worker.taskId) as { conversation_id: string }
      appendMessage({
        conversationId: task.conversation_id,
        role: "assistant",
        toolCalls: [
          {
            id: "write-1",
            name: "write_file_tool",
            arguments: JSON.stringify({
              path: "docs/plan.md",
              content: "hello",
            }),
          },
          {
            id: "test-1",
            name: "run_shell_tool",
            arguments: JSON.stringify({ command: "npm test -- a" }),
          },
        ],
      })
      appendMessage({
        conversationId: task.conversation_id,
        role: "tool",
        toolCallId: "write-1",
        toolName: "write_file_tool",
        content: "Wrote 5 bytes to docs/plan.md.",
      })
      appendMessage({
        conversationId: task.conversation_id,
        role: "tool",
        toolCallId: "test-1",
        toolName: "run_shell_tool",
        content: "1 test passed",
      })
      return { content: "done" }
    }

    const { ctx } = makeCtx(pid, runPhase)
    await expect(runScheduler(ctx)).rejects.toBeInstanceOf(GateBlockedError)

    const [pending] = listApprovals({ taskId: ctx.taskId, status: "pending" })
    expect(pending.request).toMatchObject({
      approvalPacket: {
        summary: {
          materialChanges: ["Wrote docs/plan.md"],
          validationSummary: "1 recorded validation check passed.",
        },
        artifacts: [
          {
            path: "docs/plan.md",
            fileType: "document",
            provenance: "workspace",
          },
        ],
        validations: [
          {
            label: "npm test -- a",
            status: "passed",
            command: "npm test -- a",
          },
        ],
      },
    })
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
    expect(
      listApprovals({ taskId: ctx.taskId, status: "pending" })
    ).toHaveLength(0)
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

  it("settles a phase-run left RUNNING mid-flight on a genuine cancel (plan 038.3)", async () => {
    // Regression: a plain (non-container) phase-run still `running` when the abort
    // branch runs used to be stranded (only containers were settled), so a nested
    // sub-process's inner phase stayed "Running" forever. The worker here aborts the
    // run and then never resolves, so the scheduler wakes on the abort (Promise.race)
    // while the phase-run row is still `running` — the abort branch must settle it.
    const pid = buildProcess({ phases: [{ key: "a" }] })
    const abort = new AbortController()
    const runPhase: RunPhase = ({ signal }) =>
      new Promise((resolve) => {
        abort.abort() // plain cancel, no reason
        // Never resolve on our own; unwind only if the signal fires (it just did).
        signal.addEventListener("abort", () => resolve({ stopped: true }), {
          once: true,
        })
        // But DON'T let runPhaseWithRetry settle the row — resolve on a later tick so
        // the scheduler's abort branch runs first while the row is still `running`.
      })
    const { ctx, runId } = makeCtx(pid, runPhase, { abort })
    await runScheduler(ctx)
    expect(statusByKey(runId, pid).a).toBe("cancelled")
    const aRun = runsForKey(runId, pid, "a").find((r) => r.parentId === null)!
    expectNoFailureRecorded(aRun.id)
  })

  it("does NOT terminally cancel an in-flight phase on a resumable (shutdown) abort (plan 038.3)", async () => {
    // Regression for the resume-corruption bug: quitting (SHUTDOWN_ABORT_REASON) must
    // leave an in-flight phase-run recoverable (NOT terminal `cancelled`) so the next
    // boot's crash-reset can resume it (crash-reset only resets running/ready).
    const pid = buildProcess({ phases: [{ key: "a" }] })
    const abort = new AbortController()
    const runPhase: RunPhase = ({ signal }) =>
      new Promise((resolve) => {
        abort.abort(SHUTDOWN_ABORT_REASON)
        signal.addEventListener("abort", () => resolve({ stopped: true }), {
          once: true,
        })
      })
    const { ctx, runId } = makeCtx(pid, runPhase, { abort })
    await runScheduler(ctx)
    // Left recoverable — the abort branch skipped settling on a resumable abort.
    expect(statusByKey(runId, pid).a).not.toBe("cancelled")
    const aRun = runsForKey(runId, pid, "a").find((r) => r.parentId === null)!
    expectNoFailureRecorded(aRun.id)
  })

  it("does NOT record failure attempts for an in-flight phase on pause", async () => {
    const pid = buildProcess({ phases: [{ key: "a" }] })
    const abort = new AbortController()
    const runPhase: RunPhase = ({ signal }) =>
      new Promise((resolve) => {
        abort.abort(PAUSE_ABORT_REASON)
        signal.addEventListener("abort", () => resolve({ stopped: true }), {
          once: true,
        })
      })
    const { ctx, runId } = makeCtx(pid, runPhase, { abort })

    await runScheduler(ctx)

    const aRun = runsForKey(runId, pid, "a").find((r) => r.parentId === null)!
    expect(aRun.status).toBe("running")
    expectNoFailureRecorded(aRun.id)
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

  it("persists structured failure context on the phase row, event, and attempt audit", async () => {
    const pid = buildProcess({
      phases: [{ key: "a" }],
    })
    const workerTaskId = freshTask()
    const runPhase: RunPhase = async ({ phase, phaseRun }) => ({
      error: "provider timed out",
      retryable: false,
      failure: {
        code: "provider_timeout",
        stage: "model_request",
        message: "provider timed out",
        retryable: false,
        attempt: null,
        maxAttempts: null,
        runId: "upstream-run",
        phaseRunId: phaseRun.id,
        phaseId: phase.id,
        taskId: null,
        workerTaskId,
        agentName: "a-agent",
        cause: "TimeoutError",
        occurredAt: 123,
      },
    })
    const { ctx, events, runId } = makeCtx(pid, runPhase)

    await expect(runScheduler(ctx)).rejects.toThrow(/failed/)

    const phaseRun = runsForKey(runId, pid, "a")[0]
    expect(phaseRun.failure).toMatchObject({
      code: "provider_timeout",
      stage: "model_request",
      phaseRunId: phaseRun.id,
      workerTaskId,
    })
    const failedEvent = events.find(
      (event) => event.type === "process_phase" && event.status === "failed"
    )
    expect(failedEvent).toMatchObject({
      type: "process_phase",
      phaseRunId: phaseRun.id,
      failure: { code: "provider_timeout", stage: "model_request" },
    })
    const attempts = processes.listPhaseAttempts({ phaseRunId: phaseRun.id })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      phaseRunId: phaseRun.id,
      stage: "model_request",
      attempt: 1,
      maxAttempts: 3,
      workerTaskId,
      failure: {
        code: "provider_timeout",
        stage: "model_request",
        phaseRunId: phaseRun.id,
      },
    })

    const laterCancel = new AbortController()
    laterCancel.abort()
    await runScheduler({
      ...ctx,
      run: processes.getProcessRun(runId)!,
      signal: laterCancel.signal,
      emit: () => {},
    })

    const preserved = processes.getPhaseRun(phaseRun.id)!
    expect(preserved.failure).toMatchObject({
      code: "provider_timeout",
      stage: "model_request",
      phaseRunId: phaseRun.id,
      workerTaskId,
    })
    expect(
      processes.listPhaseAttempts({ phaseRunId: phaseRun.id })
    ).toHaveLength(1)
  })

  it("sanitizes structured failures before persisting phase rows, audit attempts, and events", async () => {
    const pid = buildProcess({
      phases: [{ key: "a" }],
    })
    const workerTaskId = freshTask()
    const runPhase: RunPhase = async ({ phase, phaseRun }) => ({
      error: "provider leaked raw data",
      retryable: false,
      failure: {
        code: "provider_unauthorized",
        stage: "model_request",
        message:
          'Authorization: Bearer sk-live-secret x-api-key=raw-key response body: {"prompt":"secret prompt"}',
        retryable: false,
        attempt: null,
        maxAttempts: null,
        runId: "upstream-run",
        phaseRunId: phaseRun.id,
        phaseId: phase.id,
        taskId: null,
        workerTaskId,
        agentName: "a-agent",
        toolCallId: "tool-call-1",
        cause:
          'tool arguments: {"path":"/Users/alice/private/.env","token":"secret-token"}',
        occurredAt: 123,
      },
    })
    const { ctx, events, runId } = makeCtx(pid, runPhase)

    await expect(runScheduler(ctx)).rejects.toThrow(/failed/)

    const phaseRun = runsForKey(runId, pid, "a")[0]
    expect(phaseRun.failure).toMatchObject({
      code: "provider_unauthorized",
      stage: "model_request",
      phaseRunId: phaseRun.id,
      workerTaskId,
      agentName: "a-agent",
      toolCallId: "tool-call-1",
    })
    expect(phaseRun.error).toBe(phaseRun.failure?.message)
    const serializedPhase = JSON.stringify(phaseRun.failure)
    expect(serializedPhase).toContain("[redacted]")
    expect(serializedPhase).not.toContain("sk-live-secret")
    expect(serializedPhase).not.toContain("raw-key")
    expect(serializedPhase).not.toContain("secret prompt")
    expect(serializedPhase).not.toContain("/Users/alice")
    expect(serializedPhase).not.toContain("secret-token")

    const attempts = processes.listPhaseAttempts({ phaseRunId: phaseRun.id })
    expect(attempts).toHaveLength(1)
    expect(attempts[0].error).toBe(phaseRun.failure?.message)
    expect(JSON.stringify(attempts[0].failure)).toBe(serializedPhase)

    const failedEvent = events.find(
      (event) => event.type === "process_phase" && event.status === "failed"
    )
    expect(JSON.stringify(failedEvent)).toContain("[redacted]")
    expect(JSON.stringify(failedEvent)).not.toContain("sk-live-secret")
  })

  it("keeps failed retry attempts inspectable after a later attempt succeeds", async () => {
    const pid = buildProcess({
      phases: [{ key: "a" }],
    })
    let calls = 0
    const runPhase: RunPhase = async () => {
      calls++
      if (calls === 1) return { error: "temporary API outage", retryable: true }
      return { content: "ok" }
    }
    const { ctx, runId } = makeCtx(pid, runPhase)

    await runScheduler(ctx)

    const phaseRun = runsForKey(runId, pid, "a")[0]
    expect(phaseRun.status).toBe("completed")
    expect(phaseRun.failure).toBeNull()
    const attempts = processes.listPhaseAttempts({ phaseRunId: phaseRun.id })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      error: "temporary API outage",
      stage: "model_request",
      attempt: 1,
      maxAttempts: 3,
    })
  })

  it("surfaces result_persistence and writes an external diagnostic when a failure attempt row cannot be persisted", async () => {
    const pid = buildProcess({
      phases: [{ key: "a" }],
    })
    const fallbackDir = mkdtempSync(join(tmpdir(), "process-failure-fallback-"))
    const runPhase: RunPhase = async () => ({
      error: "provider timed out",
      retryable: false,
      failure: injectedFailure({
        stage: "model_request",
        code: "provider_timeout",
        message: "provider timed out",
        agentName: "a-agent",
      }),
    })
    const { ctx, events, runId } = makeCtx(pid, runPhase, {
      failureDiagnosticDir: fallbackDir,
    })
    const spy = vi
      .spyOn(processes, "createPhaseAttempt")
      .mockImplementationOnce(() => {
        throw new Error("sqlite attempt insert failed")
      })

    try {
      await expect(runScheduler(ctx)).rejects.toThrow(FailurePersistenceError)
    } finally {
      spy.mockRestore()
    }

    const phaseRun = runsForKey(runId, pid, "a")[0]
    expect(phaseRun.failure).toMatchObject({
      stage: "result_persistence",
      code: "process_failure_persistence_failed",
      agentName: "a-agent",
    })
    expect(phaseRun.failure?.message).toContain(
      "diagnostics were not fully persisted"
    )
    expect(phaseRun.failure?.message).toContain(
      "Original failure: model_request/provider_timeout: provider timed out"
    )

    const failedEvent = events.find(
      (event) => event.type === "process_phase" && event.status === "failed"
    )
    expect(failedEvent).toMatchObject({
      type: "process_phase",
      failure: {
        stage: "result_persistence",
        code: "process_failure_persistence_failed",
      },
    })

    const files = readdirSync(fallbackDir)
    expect(files).toHaveLength(1)
    const fallback = JSON.parse(
      readFileSync(join(fallbackDir, files[0]), "utf8")
    ) as {
      originalFailure: FailureContext
      persistenceFailure: { message: string }
    }
    expect(fallback.originalFailure).toMatchObject({
      stage: "model_request",
      code: "provider_timeout",
      message: "provider timed out",
    })
    expect(fallback.persistenceFailure.message).toBe(
      "sqlite attempt insert failed"
    )
  })

  it("surfaces result_persistence when the process phase task event cannot be persisted", async () => {
    const pid = buildProcess({
      phases: [{ key: "a" }],
    })
    const fallbackDir = mkdtempSync(join(tmpdir(), "process-event-fallback-"))
    const runPhase: RunPhase = async () => ({
      error: "provider timed out",
      retryable: false,
      failure: injectedFailure({
        stage: "model_request",
        code: "provider_timeout",
        message: "provider timed out",
      }),
    })
    const { ctx, runId } = makeCtx(pid, runPhase, {
      failureDiagnosticDir: fallbackDir,
    })
    ctx.emit = (event) => {
      if (event.type === "process_phase" && event.status === "failed") {
        throw new Error("task_events insert failed")
      }
    }

    await expect(runScheduler(ctx)).rejects.toThrow(FailurePersistenceError)

    const phaseRun = runsForKey(runId, pid, "a")[0]
    expect(phaseRun.failure).toMatchObject({
      stage: "result_persistence",
      code: "process_failure_persistence_failed",
    })
    expect(phaseRun.failure?.message).toContain("task_events insert failed")

    const files = readdirSync(fallbackDir)
    expect(files).toHaveLength(1)
    const fallback = JSON.parse(
      readFileSync(join(fallbackDir, files[0]), "utf8")
    ) as {
      originalFailure: FailureContext
      persistenceFailure: { message: string }
    }
    expect(fallback.originalFailure.stage).toBe("model_request")
    expect(fallback.persistenceFailure.message).toBe(
      "task_events insert failed"
    )
  })

  it("reports fallback diagnostic failure honestly without crashing the scheduler process", async () => {
    const pid = buildProcess({
      phases: [{ key: "a" }],
    })
    const fallbackPath = join(
      mkdtempSync(join(tmpdir(), "process-failure-fallback-file-")),
      "not-a-directory"
    )
    writeFileSync(fallbackPath, "occupied", "utf8")
    const runPhase: RunPhase = async () => ({
      error: "provider timed out",
      retryable: false,
      failure: injectedFailure({
        stage: "model_request",
        code: "provider_timeout",
        message: "provider timed out",
      }),
    })
    const { ctx, runId } = makeCtx(pid, runPhase, {
      failureDiagnosticDir: fallbackPath,
    })
    const spy = vi
      .spyOn(processes, "createPhaseAttempt")
      .mockImplementationOnce(() => {
        throw new Error("sqlite attempt insert failed")
      })

    try {
      await expect(runScheduler(ctx)).rejects.toThrow(FailurePersistenceError)
    } finally {
      spy.mockRestore()
    }

    const phaseRun = runsForKey(runId, pid, "a")[0]
    expect(phaseRun.failure?.stage).toBe("result_persistence")
    expect(phaseRun.failure?.message).toContain("Fallback diagnostic failed")
    expect(existsSync(fallbackPath)).toBe(true)
  })

  it.each([
    "agent_setup",
    "model_request",
    "tool_dispatch",
    "tool_execution",
    "result_persistence",
  ] satisfies FailureStage[])(
    "preserves injected %s failure context across phase row, audit, and event",
    async (stage) => {
      const pid = buildProcess({
        phases: [{ key: "a" }],
      })
      const workerTaskId = freshTask()
      const agentName = `${stage}-agent`
      const runPhase: RunPhase = async () => ({
        error: `${stage} failed`,
        retryable: false,
        failure: injectedFailure({
          stage,
          workerTaskId,
          agentName,
        }),
      })
      const { ctx, events, runId } = makeCtx(pid, runPhase)

      await expect(runScheduler(ctx)).rejects.toThrow(/failed/)

      expectStructuredFailure({
        runId,
        processId: pid,
        phaseKey: "a",
        events,
        stage,
        code: `${stage}_injected`,
        message: `${stage} failed`,
        attempt: 1,
        maxAttempts: 3,
        workerTaskId,
        agentName,
      })
    }
  )

  it("synthesizes structured context for a legacy string-only phase failure", async () => {
    const pid = buildProcess({
      phases: [{ key: "a" }],
    })
    const workerTaskId = freshTask()
    const runPhase: RunPhase = async ({ phaseRun }) => {
      processes.updatePhaseRun(phaseRun.id, {
        taskId: workerTaskId,
        agentName: "legacy-agent",
      })
      return { error: "plain worker error", retryable: false }
    }
    const { ctx, events, runId } = makeCtx(pid, runPhase)

    await expect(runScheduler(ctx)).rejects.toThrow(/failed/)

    expectStructuredFailure({
      runId,
      processId: pid,
      phaseKey: "a",
      events,
      stage: "model_request",
      code: "phase_worker_failed",
      message: "plain worker error",
      attempt: 1,
      maxAttempts: 3,
      workerTaskId,
      agentName: "legacy-agent",
    })
  })

  it("preserves injected decomposition failure context", async () => {
    const pid = buildProcess({
      phases: [{ key: "c", fanOut: true }],
    })
    const workerTaskId = freshTask()
    const decompose: Decompose = async () => ({
      error: "decomposition failed",
      retryable: false,
      failure: injectedFailure({
        stage: "decomposition",
        workerTaskId,
        agentName: "decomposer",
      }),
    })
    const runPhase: RunPhase = async () => ({ content: "unused" })
    const { ctx, events, runId } = makeCtx(pid, runPhase, { decompose })

    await expect(runScheduler(ctx)).rejects.toThrow(/failed/)

    expectStructuredFailure({
      runId,
      processId: pid,
      phaseKey: "c",
      events,
      stage: "decomposition",
      code: "decomposition_injected",
      message: "decomposition failed",
      attempt: 1,
      maxAttempts: 3,
      workerTaskId,
      agentName: "decomposer",
    })
  })

  it("preserves injected output_validation context for malformed decomposition output", async () => {
    const pid = buildProcess({
      phases: [{ key: "c", fanOut: true }],
    })
    const workerTaskId = freshTask()
    const decompose: Decompose = async () => ({
      subtasks: [],
      retryable: false,
      failure: injectedFailure({
        stage: "output_validation",
        code: "decomposition_output_invalid",
        message: "fan-out output was empty",
        workerTaskId,
        agentName: "decomposer",
      }),
    })
    const runPhase: RunPhase = async () => ({ content: "unused" })
    const { ctx, events, runId } = makeCtx(pid, runPhase, { decompose })

    await expect(runScheduler(ctx)).rejects.toThrow(/failed/)

    expectStructuredFailure({
      runId,
      processId: pid,
      phaseKey: "c",
      events,
      stage: "output_validation",
      code: "decomposition_output_invalid",
      message: "fan-out output was empty",
      attempt: 1,
      maxAttempts: 3,
      workerTaskId,
      agentName: "decomposer",
    })
  })

  it("preserves injected reviewer failure context at the validator boundary", async () => {
    const pid = buildProcess({
      phases: [{ key: "a", validator: true }],
    })
    const workerTaskId = freshTask()
    const runPhase: RunPhase = async () => ({ content: "needs review" })
    const validate: Validate = async () => ({
      approved: false,
      error: "reviewer failed",
      retryable: false,
      failure: injectedFailure({
        stage: "reviewer",
        workerTaskId,
        agentName: "reviewer-agent",
      }),
    })
    const { ctx, events, runId } = makeCtx(pid, runPhase, { validate })

    await expect(runScheduler(ctx)).rejects.toThrow(GateBlockedError)

    expectStructuredFailure({
      runId,
      processId: pid,
      phaseKey: "a",
      events,
      phaseRunStatus: "waiting_for_approval",
      eventStatus: "waiting_for_approval",
      stage: "reviewer",
      code: "reviewer_injected",
      message: "reviewer failed",
      attempt: 1,
      maxAttempts: 3,
      workerTaskId,
      agentName: "reviewer-agent",
    })
  })

  it("preserves injected subprocess failure context", async () => {
    const childProcessId = buildProcess({ phases: [{ key: "child" }] })
    const pid = buildProcess({
      phases: [{ key: "a", subprocessId: childProcessId }],
    })
    const workerTaskId = freshTask()
    const runPhase: RunPhase = async () => ({ content: "unused" })
    const runSubProcess: RunSubProcess = async () => ({
      error: "subprocess failed",
      retryable: false,
      failure: injectedFailure({
        stage: "subprocess",
        workerTaskId,
        agentName: "subprocess-agent",
      }),
    })
    const { ctx, events, runId } = makeCtx(pid, runPhase, { runSubProcess })

    await expect(runScheduler(ctx)).rejects.toThrow(/failed/)

    expectStructuredFailure({
      runId,
      processId: pid,
      phaseKey: "a",
      events,
      stage: "subprocess",
      code: "subprocess_injected",
      message: "subprocess failed",
      attempt: 1,
      maxAttempts: 1,
      workerTaskId,
      agentName: "subprocess-agent",
    })
  })

  it("synthesizes scheduler failure context when deriving a failed container", async () => {
    const pid = buildProcess({
      phases: [{ key: "c", fanOut: true }],
    })
    const runPhase: RunPhase = async () => ({ content: "unused" })
    const { ctx, events, runId } = makeCtx(pid, runPhase)
    const phase = processes
      .getProcessGraph(pid)!
      .phases.find((p) => p.key === "c")!
    const parent = processes.createPhaseRun({
      runId,
      phaseId: phase.id,
      status: "running",
    })
    const child = processes.createPhaseRun({
      runId,
      phaseId: phase.id,
      parentId: parent.id,
      status: "failed",
    })
    processes.updatePhaseRun(child.id, {
      error: "child failed without structured context",
    })

    await expect(runScheduler(ctx)).rejects.toThrow(/failed/)

    expectStructuredFailure({
      runId,
      processId: pid,
      phaseKey: "c",
      events,
      stage: "scheduler",
      code: "fanout_child_failed",
      message: "child failed without structured context",
      attempt: null,
      maxAttempts: null,
      workerTaskId: null,
      agentName: null,
    })
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
    const { createCheckpoint } =
      await import("../../db/repositories/task-checkpoints")
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
      .find((r) => r.phaseId === graph.phases.find((p) => p.key === "c")!.id)
    void cParentId
    await runScheduler(ctx)

    // Three v instances ran (one per completed c child).
    const vRuns = runsForKey(runId, pid, "v")
    const vInstances = vRuns.filter((r) => r.parentId !== null)
    expect(vInstances).toHaveLength(3)
    expect(vInstances.every((r) => r.status === "completed")).toBe(true)
    // Each instance is STAMPED with the c child it consumes (plan 031.2 lineage) —
    // this is what lets a flag from the instance resolve to that specific child.
    const cChildIds = new Set(
      runsForKey(runId, pid, "c")
        .filter((r) => r.parentId !== null)
        .map((r) => r.id)
    )
    expect(vInstances.every((r) => r.sourceChildRunId !== null)).toBe(true)
    expect(vInstances.every((r) => cChildIds.has(r.sourceChildRunId!))).toBe(
      true
    )
    // One instance per distinct child (no dupes, no shared lineage).
    expect(new Set(vInstances.map((r) => r.sourceChildRunId)).size).toBe(3)
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
    const { createCheckpoint } =
      await import("../../db/repositories/task-checkpoints")
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

  it("ignores a delayed stale validator approval for replaced output", async () => {
    const pid = buildProcess({
      phases: [{ key: "a", validator: true }, { key: "b" }],
      edges: [["a", "b"]],
    })
    const ran: string[] = []
    const identities = ["out-1", "out-2"]
    const runPhase: RunPhase = async ({ phase }) => {
      ran.push(phase.key)
      return {
        content: phase.key,
        outputIdentity: identities.shift() ?? "out-2",
      }
    }
    let reviews = 0
    const validate: Validate = async ({ phaseRun, outputIdentity }) => {
      reviews++
      if (reviews === 1) {
        processes.updatePhaseRun(phaseRun.id, {
          status: "pending",
          outputIdentity: "out-2",
        })
        return { approved: true, targetOutputIdentity: outputIdentity }
      }
      return { approved: true, targetOutputIdentity: outputIdentity }
    }
    const { ctx, runId } = makeCtx(pid, runPhase, { validate })

    await runScheduler(ctx)

    expect(ran).toEqual(["a", "a", "b"])
    expect(reviews).toBe(2)
    const aRun = runsForKey(runId, pid, "a").find((r) => r.parentId === null)!
    expect(aRun.status).toBe("completed")
    expect(aRun.outputIdentity).toBe("out-2")
  })

  it("ignores delayed stale validator rejection feedback for replaced output", async () => {
    const pid = buildProcess({
      phases: [{ key: "a", validator: true }, { key: "b" }],
      edges: [["a", "b"]],
    })
    const ran: string[] = []
    const identities = ["out-1", "out-2"]
    const runPhase: RunPhase = async ({ phase, phaseRun }) => {
      const fresh = processes.getPhaseRun(phaseRun.id)
      ran.push(`${phase.key}${fresh?.reworkNote ? "*" : ""}`)
      return {
        content: phase.key,
        outputIdentity: identities.shift() ?? "out-2",
      }
    }
    let reviews = 0
    const validate: Validate = async ({ phaseRun, outputIdentity }) => {
      reviews++
      if (reviews === 1) {
        processes.updatePhaseRun(phaseRun.id, {
          status: "pending",
          outputIdentity: "out-2",
        })
        return {
          approved: false,
          feedback: "stale feedback",
          targetOutputIdentity: outputIdentity,
        }
      }
      return { approved: true, targetOutputIdentity: outputIdentity }
    }
    const { ctx, runId } = makeCtx(pid, runPhase, { validate })

    await runScheduler(ctx)

    expect(ran).toEqual(["a", "a", "b"])
    expect(reviews).toBe(2)
    const aRun = runsForKey(runId, pid, "a").find((r) => r.parentId === null)!
    expect(aRun.status).toBe("completed")
    expect(aRun.validatorRound).toBe(0)
    expect(aRun.reworkNote).toBeNull()
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
    expectNoFailureRecorded(aRun.id)
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

    // Manual-override the exhaustion gate.
    const pending = listApprovals({ taskId: ctx.taskId, status: "pending" })
    expect(pending).toHaveLength(1)
    const request = pending[0].request as {
      requestId: string
      phaseKey: string
      phaseRunId: string
    }
    resolveApproval(pending[0].id, {
      status: "approved",
      decision: {
        manualOverride: true,
        gateKind: "process_validator_gate",
        requestId: request.requestId,
        phaseKey: request.phaseKey,
        phaseRunId: request.phaseRunId,
        failureReason: "not good enough",
        actor: "user",
      },
    })

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

  it("does not release a validator gate from a generic approved row", async () => {
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
    const validate: Validate = async () => ({
      approved: false,
      feedback: "not good enough",
    })
    const { ctx, runId } = makeCtx(pid, runPhase, { validate })
    await expect(runScheduler(ctx)).rejects.toBeInstanceOf(GateBlockedError)

    const pending = listApprovals({ taskId: ctx.taskId, status: "pending" })
    expect(pending).toHaveLength(1)
    resolveApproval(pending[0].id, { status: "approved" })

    await runScheduler({
      run: processes.getProcessRun(runId)!,
      graph: processes.getProcessGraph(pid)!,
      taskId: ctx.taskId,
      signal: new AbortController().signal,
      emit: () => {},
      runPhase,
      validate,
    })

    expect(ran).toEqual(["a"])
    expect(statusByKey(runId, pid)).toEqual({
      a: "waiting_for_approval",
      b: "pending",
    })
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

  it("holds the phase when the reviewer itself errors", async () => {
    // A broken reviewer is not an approval. The phase parks at the validator gate
    // and dependents remain unreleased.
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
    await expect(runScheduler(ctx)).rejects.toBeInstanceOf(GateBlockedError)
    expect(statusByKey(runId, pid)).toEqual({
      a: "waiting_for_approval",
      b: "pending",
    })
    const aRun = runsForKey(runId, pid, "a").find((r) => r.parentId === null)!
    expect(aRun.error).toBe("reviewer blew up")
    expect(aRun.validatorRound).toBe(0)
    const pending = listApprovals({ taskId: ctx.taskId, status: "pending" })
    expect(pending).toHaveLength(1)
  })

  it("retries only the validator review after a validator-unavailable gate", async () => {
    const pid = buildProcess({
      phases: [{ key: "a", validator: true }, { key: "b" }],
      edges: [["a", "b"]],
    })
    const { ctx, runId } = makeCtx(
      pid,
      async ({ phase }) => ({ content: phase.key }),
      {
        validate: async () => ({ approved: true }),
      }
    )
    const graph = processes.getProcessGraph(pid)!
    const a = graph.phases.find((p) => p.key === "a")!
    const aRun = processes.createPhaseRun({
      runId,
      phaseId: a.id,
      status: "pending",
    })
    processes.updatePhaseRun(aRun.id, {
      taskId: freshTask(),
      error: null,
      validatorRound: 0,
    })
    createApproval({
      taskId: ctx.taskId,
      request: {
        kind: "process_validator_gate",
        phaseKey: "a",
        phaseRunId: aRun.id,
        requestId: randomUUID(),
      },
    })
    const gate = listApprovals({ taskId: ctx.taskId })[0]
    resolveApproval(gate.id, {
      status: "denied",
      decision: { retryReview: true },
    })
    const ran: string[] = []
    ctx.runPhase = async ({ phase }) => {
      ran.push(phase.key)
      return { content: phase.key }
    }

    await runScheduler(ctx)

    expect(ran).toEqual(["b"])
    const fresh = processes.getPhaseRun(aRun.id)!
    expect(fresh.status).toBe("completed")
    expect(fresh.validatorRound).toBe(0)
    expect(fresh.reworkRound).toBe(0)
  })

  it("enters the normal validator rework loop after a retry review rejects", async () => {
    const pid = buildProcess({
      phases: [{ key: "a", validator: true, validatorMaxIterations: 3 }],
    })
    const { ctx, runId } = makeCtx(pid, async () => ({ content: "unused" }))
    const graph = processes.getProcessGraph(pid)!
    const a = graph.phases.find((p) => p.key === "a")!
    const aRun = processes.createPhaseRun({
      runId,
      phaseId: a.id,
      status: "pending",
    })
    processes.updatePhaseRun(aRun.id, {
      taskId: freshTask(),
      validatorRound: 0,
    })
    createApproval({
      taskId: ctx.taskId,
      request: {
        kind: "process_validator_gate",
        phaseKey: "a",
        phaseRunId: aRun.id,
        requestId: randomUUID(),
      },
    })
    resolveApproval(listApprovals({ taskId: ctx.taskId })[0].id, {
      status: "denied",
      decision: { retryReview: true },
    })
    const ran: string[] = []
    const verdicts = [
      { approved: false, feedback: "fix it" },
      { approved: true },
    ]
    ctx.runPhase = async ({ phase }) => {
      ran.push(phase.key)
      return { content: phase.key }
    }
    ctx.validate = async () => verdicts.shift()!

    await runScheduler(ctx)

    expect(ran).toEqual(["a"])
    const fresh = processes.getPhaseRun(aRun.id)!
    expect(fresh.status).toBe("completed")
    expect(fresh.validatorRound).toBe(1)
    expect(fresh.reworkRound).toBe(0)
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
    processes.createPhaseRun({
      runId,
      phaseId: pidOf(pid, "a"),
      status: "completed",
    })
    const bRun = processes.createPhaseRun({
      runId,
      phaseId: pidOf(pid, "b"),
      status: "completed",
    })
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
    expect(
      listApprovals({ taskId: ctx.taskId, status: "pending" })
    ).toHaveLength(0)
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
    processes.createPhaseRun({
      runId,
      phaseId: pidOf(pid, "a"),
      status: "completed",
    })
    const bRun = processes.createPhaseRun({
      runId,
      phaseId: pidOf(pid, "b"),
      status: "completed",
    })
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
    expectNoFailureRecorded(bRun.id)
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

describe.skipIf(!sqliteLoads)(
  "scheduler — sub-process phase (plan 038.1)",
  () => {
    // A parent process: a (sub-process) -> b. The sub-process is a separate
    // definition; the scheduler dispatches phase `a` via the injected runSubProcess
    // (never runPhase), settles it off the closure's result, then releases `b`.
    const buildParentWithSubprocess = (): {
      pid: string
      subId: string
      subPhaseId: string
    } => {
      const sub = buildProcess({ phases: [{ key: "inner" }] })
      const subGraph = processes.getProcessGraph(sub)!
      const pid = buildProcess({
        phases: [{ key: "a", subprocessId: sub }, { key: "b" }],
        edges: [["a", "b"]],
      })
      return { pid, subId: sub, subPhaseId: subGraph.phases[0].id }
    }

    it("runs a sub-process phase inline, completes it, and releases downstream", async () => {
      const { pid } = buildParentWithSubprocess()
      const ranWorker: string[] = []
      const ranSub: string[] = []
      // A sub-process phase must NEVER go through runPhase.
      const runPhase: RunPhase = async ({ phase }) => {
        ranWorker.push(phase.key)
        return { content: phase.key }
      }
      const runSubProcess: RunSubProcess = async ({ phase }) => {
        ranSub.push(phase.key)
        return { content: "nested done" }
      }
      const { ctx, runId } = makeCtx(pid, runPhase, { runSubProcess })
      await runScheduler(ctx)
      expect(ranSub).toEqual(["a"]) // a ran as a sub-process
      expect(ranWorker).toEqual(["b"]) // only b ran a worker
      expect(statusByKey(runId, pid)).toEqual({
        a: "completed",
        b: "completed",
      })
    })

    it("fails the parent phase when the nested run fails (non-retryable)", async () => {
      const { pid } = buildParentWithSubprocess()
      const runPhase: RunPhase = async ({ phase }) => ({ content: phase.key })
      let calls = 0
      const runSubProcess: RunSubProcess = async () => {
        calls++
        return { error: "sub-process run failed", retryable: false }
      }
      const { ctx, runId } = makeCtx(pid, runPhase, { runSubProcess })
      await expect(runScheduler(ctx)).rejects.toThrow(/failed/)
      expect(calls).toBe(1) // no retry
      expect(statusByKey(runId, pid).a).toBe("failed")
      expect(statusByKey(runId, pid).b).toBe("pending") // dependent never ran
    })

    it("fails loudly when no runSubProcess is injected", async () => {
      const { pid } = buildParentWithSubprocess()
      const runPhase: RunPhase = async ({ phase }) => ({ content: phase.key })
      const { ctx, runId } = makeCtx(pid, runPhase) // no runSubProcess
      await expect(runScheduler(ctx)).rejects.toThrow(/failed/)
      expect(statusByKey(runId, pid).a).toBe("failed")
    })

    it("is not treated as a container: a running sub-process phase resets to pending on resume and re-dispatches", async () => {
      const { pid } = buildParentWithSubprocess()
      const runPhase: RunPhase = async ({ phase }) => ({ content: phase.key })
      // Leave the sub-process phase-run `running` (simulate a crash mid-nested-run),
      // then a fresh scheduler pass must reset it to pending and re-dispatch it — a
      // container-with-children would instead be left running.
      const { ctx, runId } = makeCtx(pid, runPhase, {
        runSubProcess: async () => ({ content: "nested done" }),
      })
      // Seed the sub-process phase-run as `running` (a crash mid-nested-run leaves
      // it so). Phase-runs are created lazily by the scheduler, so create it here.
      const aPhaseId = processes
        .getProcessGraph(pid)!
        .phases.find((p) => p.key === "a")!.id
      processes.createPhaseRun({
        runId,
        phaseId: aPhaseId,
        status: "running",
      })

      const dispatched: string[] = []
      await runScheduler({
        run: processes.getProcessRun(runId)!,
        graph: processes.getProcessGraph(pid)!,
        taskId: ctx.taskId,
        signal: new AbortController().signal,
        emit: () => {},
        runPhase,
        runSubProcess: async ({ phase }) => {
          dispatched.push(phase.key)
          return { content: "nested done" }
        },
      })
      expect(dispatched).toEqual(["a"]) // re-dispatched (was reset from running)
      expect(statusByKey(runId, pid).a).toBe("completed")
    })

    it("blocks dependents on a gated sub-process phase until approved, then releases", async () => {
      // a (sub-process, approve) -> b. The sub-process settles `completed` like a
      // normal phase, so the approve gate fires and blocks b (plan 038.1 §6).
      const sub = buildProcess({ phases: [{ key: "inner" }] })
      const pid = buildProcess({
        phases: [
          { key: "a", subprocessId: sub, gate: "approve" },
          { key: "b" },
        ],
        edges: [["a", "b"]],
      })
      const runPhase: RunPhase = async ({ phase }) => ({ content: phase.key })
      const runSubProcess: RunSubProcess = async () => ({
        content: "nested done",
      })
      const { ctx, runId } = makeCtx(pid, runPhase, { runSubProcess })
      await expect(runScheduler(ctx)).rejects.toBeInstanceOf(GateBlockedError)
      expect(statusByKey(runId, pid).a).toBe("completed")
      expect(statusByKey(runId, pid).b).toBe("pending")

      const pending = listApprovals({ taskId: ctx.taskId, status: "pending" })
      expect(pending).toHaveLength(1)
      resolveApproval(pending[0].id, { status: "approved" })
      await runScheduler({
        run: processes.getProcessRun(runId)!,
        graph: processes.getProcessGraph(pid)!,
        taskId: ctx.taskId,
        signal: new AbortController().signal,
        emit: () => {},
        runPhase,
        runSubProcess,
      })
      expect(statusByKey(runId, pid).b).toBe("completed")
    })

    it("propagates a gate raised INSIDE the nested run and completes on resume (plan 038.2)", async () => {
      // a (sub-process) -> b. The sub-process runner throws GateBlockedError the first
      // time (a gate deep inside the child paused the shared task); the throw must
      // propagate out of the parent scheduler uncaught, leaving the sub-process
      // phase-run `running` (never settled) and b pending. On resume the runner
      // succeeds and the run completes.
      const sub = buildProcess({ phases: [{ key: "inner" }] })
      const pid = buildProcess({
        phases: [{ key: "a", subprocessId: sub }, { key: "b" }],
        edges: [["a", "b"]],
      })
      const runPhase: RunPhase = async ({ phase }) => ({ content: phase.key })
      let calls = 0
      const runSubProcess: RunSubProcess = async () => {
        calls++
        if (calls === 1) throw new GateBlockedError()
        return { content: "nested done" }
      }
      const { ctx, runId } = makeCtx(pid, runPhase, { runSubProcess })
      await expect(runScheduler(ctx)).rejects.toBeInstanceOf(GateBlockedError)
      expect(statusByKey(runId, pid).a).toBe("running") // never settled — child threw
      expect(statusByKey(runId, pid).b).toBe("pending")

      // Resume: a fresh scheduler pass resets the `running` sub-process phase-run to
      // pending (not a container) and re-dispatches; the runner now succeeds.
      await runScheduler({
        run: processes.getProcessRun(runId)!,
        graph: processes.getProcessGraph(pid)!,
        taskId: ctx.taskId,
        signal: new AbortController().signal,
        emit: () => {},
        runPhase,
        runSubProcess,
      })
      expect(statusByKey(runId, pid)).toEqual({
        a: "completed",
        b: "completed",
      })
    })

    it("gates the TERMINAL phase of a nested run even with no downstream edge (plan 038.2)", async () => {
      // The reported bug: a sub-process whose LAST phase has gate=approve completed
      // without ever asking, because needsGate skipped a phase with no dependents.
      // In a NESTED run the terminal phase has an implicit dependent (the parent
      // phase awaiting the whole child run), so its gate MUST fire.
      const childPid = buildProcess({
        phases: [{ key: "plan" }, { key: "review", gate: "approve" }],
        edges: [["plan", "review"]],
      })
      const taskId = freshTask()
      // A NESTED run: parentPhaseRunId set (as makeRunSubProcess would create it).
      const parentPid = buildProcess({ phases: [{ key: "outer" }] })
      const parentRun = processes.createProcessRun({
        processId: parentPid,
        sourceConversationId: null,
        taskId,
        objective: "obj",
        status: "running",
      })
      const parentPhaseRun = processes.createPhaseRun({
        runId: parentRun.id,
        phaseId: processes.getProcessGraph(parentPid)!.phases[0].id,
        status: "running",
      })
      const childRun = processes.createProcessRun({
        processId: childPid,
        sourceConversationId: null,
        taskId,
        objective: "obj",
        parentPhaseRunId: parentPhaseRun.id,
        status: "running",
      })
      const runPhase: RunPhase = async ({ phase }) => ({ content: phase.key })
      // Driving the nested run must PAUSE on the terminal `review` gate.
      await expect(
        runScheduler({
          run: childRun,
          graph: processes.getProcessGraph(childPid)!,
          taskId,
          signal: new AbortController().signal,
          emit: () => {},
          runPhase,
        })
      ).rejects.toBeInstanceOf(GateBlockedError)
      const pending = listApprovals({ taskId, status: "pending" })
      expect(pending).toHaveLength(1)
      // The pending gate is on the terminal `review` phase.
      const reviewPhaseId = processes
        .getProcessGraph(childPid)!
        .phases.find((p) => p.key === "review")!.id
      const reviewRun = processes
        .listPhaseRuns({ runId: childRun.id, parentId: null })
        .find((pr) => pr.phaseId === reviewPhaseId)!
      const req = pending[0].request as { phaseRunId?: string }
      expect(req.phaseRunId).toBe(reviewRun.id)

      // Approve + resume: the nested run now completes (no re-gate).
      resolveApproval(pending[0].id, { status: "approved" })
      await runScheduler({
        run: processes.getProcessRun(childRun.id)!,
        graph: processes.getProcessGraph(childPid)!,
        taskId,
        signal: new AbortController().signal,
        emit: () => {},
        runPhase,
      })
      expect(statusByKey(childRun.id, childPid)).toEqual({
        plan: "completed",
        review: "completed",
      })
    })
  }
)

describe.skipIf(!sqliteLoads)(
  "scheduler — combined fan-out + sub-process phase (plan 038.3)",
  () => {
    // A phase with BOTH fan_out and subprocess_id: it decomposes into N sub-tasks,
    // and each CHILD runs the sub-process (never a worker), seeded with the child's
    // briefing as subtaskPrompt.
    const buildCombined = (): { pid: string; subId: string } => {
      const sub = buildProcess({ phases: [{ key: "inner" }] })
      const pid = buildProcess({
        phases: [{ key: "c", fanOut: true, subprocessId: sub }, { key: "d" }],
        edges: [["c", "d"]],
      })
      return { pid, subId: sub }
    }

    it("decomposes then runs the sub-process per child (never a worker)", async () => {
      const { pid } = buildCombined()
      const decompose: Decompose = async () => ({
        subtasks: ["piece 1", "piece 2", "piece 3"],
      })
      const ranWorker: string[] = []
      const ranSubPrompts: string[] = []
      const runPhase: RunPhase = async ({ phase }) => {
        ranWorker.push(phase.key)
        return { content: phase.key }
      }
      const runSubProcess: RunSubProcess = async ({ subtaskPrompt }) => {
        ranSubPrompts.push(subtaskPrompt ?? "(none)")
        return { content: "nested done" }
      }
      const { ctx, runId } = makeCtx(pid, runPhase, {
        decompose,
        runSubProcess,
      })
      await runScheduler(ctx)
      // Each child ran through the sub-process, carrying its briefing; the only
      // worker to run was the downstream phase d.
      expect(ranSubPrompts.sort()).toEqual(["piece 1", "piece 2", "piece 3"])
      expect(ranWorker).toEqual(["d"])
      const cRuns = runsForKey(runId, pid, "c")
      const children = cRuns.filter((r) => r.parentId !== null)
      const parent = cRuns.find((r) => r.parentId === null)!
      expect(children).toHaveLength(3)
      expect(children.every((r) => r.status === "completed")).toBe(true)
      expect(parent.status).toBe("completed")
      expect(statusByKey(runId, pid).d).toBe("completed")
    })

    it("fails the parent when a per-child sub-process fails", async () => {
      const { pid } = buildCombined()
      const decompose: Decompose = async () => ({ subtasks: ["ok", "boom"] })
      const runPhase: RunPhase = async ({ phase }) => ({ content: phase.key })
      const runSubProcess: RunSubProcess = async ({ subtaskPrompt }) => {
        if (subtaskPrompt === "boom")
          return { error: "nested run failed", retryable: false }
        return { content: "ok" }
      }
      const { ctx, runId } = makeCtx(pid, runPhase, {
        decompose,
        runSubProcess,
      })
      await expect(runScheduler(ctx)).rejects.toThrow(/failed/)
      const parent = runsForKey(runId, pid, "c").find(
        (r) => r.parentId === null
      )!
      expect(parent.status).toBe("failed")
      expect(statusByKey(runId, pid).d).toBe("pending") // dependent never ran
    })

    it("resumes without re-decomposing: pending sub-process children re-dispatch", async () => {
      const { pid } = buildCombined()
      const graph = processes.getProcessGraph(pid)!
      const cPhase = graph.phases.find((p) => p.key === "c")!

      // Simulate a crash after decompose: parent running, two children pending.
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
      const { createCheckpoint } =
        await import("../../db/repositories/task-checkpoints")
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
      const ranWorker: string[] = []
      const runPhase: RunPhase = async ({ phase }) => {
        ranWorker.push(phase.key)
        return { content: phase.key }
      }
      const ranSubPrompts: string[] = []
      const runSubProcess: RunSubProcess = async ({ subtaskPrompt }) => {
        ranSubPrompts.push(subtaskPrompt ?? "(none)")
        return { content: "nested" }
      }

      await runScheduler({
        run: processes.getProcessRun(run.id)!,
        graph,
        taskId,
        signal: new AbortController().signal,
        emit: () => {},
        runPhase,
        decompose,
        runSubProcess,
      })

      expect(decomposeCalls).toBe(0) // never re-decomposed
      // The two children re-dispatched through the sub-process (not a worker).
      expect(ranSubPrompts.sort()).toEqual(["resumed 1", "resumed 2"])
      expect(ranWorker).toEqual(["d"]) // only the downstream worker ran
      expect(processes.getPhaseRun(parent.id)!.status).toBe("completed")
    })
  }
)

describe.skipIf(!sqliteLoads)(
  "scheduler — sub-process depth cap (plan 038.1/038.3)",
  () => {
    it("fails a sub-process phase when processDepth is at the cap", async () => {
      // The runtime backstop lives in the service's makeRunSubProcess; here we
      // assert the scheduler threads processDepth into the injected runSubProcess,
      // and that a runner enforcing the cap fails the phase (non-retryable).
      const sub = buildProcess({ phases: [{ key: "inner" }] })
      const pid = buildProcess({ phases: [{ key: "a", subprocessId: sub }] })
      const seenDepths: number[] = []
      const runPhase: RunPhase = async ({ phase }) => ({ content: phase.key })
      const runSubProcess: RunSubProcess = async ({ depth }) => {
        seenDepths.push(depth)
        if (depth >= MAX_PROCESS_DEPTH)
          return {
            error: `max sub-process depth (${MAX_PROCESS_DEPTH}) reached`,
            retryable: false,
          }
        return { content: "nested" }
      }
      const { ctx, runId } = makeCtx(pid, runPhase, {
        runSubProcess,
        processDepth: MAX_PROCESS_DEPTH,
      })
      await expect(runScheduler(ctx)).rejects.toThrow(/failed/)
      expect(seenDepths).toEqual([MAX_PROCESS_DEPTH])
      expect(statusByKey(runId, pid).a).toBe("failed")
    })
  }
)

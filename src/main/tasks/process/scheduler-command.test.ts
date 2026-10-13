import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { runMigrations } from "../../db/migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../../db/connection", () => ({ getDb: () => db }))

import * as processes from "../../db/repositories/processes"
import { listApprovals } from "../../db/repositories/approvals"
import {
  runScheduler,
  GateBlockedError,
  type CommandPhaseResult,
  type RunCommand,
  type RunPhase,
  type SchedulerCtx,
} from "./scheduler"
import { PAUSE_ABORT_REASON } from "../../agent/abort"
import type { TaskEventPayload } from "../runner"
import type { ProcessCommandReceipt } from "../../db/types"

// The scheduler's COMMAND branch (plan 104): a command phase is dispatched like
// any ready phase but settles from the injected executor's receipt — never an
// agent worker, never a retry, never an LLM verdict.

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

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

const CONFIG = {
  source: "literal" as const,
  command: "pnpm test",
  cwd: null,
  timeoutMs: 60_000,
  maxOutputBytes: 4096,
}

// Implement → Test (command) → Publish.
function buildPipeline(opts: { testGate?: "auto" | "approve" } = {}) {
  const def = processes.createProcessDefinition({ name: "Ship" })
  const implement = processes.createPhase({
    processId: def.id,
    key: "implement",
    name: "Implement",
    position: 0,
  })
  const test = processes.createPhase({
    processId: def.id,
    key: "test",
    name: "Test",
    position: 1,
    kind: "command",
    commandConfig: CONFIG,
    gatePolicy: opts.testGate ?? "auto",
  })
  const publish = processes.createPhase({
    processId: def.id,
    key: "publish",
    name: "Publish",
    position: 2,
  })
  processes.createEdge({
    processId: def.id,
    fromPhaseId: implement.id,
    toPhaseId: test.id,
  })
  processes.createEdge({
    processId: def.id,
    fromPhaseId: test.id,
    toPhaseId: publish.id,
  })
  return { processId: def.id, implement, test, publish }
}

function receipt(
  patch: Partial<ProcessCommandReceipt> = {}
): ProcessCommandReceipt {
  return {
    version: 1,
    command: CONFIG.command,
    cwd: null,
    environment: "local",
    status: "completed",
    exitCode: 0,
    signal: null,
    startedAt: 1_000,
    finishedAt: 3_500,
    stdout: "Tests: 12 passed\n",
    stderr: "",
    outputTruncated: false,
    capturedOutputBytes: 17,
    observedOutputBytes: 17,
    error: null,
    ...patch,
  }
}

function makeCtx(
  processId: string,
  input: {
    runCommand?: RunCommand
    runPhase?: RunPhase
    abort?: AbortController
    runId?: string
    taskId?: string
  } = {}
) {
  const taskId = input.taskId ?? freshTask()
  const run = input.runId
    ? processes.getProcessRun(input.runId)!
    : processes.createProcessRun({
        processId,
        sourceConversationId: null,
        taskId,
        objective: "ship it",
        status: "running",
      })
  const events: TaskEventPayload[] = []
  const workerPhases: string[] = []
  const runPhase: RunPhase =
    input.runPhase ??
    (async ({ phase }) => {
      workerPhases.push(phase.key)
      return { content: `${phase.key} done` }
    })
  const ctx: SchedulerCtx = {
    run,
    graph: processes.getProcessGraph(processId)!,
    taskId,
    signal: (input.abort ?? new AbortController()).signal,
    emit: (e) => events.push(e),
    runPhase,
    runCommand: input.runCommand,
  }
  return { ctx, events, workerPhases, runId: run.id, taskId }
}

const phaseRunOf = (runId: string, phaseId: string) =>
  processes
    .listPhaseRuns({ runId, parentId: null })
    .find((pr) => pr.phaseId === phaseId)!

function commandStub(result: CommandPhaseResult | (() => CommandPhaseResult)) {
  const calls: string[] = []
  const runCommand: RunCommand = async ({ phase, onStart }) => {
    calls.push(phase.key)
    const r = typeof result === "function" ? result() : result
    if (r.receipt)
      onStart({ ...r.receipt, status: "running", finishedAt: null })
    return r
  }
  return { runCommand, calls }
}

describe.skipIf(!sqliteLoads)(
  "command phases in the scheduler (plan 104)",
  () => {
    it("runs the command once, never an agent, and unblocks dependents with its receipt", async () => {
      const p = buildPipeline()
      const { runCommand, calls } = commandStub({ receipt: receipt() })
      const { ctx, workerPhases, runId, events } = makeCtx(p.processId, {
        runCommand,
      })

      await runScheduler(ctx)

      expect(calls).toEqual(["test"])
      expect(workerPhases).toEqual(["implement", "publish"])
      const test = phaseRunOf(runId, p.test.id)
      expect(test).toMatchObject({
        status: "completed",
        taskId: null,
        agentName: null,
        commandReceipt: receipt(),
      })
      expect(test.resultContent).toContain("Command: pnpm test")
      expect(test.resultContent).toContain("exited with code 0")
      expect(test.resultContent).toContain("Tests: 12 passed")
      expect(phaseRunOf(runId, p.publish.id).status).toBe("completed")
      // The live output tick is emitted for the monitor.
      expect(
        events.some(
          (e) => e.type === "process_command_output" && e.phaseRunId === test.id
        )
      ).toBe(true)
    })

    it("fails on a non-zero exit with structured diagnostics and blocks dependents", async () => {
      const p = buildPipeline()
      const { runCommand } = commandStub({
        receipt: receipt({ status: "failed", exitCode: 1, stderr: "1 failed" }),
        code: "command_failed",
      })
      const { ctx, workerPhases, runId } = makeCtx(p.processId, { runCommand })

      await expect(runScheduler(ctx)).rejects.toThrow("a process phase failed")

      expect(workerPhases).toEqual(["implement"])
      const test = phaseRunOf(runId, p.test.id)
      expect(test.status).toBe("failed")
      expect(test.failure).toMatchObject({
        code: "command_failed",
        stage: "command",
        retryable: false,
        attempt: 1,
        maxAttempts: 1,
      })
      expect(test.error).toBe("The command exited with code 1.")
      expect(test.commandReceipt?.stderr).toBe("1 failed")
      expect(phaseRunOf(runId, p.publish.id).status).toBe("pending")
      expect(processes.listPhaseAttempts({ runId })).toHaveLength(1)
    })

    it.each([
      [
        "a timeout",
        {
          receipt: receipt({
            status: "timed_out",
            exitCode: null,
            signal: "SIGTERM",
          }),
          code: "command_timed_out",
          error: "The command ran past its 1 min timeout and was stopped.",
        },
        "command_timed_out",
      ],
      [
        "a spawn error",
        {
          receipt: receipt({
            status: "failed",
            exitCode: null,
            error: "ENOENT",
          }),
          code: "command_spawn_failed",
          error: "The command failed to start: ENOENT",
        },
        "command_spawn_failed",
      ],
      [
        "a cleanup failure after exit 0",
        {
          receipt: receipt({
            status: "failed",
            error: "Cleanup failed for /tmp/x",
          }),
          code: "command_cleanup_failed",
          error: "Cleanup failed for /tmp/x",
        },
        "command_cleanup_failed",
      ],
      [
        "a policy block (never spawned)",
        {
          receipt: null,
          code: "command_blocked",
          error:
            "The approval policy blocks this command, so it was not run: x",
        },
        "command_blocked",
      ],
    ])("settles %s as failed exactly once", async (_label, result, code) => {
      const p = buildPipeline()
      const { runCommand, calls } = commandStub(result as CommandPhaseResult)
      const { ctx, runId, events } = makeCtx(p.processId, { runCommand })

      await expect(runScheduler(ctx)).rejects.toThrow("a process phase failed")

      expect(calls).toEqual(["test"])
      const test = phaseRunOf(runId, p.test.id)
      expect(test.status).toBe("failed")
      expect(test.failure?.code).toBe(code)
      expect(test.error).toBe((result as CommandPhaseResult).error)
      const failedEvents = events.filter(
        (e) =>
          e.type === "process_phase" &&
          e.phaseRunId === test.id &&
          e.status === "failed"
      )
      expect(failedEvents).toHaveLength(1)
    })

    it("never treats exit 0 with an executor error as success", async () => {
      const p = buildPipeline()
      const { runCommand } = commandStub({
        receipt: receipt(),
        code: "command_cleanup_failed",
        error: "cleanup failed",
      })
      const { ctx, runId } = makeCtx(p.processId, { runCommand })
      await expect(runScheduler(ctx)).rejects.toThrow()
      expect(phaseRunOf(runId, p.test.id).status).toBe("failed")
    })

    it("settles a cancelled command `cancelled` and keeps what ran", async () => {
      const p = buildPipeline()
      const abort = new AbortController()
      const runCommand: RunCommand = async ({ signal, onStart }) => {
        onStart(receipt({ status: "running", finishedAt: null }))
        abort.abort()
        expect(signal.aborted).toBe(true)
        return {
          receipt: receipt({
            status: "cancelled",
            exitCode: null,
            signal: "SIGINT",
          }),
          stopped: true,
        }
      }
      const { ctx, runId } = makeCtx(p.processId, { runCommand, abort })

      await runScheduler(ctx)

      const test = phaseRunOf(runId, p.test.id)
      expect(test.status).toBe("cancelled")
      expect(test.commandReceipt?.status).toBe("cancelled")
      expect(phaseRunOf(runId, p.publish.id).status).toBe("pending")
    })

    it("fails loudly with no command runner rather than starting an agent", async () => {
      const p = buildPipeline()
      const { ctx, workerPhases, runId } = makeCtx(p.processId)
      await expect(runScheduler(ctx)).rejects.toThrow("a process phase failed")
      expect(workerPhases).toEqual(["implement"])
      expect(phaseRunOf(runId, p.test.id).failure?.code).toBe(
        "command_runner_missing"
      )
    })

    it("does not replay a command that was running when the app stopped", async () => {
      const p = buildPipeline()
      const { runCommand, calls } = commandStub({ receipt: receipt() })
      const first = makeCtx(p.processId, { runCommand })
      // Simulate the crash: Implement done, Test spawned (receipt written), then
      // the process died before the result settled.
      const implementRun = processes.createPhaseRun({
        runId: first.runId,
        phaseId: p.implement.id,
        status: "completed",
      })
      processes.updatePhaseRun(implementRun.id, { resultContent: "done" })
      const testRun = processes.createPhaseRun({
        runId: first.runId,
        phaseId: p.test.id,
        status: "running",
      })
      processes.updatePhaseRun(testRun.id, {
        commandReceipt: receipt({
          status: "running",
          finishedAt: null,
          stdout: "partial",
        }),
      })

      await expect(runScheduler(first.ctx)).rejects.toThrow(
        "a process phase failed"
      )

      expect(calls).toEqual([])
      const test = processes.getPhaseRun(testRun.id)!
      expect(test.status).toBe("failed")
      expect(test.failure).toMatchObject({
        code: "command_interrupted",
        stage: "command",
      })
      expect(test.commandReceipt).toMatchObject({
        status: "interrupted",
        stdout: "partial",
      })
      expect(test.error).toMatch(/not re-run automatically/)
    })

    it("re-runs a command that never spawned before the crash", async () => {
      const p = buildPipeline()
      const { runCommand, calls } = commandStub({ receipt: receipt() })
      const first = makeCtx(p.processId, { runCommand })
      processes.createPhaseRun({
        runId: first.runId,
        phaseId: p.implement.id,
        status: "completed",
      })
      processes.createPhaseRun({
        runId: first.runId,
        phaseId: p.test.id,
        status: "running",
      })

      await runScheduler(first.ctx)

      expect(calls).toEqual(["test"])
      expect(phaseRunOf(first.runId, p.test.id).status).toBe("completed")
    })

    it("does not re-run a command interrupted by a pause on resume", async () => {
      const p = buildPipeline()
      const abort = new AbortController()
      let calls = 0
      const runCommand: RunCommand = async ({ onStart }) => {
        calls++
        onStart(receipt({ status: "running", finishedAt: null }))
        abort.abort(PAUSE_ABORT_REASON)
        return {
          receipt: receipt({ status: "interrupted", exitCode: null }),
          stopped: true,
        }
      }
      const first = makeCtx(p.processId, { runCommand, abort })
      await runScheduler(first.ctx)
      // A resumable abort leaves the row running for the resume.
      expect(phaseRunOf(first.runId, p.test.id).status).toBe("running")

      const resumed = makeCtx(p.processId, {
        runCommand,
        runId: first.runId,
        taskId: first.taskId,
      })
      await expect(runScheduler(resumed.ctx)).rejects.toThrow(
        "a process phase failed"
      )
      expect(calls).toBe(1)
      expect(phaseRunOf(first.runId, p.test.id).failure?.code).toBe(
        "command_interrupted"
      )
    })

    it("gates a command phase on approval with its receipt as evidence", async () => {
      const p = buildPipeline({ testGate: "approve" })
      const { runCommand } = commandStub({ receipt: receipt() })
      const { ctx, taskId, workerPhases } = makeCtx(p.processId, { runCommand })

      await expect(runScheduler(ctx)).rejects.toBeInstanceOf(GateBlockedError)

      expect(workerPhases).toEqual(["implement"])
      const [gate] = listApprovals({ taskId })
      const packet = (
        gate.request as {
          approvalPacket: {
            validations: Array<{ status: string; command: string | null }>
            evidenceWarnings: string[]
          }
        }
      ).approvalPacket
      expect(packet.validations).toEqual([
        expect.objectContaining({ status: "passed", command: "pnpm test" }),
      ])
      expect(packet.evidenceWarnings).toEqual([])
    })
  }
)

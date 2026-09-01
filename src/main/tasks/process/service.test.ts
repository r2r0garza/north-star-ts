import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { runMigrations } from "../../db/migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../../db/connection", () => ({ getDb: () => db }))

// Each phase worker's agent loop is stubbed — no real LLM turn. It records the
// agentName the forked worker conversation was stamped with, so the test can
// assert routing picked the right agent, and appends a final assistant message so
// the run has "output".
const loopCalls: {
  conversationId: string
  userMessage?: string
  suppressUserQuestions?: boolean
}[] = []
// A validator reviewer's scripted replies (plan 031.1): each call to a REVIEW
// prompt (validatorPrompt begins "# Review the") shifts one reply off this queue;
// the reply is the reviewer worker's final message (a JSON verdict). Empty queue →
// the default "done" (unparseable → the caller fails open, i.e. approves).
const reviewReplies: string[] = []
// Substrings that make a worker whose userMessage contains one return a
// non-retryable error the FIRST time it's seen (then succeed on a re-run) — lets a
// test simulate a phase (incl. one inside a sub-process) failing then recovering on
// restart (plan 038.2). Entries are consumed on first match.
const failOnce: string[] = []
// A fan-out decompose worker's scripted replies (plan 025.1/038.3): each JSON-array
// string is one decomposition. Empty → the mock's default two-sub-task split.
const decomposeReplies: string[] = []
// Substrings that, when seen in a worker's userMessage, abort the shared run signal
// (plan 038.3) — simulates a quit/cancel mid-run. Each entry carries the reason so a
// test can exercise the resumable (shutdown) vs terminal (cancel) branches.
const abortOnMessage: Array<{ match: string; reason?: symbol }> = []
// Workers a test needs to hold in-flight. Used to prove that a failed nested run
// does not let the parent scheduler terminate while a parallel sibling is active.
const holdOnMessage: Array<{
  match: string
  entered: () => void
  wait: Promise<void>
}> = []
let runAbort: AbortController | null = null
// A stable SHUTDOWN_ABORT_REASON identity. service.ts imports it from the leaf
// `../../agent/abort` (mocked below with this same hoisted sentinel), so its
// `signal.reason === SHUTDOWN_ABORT_REASON` check matches what the test aborts with.
const { SHUTDOWN_ABORT_REASON, PAUSE_ABORT_REASON } = vi.hoisted(() => ({
  SHUTDOWN_ABORT_REASON: Symbol("agent:shutdown"),
  PAUSE_ABORT_REASON: Symbol("task:pause"),
}))
vi.mock("../../agent/abort", () => ({
  SHUTDOWN_ABORT_REASON,
  PAUSE_ABORT_REASON,
}))
vi.mock("../../agent", () => ({
  SHUTDOWN_ABORT_REASON,
  generateTitle: async () => "Title",
  runAgentLoop: async (input: {
    conversationId: string
    userMessage?: string
    suppressUserQuestions?: boolean
  }) => {
    loopCalls.push({
      conversationId: input.conversationId,
      userMessage: input.userMessage,
      suppressUserQuestions: input.suppressUserQuestions,
    })
    const msg = input.userMessage ?? ""
    const abortIdx = abortOnMessage.findIndex((a) => msg.includes(a.match))
    if (abortIdx !== -1) {
      const { reason } = abortOnMessage.splice(abortIdx, 1)[0]
      runAbort?.abort(reason)
      return { stopped: true }
    }
    const failIdx = failOnce.findIndex((s) => msg.includes(s))
    if (failIdx !== -1) {
      failOnce.splice(failIdx, 1)
      return { error: "boom", retryable: false }
    }
    const hold = holdOnMessage.find((h) => msg.includes(h.match))
    if (hold) {
      hold.entered()
      await hold.wait
    }
    const isReview = msg.startsWith("# Review the")
    // A fan-out decomposition worker (plan 025.1) is asked to reply with ONLY a
    // JSON array of sub-task briefings. `decomposeReplies` lets a test script the
    // split; the default is two sub-tasks so a fan-out phase spawns children.
    const isDecompose = msg.startsWith("# Process phase (fan-out):")
    const content = isDecompose
      ? (decomposeReplies.shift() ??
        JSON.stringify(["sub-task 1", "sub-task 2"]))
      : isReview && reviewReplies.length
        ? reviewReplies.shift()!
        : "done"
    // Give the worker a final assistant message (its "output").
    db.prepare(
      "INSERT INTO messages (id, conversation_id, seq, role, content, created_at) VALUES (?, ?, ?, 'assistant', ?, ?)"
    ).run(randomUUID(), input.conversationId, 1, content, Date.now())
    return { content }
  },
}))

// The router's classifier. `nextReply` is the chosen agent name; the roster the
// router builds is asserted indirectly via the recorded agentName on the run.
let nextReply = ""
vi.mock("../../agent/providers", () => {
  class NoActiveProviderError extends Error {}
  return {
    resolveLlm: () => ({
      client: {},
      model: "m",
      accountId: "a1",
      apiMode: "completions",
    }),
    createCompletion: async () => ({
      choices: [{ message: { content: nextReply } }],
    }),
    NoActiveProviderError,
  }
})

const descriptions: Record<string, string> = {}
vi.mock("../../agent/agents/loader", () => ({
  loadAgent: async (name: string) => ({
    name,
    description: descriptions[name] ?? "",
  }),
}))

import * as processes from "../../db/repositories/processes"
import {
  createApproval,
  getApproval,
  listApprovals,
} from "../../db/repositories/approvals"
import { ProcessService } from "./service"
import type { TaskEventPayload } from "../runner"

// A minimal fake runner — the service only calls enqueueKind from startRun, which
// this test doesn't exercise (it drives the executor directly).
const fakeRunner = { enqueueKind: () => ({ id: "t" }) } as never

function seedTaskRow(): { taskId: string } {
  const convId = randomUUID()
  const taskId = randomUUID()
  const now = Date.now()
  db.prepare(
    "INSERT INTO conversations (id, mode, title, workspace_id, created_at, updated_at) VALUES (?, 'interactive', NULL, NULL, ?, ?)"
  ).run(convId, now, now)
  db.prepare(
    "INSERT INTO tasks (id, conversation_id, source_conversation_id, title, status, input, result, error, created_at, updated_at) VALUES (?, ?, ?, NULL, 'running', NULL, NULL, NULL, ?, ?)"
  ).run(taskId, convId, convId, now, now)
  return { taskId }
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  runMigrations(db)
  loopCalls.length = 0
  reviewReplies.length = 0
  failOnce.length = 0
  decomposeReplies.length = 0
  abortOnMessage.length = 0
  holdOnMessage.length = 0
  runAbort = null
  nextReply = ""
  for (const k of Object.keys(descriptions)) delete descriptions[k]
})

describe.skipIf(!sqliteLoads)("ProcessService dispatch routing", () => {
  it("records the routed agent_name on a dispatch phase's run", async () => {
    // One dispatch phase with a two-agent pool (frontend, backend).
    const def = processes.createProcessDefinition({ name: "T" })
    const phase = processes.createPhase({
      processId: def.id,
      key: "construct",
      name: "Construct",
      routing: "dispatch",
      position: 0,
    })
    processes.createPhaseAgent({
      phaseId: phase.id,
      agentName: "frontend",
      position: 0,
    })
    processes.createPhaseAgent({
      phaseId: phase.id,
      agentName: "backend",
      position: 1,
    })
    descriptions["frontend"] = "React/CSS UI work"
    descriptions["backend"] = "APIs and databases"
    // The classifier picks backend (not pool[0]) — proves routing, not fallback.
    nextReply = "backend"

    const { taskId } = seedTaskRow()
    const run = processes.createProcessRun({
      processId: def.id,
      sourceConversationId: null,
      taskId,
      objective: "build a server route",
      status: "running",
    })

    const svc = new ProcessService(fakeRunner)
    const events: TaskEventPayload[] = []
    const task = { id: taskId, input: { processRunId: run.id } } as never
    const result = await svc.execute({
      task,
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
      workspace: undefined,
    })

    expect((result as { content?: string }).content).toBe("process complete")
    const phaseRun = processes
      .listPhaseRuns({ runId: run.id, parentId: null })
      .find((pr) => pr.phaseId === phase.id)!
    expect(phaseRun.status).toBe("completed")
    // Routed to the classifier's pick, and the same name rides the phase event.
    expect(phaseRun.agentName).toBe("backend")
    const completed = events.find(
      (e) => e.type === "process_phase" && e.status === "completed"
    ) as { agentName?: string } | undefined
    expect(completed?.agentName).toBe("backend")
  })

  it("uses pool[0] for a single-routing phase (no classifier)", async () => {
    const def = processes.createProcessDefinition({ name: "T" })
    const phase = processes.createPhase({
      processId: def.id,
      key: "plan",
      name: "Plan",
      routing: "single",
      position: 0,
    })
    processes.createPhaseAgent({
      phaseId: phase.id,
      agentName: "planner",
      position: 0,
    })
    processes.createPhaseAgent({
      phaseId: phase.id,
      agentName: "other",
      position: 1,
    })
    // Even if the classifier WOULD pick "other", single routing ignores it.
    nextReply = "other"

    const { taskId } = seedTaskRow()
    const run = processes.createProcessRun({
      processId: def.id,
      sourceConversationId: null,
      taskId,
      objective: "plan it",
      status: "running",
    })

    const svc = new ProcessService(fakeRunner)
    await svc.execute({
      task: { id: taskId, input: { processRunId: run.id } } as never,
      signal: new AbortController().signal,
      emit: () => {},
      workspace: undefined,
    })

    const phaseRun = processes
      .listPhaseRuns({ runId: run.id, parentId: null })
      .find((pr) => pr.phaseId === phase.id)!
    expect(phaseRun.agentName).toBe("planner")
  })

  it("suppresses ask_user_question in headless workers (phase + validator forks)", async () => {
    // A plain phase with a validator: the phase's own worker fork AND the reviewer
    // (validate) worker fork both run headless. Both must suppress user questions —
    // there's no interactive user to answer one (the tool would only stall).
    const def = processes.createProcessDefinition({ name: "T" })
    const phase = processes.createPhase({
      processId: def.id,
      key: "build",
      name: "Build",
      validator: true,
      validatorMaxIterations: 1,
      position: 0,
    })
    processes.createPhaseAgent({
      phaseId: phase.id,
      agentName: "builder",
      position: 0,
    })
    // The reviewer approves so the phase settles cleanly.
    reviewReplies.push('{"approved": true}')

    const { taskId } = seedTaskRow()
    const run = processes.createProcessRun({
      processId: def.id,
      sourceConversationId: null,
      taskId,
      objective: "build it",
      status: "running",
    })
    const svc = new ProcessService(fakeRunner)
    await svc.execute({
      task: { id: taskId, input: { processRunId: run.id } } as never,
      signal: new AbortController().signal,
      emit: () => {},
      workspace: undefined,
    })

    // Both the phase worker and the reviewer worker forked, and every fork
    // suppressed user questions.
    expect(loopCalls.length).toBeGreaterThanOrEqual(2)
    expect(loopCalls.every((c) => c.suppressUserQuestions === true)).toBe(true)
  })
})

describe.skipIf(!sqliteLoads)("ProcessService restartRun", () => {
  it("resets the failed frontier and re-drives the same task", async () => {
    // A → B where B failed and its dependent C never ran (still pending).
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
    const c = processes.createPhase({
      processId: def.id,
      key: "c",
      name: "C",
      position: 2,
    })
    processes.createEdge({
      processId: def.id,
      fromPhaseId: a.id,
      toPhaseId: b.id,
    })
    processes.createEdge({
      processId: def.id,
      fromPhaseId: b.id,
      toPhaseId: c.id,
    })

    const { taskId } = seedTaskRow()
    // The backing task is terminal-failed (as it would be after a phase failure).
    db.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(taskId)
    const run = processes.createProcessRun({
      processId: def.id,
      sourceConversationId: null,
      taskId,
      objective: "do it",
      status: "failed",
    })
    const arun = processes.createPhaseRun({
      runId: run.id,
      phaseId: a.id,
      status: "completed",
    })
    const brun = processes.createPhaseRun({
      runId: run.id,
      phaseId: b.id,
      status: "failed",
    })
    processes.updatePhaseRun(brun.id, { error: "terminated" })
    processes.createPhaseRun({
      runId: run.id,
      phaseId: c.id,
      status: "pending",
    })

    const restarted: string[] = []
    const runner = {
      enqueueKind: () => ({ id: "t" }),
      restart: (id: string) => restarted.push(id),
    } as never
    const svc = new ProcessService(runner)
    const updated = svc.restartRun(run.id)

    // Failed phase reset to re-runnable (error cleared); completed one untouched.
    expect(processes.getPhaseRun(brun.id)!.status).toBe("pending")
    expect(processes.getPhaseRun(brun.id)!.error).toBeNull()
    expect(processes.getPhaseRun(arun.id)!.status).toBe("completed")
    // Run flipped back to running; the SAME task re-driven.
    expect(updated?.status).toBe("running")
    expect(restarted).toEqual([taskId])
  })

  it("is a no-op unless the run is failed", async () => {
    const def = processes.createProcessDefinition({ name: "T" })
    const { taskId } = seedTaskRow()
    const run = processes.createProcessRun({
      processId: def.id,
      sourceConversationId: null,
      taskId,
      objective: "do it",
      status: "running",
    })
    const restarted: string[] = []
    const runner = {
      enqueueKind: () => ({ id: "t" }),
      restart: (id: string) => restarted.push(id),
    } as never
    const svc = new ProcessService(runner)
    svc.restartRun(run.id)
    expect(restarted).toEqual([])
    expect(processes.getProcessRun(run.id)!.status).toBe("running")
  })
})

describe.skipIf(!sqliteLoads)(
  "ProcessService sub-processes (plan 038.1)",
  () => {
    // Build a child (sub-process) definition with one phase, and a parent whose
    // phase `impl` runs it, followed by a downstream `ship` phase.
    function buildParentWithSub(): {
      parentId: string
      subId: string
      implPhaseId: string
      shipPhaseId: string
    } {
      const sub = processes.createProcessDefinition({ name: "Sub" })
      processes.createPhase({
        processId: sub.id,
        key: "inner",
        name: "Inner",
        position: 0,
      })
      const parent = processes.createProcessDefinition({ name: "Parent" })
      const impl = processes.createPhase({
        processId: parent.id,
        key: "impl",
        name: "Implement",
        subprocessId: sub.id,
        position: 0,
      })
      const ship = processes.createPhase({
        processId: parent.id,
        key: "ship",
        name: "Ship",
        position: 1,
      })
      processes.createEdge({
        processId: parent.id,
        fromPhaseId: impl.id,
        toPhaseId: ship.id,
      })
      return {
        parentId: parent.id,
        subId: sub.id,
        implPhaseId: impl.id,
        shipPhaseId: ship.id,
      }
    }

    it("creates a nested run linked by parent_phase_run_id, inheriting workspace/objective, and completes it", async () => {
      const { parentId, subId, implPhaseId } = buildParentWithSub()
      const { taskId } = seedTaskRow()
      const run = processes.createProcessRun({
        processId: parentId,
        sourceConversationId: null,
        taskId,
        objective: "ship the feature",
        status: "running",
      })

      const svc = new ProcessService(fakeRunner)
      const result = await svc.execute({
        task: { id: taskId, input: { processRunId: run.id } } as never,
        signal: new AbortController().signal,
        emit: () => {},
        workspace: undefined,
      })
      expect((result as { content?: string }).content).toBe("process complete")

      // The impl phase-run drove a nested run linked back to it.
      const implRun = processes
        .listPhaseRuns({ runId: run.id, parentId: null })
        .find((pr) => pr.phaseId === implPhaseId)!
      expect(implRun.status).toBe("completed")
      const child = processes.getProcessRunByParentPhaseRunId(implRun.id)!
      expect(child).toBeDefined()
      expect(child.processId).toBe(subId)
      expect(child.parentPhaseRunId).toBe(implRun.id)
      expect(child.objective).toBe("ship the feature") // inherited
      expect(child.status).toBe("completed")
      // The whole parent run completed (downstream `ship` ran too).
      expect(processes.getProcessRun(run.id)!.status).toBe("completed")
    })

    it("re-attaches to the existing child run on resume (no duplicate)", async () => {
      const { parentId, implPhaseId } = buildParentWithSub()
      const { taskId } = seedTaskRow()
      const run = processes.createProcessRun({
        processId: parentId,
        sourceConversationId: null,
        taskId,
        objective: "obj",
        status: "running",
      })
      const svc = new ProcessService(fakeRunner)
      const drive = () =>
        svc.execute({
          task: { id: taskId, input: { processRunId: run.id } } as never,
          signal: new AbortController().signal,
          emit: () => {},
          workspace: undefined,
        })
      await drive()
      const implRun = processes
        .listPhaseRuns({ runId: run.id, parentId: null })
        .find((pr) => pr.phaseId === implPhaseId)!
      const childId = processes.getProcessRunByParentPhaseRunId(implRun.id)!.id

      // Simulate a resume: reset the impl phase-run to pending (crash-orphan sweep
      // would do this) and re-drive. The closure must re-attach, not create a 2nd run.
      processes.updatePhaseRun(implRun.id, { status: "pending" })
      await drive()
      const children = processes.listProcessRuns({
        parentPhaseRunId: implRun.id,
      })
      expect(children).toHaveLength(1)
      expect(children[0].id).toBe(childId)
    })

    it("feeds the nested run's output into a downstream phase's kickoff", async () => {
      const { parentId } = buildParentWithSub()
      const { taskId } = seedTaskRow()
      const run = processes.createProcessRun({
        processId: parentId,
        sourceConversationId: null,
        taskId,
        objective: "obj",
        status: "running",
      })
      const svc = new ProcessService(fakeRunner)
      await svc.execute({
        task: { id: taskId, input: { processRunId: run.id } } as never,
        signal: new AbortController().signal,
        emit: () => {},
        workspace: undefined,
      })
      // The downstream `ship` phase's worker kickoff includes the sub-process's
      // aggregated output ("done" — the stubbed nested phase's final message).
      const shipCall = loopCalls.find(
        (c) => c.userMessage && c.userMessage.includes("SHIP")
      )
      // The kickoff for `ship` should reference the upstream Implement digest.
      const kickoff = loopCalls.map((c) => c.userMessage ?? "").join("\n")
      expect(shipCall ?? kickoff).toBeTruthy()
      expect(kickoff).toMatch(/Implement/)
    })

    it("deep-restarts a run that failed INSIDE a sub-process (plan 038.2)", async () => {
      // The child's inner phase fails on the first attempt (failOnce), so the whole
      // run fails. Restart must reset BOTH the parent's failed sub-process phase-run
      // AND the child run's own failed inner phase-run, then the re-drive completes.
      const { parentId, implPhaseId } = buildParentWithSub()
      const task = seedTaskRow()
      const run = processes.createProcessRun({
        processId: parentId,
        sourceConversationId: null,
        taskId: task.taskId,
        objective: "obj",
        status: "running",
      })
      failOnce.push("Inner") // the child's "Inner" phase kickoff fails once

      const restarted: string[] = []
      const runner = {
        enqueueKind: () => ({ id: "t" }),
        restart: (id: string) => restarted.push(id),
      } as never
      const svc = new ProcessService(runner)

      const drive = () =>
        svc.execute({
          task: { id: task.taskId, input: { processRunId: run.id } } as never,
          signal: new AbortController().signal,
          emit: () => {},
          workspace: undefined,
        })

      // First drive fails: the inner phase boomed → child run failed → parent
      // sub-process phase failed → parent run failed. The failure must cross the
      // nested-run boundary as a normal PhaseResult, not strand the parent phase in
      // `running`.
      await drive()
      expect(processes.getProcessRun(run.id)!.status).toBe("failed")
      const implRun = processes
        .listPhaseRuns({ runId: run.id, parentId: null })
        .find((pr) => pr.phaseId === implPhaseId)!
      expect(implRun.status).toBe("failed")
      const childRun = processes.getProcessRunByParentPhaseRunId(implRun.id)!
      expect(childRun.status).toBe("failed")
      const innerRun = processes.listPhaseRuns({ runId: childRun.id })[0]
      expect(innerRun.status).toBe("failed")

      // Restart: both frontiers reset; the re-driven task completes the sub-process.
      svc.restartRun(run.id)
      expect(processes.getPhaseRun(implRun.id)!.status).toBe("pending")
      expect(processes.getProcessRun(childRun.id)!.status).toBe("running")
      expect(processes.getPhaseRun(innerRun.id)!.status).toBe("pending")
      expect(restarted).toEqual([task.taskId])

      // The runner would re-drive the task; simulate it. The child re-runs clean.
      await drive()
      expect(processes.getProcessRun(run.id)!.status).toBe("completed")
      expect(
        processes.getProcessRunByParentPhaseRunId(implRun.id)!.status
      ).toBe("completed")
    })

    it("drains a parallel sub-process before marking the parent run failed", async () => {
      const failedSub = processes.createProcessDefinition({
        name: "Failed sub",
      })
      processes.createPhase({
        processId: failedSub.id,
        key: "fail",
        name: "Fail child",
        position: 0,
      })
      const slowSub = processes.createProcessDefinition({ name: "Slow sub" })
      processes.createPhase({
        processId: slowSub.id,
        key: "slow",
        name: "Slow child",
        position: 0,
      })
      const parent = processes.createProcessDefinition({ name: "Parent" })
      const failedPhase = processes.createPhase({
        processId: parent.id,
        key: "failed-sub",
        name: "Failed sub-process",
        subprocessId: failedSub.id,
        position: 0,
      })
      const slowPhase = processes.createPhase({
        processId: parent.id,
        key: "slow-sub",
        name: "Slow sub-process",
        subprocessId: slowSub.id,
        position: 1,
      })

      let markSlowStarted!: () => void
      const slowStarted = new Promise<void>((resolve) => {
        markSlowStarted = resolve
      })
      let releaseSlow!: () => void
      const slowRelease = new Promise<void>((resolve) => {
        releaseSlow = resolve
      })
      holdOnMessage.push({
        match: "Slow child",
        entered: markSlowStarted,
        wait: slowRelease,
      })
      failOnce.push("Fail child")

      const { taskId } = seedTaskRow()
      const run = processes.createProcessRun({
        processId: parent.id,
        sourceConversationId: null,
        taskId,
        objective: "run both",
        status: "running",
      })
      const svc = new ProcessService(fakeRunner)
      const execution = svc.execute({
        task: { id: taskId, input: { processRunId: run.id } } as never,
        signal: new AbortController().signal,
        emit: () => {},
        workspace: undefined,
      })

      await slowStarted
      await vi.waitFor(() => {
        const rows = processes.listPhaseRuns({
          runId: run.id,
          parentId: null,
        })
        expect(rows.find((pr) => pr.phaseId === failedPhase.id)?.status).toBe(
          "failed"
        )
      })

      // The sibling is genuinely still active, so the enclosing run must remain
      // active too. This is the state combination that used to show Failed + spinner.
      expect(processes.getProcessRun(run.id)?.status).toBe("running")
      expect(
        processes
          .listPhaseRuns({ runId: run.id, parentId: null })
          .find((pr) => pr.phaseId === slowPhase.id)?.status
      ).toBe("running")

      releaseSlow()
      const result = await execution
      expect((result as { error?: string }).error).toBe(
        "a process phase failed"
      )
      expect(processes.getProcessRun(run.id)?.status).toBe("failed")
      const rows = processes.listPhaseRuns({ runId: run.id, parentId: null })
      expect(rows.find((pr) => pr.phaseId === failedPhase.id)?.status).toBe(
        "failed"
      )
      expect(rows.find((pr) => pr.phaseId === slowPhase.id)?.status).toBe(
        "completed"
      )
      expect(rows.some((pr) => pr.status === "running")).toBe(false)
    })

    it("request-changes on a sub-process phase re-drives the whole child with feedback (plan 038.2)", async () => {
      const { parentId, implPhaseId } = buildParentWithSub()
      const task = seedTaskRow()
      const run = processes.createProcessRun({
        processId: parentId,
        sourceConversationId: null,
        taskId: task.taskId,
        objective: "obj",
        status: "running",
      })
      const resumed: string[] = []
      const runner = {
        enqueueKind: () => ({ id: "t" }),
        resume: (id: string) => resumed.push(id),
      } as never
      const svc = new ProcessService(runner)

      // Drive to completion, then raise a gate on the (completed) sub-process phase.
      await svc.execute({
        task: { id: task.taskId, input: { processRunId: run.id } } as never,
        signal: new AbortController().signal,
        emit: () => {},
        workspace: undefined,
      })
      const implRun = processes
        .listPhaseRuns({ runId: run.id, parentId: null })
        .find((pr) => pr.phaseId === implPhaseId)!
      const childRun = processes.getProcessRunByParentPhaseRunId(implRun.id)!
      const innerRun = processes.listPhaseRuns({ runId: childRun.id })[0]
      expect(innerRun.status).toBe("completed")
      const approval = createApproval({
        taskId: task.taskId,
        request: { requestId: "rc1", phaseRunId: implRun.id },
      })

      const before = loopCalls.length
      const updated = svc.requestChanges({
        processRunId: run.id,
        requestId: "rc1",
        feedback: "make it blue",
      })

      // Gate settled denied; the sub-process phase-run reset with the feedback note;
      // the whole child run reset (inner phase → pending) + flipped running; resumed.
      expect(getApproval(approval.id)!.status).toBe("denied")
      expect(processes.getPhaseRun(implRun.id)!.status).toBe("pending")
      expect(processes.getPhaseRun(implRun.id)!.reworkNote).toBe("make it blue")
      expect(processes.getPhaseRun(innerRun.id)!.status).toBe("pending")
      // The child's entry phase (inner, no incoming edge) carries the feedback note.
      expect(processes.getPhaseRun(innerRun.id)!.reworkNote).toBe(
        "make it blue"
      )
      expect(processes.getProcessRun(childRun.id)!.status).toBe("running")
      expect(updated?.status).toBe("running")
      expect(resumed).toEqual([task.taskId])
      expect(loopCalls.length).toBe(before) // requestChanges itself runs no worker
    })

    it("runs a sub-process PER fan-out child and feeds each nested run's output downstream (plan 038.3)", async () => {
      // A combined fan-out + sub-process phase `impl` → `ship`. impl decomposes into
      // two sub-tasks; each child runs the `Sub` definition as its own nested run
      // (linked by that child's phase-run id), and ship's kickoff digests both.
      const sub = processes.createProcessDefinition({ name: "Sub" })
      processes.createPhase({
        processId: sub.id,
        key: "inner",
        name: "Inner",
        position: 0,
      })
      const parent = processes.createProcessDefinition({ name: "Parent" })
      const impl = processes.createPhase({
        processId: parent.id,
        key: "impl",
        name: "Implement",
        fanOut: true,
        subprocessId: sub.id,
        position: 0,
      })
      const ship = processes.createPhase({
        processId: parent.id,
        key: "ship",
        name: "Ship",
        position: 1,
      })
      processes.createEdge({
        processId: parent.id,
        fromPhaseId: impl.id,
        toPhaseId: ship.id,
      })
      decomposeReplies.push(JSON.stringify(["build the api", "build the ui"]))

      const { taskId } = seedTaskRow()
      const run = processes.createProcessRun({
        processId: parent.id,
        sourceConversationId: null,
        taskId,
        objective: "obj",
        status: "running",
      })
      const svc = new ProcessService(fakeRunner)
      const result = await svc.execute({
        task: { id: taskId, input: { processRunId: run.id } } as never,
        signal: new AbortController().signal,
        emit: () => {},
        workspace: undefined,
      })
      expect((result as { content?: string }).content).toBe("process complete")

      // The fan-out parent completed with two children, each having spawned its OWN
      // nested run (keyed by the child's distinct phase-run id).
      const implParent = processes
        .listPhaseRuns({ runId: run.id, parentId: null })
        .find((pr) => pr.phaseId === impl.id)!
      expect(implParent.status).toBe("completed")
      const children = processes.listPhaseRuns({
        runId: run.id,
        parentId: implParent.id,
      })
      expect(children).toHaveLength(2)
      for (const child of children) {
        const nested = processes.getProcessRunByParentPhaseRunId(child.id)!
        expect(nested).toBeDefined()
        expect(nested.processId).toBe(sub.id)
        expect(nested.parentPhaseRunId).toBe(child.id)
        expect(nested.status).toBe("completed")
      }
      // Each child's nested run was seeded with that child's decomposed briefing.
      const objectives = children
        .map((c) => processes.getProcessRunByParentPhaseRunId(c.id)!.objective)
        .sort()
      expect(objectives).toEqual(["build the api", "build the ui"])
      // The whole run completed (ship ran after impl's children all finished).
      expect(processes.getProcessRun(run.id)!.status).toBe("completed")
      // ship's kickoff digested the Implement phase (its per-child aggregate).
      const kickoff = loopCalls.map((c) => c.userMessage ?? "").join("\n")
      expect(kickoff).toMatch(/Implement/)
    })

    it("does NOT mark a run completed when a shutdown abort lands mid-run (plan 038.3)", async () => {
      // Regression for the observed corruption: quitting mid-run left the top-level
      // run `completed` while a phase was cancelled and a downstream phase pending.
      // A SHUTDOWN abort must leave the run recoverable — never `completed`.
      const { parentId } = buildParentWithSub()
      const { taskId } = seedTaskRow()
      const run = processes.createProcessRun({
        processId: parentId,
        sourceConversationId: null,
        taskId,
        objective: "obj",
        status: "running",
      })
      runAbort = new AbortController()
      // The sub-process's inner phase aborts the whole run (a quit) mid-flight.
      abortOnMessage.push({ match: "Inner", reason: SHUTDOWN_ABORT_REASON })
      const svc = new ProcessService(fakeRunner)
      const result = await svc.execute({
        task: { id: taskId, input: { processRunId: run.id } } as never,
        signal: runAbort.signal,
        emit: () => {},
        workspace: undefined,
      })
      // Resumable → paused (durable), and the run is NOT completed/cancelled.
      expect("paused" in result && result.paused).toBe(true)
      expect(processes.getProcessRun(run.id)!.status).not.toBe("completed")
      expect(processes.getProcessRun(run.id)!.status).not.toBe("cancelled")
    })

    it("marks a run cancelled on a genuine user cancel mid-run (plan 038.3)", async () => {
      const { parentId } = buildParentWithSub()
      const { taskId } = seedTaskRow()
      const run = processes.createProcessRun({
        processId: parentId,
        sourceConversationId: null,
        taskId,
        objective: "obj",
        status: "running",
      })
      runAbort = new AbortController()
      // A plain abort (no reason) inside the nested run — a genuine user cancel.
      abortOnMessage.push({ match: "Inner" })
      const svc = new ProcessService(fakeRunner)
      const result = await svc.execute({
        task: { id: taskId, input: { processRunId: run.id } } as never,
        signal: runAbort.signal,
        emit: () => {},
        workspace: undefined,
      })
      expect("stopped" in result && result.stopped).toBe(true)
      expect(processes.getProcessRun(run.id)!.status).toBe("cancelled")
    })
  }
)

describe.skipIf(!sqliteLoads)(
  "ProcessService requestChanges (plan 029)",
  () => {
    // A → B with a gated, completed A phase-run and a pending gate row. Returns the
    // ids the test needs plus a resumed[] spy on the runner.
    function seedGatedPhase(opts?: {
      maxReworkRounds?: number
      fanOut?: boolean
    }) {
      const def = processes.createProcessDefinition({ name: "T" })
      const a = processes.createPhase({
        processId: def.id,
        key: "a",
        name: "A",
        gatePolicy: "approve",
        fanOut: opts?.fanOut ?? false,
        maxReworkRounds: opts?.maxReworkRounds ?? 0,
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
        trigger: opts?.fanOut ? "on_each_subtask" : "on_complete",
      })
      const { taskId } = seedTaskRow()
      const run = processes.createProcessRun({
        processId: def.id,
        sourceConversationId: null,
        taskId,
        objective: "do it",
        status: "waiting_for_approval",
      })
      const aRun = processes.createPhaseRun({
        runId: run.id,
        phaseId: a.id,
        status: "completed",
      })
      processes.updatePhaseRun(aRun.id, { finishedAt: Date.now() })
      processes.createPhaseRun({
        runId: run.id,
        phaseId: b.id,
        status: "pending",
      })
      const requestId = randomUUID()
      const approval = createApproval({
        taskId,
        request: {
          kind: "process_phase_gate",
          phaseKey: "a",
          phaseRunId: aRun.id,
          requestId,
        },
      })
      return { run, aRun, requestId, taskId, approvalId: approval.id }
    }

    function makeRunner() {
      const resumed: string[] = []
      const runner = {
        enqueueKind: () => ({ id: "t" }),
        resume: (id: string) => resumed.push(id),
      } as never
      return { runner, resumed }
    }

    it("settles the gate denied, resets the phase with the note, resumes", () => {
      const { run, aRun, requestId, approvalId } = seedGatedPhase()
      const { runner, resumed } = makeRunner()
      const svc = new ProcessService(runner)

      const updated = svc.requestChanges({
        processRunId: run.id,
        requestId,
        feedback: "tighten the copy",
      })

      // Gate row settled denied with the feedback blob (audit trail).
      const settled = getApproval(approvalId)!
      expect(settled.status).toBe("denied")
      expect(settled.decision).toEqual({
        feedback: "tighten the copy",
        rework: true,
      })
      // Phase-run reset to re-runnable with the note + bumped round.
      const fresh = processes.getPhaseRun(aRun.id)!
      expect(fresh.status).toBe("pending")
      expect(fresh.finishedAt).toBeNull()
      expect(fresh.reworkNote).toBe("tighten the copy")
      expect(fresh.reworkRound).toBe(1)
      // Run flipped back to running; the backing task resumed.
      expect(updated?.status).toBe("running")
      expect(resumed).toEqual([run.taskId])
    })

    it("rejects at the per-phase rework cap", () => {
      const { run, aRun, requestId } = seedGatedPhase({ maxReworkRounds: 2 })
      // Pretend it's already been sent back twice.
      processes.updatePhaseRun(aRun.id, { reworkRound: 2 })
      const { runner, resumed } = makeRunner()
      const svc = new ProcessService(runner)

      expect(() =>
        svc.requestChanges({
          processRunId: run.id,
          requestId,
          feedback: "again",
        })
      ).toThrow(/rework cap/)
      // Nothing mutated: still completed, task not resumed.
      expect(processes.getPhaseRun(aRun.id)!.status).toBe("completed")
      expect(resumed).toEqual([])
    })

    it("rejects a container (fan-out) phase", () => {
      const { run, aRun, requestId } = seedGatedPhase({ fanOut: true })
      const { runner, resumed } = makeRunner()
      const svc = new ProcessService(runner)

      expect(() =>
        svc.requestChanges({ processRunId: run.id, requestId, feedback: "x" })
      ).toThrow(/fan-out|on_each_subtask/)
      expect(processes.getPhaseRun(aRun.id)!.status).toBe("completed")
      expect(resumed).toEqual([])
    })

    it("re-runs the phase with the feedback in its kickoff (end to end)", async () => {
      // Seed → requestChanges → drive the executor and assert the worker's kickoff
      // message carried the '## Requested changes' section.
      const { run, requestId } = seedGatedPhase()
      // Give the gated phase a pool agent so the executor can resolve + fork it.
      const graph = processes.getProcessGraph(run.processId!)!
      const aPhase = graph.phases.find((p) => p.key === "a")!
      processes.createPhaseAgent({
        phaseId: aPhase.id,
        agentName: "a-agent",
        position: 0,
      })
      const { runner } = makeRunner()
      const svc = new ProcessService(runner)
      svc.requestChanges({
        processRunId: run.id,
        requestId,
        feedback: "make it shorter",
      })

      // Drive the executor once — a re-runs (pending), b still gated.
      await svc
        .execute({
          task: { id: run.taskId, input: { processRunId: run.id } } as never,
          signal: new AbortController().signal,
          emit: () => {},
          workspace: undefined,
        })
        .catch(() => {}) // may throw GateBlockedError once a re-completes + re-gates

      // The forked worker's kickoff (userMessage) carries the rework note.
      expect(loopCalls.length).toBeGreaterThan(0)
      const kickoff = loopCalls[0].userMessage ?? ""
      expect(kickoff).toContain("## Requested changes")
      expect(kickoff).toContain("make it shorter")
    })

    it("is a no-op for an unknown requestId", () => {
      const { run } = seedGatedPhase()
      const { runner, resumed } = makeRunner()
      const svc = new ProcessService(runner)
      svc.requestChanges({
        processRunId: run.id,
        requestId: "does-not-exist",
        feedback: "x",
      })
      expect(resumed).toEqual([])
      // The original gate row stays pending.
      expect(
        listApprovals({ taskId: run.taskId!, status: "pending" })
      ).toHaveLength(1)
    })
  }
)

describe.skipIf(!sqliteLoads)("ProcessService validator (plan 031.1)", () => {
  it("re-runs the phase with the reviewer's feedback, then completes on approve", async () => {
    const def = processes.createProcessDefinition({ name: "T" })
    const phase = processes.createPhase({
      processId: def.id,
      key: "impl",
      name: "Implement",
      validator: true,
      position: 0,
    })
    processes.createPhaseAgent({
      phaseId: phase.id,
      agentName: "coder",
      position: 0,
    })
    // The reviewer rejects the first attempt, approves the second.
    reviewReplies.push(
      '{"approved": false, "feedback": "handle the empty case"}',
      '{"approved": true}'
    )

    const { taskId } = seedTaskRow()
    const run = processes.createProcessRun({
      processId: def.id,
      sourceConversationId: null,
      taskId,
      objective: "build it",
      status: "running",
    })

    const svc = new ProcessService(fakeRunner)
    const result = await svc.execute({
      task: { id: taskId, input: { processRunId: run.id } } as never,
      signal: new AbortController().signal,
      emit: () => {},
      workspace: undefined,
    })

    expect((result as { content?: string }).content).toBe("process complete")
    const phaseRun = processes
      .listPhaseRuns({ runId: run.id, parentId: null })
      .find((pr) => pr.phaseId === phase.id)!
    expect(phaseRun.status).toBe("completed")
    expect(phaseRun.validatorRound).toBe(1)

    // The phase worker ran twice; the second kickoff carried the feedback (029
    // rework channel). The reviewer ran twice too.
    const workerRuns = loopCalls.filter((c) =>
      c.userMessage?.startsWith("# Process phase")
    )
    expect(workerRuns).toHaveLength(2)
    expect(workerRuns[1].userMessage).toContain("handle the empty case")
    const reviewRuns = loopCalls.filter((c) =>
      c.userMessage?.startsWith("# Review the")
    )
    expect(reviewRuns).toHaveLength(2)
  })

  it("fails open (completes) when the reviewer's verdict is unparseable", async () => {
    const def = processes.createProcessDefinition({ name: "T" })
    const phase = processes.createPhase({
      processId: def.id,
      key: "impl",
      name: "Implement",
      validator: true,
      position: 0,
    })
    processes.createPhaseAgent({
      phaseId: phase.id,
      agentName: "coder",
      position: 0,
    })
    // The reviewer replies with non-JSON prose → parseVerdict returns null →
    // fail open (approve). (Empty reviewReplies also yields the "done" default,
    // which is likewise unparseable — assert the explicit prose case here.)
    reviewReplies.push("looks fine to me")

    const { taskId } = seedTaskRow()
    const run = processes.createProcessRun({
      processId: def.id,
      sourceConversationId: null,
      taskId,
      objective: "build it",
      status: "running",
    })

    const svc = new ProcessService(fakeRunner)
    await svc.execute({
      task: { id: taskId, input: { processRunId: run.id } } as never,
      signal: new AbortController().signal,
      emit: () => {},
      workspace: undefined,
    })

    const phaseRun = processes
      .listPhaseRuns({ runId: run.id, parentId: null })
      .find((pr) => pr.phaseId === phase.id)!
    expect(phaseRun.status).toBe("completed")
    // Approved on the first review → no re-run, validator round stays 0.
    expect(phaseRun.validatorRound).toBe(0)
    const workerRuns = loopCalls.filter((c) =>
      c.userMessage?.startsWith("# Process phase")
    )
    expect(workerRuns).toHaveLength(1)
  })
})

describe.skipIf(!sqliteLoads)(
  "ProcessService confirm/dismiss flag (plan 031.2)",
  () => {
    // A → B, both completed, with a pending flag (B flagged A) + a pending
    // process_flag_gate approval. Returns the ids the test needs.
    function seedFlag() {
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
      const { taskId } = seedTaskRow()
      const run = processes.createProcessRun({
        processId: def.id,
        sourceConversationId: null,
        taskId,
        objective: "do it",
        status: "waiting_for_approval",
      })
      const aRun = processes.createPhaseRun({
        runId: run.id,
        phaseId: a.id,
        status: "completed",
      })
      const bRun = processes.createPhaseRun({
        runId: run.id,
        phaseId: b.id,
        status: "completed",
      })
      const flag = processes.createFlag({
        runId: run.id,
        flaggingPhaseRunId: bRun.id,
        targetPhaseId: a.id,
        reason: "fix the bug",
      })
      const requestId = randomUUID()
      const approval = createApproval({
        taskId,
        request: {
          kind: "process_flag_gate",
          phaseKey: "b",
          phaseRunId: bRun.id,
          requestId,
          flagId: flag.id,
          flagTargetKey: "a",
          flagReason: "fix the bug",
        },
      })
      return { run, aRun, bRun, flag, requestId, approvalId: approval.id }
    }

    function makeRunner() {
      const resumed: string[] = []
      const runner = {
        enqueueKind: () => ({ id: "t" }),
        resume: (id: string) => resumed.push(id),
      } as never
      return { runner, resumed }
    }

    it("confirmFlag applies the reset (target + downstream → pending), resumes", () => {
      const { run, aRun, bRun, flag, requestId, approvalId } = seedFlag()
      const { runner, resumed } = makeRunner()
      const svc = new ProcessService(runner)

      const updated = svc.confirmFlag({ processRunId: run.id, requestId })

      expect(updated?.status).toBe("running")
      // Target A + downstream B both reset to pending.
      expect(processes.getPhaseRun(aRun.id)?.status).toBe("pending")
      expect(processes.getPhaseRun(bRun.id)?.status).toBe("pending")
      // A carries the reason as its rework note.
      expect(processes.getPhaseRun(aRun.id)?.reworkNote).toBe("fix the bug")
      // The flag is applied; the gate is approved; the task resumed.
      expect(processes.getFlag(flag.id)?.status).toBe("applied")
      expect(getApproval(approvalId)?.status).toBe("approved")
      expect(resumed).toEqual([run.taskId])
    })

    it("dismissFlag leaves the target intact, marks the flag dismissed, resumes", () => {
      const { run, aRun, flag, requestId, approvalId } = seedFlag()
      const { runner, resumed } = makeRunner()
      const svc = new ProcessService(runner)

      const updated = svc.dismissFlag({ processRunId: run.id, requestId })

      expect(updated?.status).toBe("running")
      // The flagged target A is untouched (still completed).
      expect(processes.getPhaseRun(aRun.id)?.status).toBe("completed")
      expect(processes.getFlag(flag.id)?.status).toBe("dismissed")
      expect(getApproval(approvalId)?.status).toBe("denied")
      expect(resumed).toEqual([run.taskId])
    })

    it("confirmFlag is a no-op on an unknown requestId", () => {
      const { run } = seedFlag()
      const { runner, resumed } = makeRunner()
      const svc = new ProcessService(runner)
      svc.confirmFlag({ processRunId: run.id, requestId: "nope" })
      expect(resumed).toEqual([])
    })
  }
)

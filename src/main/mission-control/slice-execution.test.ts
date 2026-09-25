import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { tmpdir } from "os"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))
vi.mock("../conversations/lifecycle", () => ({
  cleanupConversationArtifacts: async () => {},
}))
const { SHUTDOWN_ABORT_REASON, PAUSE_ABORT_REASON } = vi.hoisted(() => ({
  SHUTDOWN_ABORT_REASON: Symbol("agent:shutdown"),
  PAUSE_ABORT_REASON: Symbol("task:pause"),
}))
vi.mock("../agent/abort", () => ({ SHUTDOWN_ABORT_REASON, PAUSE_ABORT_REASON }))

interface LoopCall {
  conversationId: string
  userMessage?: string
  agentName: string | null
  agentOverride?: { name: string; tools?: string[] }
  sectionContent: string
  proofStep: boolean
  proofResult?: RecordProofResult
  seat?: { address: string; profile: string; anchor: unknown }
}
const loopCalls: LoopCall[] = []
// What a proof-step worker submits through record_proof, per call (FIFO).
const proofSubmissions: Array<Record<string, unknown>> = []

vi.mock("../agent", () => ({
  SHUTDOWN_ABORT_REASON,
  generateTitle: async () => "Title",
  runAgentLoop: async (input: {
    conversationId: string
    userMessage?: string
    agentOverride?: { name: string; tools?: string[] }
    extraContextSections?: Array<{ content: string }>
    processProofStep?: boolean
    processRunId?: string
    processPhaseRunId?: string
    missionControlSeat?: { address: string; profile: string; anchor: unknown }
  }) => {
    const call: LoopCall = {
      conversationId: input.conversationId,
      userMessage: input.userMessage,
      agentName: db
        .prepare("SELECT agent_name FROM conversations WHERE id = ?")
        .pluck()
        .get(input.conversationId) as string | null,
      agentOverride: input.agentOverride,
      sectionContent: (input.extraContextSections ?? [])
        .map((s) => s.content)
        .join("\n"),
      proofStep: !!input.processProofStep,
      seat: input.missionControlSeat,
    }
    loopCalls.push(call)
    const msg = input.userMessage ?? ""
    let content = "done"
    if (msg.startsWith("# Review the")) content = '{"approved": true}'
    if (input.processProofStep && proofSubmissions.length) {
      call.proofResult = recordSliceProof({
        processRunId: input.processRunId!,
        processPhaseRunId: input.processPhaseRunId!,
        args: proofSubmissions.shift()!,
      })
      content = "verified"
    }
    const seq =
      (db
        .prepare("SELECT MAX(seq) FROM messages WHERE conversation_id = ?")
        .pluck()
        .get(input.conversationId) as number | null) ?? 0
    db.prepare(
      "INSERT INTO messages (id, conversation_id, seq, role, content, created_at) VALUES (?, ?, ?, 'assistant', ?, ?)"
    ).run(randomUUID(), input.conversationId, seq + 1, content, Date.now())
    return { content }
  },
}))
// The dispatch router's classifier reply.
let routerReply = ""
vi.mock("../agent/providers", () => {
  class NoActiveProviderError extends Error {}
  return {
    resolveLlm: () => ({ client: {}, model: "m", apiMode: "completions" }),
    createCompletion: async () => ({
      choices: [{ message: { content: routerReply } }],
    }),
    NoActiveProviderError,
  }
})

const AGENTS = ["builder", "qa", "lead"].map((name) => ({
  name,
  refId: `agentref:v1:${name}`,
  label: `Agent ${name}`,
  description: `${name} agent`,
  tools: ["read", "edit", "execute"],
  body: `You are ${name}.`,
}))
vi.mock("../agent/agents/loader", () => ({
  loadAgent: async (name: string) =>
    AGENTS.find((a) => a.refId === name || a.name === name) ?? null,
}))

import * as processes from "../db/repositories/processes"
import * as rigs from "../db/repositories/rigs"
import * as initiatives from "../db/repositories/initiatives"
import * as playbooks from "../db/repositories/playbooks"
import { upsertWorkspace } from "../db/repositories/workspaces"
import { ProcessService } from "../tasks/process/service"
import { createDefaultPlaybook } from "./playbook-defaults"
import {
  SliceRunner,
  recordSliceProof,
  type RecordProofResult,
} from "./slice-runner"
import { startHookRun } from "./hook-runner"
import { installSeatSessions, SeatSessionService } from "./sessions"
import * as seatSessionsRepo from "../db/repositories/seat-sessions"
import type { AgentDefinition } from "../agent/agents/types"

const enqueued: string[] = []
const fakeRunner = {
  enqueueKind: () => {
    const conversationId = randomUUID()
    const taskId = randomUUID()
    const now = Date.now()
    db.prepare(
      "INSERT INTO conversations (id, mode, title, workspace_id, created_at, updated_at) VALUES (?, 'interactive', NULL, NULL, ?, ?)"
    ).run(conversationId, now, now)
    db.prepare(
      "INSERT INTO tasks (id, conversation_id, source_conversation_id, title, status, input, result, error, created_at, updated_at) VALUES (?, ?, ?, NULL, 'queued', NULL, NULL, NULL, ?, ?)"
    ).run(taskId, conversationId, conversationId, now, now)
    enqueued.push(taskId)
    return { id: taskId }
  },
} as never

let service: ProcessService
let runner: SliceRunner
const cancelledTasks: string[] = []

function setup() {
  service = new ProcessService(fakeRunner)
  runner = new SliceRunner({
    startProcessRun: (input) => service.startRun(input),
    cancelTask: (taskId) => cancelledTasks.push(taskId),
    loadAgents: async () => AGENTS as unknown as AgentDefinition[],
  })
  service.onRunSettled((id) => runner.settle(id))
}

// The "Orchestrated" starter rig: orchestration oversees implementation.
function orchestratedRig(options: { qaAgent?: string | null } = {}) {
  const rig = rigs.createRig({
    name: "Orchestrated",
    cultureMd: "Rig culture: small reviewed steps.",
  })
  const orchestration = rigs.createPod({
    rigId: rig.id,
    key: "orchestration",
    name: "Orchestration",
  })
  const implementation = rigs.createPod({
    rigId: rig.id,
    key: "implementation",
    name: "Implementation",
    missionStatement: "Ship working slices.",
    cultureMd: "Pod culture: tests first.",
  })
  rigs.createSeat({
    podId: orchestration.id,
    key: "lead",
    role: "lead",
    agentRefId: "agentref:v1:lead",
    agentLabel: "Agent lead",
  })
  rigs.createSeat({
    podId: implementation.id,
    key: "builder",
    role: "builder",
    charter: "Builder charter: own the implementation.",
    agentRefId: "agentref:v1:builder",
    agentLabel: "Agent builder",
    tools: ["read", "edit"],
  })
  rigs.createSeat({
    podId: implementation.id,
    key: "qa",
    role: "qa",
    charter: "QA charter: verify independently.",
    agentRefId:
      options.qaAgent === undefined ? "agentref:v1:qa" : options.qaAgent,
    agentLabel: "Agent qa",
  })
  rigs.setOversight(rig.id, [
    { overseerPodId: orchestration.id, overseenPodId: implementation.id },
  ])
  return rig
}

function billingInitiative(rigId: string) {
  const workspace = upsertWorkspace(tmpdir())
  const graph = initiatives.createInitiative({
    key: "billing",
    name: "Billing",
    intent: "Customers can be invoiced.",
    definitionOfDone: "Invoices are generated monthly.",
    rigId,
    workspaceId: workspace.id,
  })
  const mission = graph.missions[0]
  initiatives.createSlice({
    missionId: mission.id,
    key: "invoice-model",
    title: "Invoice model",
    spec: {
      goal: "Add an invoice model.",
      acceptance: ["Invoice has line items", "Totals are computed"],
    },
  })
  initiatives.startInitiative(graph.initiative.id)
  const full = initiatives.getInitiativeGraph(graph.initiative.id)!
  return { initiative: full.initiative, mission, slice: full.slices[0] }
}

async function drive(processRunId: string, signal = new AbortController().signal) {
  const run = processes.getProcessRun(processRunId)!
  await service.execute({
    task: { id: run.taskId!, input: { processRunId } } as never,
    signal,
    emit: () => {},
    workspace: undefined,
  } as never)
}

const acceptedProof = {
  verdict: "accepted",
  criteria: [
    { id: "AC-1", status: "met", evidence: "Ran the model tests: line items persist." },
    { id: "AC-2", status: "met", evidence: "Totals test passes." },
  ],
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  runMigrations(db)
  loopCalls.length = 0
  proofSubmissions.length = 0
  enqueued.length = 0
  cancelledTasks.length = 0
  routerReply = ""
  setup()
})

describe.skipIf(!sqliteLoads)("slice execution", () => {
  it("runs spec → build → test with bound seats and marks the slice done on an accepted proof", async () => {
    const rig = orchestratedRig()
    const { slice } = billingInitiative(rig.id)
    proofSubmissions.push(acceptedProof)

    const playbookRun = await runner.startSlice(slice.id)
    expect(initiatives.getSlice(slice.id)).toMatchObject({
      status: "running",
      attempts: 1,
    })
    await drive(playbookRun.processRunId!)

    const workers = loopCalls.filter((c) => !c.userMessage?.startsWith("# Review the"))
    expect(workers.map((c) => c.agentName)).toEqual([
      "agentref:v1:builder",
      "agentref:v1:builder",
      "agentref:v1:qa",
    ])
    expect(workers.map((c) => c.proofStep)).toEqual([false, false, true])
    // Seat narrowing reaches the worker as a runtime-only agent override.
    expect(workers[0].agentOverride?.tools).toEqual(["read", "edit"])
    // Seat charter, rig culture, pod culture, and intent chain are in context.
    expect(workers[0].sectionContent).toContain("builder@implementation")
    expect(workers[0].sectionContent).toContain("Builder charter")
    expect(workers[0].sectionContent).toContain("Rig culture: small reviewed steps.")
    expect(workers[0].sectionContent).toContain("Pod culture: tests first.")
    expect(workers[0].sectionContent).toContain("Customers can be invoiced.")
    expect(workers[2].sectionContent).toContain("QA charter")
    // The objective is the rendered spec with stable criterion ids.
    expect(workers[0].userMessage).toContain("**AC-1**: Invoice has line items")
    expect(workers[2].userMessage).toContain("record_proof")
    expect(workers[2].proofResult).toMatchObject({ ok: true, status: "accepted" })

    const phaseRuns = processes.listPhaseRuns({ runId: playbookRun.processRunId! })
    expect(phaseRuns.map((pr) => pr.seatAddress).sort()).toEqual([
      "builder@implementation",
      "builder@implementation",
      "qa@implementation",
    ])

    const done = initiatives.getSlice(slice.id)!
    expect(done.status).toBe("done")
    expect(done.proof).toMatchObject({
      verdict: "accepted",
      verifiedBy: { kind: "seat", address: "qa@implementation" },
      builderAddresses: ["builder@implementation"],
    })
    expect(playbooks.getPlaybookRun(playbookRun.id)!.status).toBe("completed")
  })

  it("fails before any worker starts when a playbook role is missing from the rig", async () => {
    const rig = orchestratedRig()
    const { slice } = billingInitiative(rig.id)
    const playbook = createDefaultPlaybook("slice")
    const graph = processes.getProcessGraph(
      playbook.hooks.find((h) => h.hook === "run")!.processId
    )!
    processes.createPhaseAgent({
      phaseId: graph.phases[0].id,
      seatRole: "designer",
      position: 1,
    })

    await expect(runner.startSlice(slice.id)).rejects.toThrow(
      /No seat has role "designer"/
    )
    expect(enqueued).toHaveLength(0)
    expect(loopCalls).toHaveLength(0)
    expect(playbooks.listPlaybookRuns({ sliceId: slice.id })).toHaveLength(0)
    expect(initiatives.getSlice(slice.id)).toMatchObject({
      status: "draft",
      attempts: 0,
    })
  })

  it("names a vacant seat instead of falling back to a default agent", async () => {
    const rig = orchestratedRig({ qaAgent: null })
    const { slice } = billingInitiative(rig.id)
    await expect(runner.startSlice(slice.id)).rejects.toThrow(
      /qa@implementation is vacant/
    )
    expect(enqueued).toHaveLength(0)
  })

  it("rejects a builder verifying its own slice and fails the slice without a proof", async () => {
    const rig = orchestratedRig()
    const { slice } = billingInitiative(rig.id)
    const playbook = createDefaultPlaybook("slice")
    const graph = processes.getProcessGraph(
      playbook.hooks.find((h) => h.hook === "run")!.processId
    )!
    const test = graph.phases.find((p) => p.key === "test")!
    for (const agent of processes.listPhaseAgents(test.id))
      processes.deletePhaseAgent(agent.id)
    processes.createPhaseAgent({ phaseId: test.id, seatRole: "builder", position: 0 })
    proofSubmissions.push(acceptedProof)

    const playbookRun = await runner.startSlice(slice.id)
    await drive(playbookRun.processRunId!)

    const proofCall = loopCalls.find((c) => c.proofStep)!
    expect(proofCall.proofResult).toMatchObject({
      ok: false,
      code: "proof_rejected_by_rules",
    })
    expect(
      (proofCall.proofResult as { message: string }).message
    ).toMatch(/builder@implementation built this slice/)
    expect(initiatives.getSlice(slice.id)!.status).toBe("failed")
    expect(playbooks.getPlaybookRun(playbookRun.id)).toMatchObject({
      status: "failed",
      outcomeReason: "The playbook finished without recording a proof.",
    })
  })

  // A runner whose service never notifies it: the playbook run stays open
  // after its Process run finishes, so a test can call record_proof directly.
  function unsettledRunner() {
    const detached = new ProcessService(fakeRunner)
    const detachedRunner = new SliceRunner({
      startProcessRun: (input) => detached.startRun(input),
      cancelTask: () => {},
      loadAgents: async () => AGENTS as unknown as AgentDefinition[],
    })
    const driveDetached = async (processRunId: string) => {
      const run = processes.getProcessRun(processRunId)!
      await detached.execute({
        task: { id: run.taskId!, input: { processRunId } } as never,
        signal: new AbortController().signal,
        emit: () => {},
        workspace: undefined,
      } as never)
    }
    return { detachedRunner, driveDetached }
  }

  function qaPhaseRun(processRunId: string) {
    return processes
      .listPhaseRuns({ runId: processRunId })
      .find((pr) => pr.seatAddress === "qa@implementation")!
  }

  it("freezes an accepted proof", async () => {
    const rig = orchestratedRig()
    const { slice } = billingInitiative(rig.id)
    proofSubmissions.push(acceptedProof)
    const { detachedRunner, driveDetached } = unsettledRunner()
    const playbookRun = await detachedRunner.startSlice(slice.id)
    await driveDetached(playbookRun.processRunId!)

    const again = recordSliceProof({
      processRunId: playbookRun.processRunId!,
      processPhaseRunId: qaPhaseRun(playbookRun.processRunId!).id,
      args: { ...acceptedProof, verdict: "rejected" },
    })
    expect(again).toMatchObject({ ok: false, code: "already_accepted" })
    expect(playbooks.getPlaybookRun(playbookRun.id)!.proof).toMatchObject({
      verdict: "accepted",
    })
  })

  it("fails the slice with the last proof once rejected revisions are exhausted", async () => {
    const rig = orchestratedRig()
    const { slice } = billingInitiative(rig.id)
    const rejected = {
      verdict: "rejected",
      criteria: [
        { id: "AC-1", status: "met", evidence: "Line items persist." },
        { id: "AC-2", status: "not_met", evidence: "Totals ignore tax." },
      ],
    }
    proofSubmissions.push(rejected)
    const { detachedRunner, driveDetached } = unsettledRunner()
    const playbookRun = await detachedRunner.startSlice(slice.id)
    await driveDetached(playbookRun.processRunId!)
    const record = () =>
      recordSliceProof({
        processRunId: playbookRun.processRunId!,
        processPhaseRunId: qaPhaseRun(playbookRun.processRunId!).id,
        args: rejected,
      })

    expect(record()).toMatchObject({ ok: true, status: "rejected" })
    const last = record()
    expect(last).toMatchObject({ ok: true, status: "rejected" })
    expect((last as { message: string }).message).toMatch(/No revisions remain/)
    expect(record()).toMatchObject({ ok: false, code: "revisions_exhausted" })
    expect(playbooks.getPlaybookRun(playbookRun.id)!.proofRevisions).toBe(2)

    runner.reconcile()
    expect(initiatives.getSlice(slice.id)).toMatchObject({
      status: "failed",
      proof: { verdict: "rejected" },
    })
  })

  it("rejects an accepted verdict while a criterion is not met", async () => {
    const rig = orchestratedRig()
    const { slice } = billingInitiative(rig.id)
    proofSubmissions.push({
      verdict: "accepted",
      criteria: [
        { id: "AC-1", status: "met", evidence: "ok" },
        { id: "AC-2", status: "not_met", evidence: "Totals ignore tax." },
      ],
    })
    const playbookRun = await runner.startSlice(slice.id)
    await drive(playbookRun.processRunId!)
    expect(loopCalls.find((c) => c.proofStep)!.proofResult).toMatchObject({
      ok: false,
      code: "proof_rejected_by_rules",
    })
  })

  it("applies the slice outcome exactly once across listener replays and boot reconcile", async () => {
    const rig = orchestratedRig()
    const { slice } = billingInitiative(rig.id)
    proofSubmissions.push(acceptedProof)
    const playbookRun = await runner.startSlice(slice.id)
    await drive(playbookRun.processRunId!)
    const revisionsBefore = initiatives.listRevisions(
      initiatives.getMission(slice.missionId)!.initiativeId
    ).length

    runner.settle(playbookRun.processRunId!)
    runner.reconcile()

    expect(
      initiatives.listRevisions(
        initiatives.getMission(slice.missionId)!.initiativeId
      )
    ).toHaveLength(revisionsBefore)
    expect(initiatives.getSlice(slice.id)).toMatchObject({
      status: "done",
      attempts: 1,
    })
  })

  it("recovers an outcome at boot when the app stopped before settling", async () => {
    const rig = orchestratedRig()
    const { slice } = billingInitiative(rig.id)
    proofSubmissions.push(acceptedProof)
    // A runner the service never notifies models a crash between the run
    // finishing and its outcome being applied.
    const { detachedRunner, driveDetached } = unsettledRunner()
    const playbookRun = await detachedRunner.startSlice(slice.id)
    await driveDetached(playbookRun.processRunId!)
    expect(initiatives.getSlice(slice.id)!.status).toBe("proving")

    runner.reconcile()
    expect(initiatives.getSlice(slice.id)!.status).toBe("done")
  })

  it("allows one playbook run per workspace at a time", async () => {
    const rig = orchestratedRig()
    const { slice, mission } = billingInitiative(rig.id)
    initiatives.createSlice({
      missionId: mission.id,
      key: "invoice-api",
      title: "Invoice API",
      spec: { goal: "Expose invoices.", acceptance: ["GET /invoices works"] },
    })
    const second = initiatives
      .listSlices(mission.id)
      .find((s) => s.key === "invoice-api")!
    await runner.startSlice(slice.id)
    await expect(runner.startSlice(second.id)).rejects.toThrow(
      /slice invoice-model is still running/
    )
  })

  it("cancels a parked run, keeps the slice retryable, and caps attempts", async () => {
    const rig = orchestratedRig()
    const { slice, initiative } = billingInitiative(rig.id)
    db.prepare("UPDATE initiatives SET budgets = ? WHERE id = ?").run(
      JSON.stringify({ maxSliceAttempts: 2 }),
      initiative.id
    )
    const first = await runner.startSlice(slice.id)
    runner.cancelSlice(slice.id)
    expect(cancelledTasks).toHaveLength(1)
    expect(playbooks.getPlaybookRun(first.id)!.status).toBe("cancelled")
    expect(processes.getProcessRun(first.processRunId!)!.status).toBe("cancelled")
    expect(initiatives.getSlice(slice.id)!.status).toBe("failed")

    await runner.startSlice(slice.id)
    runner.cancelSlice(slice.id)
    expect(initiatives.getSlice(slice.id)!.attempts).toBe(2)
    await expect(runner.startSlice(slice.id)).rejects.toThrow(/all 2 attempts/)
  })

  it("refuses a proof step whose seat runs on a CLI provider before spending an attempt", async () => {
    const rig = orchestratedRig()
    const { slice } = billingInitiative(rig.id)
    const cliRunner = new SliceRunner({
      startProcessRun: (input) => service.startRun(input),
      cancelTask: () => {},
      loadAgents: async () => AGENTS as unknown as AgentDefinition[],
      workerProvider: () => "claude_code",
    })
    await expect(cliRunner.startSlice(slice.id)).rejects.toThrow(
      /qa@implementation on Claude Code, which cannot record a proof/
    )
    expect(initiatives.getSlice(slice.id)!.attempts).toBe(0)
    expect(enqueued).toHaveLength(0)
  })

  it("refuses to retry a Mission Control run from the Processes screen", async () => {
    const rig = orchestratedRig()
    const { slice } = billingInitiative(rig.id)
    const playbookRun = await runner.startSlice(slice.id)
    processes.updateProcessRun(playbookRun.processRunId!, { status: "failed" })
    expect(() => service.restartRun(playbookRun.processRunId!)).toThrow(
      /Mission Control/
    )
  })

  it("dispatches across several seats that share a role", async () => {
    const rig = orchestratedRig()
    const implementation = rigs
      .listPods(rig.id)
      .find((p) => p.key === "implementation")!
    rigs.createSeat({
      podId: implementation.id,
      key: "builder-2",
      role: "builder",
      charter: "Second builder: owns the API layer.",
      agentRefId: "agentref:v1:lead",
      agentLabel: "Agent lead",
    })
    const { slice } = billingInitiative(rig.id)
    const playbook = createDefaultPlaybook("slice")
    const graph = processes.getProcessGraph(
      playbook.hooks.find((h) => h.hook === "run")!.processId
    )!
    const spec = graph.phases.find((p) => p.key === "spec")!
    processes.updatePhase(spec.id, { routing: "dispatch" })
    routerReply = "builder-2@implementation"
    proofSubmissions.push(acceptedProof)

    const playbookRun = await runner.startSlice(slice.id)
    await drive(playbookRun.processRunId!)

    const specRun = processes
      .listPhaseRuns({ runId: playbookRun.processRunId! })
      .find((pr) => pr.phaseId === spec.id)!
    expect(specRun.seatAddress).toBe("builder-2@implementation")
    expect(loopCalls[0].sectionContent).toContain("Second builder")
    // Both builders did build-type work only where they ran; the proof lists
    // exactly the seats that did.
    expect(initiatives.getSlice(slice.id)!.proof).toMatchObject({
      builderAddresses: ["builder-2@implementation", "builder@implementation"],
    })
  })

  it("runs a mission hook with the lead found through oversight", async () => {
    const rig = orchestratedRig()
    const { initiative, mission } = billingInitiative(rig.id)
    const playbookRun = await startHookRun(runner, {
      initiativeId: initiative.id,
      missionId: mission.id,
      hook: "before_slices",
    })
    await drive(playbookRun.processRunId!)
    expect(loopCalls.map((c) => c.agentName)).toEqual(["agentref:v1:lead"])
    expect(loopCalls[0].userMessage).toContain("invoice-model")
    expect(loopCalls[0].sectionContent).toContain("lead@orchestration")
    expect(playbooks.getPlaybookRun(playbookRun.id)!.status).toBe("completed")

    await expect(
      startHookRun(runner, {
        initiativeId: initiative.id,
        missionId: mission.id,
        hook: "after_each_slice",
      })
    ).rejects.toThrow(/hook is empty/)
  })

  describe("context scopes", () => {
    async function runTwoSlices(qaScope?: "initiative") {
      const rig = orchestratedRig()
      const { initiative, mission, slice } = billingInitiative(rig.id)
      const second = initiatives
        .createSlice({
          missionId: mission.id,
          key: "invoice-api",
          title: "Invoice API",
          spec: { goal: "Expose invoices.", acceptance: ["GET works", "POST works"] },
        })
        .slices.find((s) => s.key === "invoice-api")!
      const playbook = createDefaultPlaybook("slice")
      initiatives.updateSlice(slice.id, { playbookId: playbook.id })
      initiatives.updateSlice(second.id, { playbookId: playbook.id })
      if (qaScope) {
        const graph = processes.getProcessGraph(
          playbook.hooks.find((h) => h.hook === "run")!.processId
        )!
        const test = graph.phases.find((p) => p.key === "test")!
        processes.updatePhase(test.id, { contextScope: qaScope })
      }
      const runIds: string[] = []
      for (const id of [slice.id, second.id]) {
        proofSubmissions.push(acceptedProof)
        const playbookRun = await runner.startSlice(id)
        runIds.push(playbookRun.id)
        await drive(playbookRun.processRunId!)
        expect(initiatives.getSlice(id)!.status).toBe("done")
      }
      const workers = loopCalls.filter((c) => !c.userMessage?.startsWith("# Review the"))
      return {
        initiative,
        second,
        runIds,
        workers,
        builder: workers.filter((c) => c.seat?.address === "builder@implementation"),
        qa: workers.filter((c) => c.seat?.address === "qa@implementation"),
      }
    }

    beforeEach(() => {
      installSeatSessions(
        new SeatSessionService({
          runTurn: async () => ({ content: "" }),
          loadAgents: async () => AGENTS as unknown as AgentDefinition[],
          enqueueWake: () => ({ id: randomUUID() }),
          cancelTask: () => {},
        })
      )
      return () => installSeatSessions(null)
    })

    it("gives builder and QA one session per slice by default", async () => {
      const { initiative, second, runIds, workers, builder, qa } = await runTwoSlices()
      const sessionFor = (address: string, runId: string) =>
        seatSessionsRepo.listSeatSessions({
          initiativeId: initiative.id,
          seatAddress: address,
          playbookRunId: runId,
        })[0]
      // Spec and build share the builder's slice session; each slice gets its own.
      for (const [index, runId] of runIds.entries()) {
        const builderSession = sessionFor("builder@implementation", runId)
        expect(builder.slice(index * 2, index * 2 + 2).map((c) => c.conversationId)).toEqual([
          builderSession.conversationId,
          builderSession.conversationId,
        ])
        expect(qa[index].conversationId).toBe(
          sessionFor("qa@implementation", runId).conversationId
        )
      }
      expect(builder[0].conversationId).not.toBe(builder[2].conversationId)
      expect(qa[0].conversationId).not.toBe(qa[1].conversationId)
      // No long-lived session was needed.
      expect(
        seatSessionsRepo.listSeatSessions({ initiativeId: initiative.id, playbookRunId: null })
      ).toHaveLength(0)
      // Every role-bound worker is a seat turn, anchored to its slice.
      expect(workers.every((c) => c.seat?.profile === "work")).toBe(true)
      expect(qa[1].seat?.anchor).toEqual({ kind: "slice", id: second.id })
      expect(qa[1].sectionContent).toContain("## Mission Control Comms")
      // Each step's frozen result is its own turn's output.
      const secondRun = playbooks.listPlaybookRuns({ sliceId: second.id })[0]
      const testRun = processes
        .listPhaseRuns({ runId: secondRun.processRunId! })
        .find((pr) => pr.seatAddress === "qa@implementation")!
      expect(testRun.resultContent).toBe("verified")
    })

    it("keeps a long-lived QA session across slices when the step asks for it", async () => {
      const { initiative, qa } = await runTwoSlices("initiative")
      const session = seatSessionsRepo.getLiveSeatSession(
        initiative.id,
        "qa@implementation"
      )!
      expect(session.scope).toBe("initiative")
      expect(qa.map((c) => c.conversationId)).toEqual([
        session.conversationId,
        session.conversationId,
      ])
    })
  })
})

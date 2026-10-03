import { describe, it, expect, beforeEach, afterAll, vi } from "vitest"
import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { existsSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
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
  writeScope?: { allow: string[] }
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
    writeScope?: { allow: string[] }
    abort?: AbortController
  }) => {
    // A worker that never finishes on its own, like nav-test-8's refine.
    if (hangLoops && input.abort) {
      const signal = input.abort.signal
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true })
      )
      return { stopped: true }
    }
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
      writeScope: input.writeScope,
    }
    loopCalls.push(call)
    const msg = input.userMessage ?? ""
    // QA sends the work back to build once (flag_for_rework's durable effect).
    if (flagBackOnce && input.processProofStep && input.processRunId) {
      flagBackOnce = false
      const run = processes.getProcessRun(input.processRunId)!
      const build = processes
        .listPhases(run.processId!)
        .find((p) => p.key === "build")!
      processes.createFlag({
        runId: input.processRunId,
        flaggingPhaseRunId: input.processPhaseRunId!,
        targetPhaseId: build.id,
        reason: "AC-2 fails.",
      })
      return { content: "flagged" }
    }
    let content = "done"
    if (msg.startsWith("# Review the")) content = '{"approved": true}'
    if (input.processProofStep && proofSubmissions.length) {
      call.proofResult = recordUserStoryProof({
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
let hangLoops = false
let flagBackOnce = false
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
import { listApprovals } from "../db/repositories/approvals"
import * as rigs from "../db/repositories/rigs"
import * as features from "../db/repositories/features"
import * as playbooks from "../db/repositories/playbooks"
import { upsertWorkspace } from "../db/repositories/workspaces"
import { ProcessService } from "../tasks/process/service"
import { createDefaultPlaybook } from "./playbook-defaults"
import {
  UserStoryRunner,
  processRunFailure,
  recordUserStoryProof,
  type RecordProofResult,
} from "./user-story-runner"
import { startHookRun } from "./hook-runner"
import { installSeatSessions, SeatSessionService } from "./sessions"
import * as seatSessionsRepo from "../db/repositories/seat-sessions"
import type { AgentDefinition } from "../agent/agents/types"

const enqueued: string[] = []
const enqueuedInputs: unknown[] = []
const fakeRunner = {
  enqueueKind: (request: { input?: unknown }) => {
    enqueuedInputs.push(request.input)
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
let runner: UserStoryRunner
const cancelledTasks: string[] = []

function setup() {
  service = new ProcessService(fakeRunner)
  runner = new UserStoryRunner({
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
    missionStatement: "Ship working user stories.",
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

// QA steps create their checks and scratch directories in the workspace, so it
// is a folder of this file's own rather than the shared temp dir.
const workspaceDir = mkdtempSync(join(tmpdir(), "mc-exec-"))
afterAll(() => rmSync(workspaceDir, { recursive: true, force: true }))

function billingFeature(rigId: string) {
  const workspace = upsertWorkspace(workspaceDir)
  const graph = features.createFeature({
    key: "billing",
    name: "Billing",
    intent: "Customers can be invoiced.",
    definitionOfDone: "Invoices are generated monthly.",
    rigId,
    workspaceId: workspace.id,
  })
  const milestone = graph.milestones[0]
  features.createUserStory({
    milestoneId: milestone.id,
    key: "invoice-model",
    title: "Invoice model",
    spec: {
      goal: "Add an invoice model.",
      acceptance: ["Invoice has line items", "Totals are computed"],
    },
  })
  features.startFeature(graph.feature.id)
  const full = features.getFeatureGraph(graph.feature.id)!
  return { feature: full.feature, milestone, userStory: full.userStories[0] }
}

async function drive(
  processRunId: string,
  signal = new AbortController().signal
) {
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
    {
      id: "AC-1",
      status: "met",
      evidence: "Ran the model tests: line items persist.",
    },
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

describe.skipIf(!sqliteLoads)("user story execution", () => {
  it("runs spec → build → test with bound seats and marks the user story done on an accepted proof", async () => {
    const rig = orchestratedRig()
    const { userStory } = billingFeature(rig.id)
    proofSubmissions.push(acceptedProof)

    const playbookRun = await runner.startUserStory(userStory.id)
    expect(features.getUserStory(userStory.id)).toMatchObject({
      status: "running",
      attempts: 1,
    })
    await drive(playbookRun.processRunId!)

    const workers = loopCalls.filter(
      (c) => !c.userMessage?.startsWith("# Review the")
    )
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
    expect(workers[0].sectionContent).toContain(
      "Rig culture: small reviewed steps."
    )
    expect(workers[0].sectionContent).toContain("Pod culture: tests first.")
    expect(workers[0].sectionContent).toContain("Customers can be invoiced.")
    expect(workers[2].sectionContent).toContain("QA charter")
    // The objective is the rendered spec with stable criterion ids.
    expect(workers[0].userMessage).toContain("**AC-1**: Invoice has line items")
    expect(workers[2].userMessage).toContain("record_proof")
    expect(workers[2].proofResult).toMatchObject({
      ok: true,
      status: "accepted",
    })

    const phaseRuns = processes.listPhaseRuns({
      runId: playbookRun.processRunId!,
    })
    expect(phaseRuns.map((pr) => pr.seatAddress).sort()).toEqual([
      "builder@implementation",
      "builder@implementation",
      "qa@implementation",
    ])

    const done = features.getUserStory(userStory.id)!
    expect(done.status).toBe("done")
    expect(done.proof).toMatchObject({
      verdict: "accepted",
      verifiedBy: { kind: "seat", address: "qa@implementation" },
      builderAddresses: ["builder@implementation"],
    })
    expect(playbooks.getPlaybookRun(playbookRun.id)!.status).toBe("completed")
  })

  it("confines the QA seat's writes to its checks and scratch directories (plan 109.01)", async () => {
    const rig = orchestratedRig()
    const { userStory } = billingFeature(rig.id)
    proofSubmissions.push(acceptedProof)

    const playbookRun = await runner.startUserStory(userStory.id)
    await drive(playbookRun.processRunId!)

    const workers = loopCalls.filter(
      (c) => !c.userMessage?.startsWith("# Review the")
    )
    const checks = "e2e"
    const scratch = `.mission-control/scratch/${playbookRun.processRunId}`
    // Builders write anywhere, as before.
    expect(workers[0].writeScope).toBeUndefined()
    expect(workers[1].writeScope).toBeUndefined()
    expect(workers[2].writeScope).toEqual({ allow: [checks, scratch] })
    expect(workers[2].sectionContent).toContain(`\`${checks}/\``)
    expect(workers[2].sectionContent).toContain(
      "`@billing.milestone-1.invoice-model`"
    )
    expect(existsSync(join(workspaceDir, checks))).toBe(true)
    expect(existsSync(join(workspaceDir, scratch, ".gitignore"))).toBe(true)
  })

  it("refuses a second start while the first is still preparing, so a story never runs twice", async () => {
    const rig = orchestratedRig()
    const { userStory } = billingFeature(rig.id)
    // The Navigator and the lead seat start the same story at once.
    const [first, second] = await Promise.allSettled([
      runner.startUserStory(userStory.id),
      runner.startUserStory(userStory.id),
    ])
    expect(first.status).toBe("fulfilled")
    expect(second).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringMatching(/already starting/),
      }),
    })
    expect(
      playbooks.listPlaybookRuns({
        userStoryId: userStory.id,
        status: "running",
      })
    ).toHaveLength(1)
    expect(features.getUserStory(userStory.id)?.attempts).toBe(1)
  })

  it("fails before any worker starts when a playbook role is missing from the rig", async () => {
    const rig = orchestratedRig()
    const { userStory } = billingFeature(rig.id)
    const playbook = createDefaultPlaybook("user_story")
    const graph = processes.getProcessGraph(
      playbook.hooks.find((h) => h.hook === "run")!.processId
    )!
    processes.createPhaseAgent({
      phaseId: graph.phases[0].id,
      seatRole: "designer",
      position: 1,
    })

    await expect(runner.startUserStory(userStory.id)).rejects.toThrow(
      /No seat has role "designer"/
    )
    expect(enqueued).toHaveLength(0)
    expect(loopCalls).toHaveLength(0)
    expect(
      playbooks.listPlaybookRuns({ userStoryId: userStory.id })
    ).toHaveLength(0)
    expect(features.getUserStory(userStory.id)).toMatchObject({
      status: "draft",
      attempts: 0,
    })
  })

  it("names a vacant seat instead of falling back to a default agent", async () => {
    const rig = orchestratedRig({ qaAgent: null })
    const { userStory } = billingFeature(rig.id)
    await expect(runner.startUserStory(userStory.id)).rejects.toThrow(
      /qa@implementation is vacant/
    )
    expect(enqueued).toHaveLength(0)
  })

  it("rejects a builder verifying its own user story and fails the user story without a proof", async () => {
    const rig = orchestratedRig()
    const { userStory } = billingFeature(rig.id)
    const playbook = createDefaultPlaybook("user_story")
    const graph = processes.getProcessGraph(
      playbook.hooks.find((h) => h.hook === "run")!.processId
    )!
    const test = graph.phases.find((p) => p.key === "test")!
    for (const agent of processes.listPhaseAgents(test.id))
      processes.deletePhaseAgent(agent.id)
    processes.createPhaseAgent({
      phaseId: test.id,
      seatRole: "builder",
      position: 0,
    })
    proofSubmissions.push(acceptedProof)

    const playbookRun = await runner.startUserStory(userStory.id)
    await drive(playbookRun.processRunId!)

    const proofCall = loopCalls.find((c) => c.proofStep)!
    expect(proofCall.proofResult).toMatchObject({
      ok: false,
      code: "proof_rejected_by_rules",
    })
    expect((proofCall.proofResult as { message: string }).message).toMatch(
      /builder@implementation built this user story/
    )
    expect(features.getUserStory(userStory.id)!.status).toBe("failed")
    expect(playbooks.getPlaybookRun(playbookRun.id)).toMatchObject({
      status: "failed",
      outcomeReason: "The playbook finished without recording a proof.",
    })
  })

  // A runner whose service never notifies it: the playbook run stays open
  // after its Process run finishes, so a test can call record_proof directly.
  function unsettledRunner() {
    const detached = new ProcessService(fakeRunner)
    const detachedRunner = new UserStoryRunner({
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
    const { userStory } = billingFeature(rig.id)
    proofSubmissions.push(acceptedProof)
    const { detachedRunner, driveDetached } = unsettledRunner()
    const playbookRun = await detachedRunner.startUserStory(userStory.id)
    await driveDetached(playbookRun.processRunId!)

    const again = recordUserStoryProof({
      processRunId: playbookRun.processRunId!,
      processPhaseRunId: qaPhaseRun(playbookRun.processRunId!).id,
      args: { ...acceptedProof, verdict: "rejected" },
    })
    expect(again).toMatchObject({ ok: false, code: "already_accepted" })
    expect(playbooks.getPlaybookRun(playbookRun.id)!.proof).toMatchObject({
      verdict: "accepted",
    })
  })

  it("fails the user story with the last proof once rejected revisions are exhausted", async () => {
    const rig = orchestratedRig()
    const { userStory } = billingFeature(rig.id)
    const rejected = {
      verdict: "rejected",
      criteria: [
        { id: "AC-1", status: "met", evidence: "Line items persist." },
        { id: "AC-2", status: "not_met", evidence: "Totals ignore tax." },
      ],
    }
    proofSubmissions.push(rejected)
    const { detachedRunner, driveDetached } = unsettledRunner()
    const playbookRun = await detachedRunner.startUserStory(userStory.id)
    await driveDetached(playbookRun.processRunId!)
    const record = () =>
      recordUserStoryProof({
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
    expect(features.getUserStory(userStory.id)).toMatchObject({
      status: "failed",
      proof: { verdict: "rejected" },
    })
  })

  it("rejects an accepted verdict while a criterion is not met", async () => {
    const rig = orchestratedRig()
    const { userStory } = billingFeature(rig.id)
    proofSubmissions.push({
      verdict: "accepted",
      criteria: [
        { id: "AC-1", status: "met", evidence: "ok" },
        { id: "AC-2", status: "not_met", evidence: "Totals ignore tax." },
      ],
    })
    const playbookRun = await runner.startUserStory(userStory.id)
    await drive(playbookRun.processRunId!)
    expect(loopCalls.find((c) => c.proofStep)!.proofResult).toMatchObject({
      ok: false,
      code: "proof_rejected_by_rules",
    })
  })

  it("applies the user story outcome exactly once across listener replays and boot reconcile", async () => {
    const rig = orchestratedRig()
    const { userStory } = billingFeature(rig.id)
    proofSubmissions.push(acceptedProof)
    const playbookRun = await runner.startUserStory(userStory.id)
    await drive(playbookRun.processRunId!)
    const revisionsBefore = features.listRevisions(
      features.getMilestone(userStory.milestoneId)!.featureId
    ).length

    runner.settle(playbookRun.processRunId!)
    runner.reconcile()

    expect(
      features.listRevisions(
        features.getMilestone(userStory.milestoneId)!.featureId
      )
    ).toHaveLength(revisionsBefore)
    expect(features.getUserStory(userStory.id)).toMatchObject({
      status: "done",
      attempts: 1,
    })
  })

  it("recovers an outcome at boot when the app stopped before settling", async () => {
    const rig = orchestratedRig()
    const { userStory } = billingFeature(rig.id)
    proofSubmissions.push(acceptedProof)
    // A runner the service never notifies models a crash between the run
    // finishing and its outcome being applied.
    const { detachedRunner, driveDetached } = unsettledRunner()
    const playbookRun = await detachedRunner.startUserStory(userStory.id)
    await driveDetached(playbookRun.processRunId!)
    expect(features.getUserStory(userStory.id)!.status).toBe("proving")

    runner.reconcile()
    expect(features.getUserStory(userStory.id)!.status).toBe("done")
  })

  it("allows one playbook run per workspace at a time", async () => {
    const rig = orchestratedRig()
    const { userStory, milestone } = billingFeature(rig.id)
    features.createUserStory({
      milestoneId: milestone.id,
      key: "invoice-api",
      title: "Invoice API",
      spec: { goal: "Expose invoices.", acceptance: ["GET /invoices works"] },
    })
    const second = features
      .listUserStories(milestone.id)
      .find((s) => s.key === "invoice-api")!
    await runner.startUserStory(userStory.id)
    await expect(runner.startUserStory(second.id)).rejects.toThrow(
      /user story invoice-model is still running/
    )
  })

  it("cancels a parked run, keeps the user story retryable, and caps attempts", async () => {
    const rig = orchestratedRig()
    const { userStory, feature } = billingFeature(rig.id)
    db.prepare("UPDATE features SET budgets = ? WHERE id = ?").run(
      JSON.stringify({ maxUserStoryAttempts: 2 }),
      feature.id
    )
    const first = await runner.startUserStory(userStory.id)
    runner.cancelUserStory(userStory.id)
    expect(cancelledTasks).toHaveLength(1)
    expect(playbooks.getPlaybookRun(first.id)!.status).toBe("cancelled")
    expect(processes.getProcessRun(first.processRunId!)!.status).toBe(
      "cancelled"
    )
    expect(features.getUserStory(userStory.id)!.status).toBe("failed")

    await runner.startUserStory(userStory.id)
    runner.cancelUserStory(userStory.id)
    expect(features.getUserStory(userStory.id)!.attempts).toBe(2)
    await expect(runner.startUserStory(userStory.id)).rejects.toThrow(
      /all 2 attempts/
    )
  })

  it("refuses a proof step whose seat runs on a CLI provider before spending an attempt", async () => {
    const rig = orchestratedRig()
    const { userStory } = billingFeature(rig.id)
    const cliRunner = new UserStoryRunner({
      startProcessRun: (input) => service.startRun(input),
      cancelTask: () => {},
      loadAgents: async () => AGENTS as unknown as AgentDefinition[],
      workerProvider: () => "claude_code",
    })
    await expect(cliRunner.startUserStory(userStory.id)).rejects.toThrow(
      /qa@implementation on Claude Code, which cannot record a proof/
    )
    expect(features.getUserStory(userStory.id)!.attempts).toBe(0)
    expect(enqueued).toHaveLength(0)
  })

  it("tells a phase past its time limit to wrap up, and stops it at twice the limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const rig = orchestratedRig()
      const { userStory } = billingFeature(rig.id)
      const featureId = features.getMilestone(userStory.milestoneId)!.featureId
      features.setFeatureBudgets(featureId, { maxPhaseMinutes: 1 })
      hangLoops = true
      const playbookRun = await runner.startUserStory(userStory.id)
      const driving = drive(playbookRun.processRunId!)

      await vi.advanceTimersByTimeAsync(61_000)
      const notes = db
        .prepare("SELECT body, source FROM conversation_notes")
        .all() as Array<{ body: string; source: string }>
      expect(notes).toEqual([
        expect.objectContaining({
          source: "mission-control",
          body: expect.stringContaining("finish the phase now"),
        }),
      ])

      await vi.advanceTimersByTimeAsync(60_000)
      await driving
      const [phaseRun] = processes.listPhaseRuns({
        runId: playbookRun.processRunId!,
      })
      expect(phaseRun).toMatchObject({
        status: "failed",
        failure: expect.objectContaining({ code: "phase_time_limit" }),
      })
      expect(playbooks.getPlaybookRun(playbookRun.id)!.outcomeReason).toContain(
        "ran past its 1-minute limit and was stopped at 2 minutes"
      )
    } finally {
      hangLoops = false
      vi.useRealTimers()
    }
  })

  it("applies a QA send-back on Autopilot, and asks the user otherwise", async () => {
    for (const mode of ["autopilot", "manual"] as const) {
      const rig = orchestratedRig()
      const { userStory } = billingFeature(rig.id)
      const featureId = features.getMilestone(userStory.milestoneId)!.featureId
      db.prepare("UPDATE features SET drive_mode = ? WHERE id = ?").run(
        mode,
        featureId
      )
      proofSubmissions.push(acceptedProof)
      flagBackOnce = true
      const playbookRun = await runner.startUserStory(userStory.id)
      await drive(playbookRun.processRunId!)
      const taskId = processes.getProcessRun(playbookRun.processRunId!)!.taskId!
      const pending = listApprovals({ taskId, status: "pending" })
      if (mode === "autopilot") {
        expect(pending).toEqual([])
        expect(features.getUserStory(userStory.id)!.status).toBe("done")
      } else {
        expect(pending).toEqual([
          expect.objectContaining({
            request: expect.objectContaining({ kind: "process_flag_gate" }),
          }),
        ])
      }
      proofSubmissions.length = 0
      db.prepare("DELETE FROM features").run()
      db.prepare("DELETE FROM rigs").run()
    }
  })

  it("marks a user story's run quiet, so it doesn't raise task notifications", async () => {
    const rig = orchestratedRig()
    const { userStory } = billingFeature(rig.id)
    await runner.startUserStory(userStory.id)
    expect(enqueuedInputs.at(-1)).toMatchObject({ quiet: true })
  })

  it("records the failed phase and its error as the user story's failure cause", async () => {
    const rig = orchestratedRig()
    const { userStory } = billingFeature(rig.id)
    const playbookRun = await runner.startUserStory(userStory.id)
    const runId = playbookRun.processRunId!
    const [spec] = processes.listPhases(
      processes.getProcessRun(runId)!.processId!
    )
    const phaseRun = processes.createPhaseRun({
      runId,
      phaseId: spec.id,
      status: "running",
    })
    processes.updatePhaseRun(phaseRun.id, {
      status: "failed",
      finishedAt: Date.now(),
      error: "The model hit the output limit before returning a usable answer.",
      failure: {
        code: "model_request_failed",
        stage: "model_request",
        message:
          "The model hit the output limit before returning a usable answer.",
        retryable: false,
        attempt: 1,
        maxAttempts: 3,
        runId,
        phaseRunId: phaseRun.id,
        phaseId: phaseRun.phaseId,
        taskId: null,
        workerTaskId: null,
        agentName: null,
        occurredAt: Date.now(),
      },
    })
    processes.updateProcessRun(runId, {
      status: "failed",
      finishedAt: Date.now(),
    })

    expect(processRunFailure(runId)).toEqual({
      reason: expect.stringMatching(
        /^Phase ".+" failed \(model request\): The model hit the output limit/
      ),
      infrastructure: true,
    })
    runner.settle(runId)
    expect(playbooks.getPlaybookRun(playbookRun.id)!.outcomeReason).toMatch(
      /^The user story's Process run failed\. Phase ".+" failed \(model request\)/
    )
    expect(features.getUserStory(userStory.id)!.status).toBe("failed")
  })

  it("refuses to retry a Mission Control run from the Processes screen", async () => {
    const rig = orchestratedRig()
    const { userStory } = billingFeature(rig.id)
    const playbookRun = await runner.startUserStory(userStory.id)
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
    const { userStory } = billingFeature(rig.id)
    const playbook = createDefaultPlaybook("user_story")
    const graph = processes.getProcessGraph(
      playbook.hooks.find((h) => h.hook === "run")!.processId
    )!
    const spec = graph.phases.find((p) => p.key === "spec")!
    processes.updatePhase(spec.id, { routing: "dispatch" })
    routerReply = "builder-2@implementation"
    proofSubmissions.push(acceptedProof)

    const playbookRun = await runner.startUserStory(userStory.id)
    await drive(playbookRun.processRunId!)

    const specRun = processes
      .listPhaseRuns({ runId: playbookRun.processRunId! })
      .find((pr) => pr.phaseId === spec.id)!
    expect(specRun.seatAddress).toBe("builder-2@implementation")
    expect(loopCalls[0].sectionContent).toContain("Second builder")
    // Both builders did build-type work only where they ran; the proof lists
    // exactly the seats that did.
    expect(features.getUserStory(userStory.id)!.proof).toMatchObject({
      builderAddresses: ["builder-2@implementation", "builder@implementation"],
    })
  })

  it("runs a milestone hook with the lead found through oversight", async () => {
    const rig = orchestratedRig()
    const { feature, milestone } = billingFeature(rig.id)
    const playbookRun = await startHookRun(runner, {
      featureId: feature.id,
      milestoneId: milestone.id,
      hook: "before_user_stories",
    })
    await drive(playbookRun.processRunId!)
    expect(loopCalls.map((c) => c.agentName)).toEqual(["agentref:v1:lead"])
    expect(loopCalls[0].userMessage).toContain("invoice-model")
    expect(loopCalls[0].sectionContent).toContain("lead@orchestration")
    expect(playbooks.getPlaybookRun(playbookRun.id)!.status).toBe("completed")

    await expect(
      startHookRun(runner, {
        featureId: feature.id,
        milestoneId: milestone.id,
        hook: "after_each_user_story",
      })
    ).rejects.toThrow(/runs by itself when a user story's merge conflicts/)
  })

  describe("context scopes", () => {
    async function runTwoUserStories(qaScope?: "feature") {
      const rig = orchestratedRig()
      const { feature, milestone, userStory } = billingFeature(rig.id)
      const second = features
        .createUserStory({
          milestoneId: milestone.id,
          key: "invoice-api",
          title: "Invoice API",
          spec: {
            goal: "Expose invoices.",
            acceptance: ["GET works", "POST works"],
          },
        })
        .userStories.find((s) => s.key === "invoice-api")!
      const playbook = createDefaultPlaybook("user_story")
      features.updateUserStory(userStory.id, { playbookId: playbook.id })
      features.updateUserStory(second.id, { playbookId: playbook.id })
      if (qaScope) {
        const graph = processes.getProcessGraph(
          playbook.hooks.find((h) => h.hook === "run")!.processId
        )!
        const test = graph.phases.find((p) => p.key === "test")!
        processes.updatePhase(test.id, { contextScope: qaScope })
      }
      const runIds: string[] = []
      for (const id of [userStory.id, second.id]) {
        proofSubmissions.push(acceptedProof)
        const playbookRun = await runner.startUserStory(id)
        runIds.push(playbookRun.id)
        await drive(playbookRun.processRunId!)
        expect(features.getUserStory(id)!.status).toBe("done")
      }
      const workers = loopCalls.filter(
        (c) => !c.userMessage?.startsWith("# Review the")
      )
      return {
        feature,
        second,
        runIds,
        workers,
        builder: workers.filter(
          (c) => c.seat?.address === "builder@implementation"
        ),
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

    it("gives builder and QA one session per user story by default", async () => {
      const { feature, second, runIds, workers, builder, qa } =
        await runTwoUserStories()
      const sessionFor = (address: string, runId: string) =>
        seatSessionsRepo.listSeatSessions({
          featureId: feature.id,
          seatAddress: address,
          playbookRunId: runId,
        })[0]
      // Spec and build share the builder's user story session; each user story gets its own.
      for (const [index, runId] of runIds.entries()) {
        const builderSession = sessionFor("builder@implementation", runId)
        expect(
          builder.slice(index * 2, index * 2 + 2).map((c) => c.conversationId)
        ).toEqual([
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
        seatSessionsRepo.listSeatSessions({
          featureId: feature.id,
          playbookRunId: null,
        })
      ).toHaveLength(0)
      // Every role-bound worker is a seat turn, anchored to its user story.
      expect(workers.every((c) => c.seat?.profile === "work")).toBe(true)
      expect(qa[1].seat?.anchor).toEqual({ kind: "user_story", id: second.id })
      expect(qa[1].sectionContent).toContain("## Mission Control Comms")
      // Each step's frozen result is its own turn's output.
      const secondRun = playbooks.listPlaybookRuns({
        userStoryId: second.id,
      })[0]
      const testRun = processes
        .listPhaseRuns({ runId: secondRun.processRunId! })
        .find((pr) => pr.seatAddress === "qa@implementation")!
      expect(testRun.resultContent).toBe("verified")
    })

    it("keeps a long-lived QA session across user stories when the step asks for it", async () => {
      const { feature, qa } = await runTwoUserStories("feature")
      const session = seatSessionsRepo.getLiveSeatSession(
        feature.id,
        "qa@implementation"
      )!
      expect(session.scope).toBe("feature")
      expect(qa.map((c) => c.conversationId)).toEqual([
        session.conversationId,
        session.conversationId,
      ])
    })
  })
})

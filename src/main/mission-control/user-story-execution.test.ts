import { describe, it, expect, beforeEach, afterAll, vi } from "vitest"
import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { existsSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"
import type { SeatHandleInput } from "../browser/seat"
import { installSeatBrowser } from "./seat-browser"

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
  qaChecks?: "author" | "explore" | "smoke"
  // The seat browser handle input this worker would get (plan 109.04).
  seatBrowser?: { phaseRunId: string; label: string; origins: string[] }
  // What run_checks returned in the test step (plan 109.05).
  checksRun?: string
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
    processQaChecks?: "author" | "explore" | "smoke"
    processAppLaunch?: boolean
    seatBrowser?: (signal: AbortSignal) => unknown
    workspace?: string
    abort?: AbortController
  }) => {
    // A builder that makes the app startable saves its recipe, once.
    if (saveRecipe && input.processAppLaunch) {
      const services = saveRecipe
      saveRecipe = null
      recipeSaves.push(
        await appLaunchSaveTool.execute({ services }, {
          workspace: input.workspace,
          processRunId: input.processRunId,
          processPhaseRunId: input.processPhaseRunId,
          signal: input.abort?.signal,
        } as never)
      )
    }
    // A builder or QA step that starts the app (plan 109.03).
    if (startApp && input.processAppLaunch) {
      const out = await appStartTool.execute({}, {
        workspace: input.workspace,
        processRunId: input.processRunId,
        processPhaseRunId: input.processPhaseRunId,
        signal: input.abort?.signal,
      } as never)
      appStarts.push({
        phaseRunId: input.processPhaseRunId!,
        ready: /"status": "ready"/.test(out),
        pids: testAppServices.pids(),
        briefed: (input.extraContextSections ?? []).some((section) =>
          section.content.includes("## Running the app")
        ),
      })
    }
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
      qaChecks: input.processQaChecks,
    }
    if (input.seatBrowser) {
      const before = seatBrowserInputs.length
      input.seatBrowser(new AbortController().signal)
      const seen = seatBrowserInputs[before]
      call.seatBrowser = seen && {
        phaseRunId: seen.phaseRunId,
        label: seen.label,
        origins: seen.allowedOrigins(),
      }
    }
    loopCalls.push(call)
    // QA's checks step (plan 109.02, playbooks from before 110.04) completes
    // only with a valid manifest.
    if (input.processQaChecks !== "author" || manifestSkips-- <= 0)
      writeFakeManifest(input, checkCommand ?? undefined)
    // A test step that tries run_checks anyway (plan 110.04 refuses it).
    if (runChecksInVerify && input.processQaChecks)
      call.checksRun = await runChecksTool.execute({}, {
        workspace: input.workspace,
        processRunId: input.processRunId,
        processPhaseRunId: input.processPhaseRunId,
        signal: input.abort?.signal,
      } as never)
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
      call.proofResult = await recordUserStoryProof({
        processRunId: input.processRunId!,
        processPhaseRunId: input.processPhaseRunId!,
        args: proveInApp(input.processPhaseRunId!, proofSubmissions.shift()!),
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
// The installed seat browser (plan 109.04): the handles workers asked for and
// the phase runs whose tabs were released.
const seatBrowserInputs: SeatHandleInput[] = []
const seatBrowserReleases: string[] = []
// Workers start the app when it's offered, and what they started.
let startApp = false
const appStarts: Array<{
  phaseRunId: string
  ready: boolean
  pids: number[]
  briefed: boolean
}> = []
// What a builder passes to app_launch_save, and what the tool answered.
let saveRecipe: Array<Record<string, unknown>> | null = null
const recipeSaves: string[] = []
// The dispatch router's classifier reply.
let routerReply = ""
let hangLoops = false
// How many checks-step turns finish without writing the manifest.
let manifestSkips = 0
// QA's checks step (a legacy playbook) writes automated checks running this
// command instead of exploratory ones, and whether a QA proof step calls
// run_checks before its proof.
let checkCommand: string | null = null
let runChecksInVerify = false
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
  proofReworkRefusal,
  recordUserStoryProof,
  type RecordProofResult,
} from "./user-story-runner"
import { startHookRun } from "./hook-runner"
import { proveInApp, writeFakeManifest } from "../test/qa-manifest"
import { createLegacyChecksPlaybook } from "../test/legacy-playbook"
import { appLaunchSaveTool, appStartTool } from "../agent/tools/app_launch_tools"
import { runChecksTool } from "../agent/tools/qa_checks_tools"
import { testAppServices } from "./app-launch"
import { getWorkspace, updateWorkspace } from "../db/repositories/workspaces"
import { installSeatSessions, SeatSessionService } from "./sessions"
import * as seatSessionsRepo from "../db/repositories/seat-sessions"
import type { AgentDefinition } from "../agent/agents/types"
import type { Finding } from "../../shared/mission-control/workspace-analysis"
import type { Feature } from "../db/types"

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
  manifestSkips = 0
  checkCommand = null
  runChecksInVerify = false
  startApp = false
  appStarts.length = 0
  saveRecipe = null
  recipeSaves.length = 0
  seatBrowserInputs.length = 0
  seatBrowserReleases.length = 0
  installSeatBrowser(null)
  rmSync(join(workspaceDir, "e2e"), { recursive: true, force: true })
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
    // QA verifies by exploring the running app (plan 110.04): no checks.
    expect(workers.map((c) => c.qaChecks)).toEqual([
      undefined,
      undefined,
      "explore",
    ])
    expect(workers[1].userMessage).not.toContain("QA's acceptance checks")
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
    expect(workers[2].userMessage).toContain("## Verifying by exploration")
    expect(workers[2].userMessage).not.toContain("run_checks")
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

  describe("the proof gate reads what the harness recorded (plans 109.05, 110.04)", () => {
    const NODE = JSON.stringify(process.execPath)
    const ids = ["AC-1", "AC-2"].map(
      (id) => `billing.milestone-1.invoice-model-${id}`
    )
    const byChecks = {
      verdict: "accepted",
      criteria: ["AC-1", "AC-2"].map((id, i) => ({
        id,
        status: "met",
        method: "qa_check",
        checkIds: [ids[i]],
        evidence: "QA's check passed.",
      })),
    }
    async function run(submission: Record<string, unknown>) {
      const rig = orchestratedRig()
      const { userStory } = billingFeature(rig.id)
      proofSubmissions.push(submission)
      const playbookRun = await runner.startUserStory(userStory.id)
      await drive(playbookRun.processRunId!)
      return {
        verify: loopCalls.find((c) => c.proofStep)!,
        story: features.getUserStory(userStory.id)!,
      }
    }

    it("accepts criteria exercised in the app with saved evidence", async () => {
      const { verify, story } = await run(acceptedProof)
      expect(verify.proofResult).toMatchObject({ ok: true, status: "accepted" })
      expect(story.proof).toMatchObject({
        criteria: [
          { id: "AC-1", method: "app_exercised" },
          { id: "AC-2", method: "app_exercised" },
        ],
      })
    })

    it("refuses qa_check: the test step runs no checks", async () => {
      runChecksInVerify = true
      const { verify } = await run(byChecks)
      expect(verify.checksRun).toMatch(/runs no checks/)
      expect(verify.proofResult).toMatchObject({
        ok: false,
        code: "proof_rejected_by_rules",
        message: expect.stringMatching(/AC-1: this step runs no QA checks/),
      })
    })

    it("refuses a criterion exercised without saved evidence", async () => {
      const { verify } = await run({
        verdict: "accepted",
        criteria: ["AC-1", "AC-2"].map((id) => ({
          id,
          status: "met",
          method: "app_exercised",
          evidence: "Clicked through it.",
        })),
      })
      expect(verify.proofResult).toMatchObject({
        ok: false,
        code: "proof_rejected_by_rules",
        message: expect.stringMatching(
          /AC-1: verifying in the app needs evidence/
        ),
      })
    })

    it("accepts a criterion deferred to the wave gate, with its reason (plan 110)", async () => {
      const { verify, story } = await run({
        verdict: "accepted",
        criteria: [
          acceptedProof.criteria[0],
          {
            id: "AC-2",
            status: "deferred",
            method: "app_exercised",
            evidence: "Checked the totals at the default size only.",
            reason:
              "Needs a narrow viewport, which only the gate's checks can set.",
          },
        ],
      })
      expect(verify.proofResult).toMatchObject({ ok: true, status: "accepted" })
      expect(story.proof).toMatchObject({
        criteria: [
          { id: "AC-1", status: "met" },
          { id: "AC-2", status: "deferred" },
        ],
        warnings: [expect.stringMatching(/^AC-2 deferred to the wave gate/)],
      })
    })

    it("doesn't send the build back for criteria QA couldn't exercise (plan 110)", async () => {
      const unverified = {
        verdict: "rejected",
        criteria: [
          acceptedProof.criteria[0],
          {
            id: "AC-2",
            status: "not_verifiable",
            method: "app_exercised",
            evidence: "No keyboard tool.",
            reason: "Can't press keys.",
          },
        ],
      }
      const rig = orchestratedRig()
      const { userStory } = billingFeature(rig.id)
      proofSubmissions.push(unverified)
      const playbookRun = await runner.startUserStory(userStory.id)
      await drive(playbookRun.processRunId!)
      // The milestone has a wave gate: what QA couldn't exercise is deferred
      // to it, and the story goes on instead of being rebuilt.
      expect(playbooks.getPlaybookRun(playbookRun.id)!.proof).toMatchObject({
        verdict: "accepted",
        criteria: [
          expect.objectContaining({ id: "AC-1", status: "met" }),
          expect.objectContaining({ id: "AC-2", status: "deferred", reason: "Can't press keys." }),
        ],
      })
      const proofRun = processes
        .listPhaseRuns({ runId: playbookRun.processRunId! })
        .find((pr) => processes.getPhase(pr.phaseId)?.proofStep)!
      // Without a gate to defer to, such a proof stays rejected, and its
      // rework flag still can't send the build back.
      playbooks.updatePlaybookRun(playbookRun.id, {
        proof: {
          ...playbooks.getPlaybookRun(playbookRun.id)!.proof!,
          verdict: "rejected",
          criteria: [
            { id: "AC-1", status: "met", method: "app_exercised", evidence: "Works." },
            { id: "AC-2", status: "not_verifiable", method: "app_exercised", evidence: "No keyboard tool." },
          ],
        },
      })
      expect(
        proofReworkRefusal(playbookRun.processRunId!, proofRun.id)
      ).toMatch(/rejected only because AC-2 couldn't be exercised/)
      // A real failure still goes back to the build.
      playbooks.updatePlaybookRun(playbookRun.id, {
        proof: {
          ...playbooks.getPlaybookRun(playbookRun.id)!.proof!,
          criteria: [
            {
              id: "AC-1",
              status: "not_met",
              method: "app_exercised",
              evidence: "Broken.",
            },
          ],
        },
      })
      expect(
        proofReworkRefusal(playbookRun.processRunId!, proofRun.id)
      ).toBeNull()
    })

    it("doesn't bind the proof to a legacy checks step's manifest", async () => {
      createLegacyChecksPlaybook()
      checkCommand = `${NODE} -e "process.exit(1)"`
      const { verify, story } = await run(acceptedProof)
      expect(verify.qaChecks).toBe("explore")
      expect(verify.proofResult).toMatchObject({ ok: true, status: "accepted" })
      expect(story.status).toBe("done")
    })
  })

  it("confines the QA seat's test step to its scratch directory (plans 109.01, 110.04)", async () => {
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
    // QA explores and writes nothing in the repository.
    expect(workers[2].writeScope).toEqual({ allow: [scratch] })
    expect(workers[2].sectionContent).toContain(
      "you write nothing in the repository"
    )
    expect(workers[2].sectionContent).not.toContain(
      "## How checks are organized"
    )
    expect(existsSync(join(workspaceDir, checks))).toBe(false)
    expect(existsSync(join(workspaceDir, scratch, ".gitignore"))).toBe(true)
  })

  it("keeps a legacy checks step confined to its checks and scratch directories", async () => {
    createLegacyChecksPlaybook()
    const rig = orchestratedRig()
    const { userStory } = billingFeature(rig.id)
    proofSubmissions.push(acceptedProof)
    const playbookRun = await runner.startUserStory(userStory.id)
    await drive(playbookRun.processRunId!)

    const scratch = `.mission-control/scratch/${playbookRun.processRunId}`
    const qa = loopCalls.filter((c) => c.seat?.address === "qa@implementation")
    expect(qa.map((c) => [c.qaChecks, c.writeScope])).toEqual([
      ["author", { allow: ["e2e", scratch] }],
      ["explore", { allow: [scratch] }],
    ])
    expect(qa[0].userMessage).toContain(
      "e2e/stories/billing.milestone-1.invoice-model.json"
    )
    expect(qa[0].sectionContent).toContain(
      "`@billing.milestone-1.invoice-model`"
    )
    // Nothing is frozen, and the builder isn't told the checks are QA's.
    const builder = loopCalls.filter(
      (c) => c.seat?.address === "builder@implementation"
    )
    expect(builder[1].userMessage).not.toContain("QA's acceptance checks")
    expect(features.getUserStory(userStory.id)!.status).toBe("done")
  })

  it("sends the manifest validator's message back to the checks step (plan 109.02)", async () => {
    createLegacyChecksPlaybook()
    const rig = orchestratedRig()
    const { userStory } = billingFeature(rig.id)
    proofSubmissions.push(acceptedProof)
    manifestSkips = 1
    const playbookRun = await runner.startUserStory(userStory.id)
    await drive(playbookRun.processRunId!)

    const authoring = loopCalls.filter((c) => c.qaChecks === "author")
    expect(authoring).toHaveLength(2)
    expect(authoring[1].userMessage).toMatch(/There is no check manifest/)
    expect(features.getUserStory(userStory.id)!.status).toBe("done")
  })

  it("fails the checks step when the manifest never validates", async () => {
    createLegacyChecksPlaybook()
    const rig = orchestratedRig()
    const { userStory } = billingFeature(rig.id)
    manifestSkips = 99
    const playbookRun = await runner.startUserStory(userStory.id)
    await drive(playbookRun.processRunId!)

    // The first turn plus two repairs, then no build or test step.
    expect(loopCalls.filter((c) => c.qaChecks === "author")).toHaveLength(3)
    expect(loopCalls.some((c) => c.qaChecks === "explore")).toBe(false)
    expect(features.getUserStory(userStory.id)!.status).toBe("failed")
    expect(processRunFailure(playbookRun.processRunId!)?.reason).toMatch(
      /without a valid check manifest/
    )
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

  // QA's proof step, not its checks step (plan 109.02).
  function qaPhaseRun(processRunId: string) {
    return processes
      .listPhaseRuns({ runId: processRunId })
      .find(
        (pr) =>
          pr.seatAddress === "qa@implementation" &&
          processes.getPhase(pr.phaseId)?.proofStep
      )!
  }

  it("freezes an accepted proof", async () => {
    const rig = orchestratedRig()
    const { userStory } = billingFeature(rig.id)
    proofSubmissions.push(acceptedProof)
    const { detachedRunner, driveDetached } = unsettledRunner()
    const playbookRun = await detachedRunner.startUserStory(userStory.id)
    await driveDetached(playbookRun.processRunId!)

    const qaRun = qaPhaseRun(playbookRun.processRunId!)
    const again = await recordUserStoryProof({
      processRunId: playbookRun.processRunId!,
      processPhaseRunId: qaRun.id,
      args: proveInApp(qaRun.id, { ...acceptedProof, verdict: "rejected" }),
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
    const qaRun = qaPhaseRun(playbookRun.processRunId!)
    const record = () =>
      recordUserStoryProof({
        processRunId: playbookRun.processRunId!,
        processPhaseRunId: qaRun.id,
        args: proveInApp(qaRun.id, rejected),
      })

    expect(await record()).toMatchObject({ ok: true, status: "rejected" })
    const last = await record()
    expect(last).toMatchObject({ ok: true, status: "rejected" })
    expect((last as { message: string }).message).toMatch(/No revisions remain/)
    expect(await record()).toMatchObject({
      ok: false,
      code: "revisions_exhausted",
    })
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

  describe("app launch preflight", () => {
    const detected = (status: Finding["status"]) =>
      ({
        key: "app-launch:recipe",
        title: "Seats can't start the app yet",
        status,
        fix: {
          kind: "apply-settings",
          summary: "Start `node server.js` on a free port",
          patch: {
            appLaunch: {
              add: [
                {
                  key: "web",
                  label: "Node server (server.js)",
                  command: "node server.js",
                  cwd: "",
                  port: "auto",
                  ready: { http: "/" },
                },
              ],
            },
          },
        },
      }) as unknown as Finding

    function gatedRunner(
      finding: () => Finding | null,
      applyAppLaunch?: (feature: Feature) => Promise<void>
    ) {
      const lookups: Array<{ featureId: string; ref: string }> = []
      const gated = new UserStoryRunner({
        startProcessRun: (input) => service.startRun(input),
        cancelTask: () => {},
        loadAgents: async () => AGENTS as unknown as AgentDefinition[],
        appLaunchFinding: async ({ feature, ref }) => {
          lookups.push({ featureId: feature.id, ref })
          return finding()
        },
        ...(applyAppLaunch ? { applyAppLaunch } : {}),
      })
      return { gated, lookups }
    }

    it("saves a detected recipe and starts, instead of pausing for the user", async () => {
      const rig = orchestratedRig()
      const { feature, userStory } = billingFeature(rig.id)
      const applied: string[] = []
      const { gated } = gatedRunner(
        () => detected("open"),
        async (f) => {
          applied.push(f.id)
          updateWorkspace(f.workspaceId!, {
            appLaunch: {
              services: [
                {
                  key: "web",
                  label: "Node server (server.js)",
                  command: "node server.js",
                  cwd: "",
                  port: "auto",
                  ready: { http: "/" },
                  source: "analysis",
                },
              ],
            },
          })
        }
      )
      await gated.startUserStory(userStory.id)
      expect(applied).toEqual([feature.id])
      expect(features.getUserStory(userStory.id)!.status).toBe("running")
    })

    it("still refuses when the detected recipe can't be saved", async () => {
      const rig = orchestratedRig()
      const { userStory } = billingFeature(rig.id)
      const { gated } = gatedRunner(
        () => detected("open"),
        async () => {
          throw new Error("invalid")
        }
      )
      await expect(gated.startUserStory(userStory.id)).rejects.toThrow(
        /^app_launch_required: .*couldn't save that recipe/
      )
      expect(features.getUserStory(userStory.id)!.attempts).toBe(0)
    })

    it("refuses a QA-verified story while a detected recipe isn't saved, and starts once it's dismissed", async () => {
      const rig = orchestratedRig()
      const { feature, userStory } = billingFeature(rig.id)
      let status: Finding["status"] = "open"
      const { gated, lookups } = gatedRunner(() => detected(status))

      await expect(gated.startUserStory(userStory.id)).rejects.toThrow(
        /^app_launch_required: User story invoice-model .*`node server\.js`/
      )
      expect(lookups).toEqual([{ featureId: feature.id, ref: "HEAD" }])
      expect(features.getUserStory(userStory.id)!.attempts).toBe(0)
      expect(enqueued).toHaveLength(0)

      status = "dismissed"
      await gated.startUserStory(userStory.id)
      expect(features.getUserStory(userStory.id)!.status).toBe("running")
    })

    it("starts greenfield stories, where nothing runnable is detected yet", async () => {
      const rig = orchestratedRig()
      const { userStory } = billingFeature(rig.id)
      const { gated, lookups } = gatedRunner(() => null)
      await gated.startUserStory(userStory.id)
      expect(lookups).toHaveLength(1)
      expect(features.getUserStory(userStory.id)!.status).toBe("running")
    })

    it("builds the feature's first story alone until something runs (greenfield)", async () => {
      const rig = orchestratedRig()
      const { feature, userStory } = billingFeature(rig.id)
      let found: Finding | null = null
      const { gated, lookups } = gatedRunner(() => found)
      const current = () => features.getFeature(feature.id)!

      expect(await gated.firstStoryAlone(current())).toBe(true)
      expect(lookups).toEqual([{ featureId: feature.id, ref: "HEAD" }])
      // Something runnable (dismissed or not): the usual dispatch applies.
      found = detected("dismissed")
      expect(await gated.firstStoryAlone(current())).toBe(false)
      // Once a story has landed, never again.
      found = null
      features.setUserStoryExecution(
        userStory.id,
        { status: "done" },
        "done",
        "test"
      )
      expect(await gated.firstStoryAlone(current())).toBe(false)
    })

    it("builds the first story alone while the recipe is only planned (provisional)", async () => {
      const rig = orchestratedRig()
      const { feature, userStory } = billingFeature(rig.id)
      updateWorkspace(feature.workspaceId!, {
        appLaunch: {
          services: [
            {
              key: "web",
              label: "Web",
              command: "mix phx.server",
              cwd: "",
              port: "auto",
              ready: { http: "/" },
              source: "analysis",
              provisional: true,
            },
          ],
        },
      })
      const { gated, lookups } = gatedRunner(() => null)
      const current = () => features.getFeature(feature.id)!
      expect(await gated.firstStoryAlone(current())).toBe(true)
      expect(lookups).toEqual([])
      // It isn't missing a recipe, so the story starts without a preflight stop.
      await gated.startUserStory(userStory.id)
      expect(features.getUserStory(userStory.id)!.status).toBe("running")
      features.setUserStoryExecution(userStory.id, { status: "done" }, "done", "test")
      expect(await gated.firstStoryAlone(current())).toBe(false)
    })

    it("doesn't look when the workspace already has a recipe", async () => {
      const rig = orchestratedRig()
      const { feature, userStory } = billingFeature(rig.id)
      updateWorkspace(feature.workspaceId!, {
        appLaunch: {
          services: [
            {
              key: "web",
              label: "Web",
              command: "node server.js",
              cwd: "",
              port: "auto",
              ready: { http: "/" },
              source: "user",
            },
          ],
        },
      })
      const { gated, lookups } = gatedRunner(() => detected("open"))
      await gated.startUserStory(userStory.id)
      expect(lookups).toHaveLength(0)
      expect(features.getUserStory(userStory.id)!.status).toBe("running")
    })
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

  describe.skipIf(process.platform === "win32")(
    "app launch (plan 109.03)",
    () => {
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      }
      const allDead = async (pids: number[]) => {
        for (let i = 0; i < 60 && pids.some(alive); i++)
          await new Promise((r) => setTimeout(r, 50))
        return !pids.some(alive)
      }
      function withRecipe(workspaceId: string) {
        updateWorkspace(workspaceId, {
          appLaunch: {
            services: [
              {
                key: "web",
                label: "Web",
                command: `${JSON.stringify(process.execPath)} -e "require('http').createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT),'127.0.0.1')"`,
                cwd: "",
                port: "auto",
                ready: { http: "/" },
                readyTimeoutMs: 15_000,
                source: "user",
              },
            ],
          },
        })
      }

      it("offers app tools to builder and QA steps and stops what they started when each step ends", async () => {
        const rig = orchestratedRig()
        const { feature, userStory } = billingFeature(rig.id)
        withRecipe(feature.workspaceId!)
        startApp = true
        proofSubmissions.push(acceptedProof)
        const playbookRun = await runner.startUserStory(userStory.id)
        await drive(playbookRun.processRunId!)
        expect(features.getUserStory(userStory.id)!.status).toBe("done")
        // spec, build (builder) and test (QA): every step started it.
        expect(appStarts).toHaveLength(3)
        expect(appStarts.every((s) => s.ready && s.briefed)).toBe(true)
        expect(new Set(appStarts.map((s) => s.phaseRunId)).size).toBe(3)
        expect(testAppServices.size).toBe(0)
        expect(await allDead(appStarts.flatMap((s) => s.pids))).toBe(true)
      })

      it("stops the app when the run is cancelled mid-step", async () => {
        const rig = orchestratedRig()
        const { feature, userStory } = billingFeature(rig.id)
        withRecipe(feature.workspaceId!)
        startApp = true
        hangLoops = true
        try {
          const playbookRun = await runner.startUserStory(userStory.id)
          const abort = new AbortController()
          const driving = drive(playbookRun.processRunId!, abort.signal)
          for (let i = 0; i < 200 && !appStarts.length; i++)
            await new Promise((r) => setTimeout(r, 25))
          expect(appStarts).toHaveLength(1)
          expect(testAppServices.size).toBe(1)
          abort.abort()
          await driving
          // The scheduler returns on abort; the step's teardown follows as its
          // worker unwinds.
          for (let i = 0; i < 100 && testAppServices.size; i++)
            await new Promise((r) => setTimeout(r, 25))
          expect(testAppServices.size).toBe(0)
          expect(await allDead(appStarts[0].pids)).toBe(true)
        } finally {
          hangLoops = false
        }
      })

      const SERVER = `${JSON.stringify(process.execPath)} -e "require('http').createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT),'127.0.0.1')"`

      it("without a recipe, the builder saves one that starts, and later steps start the app from it", async () => {
        const rig = orchestratedRig()
        const { feature, userStory } = billingFeature(rig.id)
        saveRecipe = [{ key: "web", label: "Web", command: SERVER, ready_http: "/" }]
        startApp = true
        proofSubmissions.push(acceptedProof)
        const playbookRun = await runner.startUserStory(userStory.id)
        await drive(playbookRun.processRunId!)
        expect(recipeSaves).toEqual([expect.stringMatching(/^Saved the app launch recipe/)])
        expect(getWorkspace(feature.workspaceId!)!.appLaunch.services).toEqual([
          expect.objectContaining({ key: "web", command: SERVER, port: "auto", source: "seat" }),
        ])
        // The saving step was told to make the app startable; every step
        // after it got the recipe's briefing and started the app from it.
        const [saving, ...later] = appStarts
        expect(saving).toMatchObject({ ready: true, briefed: false })
        expect(later.length).toBeGreaterThan(0)
        expect(later.every((s) => s.ready && s.briefed)).toBe(true)
        expect(testAppServices.size).toBe(0)
      })

      const recipeOf = (
        command: string,
        source: "user" | "analysis",
        provisional?: boolean
      ) => ({
        services: [
          {
            key: "web",
            label: "Web",
            command,
            cwd: "",
            port: "auto" as const,
            ready: { http: "/" },
            readyTimeoutMs: 15_000,
            source,
            ...(provisional ? { provisional: true } : {}),
          },
        ],
      })
      const BROKEN = `${JSON.stringify(process.execPath)} -e "process.exit(1)"`

      it("confirms a provisional recipe the first time the app starts with it", async () => {
        const rig = orchestratedRig()
        const { feature, userStory } = billingFeature(rig.id)
        updateWorkspace(feature.workspaceId!, { appLaunch: recipeOf(SERVER, "analysis", true) })
        startApp = true
        proofSubmissions.push(acceptedProof)
        const playbookRun = await runner.startUserStory(userStory.id)
        await drive(playbookRun.processRunId!)
        expect(appStarts[0]).toMatchObject({ ready: true })
        expect(getWorkspace(feature.workspaceId!)!.appLaunch.services[0].provisional).toBeUndefined()
      })

      it("replaces an analysis recipe that can't start the app, and keeps one that can", async () => {
        const rig = orchestratedRig()
        const { feature, userStory } = billingFeature(rig.id)
        updateWorkspace(feature.workspaceId!, { appLaunch: recipeOf(BROKEN, "analysis", true) })
        saveRecipe = [{ key: "web", command: SERVER, ready_http: "/" }]
        proofSubmissions.push(acceptedProof)
        const playbookRun = await runner.startUserStory(userStory.id)
        await drive(playbookRun.processRunId!)
        expect(recipeSaves).toEqual([expect.stringMatching(/^Replaced the app launch recipe/)])
        expect(getWorkspace(feature.workspaceId!)!.appLaunch.services).toEqual([
          expect.objectContaining({ command: SERVER, source: "seat" }),
        ])
        expect(testAppServices.size).toBe(0)
      })

      it("keeps an analysis recipe that already starts the app", async () => {
        const rig = orchestratedRig()
        const { feature, userStory } = billingFeature(rig.id)
        updateWorkspace(feature.workspaceId!, { appLaunch: recipeOf(SERVER, "analysis") })
        saveRecipe = [{ key: "web", command: BROKEN, ready_http: "/" }]
        proofSubmissions.push(acceptedProof)
        const playbookRun = await runner.startUserStory(userStory.id)
        await drive(playbookRun.processRunId!)
        expect(recipeSaves).toEqual([expect.stringMatching(/already starts the app, so it was kept/)])
        expect(getWorkspace(feature.workspaceId!)!.appLaunch.services[0].command).toBe(SERVER)
        expect(testAppServices.size).toBe(0)
      })

      it("replaces a working analysis recipe when the builder adds a service it was missing", async () => {
        const rig = orchestratedRig()
        const { feature, userStory } = billingFeature(rig.id)
        updateWorkspace(feature.workspaceId!, { appLaunch: recipeOf(SERVER, "analysis") })
        saveRecipe = [
          { key: "api", label: "API", command: SERVER, ready_http: "/" },
          { key: "web", label: "Web", command: SERVER, ready_http: "/", depends_on: ["api"] },
        ]
        proofSubmissions.push(acceptedProof)
        const playbookRun = await runner.startUserStory(userStory.id)
        await drive(playbookRun.processRunId!)
        expect(recipeSaves).toEqual([expect.stringMatching(/^Replaced the app launch recipe/)])
        expect(getWorkspace(feature.workspaceId!)!.appLaunch.services.map((s) => s.key)).toEqual(["api", "web"])
        expect(testAppServices.size).toBe(0)
      })

      it("refuses a chained command and points to prepare", async () => {
        const rig = orchestratedRig()
        const { feature, userStory } = billingFeature(rig.id)
        saveRecipe = [{ key: "api", command: `${JSON.stringify(process.execPath)} -e "1" && ${SERVER}`, ready_http: "/" }]
        proofSubmissions.push(acceptedProof)
        const playbookRun = await runner.startUserStory(userStory.id)
        await drive(playbookRun.processRunId!)
        expect(recipeSaves).toEqual([expect.stringMatching(/one command per step.*Put a step that must run first in `prepare`/s)])
        expect(getWorkspace(feature.workspaceId!)!.appLaunch.services).toEqual([])
      })

      it("never replaces a recipe the user wrote", async () => {
        const rig = orchestratedRig()
        const { feature, userStory } = billingFeature(rig.id)
        updateWorkspace(feature.workspaceId!, { appLaunch: recipeOf(BROKEN, "user") })
        saveRecipe = [{ key: "web", command: SERVER, ready_http: "/" }]
        proofSubmissions.push(acceptedProof)
        const playbookRun = await runner.startUserStory(userStory.id)
        await drive(playbookRun.processRunId!)
        expect(recipeSaves).toEqual([expect.stringMatching(/written by the user/)])
        expect(getWorkspace(feature.workspaceId!)!.appLaunch.services[0].command).toBe(BROKEN)
      })

      it("saves nothing when the recipe doesn't start the app", async () => {
        const rig = orchestratedRig()
        const { feature, userStory } = billingFeature(rig.id)
        saveRecipe = [
          {
            key: "web",
            command: `${JSON.stringify(process.execPath)} -e "process.exit(1)"`,
            ready_http: "/",
          },
        ]
        proofSubmissions.push(acceptedProof)
        const playbookRun = await runner.startUserStory(userStory.id)
        await drive(playbookRun.processRunId!)
        expect(recipeSaves).toEqual([expect.stringMatching(/Nothing was saved/)])
        expect(getWorkspace(feature.workspaceId!)!.appLaunch.services).toEqual([])
        expect(testAppServices.size).toBe(0)
      })
    }
  )

  it("gives seat work steps an isolated browser and closes it when each step ends (plans 109.04, 109.06)", async () => {
    installSeatBrowser({
      handle: (input) => {
        seatBrowserInputs.push(input)
        return {} as never
      },
      release: async (phaseRunId) => {
        seatBrowserReleases.push(phaseRunId)
      },
    })
    const rig = orchestratedRig()
    const { userStory } = billingFeature(rig.id)
    proofSubmissions.push(acceptedProof)
    const playbookRun = await runner.startUserStory(userStory.id)
    await drive(playbookRun.processRunId!)
    expect(features.getUserStory(userStory.id)!.status).toBe("done")

    const workers = loopCalls.filter(
      (c) => !c.userMessage?.startsWith("# Review the")
    )
    // QA's exploratory test step drives the app in its own tab.
    expect(
      workers.map((c) => [c.qaChecks ?? null, c.seatBrowser?.label ?? null])
    ).toEqual([
      [null, "builder@implementation · billing.milestone-1.invoice-model"],
      [null, "builder@implementation · billing.milestone-1.invoice-model"],
      ["explore", "qa@implementation · billing.milestone-1.invoice-model"],
    ])
    // One tab per phase run, each released when its step ended.
    const browsing = workers.filter((c) => c.seatBrowser)
    const phaseRunIds = browsing.map((c) => c.seatBrowser!.phaseRunId)
    expect(new Set(phaseRunIds).size).toBe(3)
    expect([...seatBrowserReleases].sort()).toEqual([...phaseRunIds].sort())
    // Nothing started, so only loopback origins are open to it.
    expect(browsing.every((c) => c.seatBrowser!.origins.length === 0)).toBe(
      true
    )
    expect(workers[2].sectionContent).toContain("## Your browser")
  })

  it("gives seat steps no browser when none is installed", async () => {
    const rig = orchestratedRig()
    const { userStory } = billingFeature(rig.id)
    proofSubmissions.push(acceptedProof)
    const playbookRun = await runner.startUserStory(userStory.id)
    await drive(playbookRun.processRunId!)
    const workers = loopCalls.filter(
      (c) => !c.userMessage?.startsWith("# Review the")
    )
    expect(workers.every((c) => !c.seatBrowser)).toBe(true)
    expect(workers[2].sectionContent).not.toContain("## Your browser")
  })

  it("applies a QA send-back on Autopilot or by default, and asks the user when the playbook requires it", async () => {
    // The default user story playbook routes rework autonomously; the last
    // case turns flag confirmation back on, as the Process builder toggle does.
    for (const [mode, requireApproval] of [
      ["autopilot", false],
      ["manual", false],
      ["manual", true],
    ] as const) {
      if (requireApproval)
        db.prepare(
          "UPDATE process_definitions SET require_flag_approval = 1"
        ).run()
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
      if (mode === "autopilot" || !requireApproval) {
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
        // QA's test step runs in its user story session too.
        const qaSession = sessionFor("qa@implementation", runId)
        expect(qa[index].conversationId).toBe(qaSession.conversationId)
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
        .find(
          (pr) =>
            pr.seatAddress === "qa@implementation" &&
            processes.getPhase(pr.phaseId)?.proofStep
        )!
      expect(testRun.resultContent).toBe("verified")
    })

    it("keeps a long-lived QA session across user stories when the step asks for it", async () => {
      const { feature, qa } = await runTwoUserStories("feature")
      const session = seatSessionsRepo.getLiveSeatSession(
        feature.id,
        "qa@implementation"
      )!
      expect(session.scope).toBe("feature")
      // The test step asked for the long-lived session.
      const tests = qa.filter((c) => c.qaChecks === "explore")
      expect(tests.map((c) => c.conversationId)).toEqual([
        session.conversationId,
        session.conversationId,
      ])
    })
  })
})

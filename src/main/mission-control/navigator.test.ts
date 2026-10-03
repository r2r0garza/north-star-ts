import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { execFileSync } from "child_process"
import { randomUUID } from "crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

// The Navigator end to end (plan 106.6): real SQLite, real temporary git
// repositories, the real Process engine, and a stubbed agent loop. The lead's
// planning step submits its plan through the propose_plan map tool; builders
// write files into their user story worktrees; the integrator resolves conflicts.

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
  workspace: string
  userMessage: string
  seat?: string
}
const loopCalls: LoopCall[] = []
// What each user story's build step writes, by user story key: file → content.
const builds = new Map<string, Record<string, string>>()
let resolution: Record<string, string> | null = null
// The plan the lead's planning step proposes.
let plannedMilestones: unknown[] = []
// A user story the milestone's planning review adds, once.
let reviewAddsStory: Record<string, unknown> | null = null

vi.mock("../agent", () => ({
  SHUTDOWN_ABORT_REASON,
  generateTitle: async () => "Title",
  runAgentLoop: async (input: {
    conversationId: string
    workspace: string
    userMessage?: string
    processProofStep?: boolean
    processRunId?: string
    processPhaseRunId?: string
    processQaChecks?: "author" | "verify"
    missionControlSeat?: import("./seat-turns").SeatTurnIdentity
  }) => {
    // QA's checks step (plan 109.02) needs a valid manifest to complete.
    writeFakeManifest(input)
    const msg = input.userMessage ?? ""
    loopCalls.push({
      workspace: input.workspace,
      userMessage: msg,
      seat: input.missionControlSeat?.address,
    })
    let content = "done"
    if (msg.startsWith("# Review the")) content = '{"approved": true}'
    else if (msg.includes("## Submit the plan") && input.missionControlSeat) {
      const result = getMapTools()!.proposePlan(input.missionControlSeat, {
        milestones: plannedMilestones,
        reason: "Two milestones",
      })
      content = result.ok ? "Plan proposed." : result.message
    } else if (
      reviewAddsStory &&
      msg.includes("Review the milestone's user stories") &&
      input.missionControlSeat
    ) {
      const result = getMapTools()!.proposeUserStory(input.missionControlSeat, {
        userStory: reviewAddsStory,
        reason: "The definition of done needs it.",
      })
      reviewAddsStory = null
      content = result.ok ? "Proposed." : result.message
    } else if (msg.includes("Build the user story")) {
      const key = /# User story ([a-z0-9-]+):/.exec(msg)?.[1] ?? ""
      for (const [file, text] of Object.entries(builds.get(key) ?? {}))
        writeFileSync(path.join(input.workspace, file), text)
    } else if (msg.includes("Resolve the merge conflict") && resolution) {
      for (const [file, text] of Object.entries(resolution))
        writeFileSync(path.join(input.workspace, file), text)
    }
    if (input.processProofStep) {
      recordUserStoryProof({
        processRunId: input.processRunId!,
        processPhaseRunId: input.processPhaseRunId!,
        args: {
          verdict: "accepted",
          criteria: [
            { id: "AC-1", status: "met", evidence: "Checked the file." },
          ],
        },
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
vi.mock("../agent/providers", () => {
  class NoActiveProviderError extends Error {}
  return {
    resolveLlm: () => ({ client: {}, model: "m", apiMode: "completions" }),
    createCompletion: async () => ({ choices: [{ message: { content: "" } }] }),
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
import { createApproval } from "../db/repositories/approvals"
import * as rigs from "../db/repositories/rigs"
import * as features from "../db/repositories/features"
import * as playbooks from "../db/repositories/playbooks"
import * as proposals from "../db/repositories/proposals"
import * as ticks from "../db/repositories/navigator-ticks"
import * as seatComms from "../db/repositories/seat-comms"
import { upsertWorkspace } from "../db/repositories/workspaces"
import { ProcessService } from "../tasks/process/service"
import { UserStoryRunner, recordUserStoryProof } from "./user-story-runner"
import { startConflictResolution, startHookRun } from "./hook-runner"
import { MilestoneIntegration } from "./integration"
import { Navigator } from "./navigator"
import {
  applyProposal,
  checkProposal,
  getMapTools,
  judgeMilestoneDone,
  installMapTools,
  MapToolService,
  rejectProposal,
} from "./map-tools"
import { installSeatComms, SeatComms } from "./comms"
import { onWorkChanged } from "./work-events"
import type { SeatTurnIdentity } from "./seat-turns"
import type { AgentDefinition } from "../agent/agents/types"
import type { RigDecisionRight } from "../db/types"
import { writeFakeManifest } from "../test/qa-manifest"

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
    return { id: taskId }
  },
} as never

const dirs: string[] = []
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "mc-nav-"))
  dirs.push(root)
  git(root, "init", "-b", "main")
  git(root, "config", "user.email", "test@example.com")
  git(root, "config", "user.name", "Test")
  writeFileSync(path.join(root, "shared.txt"), "one\ntwo\nthree\n")
  git(root, "add", ".")
  git(root, "commit", "-m", "base")
  return root
}

let service: ProcessService
let runner: UserStoryRunner
let integration: MilestoneIntegration
let navigator: Navigator
let bus: SeatComms
const notices: string[] = []
let clock = 1_000_000
let unsubscribe: (() => void) | null = null

function makeNavigator(
  overrides: Partial<ConstructorParameters<typeof Navigator>[0]> = {}
): Navigator {
  const nav = new Navigator({
    startUserStory: (userStoryId, options) =>
      runner.startUserStory(userStoryId, options),
    startHook: (input) => startHookRun(runner, input),
    cancelPlaybookRun: (id) => runner.cancelPlaybookRun(id),
    workspaceMode: (feature) => integration.workspaceMode(feature),
    advanceMilestone: (milestoneId) =>
      integration.advanceMilestone(milestoneId),
    kickMerges: (milestoneId) => void integration.kick(milestoneId),
    completeMilestone: async (milestoneId) => {
      await integration.markMerged(milestoneId, "navigator")
    },
    direct: (input) => {
      const result = bus.direct(input)
      if (!result.ok) throw new Error(result.message)
    },
    notifyUser: (title, body) => notices.push(`${title}: ${body}`),
    debounceMs: 0,
    heartbeatMs: 0,
    now: () => clock,
    ...overrides,
  })
  unsubscribe?.()
  unsubscribe = onWorkChanged((id) => nav.poke(id))
  return nav
}

function setup() {
  const worktreeRoot = mkdtempSync(path.join(tmpdir(), "mc-nav-worktrees-"))
  dirs.push(worktreeRoot)
  service = new ProcessService(fakeRunner)
  integration = new MilestoneIntegration({
    worktreeRoot: () => worktreeRoot,
    startResolution: (input) => startConflictResolution(runner, input),
    notifyUser: (title, body) => notices.push(`${title}: ${body}`),
    leaseRetryMs: 10,
  })
  runner = new UserStoryRunner({
    startProcessRun: (input) => service.startRun(input),
    cancelTask: () => {},
    loadAgents: async () => AGENTS as unknown as AgentDefinition[],
    integration,
  })
  service.onRunSettled((id) => runner.settle(id))
  bus = new SeatComms({
    dispatch: () => {},
    notifyUser: (t, b) => notices.push(`${t}: ${b}`),
  })
  installSeatComms(bus)
  navigator = makeNavigator()
  installMapTools(
    new MapToolService({
      position: (id) => navigator.position(id),
      startUserStory: (userStoryId, options) =>
        runner.startUserStory(userStoryId, options),
      cancelUserStory: (userStoryId) => runner.cancelUserStory(userStoryId),
      completeMilestone: async (milestoneId) => {
        await integration.markMerged(milestoneId, "navigator")
      },
    })
  )
}

// Orchestration (lead) oversees implementation (two builders and QA).
function rig(
  leadRights: RigDecisionRight[] = [
    "assign_user_story",
    "revise_plan",
    "accept_proof",
  ]
) {
  const created = rigs.createRig({ name: "Team" })
  const orchestration = rigs.createPod({
    rigId: created.id,
    key: "orchestration",
    name: "Orchestration",
  })
  const implementation = rigs.createPod({
    rigId: created.id,
    key: "implementation",
    name: "Implementation",
  })
  const lead = rigs.createSeat({
    podId: orchestration.id,
    key: "lead",
    role: "lead",
    agentRefId: "agentref:v1:lead",
    agentLabel: "lead",
    decisionRights: [...leadRights],
  })
  rigs.updatePod(orchestration.id, { leadSeatId: lead.id })
  for (const key of ["builder", "builder-2"])
    rigs.createSeat({
      podId: implementation.id,
      key,
      role: "builder",
      agentRefId: "agentref:v1:builder",
      agentLabel: key,
    })
  rigs.createSeat({
    podId: implementation.id,
    key: "qa",
    role: "qa",
    agentRefId: "agentref:v1:qa",
    agentLabel: "qa",
  })
  rigs.setOversight(created.id, [
    { overseerPodId: orchestration.id, overseenPodId: implementation.id },
  ])
  return created
}

const LEAD: Omit<SeatTurnIdentity, "featureId"> = {
  address: "lead@orchestration",
  profile: "consult",
  anchor: null,
  wakeHop: null,
}

function draftFeature(
  workspace: string,
  leadRights?: Parameters<typeof rig>[0]
) {
  const graph = features.createFeature({
    key: "billing",
    name: "Billing",
    intent: "Customers can be invoiced.",
    definitionOfDone: "Invoices ship.",
    rigId: rig(leadRights).id,
    workspaceId: upsertWorkspace(workspace).id,
    defaultPodKey: "implementation",
  })
  return graph.feature.id
}

async function drive(processRunId: string) {
  const run = processes.getProcessRun(processRunId)!
  await service.execute({
    task: { id: run.taskId!, input: { processRunId } } as never,
    signal: new AbortController().signal,
    emit: () => {},
    workspace: undefined,
  } as never)
}

// Let the Navigator act, then run every started Process run and the merge
// queue, until nothing moves.
async function settle(rounds = 20) {
  for (let round = 0; round < rounds; round++) {
    await navigator.idle()
    await integration.idle()
    await navigator.idle()
    const running = playbooks
      .listPlaybookRuns({ status: "running" })
      .filter((r) => r.processRunId)
    if (!running.length) return
    for (const run of running) await drive(run.processRunId!)
  }
}

// What the approval dialog does: review, then approve that base and head.
async function approveLanding(
  milestoneId: string,
  options?: { localMerge?: boolean }
) {
  const status = await integration.status(milestoneId)
  await integration.land(
    milestoneId,
    { baseOid: status.summary!.baseOid!, headOid: status.summary!.headOid! },
    options
  )
}

function userStoriesOf(featureId: string) {
  return features
    .listMilestones(featureId)
    .flatMap((m) => features.listUserStories(m.id))
}

function directions(featureId: string) {
  return seatComms
    .listMessages({ featureId })
    .filter((m) => m.kind === "direction")
}

const PLAN = [
  {
    key: "m-invoices",
    name: "Invoices",
    outcome: "Invoices exist.",
    userStories: [
      {
        key: "api",
        title: "Invoice API",
        acceptance: ["api works"],
        touch_hints: ["api/**"],
      },
      {
        key: "pdf",
        title: "Invoice PDF",
        acceptance: ["pdf works"],
        touch_hints: ["pdf/**"],
      },
      {
        key: "ui",
        title: "Invoice UI",
        acceptance: ["ui works"],
        depends_on: ["api", "pdf"],
      },
    ],
  },
  {
    key: "m-payments",
    name: "Payments",
    outcome: "Invoices can be paid.",
    userStories: [{ key: "pay", title: "Pay", acceptance: ["pay works"] }],
  },
]

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  runMigrations(db)
  loopCalls.length = 0
  builds.clear()
  resolution = null
  notices.length = 0
  plannedMilestones = PLAN
  reviewAddsStory = null
  clock = 1_000_000
})

afterEach(() => {
  navigator?.stop()
  integration?.stop()
  unsubscribe?.()
  unsubscribe = null
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!sqliteLoads)("Navigator autopilot", () => {
  it("drives planning → two milestones → a parallel wave with a conflict → release → done, across a restart", async () => {
    setup()
    const root = repo()
    const id = draftFeature(root)
    // The two first-wave user stories touch different areas but both edit the same
    // shared file, so the second merge conflicts.
    builds.set("api", { "api.txt": "api\n", "shared.txt": "one\nAPI\nthree\n" })
    builds.set("pdf", { "pdf.txt": "pdf\n", "shared.txt": "one\nPDF\nthree\n" })
    builds.set("ui", { "ui.txt": "ui\n" })
    builds.set("pay", { "pay.txt": "pay\n" })
    resolution = { "shared.txt": "one\nAPI\nPDF\nthree\n" }

    // Start: nothing is planned, so planning runs at once.
    const started = await navigator.startDrive(id, { mode: "autopilot" })
    expect(started.planning?.hook).toBe("plan")
    await settle()
    const [plan] = proposals.listProposals(id, "pending")
    expect(plan).toMatchObject({ kind: "plan", proposer: "lead@orchestration" })
    // Autopilot waits for the user to apply the planning proposal.
    expect(userStoriesOf(id)).toHaveLength(0)
    expect(notices.some((n) => n.includes("waiting on you"))).toBe(true)

    applyProposal(plan.id, "user")
    const milestones = features.listMilestones(id)
    // The starter milestone took the first planned milestone.
    expect(milestones.map((m) => m.key)).toEqual(["milestone-1", "m-payments"])
    expect(milestones[0].name).toBe("Invoices")
    expect(userStoriesOf(id).every((s) => s.origin === "agent")).toBe(true)
    // Autopilot milestones land by an approved local merge: the starter
    // milestone switched at start, the planned one was created that way.
    expect(milestones.map((m) => m.mergePolicy.mode)).toEqual([
      "local_merge",
      "local_merge",
    ])
    // User stories the user applied from a proposal don't spend the budget for
    // user stories seats add on their own.
    const position = await navigator.position(id)
    expect(
      position.budgets.find((b) => b.key === "maxAgentUserStoriesPerMilestone")
    ).toMatchObject({
      used: 0,
      scope: "milestone-1",
    })

    // A restart right after planning: a fresh Navigator resumes from SQLite.
    navigator.stop()
    navigator = makeNavigator()
    navigator.start()
    await settle()

    const m1 = features.getMilestone(milestones[0].id)!
    const byKey = (key: string) => userStoriesOf(id).find((s) => s.key === key)!
    // The milestone's planning review ran before its user stories, then the first
    // wave ran in parallel, then the dependent user story on the merged head.
    const hooksRun = playbooks
      .listPlaybookRuns({ featureId: id })
      .filter((r) => !r.userStoryId)
      .map((r) => r.hook)
    expect(hooksRun).toEqual(
      expect.arrayContaining([
        "plan",
        "before_user_stories",
        "after_all_user_stories",
      ])
    )
    const apiRun = playbooks.listPlaybookRuns({
      userStoryId: byKey("api").id,
    })[0]
    const pdfRun = playbooks.listPlaybookRuns({
      userStoryId: byKey("pdf").id,
    })[0]
    const uiRun = playbooks.listPlaybookRuns({ userStoryId: byKey("ui").id })[0]
    expect(apiRun.worktreePath).not.toBe(pdfRun.worktreePath)
    expect(uiRun.createdAt).toBeGreaterThanOrEqual(
      Math.max(apiRun.createdAt, pdfRun.createdAt)
    )
    const startTick = ticks
      .listTicks(id, 200)
      .find(
        (t) =>
          t.actions.filter((a) => a.kind === "start_user_story" && a.ok)
            .length === 2
      )
    expect(startTick?.actions.map((a) => a.target).sort()).toEqual([
      "api",
      "pdf",
    ])
    // The conflict was resolved by the integrator (the lead) and merged.
    expect(byKey("api").status).toBe("done")
    expect(byKey("pdf").status).toBe("done")
    expect(byKey("ui").status).toBe("done")
    expect(git(root, "show", `${m1.integrationBranch}:shared.txt`)).toBe(
      "one\nAPI\nPDF\nthree"
    )
    expect(
      playbooks
        .listPlaybookRuns({ featureId: id })
        .some((r) => r.hook === "after_each_user_story")
    ).toBe(true)

    // Every user story merged: the lead is asked to judge the definition of done.
    expect(features.getMilestone(m1.id)!.status).toBe("review")
    const decision = directions(id).at(-1)!
    expect(decision.toAddress).toBe("lead@orchestration")
    expect(decision.body).toContain("Decision needed from you")
    expect(decision.body).toContain("definition of done")

    const turn = { ...LEAD, featureId: id }
    const judged = await getMapTools()!.completeMilestone(turn, {
      milestone: m1.key,
      summary: "All three user stories are merged and verified.",
    })
    expect(judged).toMatchObject({ ok: true })
    // A milestone with an integration branch lands only by the user's hand:
    // the approval is bound to the base and head the user reviewed.
    await settle()
    expect(features.getMilestone(m1.id)!.status).toBe("review")
    expect(notices.some((n) => n.includes("ready to land"))).toBe(true)
    await approveLanding(m1.id)
    await settle()
    expect(git(root, "show", "main:shared.txt")).toBe("one\nAPI\nPDF\nthree")

    // The release ran between milestones, then milestone 2 ran to review.
    const m2 = features.getMilestone(milestones[1].id)!
    expect(
      playbooks
        .listPlaybookRuns({ featureId: id })
        .some((r) => r.hook === "between_milestones" && r.milestoneId === m1.id)
    ).toBe(true)
    expect(byKey("pay").status).toBe("done")
    expect(m2.status).toBe("review")
    await getMapTools()!.completeMilestone(turn, {
      milestone: m2.key,
      summary: "Paid.",
    })
    // The user switched this one to manual, then merged it here anyway.
    features.setMilestoneMergePolicy(m2.id, "manual")
    await approveLanding(m2.id, { localMerge: true })
    await settle()

    expect(features.getFeature(id)!.status).toBe("completed")
    expect(features.getMilestone(m2.id)!.landing).toMatchObject({
      mode: "local_merge",
    })
    expect(git(root, "branch", "--show-current")).toBe("main")
    expect(readFileSync(path.join(root, "pay.txt"), "utf8")).toBe("pay\n")
    // Finished: per-milestone meters show the last milestone's final numbers.
    const final = await navigator.position(id)
    expect(
      final.budgets.find((b) => b.key === "maxUserStoryAttempts")
    ).toMatchObject({
      used: 1,
      scope: "m-payments, final",
      final: true,
    })

    // The next sprint: a completed feature takes no new work until the
    // user reopens it, and it reopens paused.
    expect(() =>
      features.createMilestone({
        featureId: id,
        key: "m-refunds",
        name: "Refunds",
        outcome: "Refunds.",
      })
    ).toThrow(/Reopen it/)
    navigator.reopen(id)
    expect(features.getFeature(id)).toMatchObject({
      status: "paused",
      finishedAt: null,
    })
    const m3 = features
      .createMilestone({
        featureId: id,
        key: "m-refunds",
        name: "Refunds",
        outcome: "Refunds.",
      })
      .milestones.at(-1)!
    expect(m3.mergePolicy.mode).toBe("local_merge")
    features.createUserStory({
      milestoneId: m3.id,
      key: "refund",
      title: "Refund",
      spec: { acceptance: ["refunds"] },
    })
    builds.set("refund", { "refund.txt": "refund\n" })
    await settle()
    expect(
      playbooks.listPlaybookRuns({ featureId: id, status: "running" })
    ).toHaveLength(0)
    navigator.resume(id)
    await settle()
    // The release for the last finished milestone ran first, then the sprint.
    expect(
      playbooks
        .listPlaybookRuns({ featureId: id })
        .some((r) => r.hook === "between_milestones" && r.milestoneId === m2.id)
    ).toBe(true)
    expect(userStoriesOf(id).find((s) => s.key === "refund")!.status).toBe(
      "done"
    )
    await getMapTools()!.completeMilestone(turn, {
      milestone: m3.key,
      summary: "Refunds work.",
    })
    await approveLanding(m3.id)
    await settle()
    expect(features.getFeature(id)!.status).toBe("completed")
  }, 90_000)

  it("retries a failed mechanical step on the heartbeat, then tells the user", async () => {
    setup()
    const root = repo()
    const id = draftFeature(root)
    const milestone = features.getFeatureGraph(id)!.milestones[0]
    features.createUserStory({
      milestoneId: milestone.id,
      key: "a",
      title: "A",
      spec: { acceptance: ["works"] },
    })
    features.updateMilestone(milestone.id, {
      playbookId: playbooks.createPlaybook({
        name: "Bare",
        altitude: "milestone",
      }).id,
    })
    // Every start fails (say, the repository has uncommitted changes).
    let attempts = 0
    navigator.stop()
    navigator = makeNavigator({
      startUserStory: async () => {
        attempts++
        throw new Error("The working tree has uncommitted changes.")
      },
    })
    await navigator.startDrive(id, { mode: "autopilot" })
    await navigator.idle()
    expect(attempts).toBe(1)
    // The same position within the retry interval: nothing new.
    expect(await navigator.tick(id)).toBeNull()
    for (let i = 0; i < 5; i++) {
      clock += 61_000
      await navigator.tick(id)
    }
    expect(attempts).toBe(4)
    expect(notices.some((n) => n.includes("stuck"))).toBe(true)
    const failed = ticks
      .listTicks(id)
      .filter((t) => t.actions.some((a) => !a.ok))
    expect(failed[0].actions[0].detail).toContain("uncommitted changes")
  })

  it("doesn't start a story again while its worktree is still being prepared", async () => {
    setup()
    const root = repo()
    const id = draftFeature(root)
    const milestone = features.getFeatureGraph(id)!.milestones[0]
    features.createUserStory({
      milestoneId: milestone.id,
      key: "a",
      title: "A",
      spec: { acceptance: ["works"] },
    })
    features.updateMilestone(milestone.id, {
      playbookId: playbooks.createPlaybook({
        name: "Bare",
        altitude: "milestone",
      }).id,
    })
    // A long setup: the story stays draft while it runs.
    let starts = 0
    navigator.stop()
    navigator = makeNavigator({
      startUserStory: async () => {
        starts++
        throw new Error("should not be called")
      },
      isStartingUserStory: () => true,
    })
    await navigator.startDrive(id, { mode: "autopilot" })
    await navigator.idle()
    expect(starts).toBe(0)
    // Nothing started and nothing failed: it's simply still preparing.
    expect(
      ticks
        .listTicks(id)
        .flatMap((t) => t.actions)
        .filter((a) => a.kind === "start_user_story")
    ).toEqual([])
  })

  it("tells a lead that judges early that running stories finish on their own", async () => {
    setup()
    const root = repo()
    const id = draftFeature(root)
    plannedMilestones = []
    await navigator.startDrive(id, { mode: "manual" })
    const milestone = features.getFeatureGraph(id)!.milestones[0]
    features.createUserStory({
      milestoneId: milestone.id,
      key: "proof",
      title: "Proof",
      spec: { acceptance: ["proven"] },
    })
    const story = features
      .listUserStories(milestone.id)
      .find((s) => s.key === "proof")!
    const turn = { ...LEAD, featureId: id }
    const judge = () =>
      getMapTools()!.completeMilestone(turn, {
        milestone: milestone.key,
        summary: "Proven.",
      })

    features.setUserStoryExecution(story.id, { status: "running" }, "test")
    const early = await judge()
    expect(early).toMatchObject({ ok: false, code: "not_done" })
    expect(!early.ok && early.message).toContain("proof (running)")
    expect(!early.ok && early.message).toContain("nothing to escalate")

    // A story that isn't moving on its own gets no such reassurance.
    features.setUserStoryExecution(story.id, { status: "failed" }, "test")
    const failed = await judge()
    expect(!failed.ok && failed.message).toContain("proof (failed)")
    expect(!failed.ok && failed.message).not.toContain("nothing to escalate")
  })

  it("tells the host when a feature starts, so its workspace can be indexed", async () => {
    setup()
    const root = repo()
    const id = draftFeature(root)
    plannedMilestones = []
    const started: string[] = []
    navigator = makeNavigator({
      onFeatureStarted: (feature) =>
        started.push(`${feature.id}:${feature.status}`),
    })
    await navigator.startDrive(id, { mode: "manual" })
    expect(started).toEqual([`${id}:active`])
  })

  it("with auto-apply on, applies what the planning review adds too", async () => {
    setup()
    const root = repo()
    const id = draftFeature(root)
    reviewAddsStory = {
      key: "audit",
      title: "Audit log",
      acceptance: ["audited"],
    }
    await navigator.startDrive(id, { mode: "autopilot", autoApplyPlan: true })
    await settle()
    expect(proposals.listProposals(id, "pending")).toEqual([])
    const applied = proposals
      .listProposals(id, "applied")
      .map((p) => p.kind)
      .sort()
    expect(applied).toEqual(["plan", "user_story"])
    expect(userStoriesOf(id).some((s) => s.key === "audit")).toBe(true)
  })

  it("with auto-apply off, the planning review's additions wait for the user", async () => {
    setup()
    const root = repo()
    const id = draftFeature(root)
    reviewAddsStory = {
      key: "audit",
      title: "Audit log",
      acceptance: ["audited"],
    }
    await navigator.startDrive(id, { mode: "autopilot" })
    await settle()
    applyProposal(proposals.listProposals(id, "pending")[0].id, "user")
    await settle()
    expect(proposals.listProposals(id, "pending").map((p) => p.kind)).toEqual([
      "user_story",
    ])
  })

  it("does nothing new when a tick sees the same position", async () => {
    setup()
    const root = repo()
    const id = draftFeature(root)
    plannedMilestones = []
    await navigator.startDrive(id, { mode: "manual" })
    await settle()
    const before = ticks.listTicks(id).length
    expect(await navigator.tick(id)).toBeNull()
    expect(await navigator.tick(id)).toBeNull()
    expect(ticks.listTicks(id).length).toBe(before)
  })

  it("doesn't count time spent waiting with no work in flight", async () => {
    setup()
    const root = repo()
    const id = draftFeature(root)
    features.createUserStory({
      milestoneId: features.getFeatureGraph(id)!.milestones[0].id,
      key: "a",
      title: "A",
      spec: { acceptance: ["works"] },
    })
    features.setFeatureBudgets(id, { maxActiveHours: 1 })
    await navigator.startDrive(id, { mode: "copilot" })
    await navigator.idle()
    // Nothing running: the feature is waiting (here, on the lead or user).
    for (let i = 0; i < 40; i++) {
      clock += 2 * 60 * 1000
      await navigator.tick(id)
    }
    const feature = features.getFeature(id)!
    expect(feature.drive.activeMs).toBe(0)
    expect(feature.status).toBe("active")
  })

  it("auto-pauses at the active-time budget and stays resumable once it is raised", async () => {
    setup()
    const root = repo()
    const id = draftFeature(root)
    const graph = features.getFeatureGraph(id)!
    for (const key of ["a", "b"])
      features.createUserStory({
        milestoneId: graph.milestones[0].id,
        key,
        title: key.toUpperCase(),
        spec: { acceptance: ["works"] },
      })
    features.setFeatureBudgets(id, { maxActiveHours: 1 })
    await navigator.startDrive(id, { mode: "copilot" })
    await navigator.idle()
    // Work in flight: user story a is running (its run is never driven here).
    await runner.startUserStory(
      userStoriesOf(id).find((s) => s.key === "a")!.id
    )
    // Drive time accrues in bounded steps; a long gap (app closed) never counts.
    clock += 10 * 60 * 60 * 1000
    await navigator.tick(id)
    expect(features.getFeature(id)!.drive.activeMs).toBeLessThanOrEqual(
      2 * 60 * 1000
    )
    for (let i = 0; i < 40; i++) {
      clock += 2 * 60 * 1000
      await navigator.tick(id)
    }
    const paused = features.getFeature(id)!
    expect(paused.status).toBe("paused")
    expect(paused.drive).toMatchObject({ pausedBy: "budget" })
    expect(notices.some((n) => n.includes("paused"))).toBe(true)
    // Nothing starts while paused.
    await expect(
      runner.startUserStory(userStoriesOf(id).find((s) => s.key === "b")!.id)
    ).rejects.toThrow(/Start the feature/)
    expect(() => navigator.resume(id)).toThrow(/Raise the budget/)
    features.setFeatureBudgets(id, { maxActiveHours: 4 })
    navigator.resume(id)
    expect(features.getFeature(id)!.status).toBe("active")
  })
})

describe.skipIf(!sqliteLoads)("Navigator copilot and map tools", () => {
  async function copilot(leadRights?: Parameters<typeof rig>[0]) {
    setup()
    const root = repo()
    const id = draftFeature(root, leadRights)
    const milestone = features.getFeatureGraph(id)!.milestones[0]
    for (const key of ["a", "b"])
      features.createUserStory({
        milestoneId: milestone.id,
        key,
        title: key.toUpperCase(),
        spec: { acceptance: [`${key} works`], touchHints: [`${key}/**`] },
      })
    // A milestone playbook without a planning review, so user stories are ready at once.
    const playbook = playbooks.createPlaybook({
      name: "Bare",
      altitude: "milestone",
    })
    features.updateMilestone(milestone.id, { playbookId: playbook.id })
    builds.set("a", { "a.txt": "a\n" })
    builds.set("b", { "b.txt": "b\n" })
    await navigator.startDrive(id, { mode: "copilot" })
    await navigator.idle()
    return { id, milestone, turn: { ...LEAD, featureId: id } }
  }

  it("dispatches nothing itself and directs the lead after each change", async () => {
    const { id, turn } = await copilot()
    expect(playbooks.listPlaybookRuns({ featureId: id })).toHaveLength(0)
    const first = directions(id)
    expect(first).toHaveLength(1)
    expect(first[0].body).toContain(
      "Ready to start now (assign_user_story, critical path first): a, b"
    )

    const assigned = await getMapTools()!.assignUserStory(turn, {
      userStory: "a",
    })
    expect(assigned).toMatchObject({ ok: true })
    await navigator.idle()
    // A new direction superseded the one still queued.
    const after = directions(id)
    expect(after.at(-1)!.body).toContain("a draft → running")
    expect(after.filter((m) => m.status === "queued")).toHaveLength(1)
    const revision = features
      .listRevisions(id)
      .find(
        (r) =>
          r.targetId === userStoriesOf(id).find((s) => s.key === "a")!.id &&
          r.reason?.startsWith("Attempt 1 started")
      )
    expect(revision?.actor).toBe("lead@orchestration")
  })

  it("enforces decision rights: a lead without revise_plan can only propose", async () => {
    const { id, turn } = await copilot(["assign_user_story"])
    const tools = getMapTools()!
    const revised = tools.revisePlan(turn, {
      changes: [
        {
          op: "add_user_story",
          userStory: { title: "Extra", acceptance: ["x"] },
        },
      ],
      reason: "Found missing work",
    })
    expect(revised).toMatchObject({ ok: true, data: { status: "pending" } })
    expect(userStoriesOf(id).map((s) => s.key)).toEqual(["a", "b"])
    expect(
      tools.cancelUserStory(turn, { userStory: "a", reason: "no" })
    ).toMatchObject({
      ok: false,
      code: "lacks_decision_right",
    })
    expect(
      await tools.completeMilestone(turn, {
        milestone: "milestone-1",
        summary: "x",
      })
    ).toMatchObject({ ok: false, code: "lacks_decision_right" })
  })

  it("surfaces an approval a running user story waits on as a user decision", async () => {
    const { id, turn } = await copilot()
    await getMapTools()!.assignUserStory(turn, { userStory: "a" })
    const run = playbooks.listPlaybookRuns({
      featureId: id,
      status: "running",
    })[0]
    const taskId = processes.getProcessRun(run.processRunId!)!.taskId!
    createApproval({
      taskId,
      request: {
        kind: "process_flag_gate",
        phaseKey: "test",
        flagTargetKey: "build",
        flagReason: "AC-2 fails.",
      },
    })
    const position = await navigator.position(id)
    expect(position.pendingDecisions).toContainEqual(
      expect.objectContaining({
        kind: "run_approval",
        owner: "user",
        summary:
          "User story a: test wants to send it back to build. AC-2 fails.",
      })
    )
  })

  it("orders added user stories with blocks and runs_last", async () => {
    const { id, turn } = await copilot()
    const tools = getMapTools()!
    const edgeKeys = () => {
      const stories = userStoriesOf(id)
      const key = (sid: string) => stories.find((s) => s.id === sid)!.key
      return features
        .listEdges(stories[0].milestoneId)
        .map((e) => `${key(e.fromUserStoryId)}>${key(e.toUserStoryId)}`)
        .sort()
    }
    const story = (k: string) => userStoriesOf(id).find((s) => s.key === k)!

    // c needs a, and b (already planned) must wait for c.
    expect(
      tools.revisePlan(turn, {
        changes: [
          {
            op: "add_user_story",
            userStory: {
              key: "c",
              title: "C",
              acceptance: ["c"],
              depends_on: ["a"],
              blocks: ["b"],
            },
          },
          {
            op: "add_user_story",
            userStory: {
              key: "proof",
              title: "Proof",
              acceptance: ["all"],
              runs_last: true,
            },
          },
        ],
        reason: "Order the additions",
      })
    ).toMatchObject({ ok: true })
    expect(edgeKeys()).toEqual(["a>c", "c>b"])
    expect(story("proof").spec.runsLast).toBe(true)

    // A story added later is covered too: proof waits for it without an edge.
    tools.revisePlan(turn, {
      changes: [
        {
          op: "add_user_story",
          userStory: { key: "d", title: "D", acceptance: ["d"] },
        },
      ],
      reason: "One more",
    })
    await expect(runner.startUserStory(story("proof").id)).rejects.toThrow(
      /depends on unmerged user stories: .*\bd\b/
    )
    const position = await navigator.position(id)
    expect(position.milestone!.waves.at(-1)).toEqual([story("proof").id])

    // Refused: a runs-last story that blocks others, a dependent of a
    // runs-last story, and blocking a story that has started.
    expect(
      tools.revisePlan(turn, {
        changes: [
          {
            op: "add_user_story",
            userStory: {
              key: "e",
              title: "E",
              acceptance: ["e"],
              runs_last: true,
              blocks: ["b"],
            },
          },
        ],
        reason: "x",
      })
    ).toMatchObject({ ok: false })
    expect(
      tools.revisePlan(turn, {
        changes: [{ op: "add_dependency", from: "proof", to: "d" }],
        reason: "x",
      })
    ).toMatchObject({ ok: false })
    await tools.assignUserStory(turn, { userStory: "a" })
    expect(
      tools.revisePlan(turn, {
        changes: [
          {
            op: "add_user_story",
            userStory: {
              key: "f",
              title: "F",
              acceptance: ["f"],
              blocks: ["a"],
            },
          },
        ],
        reason: "x",
      })
    ).toMatchObject({ ok: false })
    expect(userStoriesOf(id).some((s) => s.key === "f")).toBe(false)
  })

  it("applies bounded revisions and turns out-of-scope edits into proposals", async () => {
    const { id, turn } = await copilot()
    const tools = getMapTools()!
    const applied = tools.revisePlan(turn, {
      changes: [
        {
          op: "add_user_story",
          userStory: {
            key: "c",
            title: "C",
            acceptance: ["c"],
            depends_on: ["a"],
          },
        },
        {
          op: "split_user_story",
          userStory: "b",
          into: [
            { key: "b1", title: "B1", acceptance: ["b1"] },
            { key: "b2", title: "B2", acceptance: ["b2"], depends_on: ["b1"] },
          ],
        },
        { op: "reorder", order: ["c", "a"] },
      ],
      reason: "Refine the plan",
    })
    expect(applied).toMatchObject({ ok: true })
    const userStories = userStoriesOf(id)
    const key = (k: string) => userStories.find((s) => s.key === k)!
    expect(key("b").status).toBe("cancelled")
    expect(key("c")).toMatchObject({ origin: "agent", position: 0 })
    const edges = features
      .listEdges(key("a").milestoneId)
      .map(
        (e) =>
          `${userStories.find((s) => s.id === e.fromUserStoryId)!.key}>${userStories.find((s) => s.id === e.toUserStoryId)!.key}`
      )
    expect(edges.sort()).toEqual(["a>c", "b1>b2"])
    // Every change is attributed to the seat, with its reason.
    const created = features
      .listRevisions(id)
      .filter((r) => r.change.op === "create")
    expect(
      created.every(
        (r) =>
          r.actor === "lead@orchestration" && r.reason === "Refine the plan"
      )
    ).toBe(true)

    // A cycle is refused and nothing changes.
    const cyclic = tools.revisePlan(turn, {
      changes: [{ op: "add_dependency", from: "c", to: "a" }],
      reason: "oops",
    })
    expect(cyclic).toMatchObject({ ok: false, code: "invalid_change" })
    // The feature's definition of done is always a proposal.
    const outOfScope = tools.revisePlan(turn, {
      changes: [{ op: "edit_feature", patch: { definition_of_done: "Less" } }],
      reason: "Lower the bar",
    })
    expect(outOfScope).toMatchObject({ ok: true, data: { status: "pending" } })
    expect(features.getFeature(id)!.definitionOfDone).toBe("Invoices ship.")
    // Rejections go back to the proposer in the user's words.
    const pending = proposals.listProposals(id, "pending")[0]
    rejectProposal(pending.id, "The bar stays.", (proposal, body) => {
      bus.userNote({
        featureId: id,
        to: proposal.proposer,
        body,
        subject: "Proposal rejected",
      })
    })
    const note = seatComms
      .listMessages({ featureId: id, toAddress: "lead@orchestration" })
      .find((m) => m.kind === "steer")
    expect(note?.body).toContain("The bar stays.")
  })

  it("cancelling a user story blocks its dependents until the plan changes", async () => {
    const { id, turn } = await copilot()
    const tools = getMapTools()!
    tools.revisePlan(turn, {
      changes: [{ op: "add_dependency", from: "a", to: "b" }],
      reason: "b needs a",
    })
    expect(
      tools.cancelUserStory(turn, { userStory: "a", reason: "Not needed" })
    ).toMatchObject({
      ok: true,
      message: expect.stringContaining("Blocked until you replan: b"),
    })
    const b = () => userStoriesOf(id).find((s) => s.key === "b")!
    expect(b().status).toBe("blocked")
    await navigator.idle()
    const position = await navigator.position(id)
    expect(position.pendingDecisions.map((d) => d.kind)).toContain(
      "user_story_blocked"
    )
    tools.revisePlan(turn, {
      changes: [{ op: "remove_dependency", from: "a", to: "b" }],
      reason: "b stands alone",
    })
    expect(b().status).toBe("ready")
  })

  it("refuses seat messages past the hourly message budget, but still escalates", async () => {
    const { id, turn } = await copilot()
    features.setFeatureBudgets(id, { maxMessagesPerHour: 1 })
    const first = bus.send(
      { ...turn, profile: "work" },
      { to: "qa@implementation", body: "Hi" }
    )
    expect(first).toMatchObject({ ok: true })
    const second = bus.send(
      { ...turn, profile: "work" },
      { to: "qa@implementation", body: "Again" }
    )
    expect(second).toMatchObject({ ok: false, code: "feature_rate_limit" })
    expect(
      bus.escalate({ ...turn, profile: "work" }, { reason: "Blocked" })
    ).toMatchObject({
      ok: true,
    })
    // The Navigator's own directions are not seat chatter.
    const position = await navigator.position(id)
    expect(
      position.budgets.find((b) => b.key === "maxMessagesPerHour")
    ).toMatchObject({
      used: 2,
      level: "hard",
    })
  })

  it("marks proposals that went stale and applies what still applies", async () => {
    const { id, turn } = await copilot(["assign_user_story"])
    const tools = getMapTools()!
    // Without revise_plan every change is a proposal.
    tools.revisePlan(turn, {
      changes: [
        { op: "edit_user_story", userStory: "a", patch: { goal: "A, better" } },
        {
          op: "add_user_story",
          userStory: { key: "c", title: "C", acceptance: ["c"] },
        },
      ],
      reason: "Sharpen a, add c",
    })
    const [proposal] = proposals.listProposals(id, "pending")
    expect(checkProposal(proposal)).toEqual([])
    // Then user story a starts, so editing it no longer applies.
    await tools.assignUserStory(turn, { userStory: "a" })
    const problems = checkProposal(proposals.getProposal(proposal.id)!)
    expect(problems).toEqual([
      { index: 0, error: expect.stringContaining("has started") },
    ])
    // The dry run changed nothing.
    expect(userStoriesOf(id).map((s) => s.key)).toEqual(["a", "b"])
    expect(() => applyProposal(proposal.id)).toThrow(/has started/)
    const notes: string[] = []
    const applied = applyProposal(proposal.id, "user", {
      partial: true,
      deliver: (_p, body) => notes.push(body),
    })
    expect(applied.status).toBe("applied")
    expect(applied.resolutionNote).toContain("Applied 1 of 2")
    expect(userStoriesOf(id).map((s) => s.key)).toEqual(["a", "b", "c"])
    expect(notes[0]).toContain("has started")
    // User-applied user stories don't spend the seats' own user story budget.
    expect(
      features.countSeatCreatedUserStories(userStoriesOf(id)[0].milestoneId)
    ).toBe(0)
  })

  it("lets the user judge a milestone done and answer an escalation", async () => {
    const { id, turn } = await copilot(["assign_user_story"])
    const position = await navigator.position(id)
    // No lead DoD right: the user gets the judgment, with an action for it.
    const escalation = bus.escalate(
      { ...turn, profile: "work" },
      { reason: "Need a call on scope" }
    )
    expect(escalation).toMatchObject({
      ok: true,
      message: { toAddress: "user@rig" },
    })
    const replied = bus.userReply(
      escalation.ok ? escalation.message.id : "",
      "Keep it small."
    )
    expect(replied).toMatchObject({
      ok: true,
      message: { toAddress: "lead@orchestration", kind: "steer" },
    })
    expect(
      seatComms.getMessage(escalation.ok ? escalation.message.id : "")!.status
    ).toBe("replied")
    expect(
      position.pendingDecisions.every(
        (d) => d.owner === "user" || d.kind !== "milestone_dod"
      )
    ).toBe(true)
    // Judging before the work is merged is refused.
    const milestone = features.listMilestones(id)[0]
    await expect(
      judgeMilestoneDone(milestone.id, "done", async () => {})
    ).rejects.toThrow(/unfinished user stories/)
  })

  it("stops agent revisions at the budget: further changes become proposals", async () => {
    const { id, turn } = await copilot()
    features.setFeatureBudgets(id, {
      maxPlanRevisionsPerMilestone: 1,
      maxAgentUserStoriesPerMilestone: 5,
    })
    const tools = getMapTools()!
    expect(
      tools.revisePlan(turn, {
        changes: [{ op: "reorder", order: ["b", "a"] }],
        reason: "one",
      })
    ).toMatchObject({ ok: true })
    const second = tools.revisePlan(turn, {
      changes: [{ op: "reorder", order: ["a", "b"] }],
      reason: "two",
    })
    expect(second).toMatchObject({ ok: true, data: { status: "pending" } })
    expect(second.ok && second.message).toContain("used its 1 plan revisions")
  })
})

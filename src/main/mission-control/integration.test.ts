import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { execFileSync } from "child_process"
import { randomUUID } from "crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs"
import { tmpdir } from "os"
import path from "path"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

// Milestone integration end to end (plan 106.5): real SQLite, real temporary git
// repositories, and a fake agent loop whose builders write files into the
// workspace the Process engine hands them (a user story worktree).

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
  agentName: string | null
}
const loopCalls: LoopCall[] = []
// What each user story's build step writes, by user story key: file → content.
const builds = new Map<string, Record<string, string>>()
// What the integrator writes into the conflicted files.
let resolution: Record<string, string> | null = null
// The wave gate's QA turn (plan 110.02): every batch criterion passes,
// unless a test scripts it.
type GateTurn = (input: {
  processQaChecks?: "author" | "explore" | "verify" | "gate"
  processRunId?: string
  processPhaseRunId?: string
  workspace?: string
}) => Promise<unknown>
const passGate: GateTurn = (input) => recordFakeGate(input)
let gateTurn: GateTurn = passGate

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
    processQaChecks?: "author" | "explore" | "verify" | "gate"
  }) => {
    // QA's checks step (a playbook from before plan 110.04) needs a valid
    // manifest to complete.
    writeFakeManifest(input)
    // The wave gate's QA step (plan 110.02) records the gate.
    await gateTurn(input)
    const msg = input.userMessage ?? ""
    loopCalls.push({
      workspace: input.workspace,
      userMessage: msg,
      agentName: db
        .prepare("SELECT agent_name FROM conversations WHERE id = ?")
        .pluck()
        .get(input.conversationId) as string | null,
    })
    let content = "done"
    if (msg.startsWith("# Review the")) content = '{"approved": true}'
    else if (msg.includes("Build the user story")) {
      const key = /# User story ([a-z0-9-]+):/.exec(msg)?.[1] ?? ""
      for (const [file, text] of Object.entries(builds.get(key) ?? {}))
        writeFileSync(path.join(input.workspace, file), text)
    } else if (msg.includes("Resolve the merge conflict") && resolution) {
      for (const [file, text] of Object.entries(resolution))
        writeFileSync(path.join(input.workspace, file), text)
    }
    if (input.processProofStep) {
      await recordUserStoryProof({
        processRunId: input.processRunId!,
        processPhaseRunId: input.processPhaseRunId!,
        workspace: input.workspace,
        args: proveInApp(input.processPhaseRunId!, {
          verdict: "accepted",
          criteria: [
            { id: "AC-1", status: "met", evidence: "Checked the file." },
          ],
        }),
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
import * as rigs from "../db/repositories/rigs"
import * as features from "../db/repositories/features"
import * as mergeQueue from "../db/repositories/merge-queue"
import * as playbooks from "../db/repositories/playbooks"
import {
  listWorkspaces,
  updateWorkspace,
  upsertWorkspace,
} from "../db/repositories/workspaces"
import { ProcessService } from "../tasks/process/service"
import { UserStoryRunner, recordUserStoryProof } from "./user-story-runner"
import { startConflictResolution, startHookRun } from "./hook-runner"
import * as waveGates from "../db/repositories/wave-gates"
import { MilestoneIntegration } from "./integration"
import { createDefaultPlaybook } from "./playbook-defaults"
import type { AgentDefinition } from "../agent/agents/types"
import { listWorktrees } from "../agent/subagents/worktrees"
import { gateChecks, runQaChecks } from "./qa-checks"
import type { WaveGateReport } from "../db/types"
import {
  proveInApp,
  recordFakeGate,
  writeFakeManifest,
} from "../test/qa-manifest"

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
  const root = mkdtempSync(path.join(tmpdir(), "mc-int-"))
  dirs.push(root)
  git(root, "init", "-b", "main")
  git(root, "config", "user.email", "test@example.com")
  git(root, "config", "user.name", "Test")
  writeFileSync(path.join(root, "README.md"), "base\n")
  writeFileSync(path.join(root, "shared.txt"), "one\ntwo\nthree\n")
  git(root, "add", ".")
  git(root, "commit", "-m", "base")
  return root
}

let service: ProcessService
let runner: UserStoryRunner
let integration: MilestoneIntegration
let worktreeRoot: string
const notices: string[] = []

function setup(options: { resolve?: boolean } = {}) {
  worktreeRoot = mkdtempSync(path.join(tmpdir(), "mc-worktrees-"))
  dirs.push(worktreeRoot)
  service = new ProcessService(fakeRunner)
  integration = new MilestoneIntegration({
    worktreeRoot: () => worktreeRoot,
    startResolution:
      options.resolve === false
        ? undefined
        : (input) => startConflictResolution(runner, input),
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
}

function rig() {
  const created = rigs.createRig({ name: "Team" })
  const lead = rigs.createPod({
    rigId: created.id,
    key: "orchestration",
    name: "Orchestration",
  })
  const pod = rigs.createPod({
    rigId: created.id,
    key: "implementation",
    name: "Implementation",
  })
  rigs.createSeat({
    podId: lead.id,
    key: "lead",
    role: "lead",
    agentRefId: "agentref:v1:lead",
    agentLabel: "lead",
  })
  rigs.createSeat({
    podId: pod.id,
    key: "builder",
    role: "builder",
    agentRefId: "agentref:v1:builder",
    agentLabel: "builder",
  })
  rigs.createSeat({
    podId: pod.id,
    key: "qa",
    role: "qa",
    agentRefId: "agentref:v1:qa",
    agentLabel: "qa",
  })
  rigs.setOversight(created.id, [
    { overseerPodId: lead.id, overseenPodId: pod.id },
  ])
  return created
}

// Most tests here are about the merge queue (106.5), so their milestone
// playbook has no wave acceptance gate and a merge lands the story done.
// `gate: true` keeps the default playbook's gate (plan 110).
function featureIn(
  workspace: string,
  keys: string[],
  options: { gate?: boolean } = {}
) {
  const graph = features.createFeature({
    key: "billing",
    name: "Billing",
    intent: "Invoices.",
    definitionOfDone: "Done.",
    rigId: rig().id,
    workspaceId: upsertWorkspace(workspace).id,
  })
  const milestone = graph.milestones[0]
  if (!options.gate) {
    const playbook = createDefaultPlaybook("milestone")
    playbooks.removeHook(playbook.id, "after_each_wave")
    features.updateMilestone(milestone.id, { playbookId: playbook.id })
  }
  for (const key of keys)
    features.createUserStory({
      milestoneId: milestone.id,
      key,
      title: key,
      spec: { goal: key, acceptance: ["The file exists"] },
    })
  features.startFeature(graph.feature.id)
  const userStories = features.listUserStories(milestone.id)
  return {
    feature: features.getFeature(graph.feature.id)!,
    milestone,
    userStory: (key: string) => userStories.find((s) => s.key === key)!,
  }
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

// Drive every Mission Control run that is still running (resolution hooks
// appear only after a conflict), then wait for the merge queue.
async function settleAll() {
  for (let round = 0; round < 5; round++) {
    await integration.idle()
    const running = playbooks
      .listPlaybookRuns({ status: "running" })
      .filter((r) => r.processRunId)
    if (!running.length) break
    for (const run of running) await drive(run.processRunId!)
  }
  await integration.idle()
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  runMigrations(db)
  loopCalls.length = 0
  builds.clear()
  resolution = null
  gateTurn = passGate
  notices.length = 0
})

afterEach(() => {
  integration?.stop()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!sqliteLoads)("milestone integration", () => {
  it("lands a merge as merged with the wave gate, and the gate makes it done", async () => {
    setup()
    const root = repo()
    const { feature, milestone, userStory } = featureIn(
      root,
      ["api", "pdf", "ui"],
      { gate: true }
    )
    features.setUserStoryEdges(milestone.id, [
      {
        fromUserStoryId: userStory("api").id,
        toUserStoryId: userStory("ui").id,
      },
      {
        fromUserStoryId: userStory("pdf").id,
        toUserStoryId: userStory("ui").id,
      },
    ])
    builds.set("api", { "api.txt": "api\n" })
    builds.set("pdf", { "pdf.txt": "pdf\n" })
    const api = await runner.startUserStory(userStory("api").id)
    await drive(api.processRunId!)
    await integration.idle()
    expect(features.getUserStory(userStory("api").id)!.status).toBe("merged")
    // Its worktree is gone like any merged story's.
    expect(existsSync(api.worktreePath!)).toBe(false)
    // pdf is still running: no gate yet, and the dependent waits on both.
    const pdf = await runner.startUserStory(userStory("pdf").id)
    await expect(
      startHookRun(runner, {
        featureId: feature.id,
        milestoneId: milestone.id,
        hook: "after_each_wave",
      })
    ).rejects.toThrow(/Wait for pdf \(running\)/)
    await drive(pdf.processRunId!)
    await integration.idle()
    await expect(runner.startUserStory(userStory("ui").id)).rejects.toThrow(
      /awaiting their acceptance gate: (api, pdf|pdf, api)\./
    )
    expect(features.getMilestone(milestone.id)!.status).toBe("active")

    const run = await startHookRun(runner, {
      featureId: feature.id,
      milestoneId: milestone.id,
      hook: "after_each_wave",
    })
    // The gate runs in its own worktree at the integration head.
    expect(run).toMatchObject({ hook: "after_each_wave", status: "running" })
    expect(existsSync(run.worktreePath!)).toBe(true)
    await drive(run.processRunId!)
    await integration.idle()
    expect(playbooks.getPlaybookRun(run.id)!.status).toBe("completed")
    expect(existsSync(run.worktreePath!)).toBe(false)
    const [gate] = waveGates.listWaveGates(milestone.id)
    expect(gate).toMatchObject({
      round: 1,
      status: "passed",
      playbookRunId: run.id,
    })
    expect(gate.storyIds.sort()).toEqual(
      [userStory("api").id, userStory("pdf").id].sort()
    )
    expect(features.getUserStory(userStory("api").id)!.status).toBe("done")
    expect(features.getUserStory(userStory("pdf").id)!.status).toBe("done")
    // Nothing is merged now, so there is no gate to run.
    await expect(
      startHookRun(runner, {
        featureId: feature.id,
        milestoneId: milestone.id,
        hook: "after_each_wave",
      })
    ).rejects.toThrow(/No user story in milestone-1 is merged/)

    // The dependent starts once both are done; after it, the second gate's
    // batch is only ui, and passing it brings the milestone to review.
    const ui = await runner.startUserStory(userStory("ui").id)
    await drive(ui.processRunId!)
    await integration.idle()
    expect(features.getUserStory(userStory("ui").id)!.status).toBe("merged")
    expect(features.getMilestone(milestone.id)!.status).toBe("integrating")
    const secondRun = await startHookRun(runner, {
      featureId: feature.id,
      milestoneId: milestone.id,
      hook: "after_each_wave",
    })
    await drive(secondRun.processRunId!)
    await integration.idle()
    const second = waveGates.listWaveGates(milestone.id)[1]
    expect(second).toMatchObject({
      round: 2,
      status: "passed",
      storyIds: [userStory("ui").id],
    })
    integration.advanceMilestone(milestone.id)
    expect(features.getMilestone(milestone.id)!.status).toBe("review")
  })

  it("settles merged stories when the playbook drops its gate", async () => {
    setup()
    const root = repo()
    const { feature, milestone, userStory } = featureIn(root, ["a"], {
      gate: true,
    })
    builds.set("a", { "a.txt": "a\n" })
    const a = await runner.startUserStory(userStory("a").id)
    await drive(a.processRunId!)
    await integration.idle()
    expect(features.getUserStory(userStory("a").id)!.status).toBe("merged")
    const playbook = playbooks
      .listPlaybooks()
      .find((p) => p.altitude === "milestone")!
    playbooks.removeHook(playbook.id, "after_each_wave")
    await startHookRun(runner, {
      featureId: feature.id,
      milestoneId: milestone.id,
      hook: "after_each_wave",
    })
    expect(features.getUserStory(userStory("a").id)!.status).toBe("done")
    expect(waveGates.listWaveGates(milestone.id)[0].report).toMatchObject({
      reason: "The milestone playbook has no gate hook.",
    })
  })

  // A gate QA turn that rewrites each batch story's manifest with one
  // automated command check per criterion, runs the whole suite, writes a
  // stray product file (never committed), and records `outcomes`.
  function scriptedGate(
    command: string,
    outcomes: Record<string, Record<string, unknown>> = {}
  ): GateTurn {
    return async (input) => {
      if (input.processQaChecks !== "gate") return
      const run = processes.getProcessRun(input.processRunId!)!
      const gate = gateChecks(run.missionControl!)!
      for (const story of gate.stories.values()) {
        if (!story.batch) continue
        const file = path.join(
          input.workspace!,
          "e2e",
          "stories",
          `${story.storyRef}.json`
        )
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(
          file,
          JSON.stringify({
            criteria: Object.fromEntries(
              story.criteria.map((c) => [
                c.id,
                [
                  {
                    id: `${story.userStory.key}-${c.id.toLowerCase()}`,
                    kind: "automated",
                    command,
                    cwd: "",
                    timeoutMs: 30000,
                  },
                ],
              ])
            ),
          })
        )
      }
      writeFileSync(path.join(input.workspace!, "stray.txt"), "qa\n")
      const ran = await runQaChecks({
        processRunId: input.processRunId!,
        phaseRunId: input.processPhaseRunId!,
        workspace: input.workspace!,
      })
      expect(ran.ok).toBe(true)
      return recordFakeGate(input, outcomes)
    }
  }

  async function mergedStory(key: string) {
    setup()
    const root = repo()
    const made = featureIn(root, [key], { gate: true })
    builds.set(key, { [`${key}.txt`]: `${key}\n` })
    const run = await runner.startUserStory(made.userStory(key).id)
    await drive(run.processRunId!)
    await integration.idle()
    expect(features.getUserStory(made.userStory(key).id)!.status).toBe("merged")
    return { root, ...made }
  }

  async function runGate(featureId: string, milestoneId: string) {
    const run = await startHookRun(runner, {
      featureId,
      milestoneId,
      hook: "after_each_wave",
    })
    await drive(run.processRunId!)
    await integration.idle()
    return playbooks.getPlaybookRun(run.id)!
  }

  it("commits the gate's suite to the integration branch and passes the batch", async () => {
    const { root, feature, milestone, userStory } = await mergedStory("a")
    gateTurn = scriptedGate('node -e "process.exit(0)"')
    const run = await runGate(feature.id, milestone.id)
    expect(run.status).toBe("completed")
    const [gate] = waveGates.listWaveGates(milestone.id)
    expect(gate.status).toBe("passed")
    expect(features.getUserStory(userStory("a").id)!.status).toBe("done")
    const report = gate.report as WaveGateReport
    expect(report).toMatchObject({
      outcome: "passed",
      suite: { checks: 1, passed: 1 },
      stories: [
        {
          key: "a",
          batch: true,
          criteria: [
            {
              id: "AC-1",
              outcome: "passed",
              checks: [{ checkId: "a-ac-1", status: "passed", attempts: 1 }],
            },
          ],
        },
      ],
    })
    // The suite is on the integration branch; QA's stray file is not.
    const branch = features.getMilestone(milestone.id)!.integrationBranch!
    expect(gate.checksCommit).toBe(git(root, "rev-parse", branch))
    expect(git(root, "log", "-1", "--format=%B", branch)).toContain(
      `Mission-Control-Gate: ${gate.id}`
    )
    const files = git(root, "show", "--name-only", "--format=", branch)
    expect(files).toBe("e2e/stories/billing.milestone-1.a.json")
    expect(
      git(root, "show", `${branch}:e2e/stories/billing.milestone-1.a.json`)
    ).toContain("a-ac-1")
  })

  it("fails the gate on an app bug, keeps the story merged, and still commits the suite", async () => {
    const { root, feature, milestone, userStory } = await mergedStory("a")
    features.setFeatureStatus(feature.id, "paused", "test")
    features.setDriveMode(feature.id, "copilot")
    features.setFeatureStatus(feature.id, "active", "test")
    gateTurn = scriptedGate('node -e "process.exit(1)"', {
      "a AC-1": {
        outcome: "app_bug",
        problem: "The file is missing its heading.",
        artifacts: undefined,
      },
    })
    const run = await runGate(feature.id, milestone.id)
    // QA's step did its job; the gate failed and its app bug became a fix
    // story (plan 110.03).
    expect(run.status).toBe("completed")
    expect(run.outcomeReason).toMatch(/round 1 failed: a didn't pass/)
    const [gate] = waveGates.listWaveGates(milestone.id)
    expect(gate.status).toBe("fixing")
    const fix = features
      .listUserStories(milestone.id)
      .find((s) => s.origin === "gate")!
    expect(fix).toMatchObject({
      key: "fix-a-ac1",
      status: "draft",
      gateId: gate.id,
      fixes: {
        userStoryId: userStory("a").id,
        criterionId: "AC-1",
        criterion: "The file exists",
      },
    })
    expect(fix.spec.acceptance[0]).toBe("The file exists")
    expect(fix.spec.acceptance[1]).toContain("`a-ac-1`")
    expect(fix.spec.notes).toContain("e2e/stories/billing.milestone-1.a.json")
    // The milestone is back to work: the fix story is the next wave.
    expect(features.getMilestone(milestone.id)!.status).toBe("active")
    expect(gate.report).toMatchObject({
      outcome: "failed",
      stories: [
        {
          key: "a",
          criteria: [
            {
              outcome: "app_bug",
              problem: "The file is missing its heading.",
              checks: [{ checkId: "a-ac-1", status: "failed", attempts: 2 }],
            },
          ],
        },
      ],
    })
    expect(features.getUserStory(userStory("a").id)!.status).toBe("merged")
    const branch = features.getMilestone(milestone.id)!.integrationBranch!
    expect(gate.checksCommit).toBe(git(root, "rev-parse", branch))
  })

  it("refuses a record that calls a failing check passed", async () => {
    const { feature, milestone } = await mergedStory("a")
    let refused: unknown = null
    const record = scriptedGate('node -e "process.exit(1)"', {
      "a AC-1": { artifacts: undefined },
    })
    gateTurn = async (input) => {
      refused = await record(input)
    }
    const run = await runGate(feature.id, milestone.id)
    expect(refused).toMatchObject({
      ok: false,
      code: "gate_rejected_by_rules",
      message: expect.stringContaining("a-ac-1 failed on the current suite"),
    })
    // Nothing recorded: the gate fails, and says why.
    expect(run.status).toBe("failed")
    expect(waveGates.listWaveGates(milestone.id)[0]).toMatchObject({
      status: "failed",
      report: { reason: expect.stringMatching(/without recording a result/) },
    })
  })

  it("fails the gate when its run ends without a result, keeping the batch merged", async () => {
    setup()
    const root = repo()
    const { feature, milestone, userStory } = featureIn(root, ["a"], {
      gate: true,
    })
    builds.set("a", { "a.txt": "a\n" })
    const a = await runner.startUserStory(userStory("a").id)
    await drive(a.processRunId!)
    await integration.idle()
    // A gate run interrupted before it recorded a result (110.02 runs steps).
    const run = playbooks.createPlaybookRun({
      playbookId: null,
      hook: "after_each_wave",
      featureId: feature.id,
      milestoneId: milestone.id,
    })
    const gate = waveGates.createWaveGate({
      milestoneId: milestone.id,
      storyIds: [userStory("a").id],
      playbookRunId: run.id,
    })
    runner.reconcile()
    expect(waveGates.getWaveGate(gate.id)!.status).toBe("failed")
    expect(features.getUserStory(userStory("a").id)!.status).toBe("merged")
    // Re-running it opens the next round.
    const rerun = await startHookRun(runner, {
      featureId: feature.id,
      milestoneId: milestone.id,
      hook: "after_each_wave",
    })
    await drive(rerun.processRunId!)
    await integration.idle()
    expect(waveGates.listWaveGates(milestone.id).map((g) => g.status)).toEqual([
      "failed",
      "passed",
    ])
    expect(features.getUserStory(userStory("a").id)!.status).toBe("done")
  })

  it("runs independent user stories in parallel worktrees, merges them in order, and starts the dependent user story on both", async () => {
    setup()
    const root = repo()
    const userHead = git(root, "rev-parse", "HEAD")
    const { milestone, userStory } = featureIn(root, [
      "invoice-api",
      "invoice-pdf",
      "invoice-ui",
    ])
    features.setUserStoryEdges(milestone.id, [
      {
        fromUserStoryId: userStory("invoice-api").id,
        toUserStoryId: userStory("invoice-ui").id,
      },
      {
        fromUserStoryId: userStory("invoice-pdf").id,
        toUserStoryId: userStory("invoice-ui").id,
      },
    ])
    builds.set("invoice-api", { "api.txt": "api\n" })
    builds.set("invoice-pdf", { "pdf.txt": "pdf\n" })
    builds.set("invoice-ui", { "ui.txt": "ui\n" })

    // Both start before either runs: two isolated runs at once.
    const api = await runner.startUserStory(userStory("invoice-api").id)
    const pdf = await runner.startUserStory(userStory("invoice-pdf").id)
    expect(api.worktreePath).not.toBe(pdf.worktreePath)
    const started = features.getMilestone(milestone.id)!
    expect(started).toMatchObject({
      integrationBranch: "mc/billing/milestone-1/integration",
      baseRef: "main",
      baseOid: userHead,
    })
    // The dependent user story waits for merges, not just proofs.
    await expect(
      runner.startUserStory(userStory("invoice-ui").id)
    ).rejects.toThrow(/unmerged user stories/)
    // Worktrees are never registered as workspaces: each run belongs to the
    // feature's workspace and works in its own worktree.
    expect(listWorkspaces().map((w) => w.path)).toEqual([root])
    expect(db.prepare("SELECT path FROM workspaces").pluck().all()).toEqual([
      root,
    ])
    const workspaceId = upsertWorkspace(root).id
    for (const run of [api, pdf]) {
      const processRun = processes.getProcessRun(run.processRunId!)!
      expect(processRun.workspaceId).toBe(workspaceId)
      expect(processRun.workingDirectory).toBe(run.worktreePath)
    }
    expect(integration.info(userStory("invoice-api").id).workspacePath).toBe(
      api.worktreePath
    )

    // Drive the second one first: merge order is dependency level, then the
    // time each proof was accepted.
    await drive(pdf.processRunId!)
    await drive(api.processRunId!)
    await integration.idle()
    // Every worker ran in its worktree, in a conversation that says so.
    const workers = db
      .prepare(
        "SELECT workspace_id, working_directory FROM conversations WHERE working_directory IS NOT NULL"
      )
      .all() as Array<{ workspace_id: string; working_directory: string }>
    expect(workers.length).toBeGreaterThan(0)
    for (const worker of workers) {
      expect(worker.workspace_id).toBe(workspaceId)
      expect([api.worktreePath, pdf.worktreePath]).toContain(
        worker.working_directory
      )
    }
    // Every worker of each user story ran in that user story's own worktree.
    const workspaces = new Set(loopCalls.map((c) => c.workspace))
    expect([...workspaces].sort()).toEqual(
      [api.worktreePath, pdf.worktreePath].sort()
    )
    expect(features.getUserStory(userStory("invoice-api").id)!.status).toBe(
      "done"
    )
    expect(features.getUserStory(userStory("invoice-pdf").id)!.status).toBe(
      "done"
    )
    const subjects = git(
      root,
      "log",
      "--first-parent",
      "--format=%s",
      started.integrationBranch!
    )
      .split("\n")
      .slice(0, 2)
    expect(subjects).toEqual([
      "user story invoice-api: invoice-api",
      "user story invoice-pdf: invoice-pdf",
    ])
    // Merged worktrees are removed.
    expect(existsSync(api.worktreePath!)).toBe(false)
    expect(existsSync(pdf.worktreePath!)).toBe(false)

    const ui = await runner.startUserStory(userStory("invoice-ui").id)
    const uiUserStory = features.getUserStory(userStory("invoice-ui").id)!
    expect(existsSync(path.join(ui.worktreePath!, "api.txt"))).toBe(true)
    expect(existsSync(path.join(ui.worktreePath!, "pdf.txt"))).toBe(true)
    expect(uiUserStory.baseOid).toBe(
      git(root, "rev-parse", started.integrationBranch!)
    )
    await drive(ui.processRunId!)
    await integration.idle()
    expect(features.getMilestone(milestone.id)!.status).toBe("review")

    // The merge commit carries the proof and the trailers.
    const body = git(
      root,
      "log",
      "-1",
      "--format=%B",
      started.integrationBranch!
    )
    expect(body).toContain(`Mission-Control-User-Story: ${uiUserStory.id}`)
    expect(body).toContain(`Mission-Control-Proof: ${ui.id}`)
    expect(body).toContain("AC-1 met")

    // The user's checkout and base branch were never touched.
    expect(git(root, "rev-parse", "main")).toBe(userHead)
    expect(git(root, "status", "--porcelain")).toBe("")
    expect(git(root, "branch", "--show-current")).toBe("main")
  })

  it("hands a conflict to the integrator (falling back to the lead), re-verifies, and merges", async () => {
    setup()
    const root = repo()
    const { milestone, userStory } = featureIn(root, ["a", "b"])
    builds.set("a", { "shared.txt": "one\nTWO from a\nthree\n" })
    builds.set("b", { "shared.txt": "one\nTWO from b\nthree\n" })
    resolution = { "shared.txt": "one\nTWO from a and b\nthree\n" }
    const a = await runner.startUserStory(userStory("a").id)
    const b = await runner.startUserStory(userStory("b").id)
    await drive(a.processRunId!)
    await drive(b.processRunId!)
    await integration.idle()

    const entry = mergeQueue.listMergeEntries({
      userStoryId: userStory("b").id,
    })[0]
    expect(entry).toMatchObject({
      status: "resolving",
      conflictFiles: ["shared.txt"],
    })
    expect(features.getUserStory(userStory("b").id)!.status).toBe("integrating")
    const resolutionRun = playbooks.getPlaybookRun(entry.resolutionRunId!)!
    expect(resolutionRun).toMatchObject({
      hook: "after_each_user_story",
      userStoryId: userStory("b").id,
    })

    await settleAll()
    const integrator = loopCalls.find((c) =>
      c.userMessage.includes("Resolve the merge conflict")
    )!
    // No integrator seat in this rig: the lead stands in.
    expect(integrator.agentName).toBe("agentref:v1:lead")
    expect(integrator.userMessage).toContain("shared.txt")
    expect(mergeQueue.getMergeEntry(entry.id)!.status).toBe("merged")
    expect(features.getUserStory(userStory("b").id)!.status).toBe("done")
    const integrationBranch = features.getMilestone(
      milestone.id
    )!.integrationBranch!
    expect(git(root, "show", `${integrationBranch}:shared.txt`)).toContain(
      "a and b"
    )
    expect(git(root, "log", "-1", "--format=%B", integrationBranch)).toContain(
      "Mission-Control-Resolved-By:"
    )
    expect(git(root, "status", "--porcelain")).toBe("")
    expect((await listWorktrees(root)).length).toBe(1)
  })

  it("escalates a conflict with no way to resolve it and leaves the repository clean", async () => {
    setup({ resolve: false })
    const root = repo()
    const { milestone, userStory } = featureIn(root, ["a", "b"])
    builds.set("a", { "shared.txt": "a\n" })
    builds.set("b", { "shared.txt": "b\n" })
    const a = await runner.startUserStory(userStory("a").id)
    const b = await runner.startUserStory(userStory("b").id)
    await drive(a.processRunId!)
    await drive(b.processRunId!)
    await integration.idle()

    const entry = mergeQueue.listMergeEntries({
      userStoryId: userStory("b").id,
    })[0]
    expect(entry).toMatchObject({ status: "conflict", escalated: true })
    expect(notices.join("\n")).toMatch(/user story b needs you/)
    expect(git(root, "status", "--porcelain")).toBe("")
    expect(features.getMilestone(milestone.id)!.status).toBe("integrating")

    // Abandoning fails the user story (its branch kept) and reopens the milestone.
    await integration.abandon(entry.id)
    const failed = features.getUserStory(userStory("b").id)!
    expect(failed.status).toBe("failed")
    expect(git(root, "branch", "--list", failed.branch!)).toContain(
      failed.branch!
    )
    expect(features.getMilestone(milestone.id)!.status).toBe("active")
    // A retry starts from the integration head, which now has user story a.
    builds.set("b", { "b.txt": "b\n" })
    const retry = await runner.startUserStory(userStory("b").id)
    expect(
      readFileSync(path.join(retry.worktreePath!, "shared.txt"), "utf8")
    ).toBe("a\n")
  })

  it("regenerates conflicting generated files in the queue, without the integrator", async () => {
    setup({ resolve: false })
    const root = repo()
    const { feature, userStory } = featureIn(root, ["a", "b"])
    updateWorkspace(feature.workspaceId!, {
      generatedFiles: [
        {
          paths: ["*.generated"],
          command: "echo rebuilt > out.generated",
        },
      ],
    })
    builds.set("a", { "a.txt": "a\n", "out.generated": "a\n" })
    builds.set("b", { "b.txt": "b\n", "out.generated": "b\n" })
    const a = await runner.startUserStory(userStory("a").id)
    const b = await runner.startUserStory(userStory("b").id)
    await drive(a.processRunId!)
    await drive(b.processRunId!)
    await integration.idle()

    const entry = mergeQueue.listMergeEntries({
      userStoryId: userStory("b").id,
    })[0]
    expect(entry).toMatchObject({ status: "merged", resolutionAttempts: 0 })
    expect(entry.note).toContain(
      "regenerating 1 conflicting generated file(s): out.generated"
    )
  })

  it("keeps why regeneration failed in the user story's history", async () => {
    setup({ resolve: false })
    const root = repo()
    const { feature, userStory } = featureIn(root, ["a", "b"])
    updateWorkspace(feature.workspaceId!, {
      generatedFiles: [{ paths: ["*.generated"], command: "exit 2" }],
    })
    builds.set("a", { "out.generated": "a\n" })
    builds.set("b", { "out.generated": "b\n" })
    const a = await runner.startUserStory(userStory("a").id)
    const b = await runner.startUserStory(userStory("b").id)
    await drive(a.processRunId!)
    await drive(b.processRunId!)
    await integration.idle()

    const history = features
      .listRevisions(feature.id)
      .filter((r) => r.targetId === userStory("b").id)
      .map((r) => r.reason ?? "")
    expect(
      history.some((reason) =>
        /regenerating them failed \(`exit 2` failed/.test(reason)
      )
    ).toBe(true)
  })

  it("escalates when the milestone playbook has no after-each-user-story hook", async () => {
    setup()
    const root = repo()
    const { milestone, userStory } = featureIn(root, ["a", "b"])
    const playbook = createDefaultPlaybook("milestone")
    playbooks.removeHook(playbook.id, "after_each_user_story")
    features.updateMilestone(milestone.id, { playbookId: playbook.id })
    builds.set("a", { "shared.txt": "a\n" })
    builds.set("b", { "shared.txt": "b\n" })
    const a = await runner.startUserStory(userStory("a").id)
    const b = await runner.startUserStory(userStory("b").id)
    await drive(a.processRunId!)
    await drive(b.processRunId!)
    await integration.idle()
    const entry = mergeQueue.listMergeEntries({
      userStoryId: userStory("b").id,
    })[0]
    expect(entry).toMatchObject({ status: "conflict", escalated: true })
    expect(entry.note).toMatch(/no after each user story hook/)
    expect((await listWorktrees(root)).length).toBe(2)
  })

  it("finishes the bookkeeping for a merge interrupted after the branch moved", async () => {
    setup()
    const root = repo()
    const { milestone, userStory } = featureIn(root, ["a", "b"])
    builds.set("a", { "a.txt": "a\n" })
    builds.set("b", { "b.txt": "b\n" })
    const a = await runner.startUserStory(userStory("a").id)
    const b = await runner.startUserStory(userStory("b").id)
    // Settle both runs without letting the queue drain yet.
    integration.stop()
    await drive(a.processRunId!)
    await drive(b.processRunId!)
    const entryA = mergeQueue.listMergeEntries({
      userStoryId: userStory("a").id,
    })[0]
    const entryB = mergeQueue.listMergeEntries({
      userStoryId: userStory("b").id,
    })[0]
    expect([entryA.status, entryB.status]).toEqual(["queued", "queued"])

    // Simulate a crash mid-merge for a: its merge landed on the integration
    // branch, but the row still says merging. b crashed before merging.
    const mc = features.getMilestone(milestone.id)!
    const userStoryA = features.getUserStory(userStory("a").id)!
    git(userStoryA.worktreePath!, "add", "-A")
    git(userStoryA.worktreePath!, "commit", "-m", "a work")
    const headA = git(root, "rev-parse", userStoryA.branch!)
    const scratch = path.join(worktreeRoot, "crash-merge")
    git(root, "worktree", "add", "--detach", scratch, mc.integrationBranch!)
    git(
      scratch,
      "merge",
      "--no-ff",
      "-m",
      `user story a\n\nMission-Control-User-Story: ${userStoryA.id}`,
      headA
    )
    git(
      root,
      "update-ref",
      `refs/heads/${mc.integrationBranch}`,
      git(scratch, "rev-parse", "HEAD")
    )
    mergeQueue.updateMergeEntry(entryA.id, {
      status: "merging",
      userStoryHead: headA,
    })
    mergeQueue.updateMergeEntry(entryB.id, {
      status: "merging",
      userStoryHead: null,
    })

    // Restart: a fresh service sweeps the stray worktree and resumes.
    setupRestart()
    await integration.reconcile()
    await integration.idle()
    expect(existsSync(scratch)).toBe(false)
    expect(mergeQueue.getMergeEntry(entryA.id)).toMatchObject({
      status: "merged",
      mergeCommit: git(
        root,
        "log",
        "-1",
        "--format=%H",
        "--grep",
        userStoryA.id,
        mc.integrationBranch!
      ),
    })
    expect(mergeQueue.getMergeEntry(entryB.id)!.status).toBe("merged")
    expect(features.getMilestone(milestone.id)!.status).toBe("review")
    // Each user story merged exactly once.
    expect(
      git(root, "log", "--merges", "--format=%s", mc.integrationBranch!).split(
        "\n"
      )
    ).toHaveLength(2)
  })

  it("lands a local-merge milestone only with an approval for what the user reviewed", async () => {
    setup()
    const root = repo()
    const { milestone, userStory } = featureIn(root, ["a"])
    features.setMilestoneMergePolicy(milestone.id, "local_merge")
    builds.set("a", { "a.txt": "a\n" })
    const a = await runner.startUserStory(userStory("a").id)
    // Locked once started, except back to manual.
    expect(() =>
      features.setMilestoneMergePolicy(milestone.id, "open_pr")
    ).toThrow(/locked/)
    await drive(a.processRunId!)
    await integration.idle()

    const status = await integration.status(milestone.id)
    expect(status).toMatchObject({
      policy: "local_merge",
      workspace: { mode: "git" },
      summary: { fastForward: true, merged: false },
    })
    expect(status.queue.map((e) => e.status)).toEqual(["merged"])
    expect(git(root, "rev-parse", "main")).toBe(status.baseOid)
    await expect(
      integration.land(milestone.id, {
        baseOid: status.summary!.baseOid!,
        headOid: "stale",
      })
    ).rejects.toThrow(/moved since you reviewed/)
    const landing = await integration.land(milestone.id, {
      baseOid: status.summary!.baseOid!,
      headOid: status.summary!.headOid!,
    })
    expect(landing).toMatchObject({
      mode: "local_merge",
      fastForward: true,
      completedBy: "user",
    })
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a\n")
    const done = features.getMilestone(milestone.id)!
    expect(done.status).toBe("completed")
    // User story and integration branches are cleaned up once reachable from main.
    expect(git(root, "branch", "--list", "mc/*")).toBe("")
  })

  it("reaches review when the last unfinished user story is deleted", async () => {
    setup()
    const root = repo()
    const { milestone, userStory } = featureIn(root, ["a", "b"])
    builds.set("a", { "a.txt": "a\n" })
    const a = await runner.startUserStory(userStory("a").id)
    await drive(a.processRunId!)
    await integration.idle()
    expect(features.getMilestone(milestone.id)!.status).toBe("active")
    features.deleteUserStory(userStory("b").id)
    // Nothing merged since; the status read catches up, and stays quiet after.
    const changes: string[] = []
    const quiet = new MilestoneIntegration({
      worktreeRoot: () => worktreeRoot,
      onChanged: (id) => changes.push(id),
    })
    await quiet.status(milestone.id)
    expect(features.getMilestone(milestone.id)!.status).toBe("review")
    await quiet.status(milestone.id)
    expect(changes).toHaveLength(1)
  })

  it("detects a manual merge and completes the milestone", async () => {
    setup()
    const root = repo()
    const { milestone, userStory } = featureIn(root, ["a"])
    builds.set("a", { "a.txt": "a\n" })
    const a = await runner.startUserStory(userStory("a").id)
    await drive(a.processRunId!)
    await integration.idle()
    git(
      root,
      "merge",
      "--no-ff",
      "-m",
      "my merge",
      "mc/billing/milestone-1/integration"
    )
    const status = await integration.status(milestone.id)
    expect(status.landing).toMatchObject({
      completedBy: "detected",
      mode: "manual",
    })
    expect(features.getMilestone(milestone.id)!.status).toBe("completed")
  })

  it("serializes user stories with overlapping touch hints unless told otherwise", async () => {
    setup()
    const root = repo()
    const { userStory } = featureIn(root, ["a", "b"])
    features.updateUserStory(userStory("a").id, {
      spec: { ...userStory("a").spec, touchHints: ["src/billing/**"] },
    })
    features.updateUserStory(userStory("b").id, {
      spec: { ...userStory("b").spec, touchHints: ["src/billing/invoice.ts"] },
    })
    await runner.startUserStory(userStory("a").id)
    await expect(runner.startUserStory(userStory("b").id)).rejects.toThrow(
      /touch_overlap/
    )
    await expect(
      runner.startUserStory(userStory("b").id, { allowTouchOverlap: true })
    ).resolves.toMatchObject({ status: "running" })
  })

  it("runs overlapping user stories together under the feature's parallel policy", async () => {
    setup()
    const root = repo()
    const { feature, userStory } = featureIn(root, ["a", "b"])
    features.updateUserStory(userStory("a").id, {
      spec: { ...userStory("a").spec, touchHints: ["src/billing/**"] },
    })
    features.updateUserStory(userStory("b").id, {
      spec: { ...userStory("b").spec, touchHints: ["src/billing/invoice.ts"] },
    })
    features.setFeatureDrive(feature.id, { overlapPolicy: "parallel" })
    await runner.startUserStory(userStory("a").id)
    await expect(
      runner.startUserStory(userStory("b").id)
    ).resolves.toMatchObject({
      status: "running",
    })
  })

  it("caps concurrent user stories at the feature budget", async () => {
    setup()
    const root = repo()
    const { feature, userStory } = featureIn(root, ["a", "b"])
    db.prepare("UPDATE features SET budgets = ? WHERE id = ?").run(
      JSON.stringify({ maxConcurrentUserStories: 1 }),
      feature.id
    )
    await runner.startUserStory(userStory("a").id)
    await expect(runner.startUserStory(userStory("b").id)).rejects.toThrow(
      /1 running user stories at once/
    )
    // The refused attempt left no worktree behind.
    expect((await listWorktrees(root)).length).toBe(2)
  })

  it("keeps single-flight behavior with an explanation outside git", async () => {
    setup()
    const folder = mkdtempSync(path.join(tmpdir(), "mc-plain-"))
    dirs.push(folder)
    const { milestone, userStory } = featureIn(folder, ["a", "b"])
    const a = await runner.startUserStory(userStory("a").id)
    expect(a.worktreePath).toBeNull()
    await expect(runner.startUserStory(userStory("b").id)).rejects.toThrow(
      /one playbook run can use this workspace at a time.*git workspace/
    )
    const status = await integration.status(milestone.id)
    expect(status.workspace).toMatchObject({
      mode: "single_flight",
      reason: expect.stringContaining("isn't a git repository"),
    })
    expect(status.policies.local_merge.available).toBe(false)
    await drive(a.processRunId!)
    expect(features.getUserStory(userStory("a").id)!.status).toBe("done")
  })

  it("removes worktrees and merged mc branches when the feature is deleted", async () => {
    setup()
    const root = repo()
    const { feature, userStory } = featureIn(root, ["a", "b"])
    builds.set("a", { "a.txt": "a\n" })
    const a = await runner.startUserStory(userStory("a").id)
    await drive(a.processRunId!)
    await integration.idle()
    const b = await runner.startUserStory(userStory("b").id)
    runner.cancelPlaybookRun(b.id)
    const { keptBranches } = await integration.cleanupFeature(feature.id)
    // The integration branch holds merged work that never reached main.
    expect(keptBranches).toEqual(["mc/billing/milestone-1/integration"])
    expect(
      git(root, "branch", "--list", "mc/billing/milestone-1/userStories/*")
    ).toBe("")
    expect((await listWorktrees(root)).length).toBe(1)
    expect(existsSync(path.join(worktreeRoot, feature.id))).toBe(false)
  })
})

// A second service over the same database and worktree root, as after a
// restart.
function setupRestart() {
  const root = worktreeRoot
  integration.stop()
  integration = new MilestoneIntegration({
    worktreeRoot: () => root,
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
}

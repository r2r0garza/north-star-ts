import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
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
import { runMigrations } from "../../db/migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

// The live scenario driver (plan 112.2) on a fake provider: the real user
// story runner, Process service, and Navigator on Autopilot, with the model
// replaced by a scripted one that follows the playbook (build, then QA
// records a proof for every criterion). The driver must read a complete
// scorecard record back from the database and clean up after itself.

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../../db/connection", () => ({ getDb: () => db }))
vi.mock("../../conversations/lifecycle", () => ({
  cleanupConversationArtifacts: async () => {},
}))
const { SHUTDOWN_ABORT_REASON, PAUSE_ABORT_REASON } = vi.hoisted(() => ({
  SHUTDOWN_ABORT_REASON: Symbol("agent:shutdown"),
  PAUSE_ABORT_REASON: Symbol("task:pause"),
}))
vi.mock("../../agent/abort", () => ({
  SHUTDOWN_ABORT_REASON,
  PAUSE_ABORT_REASON,
}))

// The scripted model. `hang` makes every worker wait until it's stopped;
// `duringBuild` runs once per story at its first non-proof step (a seat or
// the user changing the plan mid-run); QA rejects the stories in `reject`.
let hang = false
let duringBuild: ((story: UserStory, featureId: string) => void) | null = null
const built = new Set<string>()
const reject = new Set<string>()
// The seats that took a turn on a story, and whether QA edits the delivered
// code before recording its proof (standing in for a builder's fix).
const storyTurns: string[] = []
let editDelivered = false
const usageLog = { current: null as null | ContextUsageLog }
vi.mock("../../agent", () => ({
  SHUTDOWN_ABORT_REASON,
  generateTitle: async () => "Title",
  runAgentLoop: async (input: {
    conversationId: string
    userMessage?: string
    processProofStep?: boolean
    processRunId?: string
    processPhaseRunId?: string
    missionControlSeat?: { address: string; profile: string }
    abort?: AbortController
    workspace?: string
  }) => {
    const run = input.processRunId
      ? processes.getProcessRun(input.processRunId)
      : null
    const featureId = run?.missionControl?.featureId
    // One logged round per turn, as the real loop does.
    if (featureId && input.missionControlSeat)
      await usageLog.current!.append(usageEntry(featureId, input))
    if (hang && input.abort) {
      const signal = input.abort.signal
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true })
      )
      return { stopped: true }
    }
    let content = "done"
    if (input.userMessage?.startsWith("# Review the"))
      content = '{"approved": true}'
    const storyId = run?.missionControl?.userStoryId
    if (storyId && input.missionControlSeat)
      storyTurns.push(input.missionControlSeat.address)
    if (editDelivered && input.processProofStep && input.workspace)
      writeFileSync(
        path.join(input.workspace, "calc.js"),
        "module.exports = { bill: () => ({}) }\n"
      )
    if (
      storyId &&
      featureId &&
      !input.processProofStep &&
      duringBuild &&
      !built.has(storyId)
    ) {
      built.add(storyId)
      duringBuild(features.getUserStory(storyId)!, featureId)
    }
    if (input.processProofStep && storyId) {
      const story = features.getUserStory(storyId)!
      const rejected = reject.has(story.key)
      recordUserStoryProof({
        processRunId: input.processRunId!,
        processPhaseRunId: input.processPhaseRunId!,
        args: {
          verdict: rejected ? "rejected" : "accepted",
          criteria: story.spec.acceptance.map((_, i) => ({
            id: `AC-${i + 1}`,
            status: rejected ? "not_met" : "met",
            evidence: "Called the library with the example input.",
            method: "command",
          })),
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
vi.mock("../../tasks/process/command-executor", () => ({
  executeProcessCommand: async (input: {
    config: { command: string; cwd: string | null }
  }) => ({
    receipt: {
      version: 1,
      command: input.config.command,
      cwd: input.config.cwd,
      environment: "local",
      status: "completed",
      exitCode: 0,
      signal: null,
      startedAt: 1,
      finishedAt: 2,
      stdout: "",
      stderr: "",
      outputTruncated: false,
      capturedOutputBytes: 0,
      observedOutputBytes: 0,
      error: null,
    },
  }),
}))
vi.mock("../../agent/providers", () => {
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
vi.mock("../../agent/agents/loader", () => ({
  loadAgent: async (name: string) =>
    AGENTS.find((a) => a.refId === name || a.name === name) ?? null,
}))

import * as processes from "../../db/repositories/processes"
import * as features from "../../db/repositories/features"
import * as playbooks from "../../db/repositories/playbooks"
import * as rigs from "../../db/repositories/rigs"
import { getWorkspace, listWorkspaces } from "../../db/repositories/workspaces"
import {
  createContextUsageLog,
  type ContextUsageEntry,
  type ContextUsageLog,
} from "../../agent/context/usage-log"
import type { AgentDefinition } from "../../agent/agents/types"
import type { UserStory } from "../../db/types"
import { applyPlanChanges } from "../plan-edits"
import { ProcessService } from "../../tasks/process/service"
import { startHookRun } from "../hook-runner"
import { Navigator } from "../navigator"
import { UserStoryRunner, recordUserStoryProof } from "../user-story-runner"
import { onWorkChanged } from "../work-events"
import {
  runScenario,
  runScenarioBatch,
  selectScenarios,
  type ScenarioDriverDeps,
} from "./driver"
import { buildScorecard, loadScenarios, type Scorecard } from "./scorecard"

function usageEntry(
  featureId: string,
  input: { conversationId: string; missionControlSeat?: { address: string } }
): ContextUsageEntry {
  return {
    at: new Date().toISOString(),
    conversationId: input.conversationId,
    taskId: null,
    agentDepth: 0,
    turnStartSeq: 0,
    round: 1,
    roundId: randomUUID(),
    attempt: 1,
    provider: "scripted",
    accountId: "a",
    model: "scripted-model",
    mode: "interactive",
    seat: {
      address: input.missionControlSeat!.address,
      profile: "worker",
      featureId,
      anchor: null,
    },
    request: {
      reported: 1000,
      estimated: 900,
      estimator: "test",
      ratio: null,
      usageRequested: true,
      byRole: {} as ContextUsageEntry["request"]["byRole"],
      toolDefs: 0,
      messageCount: 1,
      largest: null as unknown as ContextUsageEntry["request"]["largest"],
    },
    response: { reported: 50, estimated: null, finishReason: "stop" },
    outcome: "ok",
  }
}

const scenarios = loadScenarios()
const nonUi = scenarios.find((s) => s.spec.key === "05-non-ui")!
const greenfield = scenarios.find((s) => s.spec.key === "01-greenfield")!
const misread = scenarios.find((s) => s.spec.key === "06-misread-criterion")!

let navigator: Navigator
let deps: ScenarioDriverDeps
let unsubscribe: () => void
const executions = new Map<string, AbortController>()
const workspaces: string[] = []
let logDir: string

// Tasks run as soon as they're enqueued, the way the task runner would.
function setup() {
  const fakeRunner = {
    enqueueKind: (request: { input?: unknown }) => {
      const conversationId = randomUUID()
      const taskId = randomUUID()
      const now = Date.now()
      db.prepare(
        "INSERT INTO conversations (id, mode, title, workspace_id, created_at, updated_at) VALUES (?, 'interactive', NULL, NULL, ?, ?)"
      ).run(conversationId, now, now)
      db.prepare(
        "INSERT INTO tasks (id, conversation_id, source_conversation_id, title, status, input, result, error, created_at, updated_at) VALUES (?, ?, ?, NULL, 'queued', ?, NULL, NULL, ?, ?)"
      ).run(
        taskId,
        conversationId,
        conversationId,
        JSON.stringify(request.input ?? null),
        now,
        now
      )
      const controller = new AbortController()
      executions.set(taskId, controller)
      setTimeout(() => {
        void service
          .execute({
            task: { id: taskId, input: request.input } as never,
            signal: controller.signal,
            emit: () => {},
            workspace: undefined,
          } as never)
          .catch(() => {})
      }, 5)
      return { id: taskId }
    },
  } as never
  const service = new ProcessService(fakeRunner)
  const runner = new UserStoryRunner({
    startProcessRun: (input) => service.startRun(input),
    cancelTask: (taskId) => executions.get(taskId)?.abort(),
    loadAgents: async () => AGENTS as unknown as AgentDefinition[],
  })
  service.onRunSettled((id) => runner.settle(id))
  navigator = new Navigator({
    startUserStory: (id, options) => runner.startUserStory(id, options),
    startHook: (input) => startHookRun(runner, input),
    cancelPlaybookRun: (id) => runner.cancelPlaybookRun(id),
    workspaceMode: async () => ({ mode: "single_flight", reason: "test" }),
    advanceMilestone: () => {},
    kickMerges: () => {},
    completeMilestone: async () => {},
    direct: () => {},
    notifyUser: () => {},
    debounceMs: 0,
    heartbeatMs: 60_000,
  })
  unsubscribe = onWorkChanged((featureId) => navigator.poke(featureId))
  deps = {
    startDrive: async (id) => {
      const workspaceId = features.getFeature(id)!.workspaceId!
      workspaces.push(getWorkspace(workspaceId)!.path)
      return navigator.startDrive(id, { mode: "autopilot" })
    },
    cancel: (id, reason) => void navigator.cancel(id, reason),
    position: (id) => navigator.position(id),
    preflight: async () => ({ ok: true, blockers: [] }),
    removeFeature: async (id) => features.deleteFeature(id),
    model: () => ({ provider: "configured", model: "configured-model" }),
  }
}

function orchestratedRig() {
  const rig = rigs.createRig({ name: "Orchestrated" })
  const orchestration = rigs.createPod({
    rigId: rig.id,
    key: "orchestration",
    name: "Orchestration",
  })
  const implementation = rigs.createPod({
    rigId: rig.id,
    key: "implementation",
    name: "Implementation",
  })
  rigs.createSeat({
    podId: orchestration.id,
    key: "lead",
    role: "lead",
    agentRefId: "agentref:v1:lead",
    agentLabel: "Agent lead",
  })
  for (const role of ["builder", "qa"])
    rigs.createSeat({
      podId: implementation.id,
      key: role,
      role,
      agentRefId: `agentref:v1:${role}`,
      agentLabel: `Agent ${role}`,
    })
  rigs.setOversight(rig.id, [
    { overseerPodId: orchestration.id, overseenPodId: implementation.id },
  ])
  return rig
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  runMigrations(db)
  hang = false
  duringBuild = null
  built.clear()
  reject.clear()
  storyTurns.length = 0
  editDelivered = false
  executions.clear()
  workspaces.length = 0
  logDir = mkdtempSync(path.join(tmpdir(), "driver-usage-"))
  usageLog.current = createContextUsageLog({
    dir: () => logDir,
    console: { info: () => {}, warn: () => {} },
  })
  setup()
})

afterEach(() => {
  if (!sqliteLoads) return
  unsubscribe()
  navigator.stop()
  rmSync(logDir, { recursive: true, force: true })
})

const FAST = { pollMs: 20, idleMs: 500, capMs: 20_000 }

describe.skipIf(!sqliteLoads || process.platform === "win32")(
  "live scenario driver (plan 112.2)",
  () => {
    it("runs a scenario on Autopilot and writes a complete scorecard record", async () => {
      orchestratedRig()
      const record = await runScenario(deps, nonUi, {
        ...FAST,
        appCommit: "abc1234",
      })

      expect(record).toMatchObject({
        scenario: "05-non-ui",
        variant: "library",
        tier: "live",
        settle: "settled",
        stories: { accents: "done" },
        firstVerdicts: { accents: "accepted" },
        attemptsByStory: { accents: 1 },
        storyAttempts: 1,
        proofRevisions: 0,
        escalations: 0,
        recipeRepairs: 0,
        // No wave gate on this build (112.5), so the scenario can't fully
        // match yet; the stories did.
        waveGate: "not_run",
        failureClass: null,
        orphans: [],
        outcome: "gate_not_run",
        matched: false,
        checks: {
          stories: true,
          failureClass: true,
          waveGate: false,
          attempts: true,
          escalations: true,
          orphans: true,
        },
        model: "scripted-model",
        provider: "scripted",
        appCommit: "abc1234",
        scenarioVersion: 1,
      })
      expect(record.aborted).toBeUndefined()
      expect(record.wallMs).toBeGreaterThan(0)
      // Builder and QA turns each logged a round.
      expect(record.cost!.rounds).toBeGreaterThanOrEqual(2)
      expect(record.cost).toMatchObject({ estimated: false })
      expect(record.cost!.inputTokens).toBe(record.cost!.rounds * 1000)
      expect(record.cost!.outputTokens).toBe(record.cost!.rounds * 50)

      // The temp workspace, its row, and the feature are gone.
      expect(workspaces).toHaveLength(1)
      expect(existsSync(workspaces[0])).toBe(false)
      expect(listWorkspaces()).toEqual([])
      expect(features.listFeatures()).toEqual([])
      // The run's own milestone playbook (no planning review) went with it.
      expect(
        playbooks.listPlaybooks().filter((p) => p.name.startsWith("Scenario"))
      ).toEqual([])
    }, 30_000)

    it("runs scenario 6's story with App check → Test only, and scores a changed delivery as builder_fixed (plan 112.4)", async () => {
      orchestratedRig()
      reject.add("bill")
      const first = await runScenario(deps, misread, FAST)
      // No builder turn: QA judges the code as delivered, once.
      expect(storyTurns.length).toBeGreaterThan(0)
      expect(storyTurns.every((a) => a.startsWith("qa@"))).toBe(true)
      expect(first).toMatchObject({
        deliveredChanged: false,
        firstVerdicts: { bill: "rejected" },
        attemptsByStory: { bill: 1 },
        // QA's rejection is a feature failure.
        failureClass: "feature",
        outcome: "as_expected",
        matched: true,
      })
      reject.clear()
      // The run's story playbook went with it.
      expect(
        playbooks.listPlaybooks().filter((p) => p.name.startsWith("Scenario"))
      ).toEqual([])

      // The delivered code changed before the proof: not QA's miss.
      editDelivered = true
      const second = await runScenario(deps, misread, FAST)
      expect(second).toMatchObject({
        deliveredChanged: true,
        outcome: "builder_fixed",
      })
    }, 60_000)

    it("follows a story a seat adds mid-run, and reports it apart from the scenario's", async () => {
      orchestratedRig()
      duringBuild = (story, featureId) => {
        if (story.key !== "accents") return
        applyPlanChanges({
          featureId,
          milestoneId: story.milestoneId,
          changes: [
            {
              op: "add_user_story",
              userStory: {
                key: "docs",
                title: "Document accents",
                acceptance: ["The README shows an accented example."],
              },
            },
          ],
          actor: "lead@orchestration",
          reason: "The plan missed the docs.",
          origin: "agent",
        })
      }
      const record = await runScenario(deps, nonUi, FAST)

      // The run waited for the added story before settling.
      expect(record).toMatchObject({
        settle: "settled",
        stories: { accents: "done", docs: "done" },
        resolvedStories: { accents: "done" },
        attemptsByStory: { accents: 1, docs: 1 },
        storyAttempts: 2,
        planChanges: {
          addedStories: ["docs"],
          addedMilestones: [],
          splits: {},
          cancelled: [],
        },
        checks: { stories: true },
      })
    }, 30_000)

    it("scores a story split mid-run by its parts", async () => {
      orchestratedRig()
      // The lead splits item-crud (not started: it waits on app-skeleton),
      // and QA rejects one of the parts.
      reject.add("item-delete")
      duringBuild = (story, featureId) => {
        if (story.key !== "app-skeleton") return
        applyPlanChanges({
          featureId,
          milestoneId: story.milestoneId,
          changes: [
            {
              op: "split_user_story",
              userStory: "item-crud",
              into: [
                {
                  key: "item-add",
                  title: "Add and rename items",
                  acceptance: ["Add shows the item.", "Rename updates it."],
                },
                {
                  key: "item-delete",
                  title: "Complete and delete items",
                  acceptance: ["Complete strikes it.", "Delete removes it."],
                },
              ],
            },
          ],
          actor: "lead@orchestration",
          reason: "Two smaller stories.",
          origin: "agent",
        })
      }
      const record = await runScenario(deps, greenfield, FAST)

      expect(record).toMatchObject({
        settle: "settled",
        variant: null,
        stories: {
          "app-skeleton": "done",
          "item-crud": "not_run",
          "item-add": "done",
          "item-delete": "rejected",
        },
        firstVerdicts: { "item-crud": null, "item-delete": "rejected" },
        resolvedStories: { "app-skeleton": "done", "item-crud": "rejected" },
        resolvedVerdicts: {
          "app-skeleton": "accepted",
          "item-crud": "rejected",
        },
        planChanges: {
          addedStories: [],
          splits: { "item-crud": ["item-add", "item-delete"] },
          cancelled: [],
        },
        checks: { stories: false },
        outcome: "story_rejected",
      })
    }, 30_000)

    it("doesn't settle while an added milestone still has work", async () => {
      orchestratedRig()
      duringBuild = (story, featureId) => {
        if (story.key !== "accents") return
        applyPlanChanges({
          featureId,
          milestoneId: null,
          changes: [
            {
              op: "add_milestone",
              milestone: {
                key: "docs",
                name: "Docs",
                outcome: "The library is documented.",
                userStories: [{ key: "readme", title: "README" }],
              },
            },
          ],
          actor: "user",
          reason: "Applied a proposal.",
          origin: "user",
        })
      }
      const record = await runScenario(deps, nonUi, FAST)

      // This test's integration never lands the first milestone, so the
      // second can't start: the run ends waiting on the user, not settled.
      expect(record).toMatchObject({
        settle: "waiting_on_user",
        stories: { accents: "done", "docs/readme": "not_run" },
        resolvedStories: { accents: "done" },
        planChanges: {
          addedStories: ["docs/readme"],
          addedMilestones: ["docs"],
        },
      })
    }, 30_000)

    it("still writes a record, marked aborted, when the run is stopped", async () => {
      orchestratedRig()
      hang = true
      const controller = new AbortController()
      const stop = setInterval(() => {
        const started = playbooks.listPlaybookRuns({ status: "running" })
        if (started.length) controller.abort()
      }, 20)
      const record = await runScenario(deps, nonUi, {
        ...FAST,
        signal: controller.signal,
      })
      clearInterval(stop)

      expect(record).toMatchObject({
        scenario: "05-non-ui",
        outcome: "aborted",
        aborted: true,
        settle: "aborted",
        matched: false,
        stories: { accents: "incomplete" },
        orphans: [],
      })
      // The app's teardown stopped the run before cleanup.
      expect(playbooks.listPlaybookRuns({ status: "running" })).toEqual([])
      expect(existsSync(workspaces[0])).toBe(false)
      expect(features.listFeatures()).toEqual([])
    }, 30_000)

    it("records a run with no rig to use as not runnable", async () => {
      const record = await runScenario(deps, nonUi, FAST)
      expect(record).toMatchObject({
        outcome: "not_runnable",
        settle: "not_runnable",
        matched: false,
        detail: "No rig with a builder and a QA seat.",
      })
      expect(listWorkspaces()).toEqual([])
    })

    it("writes the batch scorecard as rates after every run", async () => {
      orchestratedRig()
      const repoRoot = mkdtempSync(path.join(tmpdir(), "driver-repo-"))
      try {
        const written: number[] = []
        const { file, scorecard } = await runScenarioBatch(deps, {
          ...FAST,
          scenarios: ["5"],
          runs: 2,
          label: "Live baseline",
          date: "2026-10-13",
          repoRoot,
          onRecord: (_record, index) => written.push(index),
        })
        expect(written).toEqual([1, 2])
        expect(file).toBe(
          path.join(
            repoRoot,
            ".plan/112-scorecard/2026-10-13-live-baseline.json"
          )
        )
        const saved = JSON.parse(readFileSync(file, "utf8")) as Scorecard
        expect(saved).toEqual(scorecard)
        expect(saved).toMatchObject({
          tier: "live",
          label: "Live baseline",
          model: "scripted-model",
          provider: "scripted",
          scenarios: [
            {
              scenario: "05-non-ui",
              runs: 2,
              rates: { gate_not_run: 1 },
              matchedRate: 0,
              runsWithOrphans: 0,
              checkRates: { stories: 1, waveGate: 0, orphans: 1 },
            },
          ],
        })
        expect(saved.scenarios[0].cost!.meanInputTokens).toBeGreaterThan(0)
        expect(saved.configuredModel).toBe("configured-model")
      } finally {
        rmSync(repoRoot, { recursive: true, force: true })
      }
    }, 60_000)

    it("adds a later batch's runs to the same scorecard when the model matches", async () => {
      orchestratedRig()
      const repoRoot = mkdtempSync(path.join(tmpdir(), "driver-repo-"))
      const batch = (scenarios: string[]) =>
        runScenarioBatch(deps, {
          ...FAST,
          scenarios,
          runs: 1,
          label: "live-baseline",
          date: "2026-10-13",
          repoRoot,
        })
      try {
        await batch(["5"])
        const { file, scorecard } = await batch(["5"])
        expect(scorecard.runs).toHaveLength(2)
        expect(scorecard.scenarios).toMatchObject([
          { scenario: "05-non-ui", runs: 2, rates: { gate_not_run: 1 } },
        ])
        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(scorecard)

        // Another selected model: refused before anything runs.
        const before = readFileSync(file, "utf8")
        deps.model = () => ({ provider: "configured", model: "other-model" })
        await expect(batch(["5"])).rejects.toThrow(
          "2026-10-13-live-baseline.json was recorded with configured-model selected, but the selected model is now other-model."
        )
        expect(readFileSync(file, "utf8")).toBe(before)
        expect(workspaces).toHaveLength(2)
      } finally {
        rmSync(repoRoot, { recursive: true, force: true })
      }
    }, 60_000)

    it("refuses to add to a harness scorecard or use a malformed date", async () => {
      const repoRoot = mkdtempSync(path.join(tmpdir(), "driver-repo-"))
      try {
        const file = path.join(
          repoRoot,
          ".plan/112-scorecard/2026-10-13-after-port.json"
        )
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(
          file,
          JSON.stringify(
            buildScorecard({
              label: "after-port",
              date: "2026-10-13",
              tier: "harness",
              commit: null,
              runs: [],
            })
          )
        )
        const options = { ...FAST, scenarios: ["5"], repoRoot }
        await expect(
          runScenarioBatch(deps, {
            ...options,
            label: "after-port",
            date: "2026-10-13",
          })
        ).rejects.toThrow("is a harness-tier scorecard")
        await expect(
          runScenarioBatch(deps, { ...options, date: "13/10/2026" })
        ).rejects.toThrow(
          'The scorecard date must be YYYY-MM-DD, not "13/10/2026".'
        )
        expect(workspaces).toEqual([])
      } finally {
        rmSync(repoRoot, { recursive: true, force: true })
      }
    })
  }
)

describe("selectScenarios", () => {
  it("takes keys, numbers, or all", () => {
    expect(selectScenarios(scenarios).map((s) => s.spec.number)).toEqual([
      1, 2, 3, 4, 5, 6,
    ])
    expect(
      selectScenarios(scenarios, ["3", "06-misread-criterion"]).map(
        (s) => s.spec.number
      )
    ).toEqual([3, 6])
    expect(() => selectScenarios(scenarios, ["9"])).toThrow(
      "Unknown scenario(s): 9."
    )
  })
})

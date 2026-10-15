import { execFileSync } from "child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs"
import { tmpdir } from "os"
import path from "path"
import {
  listRecipeQuestions,
  listRecipeStates,
} from "../../db/repositories/app-recipe-states"
import * as features from "../../db/repositories/features"
import { listEvents } from "../../db/repositories/mc-events"
import * as playbooks from "../../db/repositories/playbooks"
import {
  deleteProcessDefinition,
  getPhaseRun,
  getProcessRun,
} from "../../db/repositories/processes"
import * as rigs from "../../db/repositories/rigs"
import { listMessages } from "../../db/repositories/seat-comms"
import { hasActiveFeatureTask } from "../../db/repositories/tasks"
import {
  deleteWorkspace,
  updateWorkspace,
  upsertWorkspace,
} from "../../db/repositories/workspaces"
import type { UserStory, UserStoryProof } from "../../db/types"
import type { Position } from "../../../shared/mission-control/position"
import { onContextUsage } from "../../agent/context/usage-log"
import { onServiceSpawned } from "../app-launch"
import { USER_ADDRESS } from "../comms"
import { applyPlanChanges } from "../plan-edits"
import {
  createDefaultPlaybook,
  ensureDefaultPlaybook,
} from "../playbook-defaults"
import {
  buildScorecard,
  loadScenarios,
  runRecord,
  scoreLiveRun,
  scorecardPath,
  waitForOrphans,
  type LoadedScenario,
  type RunCost,
  type ScenarioRunRecord,
  type Scorecard,
  type StoryOutcome,
} from "./scorecard"

// The live-model scenario driver (plan 112.2). Dev-only, behind the same
// `.env.local` gate as Mission Control: it runs a scenario as a real feature
// on Autopilot with the configured provider and model, and writes one
// scorecard record per run. Every run starts from a fresh copy of the
// fixture in its own git repository, with the scenario's pre-authored
// milestone and stories applied through the plan-edit engine, so planning
// noise stays out of the measurement.
//
// Outcomes come from the database through the repositories (story status,
// proofs, the event log, Comms), never from the UI or transcripts. Cost
// comes from the per-round context usage log.

// SEAT_WAKE_KIND (sessions.ts), named here so the driver doesn't load the
// seat session machinery.
const SEAT_WAKE_KIND = "seat_wake"

export interface ScenarioDriverDeps {
  // Navigator.startDrive on Autopilot.
  startDrive(featureId: string): Promise<{ planningError: string | null }>
  cancel(featureId: string, reason: string): void
  position(featureId: string): Promise<Position>
  // Start's workspace preflight; blockers stop the run as not runnable.
  preflight(featureId: string): Promise<{ ok: boolean; blockers: string[] }>
  // Delete the feature with its worktrees, branches, and seat conversations.
  removeFeature(featureId: string): Promise<void>
  // The configured provider and model, for runs that logged no rounds.
  model(): { provider: string | null; model: string | null }
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface ScenarioRunOptions {
  // Recipe variant; default the scenario's `live.variant`, else none.
  variant?: string | null
  rigId?: string | null
  // Wall-clock cap for the run.
  capMs?: number
  pollMs?: number
  // How long nothing may be running, with nothing to start, before the run
  // counts as waiting on the user.
  idleMs?: number
  // Run even when the workspace preflight reports blockers.
  skipPreflight?: boolean
  // Keep the milestone's planning review (before_user_stories). Off by
  // default: the review can add stories, which is planning noise.
  planningReview?: boolean
  // Leave the feature and temp workspace in place for inspection.
  keep?: boolean
  appCommit?: string | null
  signal?: AbortSignal
}

const DEFAULT_CAP_MS = 45 * 60 * 1000
const DEFAULT_POLL_MS = 5000
const DEFAULT_IDLE_MS = 3 * 60 * 1000
const TEARDOWN_MS = 2 * 60 * 1000
// Unverified (plan 112.3) ends an attempt like failed: neither runs on.
const DONE_STATUSES = new Set(["done", "failed", "cancelled", "unverified"])
const TERMINAL_FEATURE = new Set(["completed", "cancelled", "failed"])
// Maneuvers that mean the Navigator still has something to do itself.
const ACTIVE_MANEUVERS = new Set([
  "run_hook",
  "dispatch",
  "complete_milestone",
  "complete_feature",
])

class Aborted extends Error {}

// A fresh copy of the fixture project, as a git repository with one commit,
// so worktrees and the merge queue behave as in real use.
export function scenarioWorkspace(scenario: LoadedScenario): string {
  const dir = mkdtempSync(
    path.join(tmpdir(), `mc-scenario-${scenario.spec.number}-`)
  )
  cpSync(scenario.projectDir, dir, { recursive: true })
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" })
  git("init", "-q", "-b", "main")
  git("add", "-A")
  git(
    "-c",
    "user.name=Scenario fixture",
    "-c",
    "user.email=scenario@localhost",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    `Scenario ${scenario.spec.key}`
  )
  return dir
}

// The default milestone playbook without its planning review, so the
// scenario's pre-authored stories are the ones that run. Conflict
// resolution and the milestone summary stay. One per run, deleted with it.
function playbookWithoutReview(): string {
  // The user's default stays the default: ours must not become it.
  ensureDefaultPlaybook("milestone")
  const playbook = createDefaultPlaybook("milestone")
  const review = playbook.hooks.find((h) => h.hook === "before_user_stories")
  if (review) {
    playbooks.removeHook(playbook.id, "before_user_stories")
    deleteProcessDefinition(review.processId)
  }
  playbooks.updatePlaybook(playbook.id, {
    name: "Scenario driver · no planning review",
  })
  return playbook.id
}

// The first rig with a builder and a QA seat (plan 112.2: scenarios run with
// a QA seat).
export function defaultScenarioRig(): string | null {
  for (const rig of rigs.listRigs()) {
    const graph = rigs.getRigGraph(rig.id)
    const roles = new Set(graph?.seats.map((s) => s.role) ?? [])
    if (roles.has("builder") && roles.has("qa")) return rig.id
  }
  return null
}

function storyRuns(featureId: string, userStoryId: string) {
  return playbooks
    .listPlaybookRuns({ featureId, userStoryId })
    .filter((r) => r.hook === "run")
    .reverse()
}

function lastProof(featureId: string, story: UserStory): UserStoryProof | null {
  const fromRuns = storyRuns(featureId, story.id)
    .map((r) => r.proof)
    .filter((p): p is UserStoryProof => !!p)
    .at(-1)
  return fromRuns ?? (story.proof as UserStoryProof | null) ?? null
}

function storyOutcome(
  story: UserStory,
  proof: UserStoryProof | null
): StoryOutcome {
  switch (story.status) {
    case "done":
      return "done"
    // Plan 112.3: the harness's own outcome when the app couldn't be run.
    case "unverified":
      return "unverified"
    case "failed": {
      if (proof?.verdict !== "rejected") return "failed"
      const statuses = proof.criteria.map((c) => c.status)
      return statuses.includes("not_verifiable") &&
        !statuses.includes("not_met")
        ? "unverified"
        : "rejected"
    }
    case "running":
    case "proving":
    case "integrating":
      return "incomplete"
    default:
      return "not_run"
  }
}

// The feature's stories in every milestone, named for the record: the
// scenario milestone's by key, another milestone's as `<milestone>/<key>`.
// Seats add stories (revise_plan) and the user can apply new milestones
// while a run is going, so the record covers whatever the plan became.
function featureStories(
  featureId: string,
  scenarioMilestoneId: string
): Array<{ story: UserStory; name: string; milestone: string }> {
  return features.listMilestones(featureId).flatMap((milestone) =>
    features.listUserStories(milestone.id).map((story) => ({
      story,
      milestone: milestone.key,
      name:
        milestone.id === scenarioMilestoneId
          ? story.key
          : `${milestone.key}/${story.key}`,
    }))
  )
}

// A split story's parts, from the plan-edit engine's `split` revisions.
function splitParts(featureId: string): Map<string, string[]> {
  const parts = new Map<string, string[]>()
  for (const revision of features.listRevisions(featureId)) {
    if (revision.targetKind !== "user_story" || revision.change.op !== "split")
      continue
    const into = (revision.change.after as { into?: unknown } | null)?.into
    if (Array.isArray(into))
      parts.set(
        revision.targetId,
        into.filter((id): id is string => typeof id === "string")
      )
  }
  return parts
}

// The story and every story its work was split into, recursively.
function lineage(id: string, parts: Map<string, string[]>): string[] {
  const seen = new Set<string>()
  const walk = (current: string) => {
    if (seen.has(current)) return
    seen.add(current)
    for (const part of parts.get(current) ?? []) walk(part)
  }
  walk(id)
  return [...seen]
}

// A split story scores as its parts together: the worst part decides.
const OUTCOME_ORDER: StoryOutcome[] = [
  "incomplete",
  "rejected",
  "unverified",
  "failed",
  "not_run",
  "done",
]
function combined(outcomes: StoryOutcome[]): StoryOutcome {
  return OUTCOME_ORDER.find((o) => outcomes.includes(o)) ?? "not_run"
}

// Every story that still runs, in every milestone that isn't cancelled.
function liveStories(featureId: string): UserStory[] {
  return features
    .listMilestones(featureId)
    .filter((m) => m.status !== "cancelled")
    .flatMap((m) => features.listUserStories(m.id))
}

// Why the run can stop now, or null to keep polling.
async function settleReason(
  deps: ScenarioDriverDeps,
  featureId: string,
  idle: { since: number | null },
  now: number,
  idleMs: number
): Promise<string | null> {
  const feature = features.getFeature(featureId)
  if (!feature) return "feature_missing"
  if (TERMINAL_FEATURE.has(feature.status)) return `feature_${feature.status}`
  if (feature.status === "paused") return "paused"
  // A story's app check waiting on recipe repair's question (plan 112.3):
  // nobody answers in an unattended run, so after the idle wait the run is
  // waiting on the user, though the step still counts as running.
  if (listRecipeQuestions(featureId).length) {
    idle.since ??= now
    return now - idle.since >= idleMs ? "waiting_on_user" : null
  }
  const inFlight =
    playbooks.listPlaybookRuns({ featureId, status: "running" }).length > 0 ||
    hasActiveFeatureTask(SEAT_WAKE_KIND, featureId)
  if (inFlight) {
    idle.since = null
    return null
  }
  const position = await deps.position(featureId)
  const starting =
    position.dispatch.length > 0 || (position.preparing?.length ?? 0) > 0
  // Every story in the feature finished, including ones added during the
  // run, with no retry or hook about to start. Completing or landing a
  // milestone doesn't change a story's outcome.
  if (
    !starting &&
    position.maneuver.kind !== "run_hook" &&
    liveStories(featureId).every((s) => DONE_STATUSES.has(s.status))
  )
    return "settled"
  if (starting || ACTIVE_MANEUVERS.has(position.maneuver.kind)) {
    idle.since = null
    return null
  }
  // Nothing running and nothing to start: give the lead a moment to act on
  // a decision, then it's waiting on the user.
  idle.since ??= now
  return now - idle.since >= idleMs ? "waiting_on_user" : null
}

// One live run of one scenario. Always returns a record: a run that can't
// start is `not_runnable`, one stopped from outside is `aborted`.
export async function runScenario(
  deps: ScenarioDriverDeps,
  scenario: LoadedScenario,
  options: ScenarioRunOptions = {}
): Promise<ScenarioRunRecord> {
  const now = deps.now ?? Date.now
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const { spec } = scenario
  const variantKey =
    options.variant !== undefined
      ? options.variant
      : (spec.live?.variant ?? null)
  const variant = variantKey ? spec.variants[variantKey] : null
  const started = now()
  const record = runRecord(spec.key, variantKey, "live", {
    scenarioVersion: spec.version,
    appCommit: options.appCommit ?? null,
  })

  // Model usage and service processes, collected for this feature only.
  let featureId: string | null = null
  const cost: RunCost = {
    rounds: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimated: false,
  }
  const models = new Map<string, { provider: string | null; model: string }>()
  const stopUsage = onContextUsage((entry) => {
    if (!featureId || entry.seat?.featureId !== featureId) return
    cost.rounds++
    cost.inputTokens += entry.request.reported ?? entry.request.estimated
    cost.outputTokens +=
      entry.response.reported ?? entry.response.estimated ?? 0
    if (entry.request.reported === null || entry.response.reported === null)
      cost.estimated = true
    models.set(`${entry.provider}/${entry.model}`, {
      provider: entry.provider,
      model: entry.model,
    })
  })
  const spawned: Array<{ owner: string; pid: number }> = []
  const stopSpawns = onServiceSpawned(({ owner, pid }) =>
    spawned.push({ owner, pid })
  )

  let dir: string | null = null
  let workspaceId: string | null = null
  let playbookId: string | null = null
  // The scenario's milestone and the stories it started with, by key.
  let scenarioMilestoneId: string | null = null
  let seeded = new Map<string, string>()
  const checkAbort = () => {
    if (options.signal?.aborted) throw new Aborted("The run was stopped.")
  }

  try {
    checkAbort()
    if (variantKey && !variant)
      throw new Error(`Scenario ${spec.key} has no variant "${variantKey}".`)
    const rigId = options.rigId ?? defaultScenarioRig()
    if (!rigId) {
      record.settle = "not_runnable"
      record.detail = "No rig with a builder and a QA seat."
      return record
    }
    dir = scenarioWorkspace(scenario)
    const workspace = upsertWorkspace(dir, `Scenario ${spec.number}`)
    workspaceId = workspace.id
    if (variant?.recipe.services.length)
      updateWorkspace(workspace.id, { appLaunch: variant.recipe })

    const graph = features.createFeature({
      key: `scenario-${spec.number}`,
      name: `Scenario ${spec.number}: ${spec.title}`,
      intent: spec.intent,
      definitionOfDone: "Every user story's acceptance criteria are met.",
      rigId,
      workspaceId: workspace.id,
    })
    featureId = graph.feature.id
    const applied = applyPlanChanges({
      featureId,
      milestoneId: null,
      changes: [
        {
          op: "add_milestone",
          milestone: {
            key: spec.milestone.key,
            name: spec.milestone.title,
            outcome: spec.intent,
            userStories: spec.stories.map((story) => ({
              key: story.key,
              title: story.title,
              goal: story.goal,
              acceptance: story.acceptance,
              ...(story.dependsOn ? { dependsOn: story.dependsOn } : {}),
            })),
          },
        },
      ],
      actor: "user",
      reason: `Scenario ${spec.key}: pre-authored plan`,
      origin: "user",
    })
    const milestoneId = applied.createdMilestoneIds[0]
    scenarioMilestoneId = milestoneId
    seeded = new Map(
      features.listUserStories(milestoneId).map((s) => [s.key, s.id])
    )
    if (!options.planningReview) {
      playbookId = playbookWithoutReview()
      features.updateMilestone(milestoneId, { playbookId })
    }

    checkAbort()
    const preflight = await deps.preflight(featureId)
    if (!preflight.ok && !options.skipPreflight) {
      record.settle = "not_runnable"
      record.detail = `Workspace preflight blocked: ${preflight.blockers.join(", ")}`
      return record
    }
    const drive = await deps.startDrive(featureId)
    if (drive.planningError) record.detail = drive.planningError

    // Poll until the run settles, hits its cap, or is stopped.
    const cap = started + (options.capMs ?? DEFAULT_CAP_MS)
    const idle = { since: null as number | null }
    let settle: string | null = null
    while (!settle) {
      checkAbort()
      settle = await settleReason(
        deps,
        featureId,
        idle,
        now(),
        options.idleMs ?? DEFAULT_IDLE_MS
      )
      if (!settle && now() >= cap) settle = "cap"
      if (!settle) await sleep(options.pollMs ?? DEFAULT_POLL_MS)
    }
    record.settle = settle
    observe(record, featureId, milestoneId, seeded)
  } catch (error) {
    record.aborted = true
    record.outcome = "aborted"
    record.settle = "aborted"
    record.detail = error instanceof Error ? error.message : String(error)
    if (featureId && scenarioMilestoneId)
      observe(record, featureId, scenarioMilestoneId, seeded)
  } finally {
    // The app's own teardown first: cancelling stops the playbook runs, and
    // each phase stops the services it started.
    if (featureId) await teardown(deps, featureId, now, sleep)
    stopUsage()
    stopSpawns()
    const pids = spawned
      .filter((s) => ownedByFeature(s.owner, featureId))
      .map((s) => s.pid)
    record.orphans = await waitForOrphans(pids, 5000)
    record.wallMs = now() - started
    if (cost.rounds) record.cost = cost
    const used = [...models.values()]
    const configured = deps.model()
    record.model =
      used.length > 1
        ? used.map((m) => m.model).join(", ")
        : (used[0]?.model ?? configured.model)
    record.provider = used[0]?.provider ?? configured.provider
    if (record.settle !== "not_runnable" && !record.aborted)
      score(record, scenario)
    if (!options.keep) {
      if (featureId)
        await deps.removeFeature(featureId).catch((err) => {
          record.detail = [record.detail, `Cleanup failed: ${String(err)}`]
            .filter(Boolean)
            .join("\n")
        })
      if (playbookId) playbooks.deletePlaybook(playbookId)
      if (workspaceId) deleteWorkspace(workspaceId)
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  }
  return record
}

// The stories' outcomes, attempts, proofs, and escalations, as of now,
// across whatever the plan became during the run.
function observe(
  record: ScenarioRunRecord,
  featureId: string,
  scenarioMilestoneId: string,
  seeded: Map<string, string>
): void {
  const all = featureStories(featureId, scenarioMilestoneId)
  const byId = new Map(all.map((entry) => [entry.story.id, entry]))
  const outcomes = new Map(
    all.map(({ story }) => [
      story.id,
      storyOutcome(story, lastProof(featureId, story)),
    ])
  )
  const events = listEvents(featureId, {
    types: ["proof_accepted", "proof_rejected"],
  })
  const firstVerdict = (id: string) => {
    const first = events.find((e) => e.userStoryId === id)
    return first
      ? first.type === "proof_accepted"
        ? "accepted"
        : "rejected"
      : null
  }
  const parts = splitParts(featureId)
  const nameOf = (id: string) => byId.get(id)?.name ?? id

  record.stories = Object.fromEntries(
    all.map(({ story, name }) => [name, outcomes.get(story.id)!])
  )
  record.firstVerdicts = Object.fromEntries(
    all.map(({ story, name }) => [name, firstVerdict(story.id)])
  )
  // The scenario's own stories, each with whatever it was split into.
  record.resolvedStories = {}
  record.resolvedVerdicts = {}
  for (const [key, id] of seeded) {
    const family = lineage(id, parts)
    const leaves = family.filter((member) => !parts.has(member))
    record.resolvedStories[key] = combined(
      leaves.map((leaf) => outcomes.get(leaf) ?? "not_run")
    )
    // Any part whose first proof was rejected means QA caught something.
    const verdicts = family.map(firstVerdict)
    record.resolvedVerdicts[key] = verdicts.includes("rejected")
      ? "rejected"
      : verdicts.includes("accepted")
        ? "accepted"
        : null
  }
  const splitIds = new Set([...parts.values()].flat())
  const seededIds = new Set(seeded.values())
  record.planChanges = {
    addedStories: all
      .filter(
        ({ story }) => !seededIds.has(story.id) && !splitIds.has(story.id)
      )
      .map(({ name }) => name),
    addedMilestones: features
      .listMilestones(featureId)
      .filter((m) => m.id !== scenarioMilestoneId)
      .map((m) => m.key),
    splits: Object.fromEntries(
      [...parts].map(([from, into]) => [nameOf(from), into.map(nameOf)])
    ),
    cancelled: all
      .filter(
        ({ story }) => story.status === "cancelled" && !parts.has(story.id)
      )
      .map(({ name }) => name),
  }
  // Attempts count for every story: one a seat added burns budget too.
  record.attemptsByStory = Object.fromEntries(
    all.map(({ story, name }) => [name, story.attempts])
  )
  record.storyAttempts = all.reduce((sum, { story }) => sum + story.attempts, 0)
  record.proofRevisions = all
    .flatMap(({ story }) => storyRuns(featureId, story.id))
    .reduce((sum, r) => sum + r.proofRevisions, 0)
  record.escalations = listMessages({
    featureId,
    toAddress: USER_ADDRESS,
  }).filter((m) => m.kind === "escalation").length
  // No wave gate yet (112.5). Failure classes and recipe repairs come from
  // the recipe state (plan 112.3): the worst class seen on any branch, and
  // every repair attempt, none of which counts against a story.
  record.waveGate = "not_run"
  const feature = features.getFeature(featureId)
  const states = feature?.workspaceId
    ? listRecipeStates(feature.workspaceId)
    : []
  // What happened to the running app: app checks, recipes seats saved, and
  // seats' failed starts, each with its failure class.
  const storyName = (id: string | null) =>
    id ? (features.getUserStory(id)?.key ?? id) : null
  const text = (value: unknown) => (typeof value === "string" ? value : null)
  const asClass = (value: unknown) =>
    value === "environment" || value === "feature" || value === "test_defect"
      ? value
      : null
  const ofType = (type: string) => listEvents(featureId, { types: [type] })
  record.appChecks = ofType("app_check").map((e) => ({
    story: storyName(e.userStoryId),
    result: text(e.detail?.result) ?? "unknown",
    cached: e.detail?.cached === true,
    repairs: Number(e.detail?.repairs) || 0,
    questions: Number(e.detail?.questions) || 0,
    class: asClass(e.detail?.class),
    reason: text(e.detail?.reason),
  }))
  record.recipeSaves = ofType("recipe_saved").map((e) => ({
    seat: e.seatAddress,
    repair: e.detail?.repair === true,
    replaced: text(e.detail?.replaced),
    services: (e.detail?.services as string[] | undefined) ?? [],
    setup: (e.detail?.setup as string[] | undefined) ?? [],
  }))
  record.appStartFailures = ofType("app_start_failed").map((e) => ({
    seat: e.seatAddress,
    class: asClass(e.detail?.class),
    reason: text(e.detail?.reason),
  }))
  // The failure class: the worst seen anywhere — a recipe state, an app
  // check, or a seat's failed start. Environment first: it's the class
  // that must never count against a story.
  const classes = [
    ...states.map((s) => s.failure?.class),
    ...record.appChecks.map((c) => c.class),
    ...record.appStartFailures.map((f) => f.class),
  ].filter((c): c is NonNullable<typeof c> => !!c)
  record.failureClass = classes.includes("environment")
    ? "environment"
    : (classes[0] ?? null)
  record.recipeRepairs = ofType("recipe_repair").length
}

function score(record: ScenarioRunRecord, scenario: LoadedScenario): void {
  // Scored on the scenario's own stories; stories a seat added are
  // reported in planChanges and count toward attempts, but the scenario
  // has no expectation for them.
  const scored = scoreLiveRun(scenario.spec.expected.live, {
    stories: record.resolvedStories ?? {},
    firstVerdicts: record.resolvedVerdicts ?? {},
    attemptsByStory: record.attemptsByStory ?? {},
    waveGate: record.waveGate ?? "not_run",
    failureClass: record.failureClass,
    recipeRepairs: record.recipeRepairs,
    escalations: record.escalations,
    orphans: record.orphans,
    settle: record.settle ?? "",
  })
  record.outcome = scored.outcome
  record.matched = scored.matched
  record.checks = scored.checks
}

// A service's owner is the phase run that started it.
function ownedByFeature(owner: string, featureId: string | null): boolean {
  if (!featureId) return false
  const phaseRun = getPhaseRun(owner)
  const run = phaseRun ? getProcessRun(phaseRun.runId) : null
  return run?.missionControl?.featureId === featureId
}

async function teardown(
  deps: ScenarioDriverDeps,
  featureId: string,
  now: () => number,
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  const feature = features.getFeature(featureId)
  if (
    feature &&
    !TERMINAL_FEATURE.has(feature.status) &&
    feature.status !== "draft"
  )
    deps.cancel(featureId, "The scenario run ended")
  const deadline = now() + TEARDOWN_MS
  while (
    now() < deadline &&
    (playbooks.listPlaybookRuns({ featureId, status: "running" }).length > 0 ||
      hasActiveFeatureTask(SEAT_WAKE_KIND, featureId))
  )
    await sleep(500)
}

export interface ScenarioBatchOptions extends Omit<
  ScenarioRunOptions,
  "signal"
> {
  // Scenario keys or numbers; default all.
  scenarios?: string[]
  runs?: number
  label?: string
  // Where the fixtures are (the bundled main process has no __dirname next
  // to them) and the repository root the scorecard is written under.
  scenariosDir?: string
  repoRoot: string
  date?: string
  signal?: AbortSignal
  onRecord?: (record: ScenarioRunRecord, index: number, total: number) => void
}

// Run each selected scenario `runs` times, one at a time, and write the
// scorecard after every run, so an interrupted batch keeps what it measured.
// A scorecard already at that date and label gains the new runs, so a
// baseline can be recorded in more than one sitting; one recorded on another
// model is refused before anything runs (a baseline is one model's).
export async function runScenarioBatch(
  deps: ScenarioDriverDeps,
  options: ScenarioBatchOptions
): Promise<{ file: string; scorecard: Scorecard }> {
  const selected = selectScenarios(
    loadScenarios(options.scenariosDir),
    options.scenarios
  )
  const runs = Math.max(1, options.runs ?? 3)
  const label = options.label ?? "live-baseline"
  const date = options.date ?? new Date().toLocaleDateString("en-CA")
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error(`The scorecard date must be YYYY-MM-DD, not "${date}".`)
  const file = path.join(options.repoRoot, scorecardPath(date, label))
  const configured = deps.model().model
  const records = existingRuns(file, configured)
  const card = () =>
    liveScorecard(label, date, options.appCommit ?? null, configured, records)
  let scorecard = card()
  const total = records.length + selected.length * runs
  for (const scenario of selected)
    for (let i = 0; i < runs; i++) {
      const record = options.signal?.aborted
        ? Object.assign(runRecord(scenario.spec.key, null, "live"), {
            outcome: "aborted",
            aborted: true,
            settle: "aborted",
            detail: "The batch was stopped before this run started.",
          })
        : await runScenario(deps, scenario, options)
      records.push(record)
      scorecard = card()
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(scorecard, null, 2)}\n`)
      options.onRecord?.(record, records.length, total)
    }
  return { file, scorecard }
}

// The runs already recorded in `file`, to add to. Refuses a harness-tier
// file, or one recorded with another model selected in Settings.
function existingRuns(file: string, model: string | null): ScenarioRunRecord[] {
  if (!existsSync(file)) return []
  const existing = JSON.parse(readFileSync(file, "utf8")) as Scorecard
  const name = path.basename(file)
  if (existing.tier !== "live")
    throw new Error(
      `${name} is a ${existing.tier}-tier scorecard. Use another label.`
    )
  const recorded = existing.configuredModel ?? existing.model
  if (recorded && recorded !== model)
    throw new Error(
      `${name} was recorded with ${recorded} selected, but the selected model is now ${model ?? "none"}. A baseline on another model goes in its own file: use another label.`
    )
  return existing.runs
}

export function selectScenarios(
  all: LoadedScenario[],
  keys?: string[]
): LoadedScenario[] {
  if (!keys?.length || keys.includes("all")) return all
  // A key, a number, or a number's prefix ("3" → 03-app-needing-setup).
  const names = (k: string, s: LoadedScenario) =>
    k === s.spec.key ||
    k === String(s.spec.number) ||
    s.spec.key.startsWith(`${k.padStart(2, "0")}-`)
  const missing = keys.filter((k) => !all.some((s) => names(k, s)))
  if (missing.length)
    throw new Error(`Unknown scenario(s): ${missing.join(", ")}.`)
  return all.filter((s) => keys.some((k) => names(k, s)))
}

function liveScorecard(
  label: string,
  date: string,
  commit: string | null,
  configuredModel: string | null,
  runs: ScenarioRunRecord[]
): Scorecard {
  const models = [...new Set(runs.map((r) => r.model).filter(Boolean))]
  const providers = [...new Set(runs.map((r) => r.provider).filter(Boolean))]
  // Runs added in a later sitting may be on another build; each run keeps
  // its own appCommit.
  const commits = [...new Set(runs.map((r) => r.appCommit).filter(Boolean))]
  return buildScorecard({
    label,
    date,
    tier: "live",
    commit:
      commits.length === 1 ? commits[0]! : commits.length ? "mixed" : commit,
    model: models.length === 1 ? models[0]! : models.length ? "mixed" : null,
    provider:
      providers.length === 1
        ? providers[0]!
        : providers.length
          ? "mixed"
          : null,
    configuredModel,
    notes:
      "Live tier: each scenario run as a feature on Autopilot with a real model, from a fresh fixture copy with its pre-authored plan. Rates per outcome across runs; cost is seat model usage from the context usage log.",
    runs,
  })
}

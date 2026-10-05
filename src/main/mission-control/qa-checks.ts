import { createHash } from "crypto"
import { lstat, readdir, readFile } from "fs/promises"
import { tmpdir } from "os"
import { join, posix } from "path"
import * as features from "../db/repositories/features"
import * as mergeQueue from "../db/repositories/merge-queue"
import * as processes from "../db/repositories/processes"
import * as waveGates from "../db/repositories/wave-gates"
import type {
  CheckResult,
  ChecksSnapshot,
  MissionControlRunLink,
  PhaseRunQaChecks,
  ProcessPhaseRun,
  ProcessRun,
  UserStory,
  WaveGate,
} from "../db/types"
import { resolveInWorkspaceReal } from "../agent/tools/workspace"
import { gitSucceeds, runGit } from "../agent/subagents/worktrees"
import { CommandError, runLongCommand } from "./long-command"
import {
  describeServices,
  recipeForLink,
  serviceEnvironment,
  startServices,
} from "./app-launch"
import {
  substitutePorts,
  type AppLaunch,
} from "../../shared/mission-control/app-launch"
import { QA_ROLE, checksForRun } from "./qa-scope"
import { evidenceDir } from "./evidence"
import { runPlaywrightCheck } from "./playwright-runner"
import { waitForTestBrowser } from "./playwright-install"
import { recordEvent } from "../db/repositories/mc-events"
import { gateWaivers, waivedCriteria } from "./gate-fixes"
import { holdPhaseClock } from "../tasks/process/phase-clock"
import {
  userStoryCriteria,
  type UserStoryCriterion,
} from "./user-story-objective"
import {
  automatedChecks,
  localImports,
  unreachableAppProblem,
  validateChecksManifest,
  type AutomatedCheck,
  type ChecksManifest,
} from "./checks-manifest"
import {
  MANIFEST_DIR,
  storyManifestPath,
  userStoryRef,
} from "../../shared/mission-control/checks"

// QA acceptance checks (plans 109.02, 110). The milestone's wave gate writes
// and runs the Playwright suite against the integrated app; a user story's
// test step verifies by exploring the running app and runs no checks (plan
// 110.04). The harness runs checks for QA (`run_checks`) and records the
// results on the phase run, never from model arguments.

// What a QA seat's step does:
// - "explore": a user story run's proof step. QA verifies each criterion in
//   the running app and records an evidence-backed proof; no checks.
// - "author": any other QA step in a user story run. Only playbooks from
//   before plan 110.04 have one (the `checks` step): it writes the story's
//   manifest, which the wave gate later adopts.
// - "smoke": the proof step of a merge conflict's resolution (plan 110.05).
//   QA starts the app, runs the project's own tests, and spot-checks the
//   story's criteria by exploration; no checks. The wave gate is the real
//   check.
// - "gate": the QA proof step of a milestone's wave gate (plan 110.02).
// Other roles and other runs have no QA checks step.
export type QaStepKind = "author" | "explore" | "smoke" | "gate"

export function qaStepKind(input: {
  role: string | null | undefined
  proofStep: boolean
  link: MissionControlRunLink | null | undefined
}): QaStepKind | null {
  if (input.role !== QA_ROLE || !input.link) return null
  if (!input.link.userStoryId)
    return input.link.hook === "after_each_wave" && input.proofStep
      ? "gate"
      : null
  if (!input.proofStep) return "author"
  return input.link.hook === "after_each_user_story" ? "smoke" : "explore"
}

// ── the story's checks context ──────────────────────────────────────────────

export interface StoryChecks {
  checksDir: string
  storyRef: string
  criterionIds: string[]
  manifestPath: string
  // The workspace's app launch recipe: the services a check may declare.
  recipe: AppLaunch
}

export function storyChecks(link: MissionControlRunLink): StoryChecks | null {
  const { checksDir, storyRef } = checksForRun(link)
  const userStory = link.userStoryId
    ? features.getUserStory(link.userStoryId)
    : null
  const feature = features.getFeature(link.featureId)
  const milestone = userStory
    ? features.getMilestone(userStory.milestoneId)
    : null
  if (!storyRef || !userStory || !feature || !milestone) return null
  return {
    checksDir,
    storyRef,
    criterionIds: userStoryCriteria(userStory).map((c) => c.id),
    manifestPath: storyManifestPath(checksDir, storyRef),
    recipe: recipeForLink(link),
  }
}

// ── the wave gate's checks context (plan 110.02) ────────────────────────────

export interface GateCheckStory {
  userStory: UserStory
  storyRef: string
  criteria: UserStoryCriterion[]
  batch: boolean
  // Criteria the user accepted as is at an earlier gate (plan 110.03): not
  // triaged, whatever their checks do.
  waived: string[]
}

export interface GateChecks {
  checksDir: string
  recipe: AppLaunch
  gate: WaveGate
  milestoneId: string
  // Every story of the feature, by ref: the batch, and the stories whose
  // checks earlier gates (or 109.02's per-story checks) put in the suite.
  stories: Map<string, GateCheckStory>
}

export function gateChecks(link: MissionControlRunLink): GateChecks | null {
  if (link.hook !== "after_each_wave" || link.userStoryId) return null
  const gate = waveGates.getWaveGateByRun(link.playbookRunId)
  const feature = features.getFeature(link.featureId)
  if (!gate || !feature) return null
  const batch = new Set(gate.storyIds)
  const waivers = gateWaivers(feature.id, gate.id)
  const stories = new Map<string, GateCheckStory>()
  for (const milestone of features.listMilestones(feature.id))
    for (const story of features.listUserStories(milestone.id)) {
      if (story.status === "cancelled") continue
      const storyRef = userStoryRef({
        featureKey: feature.key,
        milestoneKey: milestone.key,
        userStoryKey: story.key,
      })
      stories.set(storyRef, {
        userStory: story,
        storyRef,
        criteria: userStoryCriteria(story),
        batch: batch.has(story.id),
        waived: waivedCriteria(story, waivers),
      })
    }
  return {
    checksDir: checksForRun(link).checksDir,
    recipe: recipeForLink(link),
    gate,
    milestoneId: gate.milestoneId,
    stories,
  }
}

// ── snapshots ───────────────────────────────────────────────────────────────

export async function isRepository(root: string): Promise<boolean> {
  return gitSucceeds(root, ["rev-parse", "--is-inside-work-tree"])
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

// Files under the checks directory. In a repository: tracked and untracked
// files git doesn't ignore, so test output (reports, traces) is left out.
async function checksFiles(
  root: string,
  checksDir: string,
  repo: boolean
): Promise<string[]> {
  if (repo) {
    const out = await runGit(root, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      checksDir,
    ])
    const paths = [...new Set(out.split("\0").filter(Boolean))]
    const present = await Promise.all(
      paths.map(async (p) => ((await isFile(join(root, p))) ? p : null))
    )
    return present.filter((p): p is string => !!p).sort()
  }
  const found: string[] = []
  const walk = async (dir: string) => {
    let entries
    try {
      entries = await readdir(join(root, dir), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") await walk(rel)
      } else if (entry.isFile()) found.push(rel)
    }
  }
  await walk(checksDir)
  return found.sort()
}

// Hash files: git blob ids in a repository, SHA-256 otherwise.
async function hashFiles(
  root: string,
  paths: string[],
  repo: boolean
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {}
  if (repo) {
    for (let i = 0; i < paths.length; i += 200) {
      const chunk = paths.slice(i, i + 200)
      const out = await runGit(root, ["hash-object", "--", ...chunk])
      const ids = out.split("\n")
      chunk.forEach((p, j) => (hashes[p] = ids[j]))
    }
    return hashes
  }
  for (const p of paths)
    hashes[p] = createHash("sha256")
      .update(await readFile(join(root, p)))
      .digest("hex")
  return hashes
}

function combinedHash(files: Record<string, string>): string {
  const hash = createHash("sha256")
  for (const path of Object.keys(files).sort())
    hash.update(`${path}\0${files[path]}\n`)
  return hash.digest("hex")
}

// The whole checks directory, not only one story's specs: shared page
// objects and fixtures are part of what a check asserts. A wave gate stamps
// its results with this hash (plan 110.02).
export async function snapshotChecks(
  root: string,
  checksDir: string
): Promise<ChecksSnapshot> {
  const repo = await isRepository(root)
  const files = await hashFiles(
    root,
    await checksFiles(root, checksDir, repo),
    repo
  )
  return { checksDir, hash: combinedHash(files), files }
}

// ── manifests ───────────────────────────────────────────────────────────────

export type ManifestRead =
  | { ok: true; manifest: ChecksManifest; warnings: string[] }
  | { ok: false; message: string }

export async function readStoryManifest(
  root: string,
  input: {
    manifestPath: string
    criterionIds: string[]
    storyRef: string
    recipe: AppLaunch
  }
): Promise<ManifestRead> {
  let text: string
  try {
    text = await readFile(
      await resolveInWorkspaceReal(root, input.manifestPath),
      "utf8"
    )
  } catch {
    return {
      ok: false,
      message: `There is no check manifest at \`${input.manifestPath}\`. Write it before you finish this step.`,
    }
  }
  const result = validateChecksManifest({
    text,
    criterionIds: input.criterionIds,
    storyRef: input.storyRef,
    serviceKeys: input.recipe.services.map((service) => service.key),
  })
  if (!result.ok)
    return {
      ok: false,
      message: `The check manifest at \`${input.manifestPath}\` isn't valid:\n${result.errors.map((e) => `- ${e}`).join("\n")}`,
    }
  return result
}

export interface ManifestSet {
  manifests: Array<{ storyRef: string; manifest: ChecksManifest }>
  problems: string[]
  // Per story ref, why its manifest couldn't be used.
  invalid: Record<string, string>
}

// The wave gate's suite: every manifest in the checks directory that belongs
// to one of the feature's stories (the accumulated suite), and a problem for
// each batch story without a usable one.
export async function gateManifests(
  root: string,
  gate: Pick<GateChecks, "checksDir" | "recipe" | "stories">
): Promise<ManifestSet> {
  const names = await readdir(
    await resolveInWorkspaceReal(root, `${gate.checksDir}/${MANIFEST_DIR}`)
  ).catch(() => [] as string[])
  const present = new Set(
    names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5))
  )
  const set: ManifestSet = { manifests: [], problems: [], invalid: {} }
  for (const [ref, story] of [...gate.stories].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (!present.has(ref)) {
      if (story.batch) {
        const message = `There is no check manifest at \`${storyManifestPath(gate.checksDir, ref)}\` for ${story.userStory.key}, which is in this gate's batch. Write it.`
        set.problems.push(message)
        set.invalid[ref] = message
      }
      continue
    }
    const read = await readStoryManifest(root, {
      manifestPath: storyManifestPath(gate.checksDir, ref),
      criterionIds: story.criteria.map((c) => c.id),
      storyRef: ref,
      recipe: gate.recipe,
    })
    if (read.ok) set.manifests.push({ storyRef: ref, manifest: read.manifest })
    else {
      set.problems.push(read.message)
      set.invalid[ref] = read.message
    }
  }
  return set
}

// The manifest run_checks uses outside a gate: the story's own (a checks step
// from before plan 110.04).
async function manifestsForRun(
  root: string,
  story: StoryChecks
): Promise<ManifestSet> {
  const set: ManifestSet = { manifests: [], problems: [], invalid: {} }
  const read = await readStoryManifest(root, story)
  if (read.ok)
    set.manifests.push({ storyRef: story.storyRef, manifest: read.manifest })
  else {
    set.problems.push(read.message)
    set.invalid[story.storyRef] = read.message
  }
  return set
}

// ── the run's QA checks state ───────────────────────────────────────────────

export function rootRun(run: ProcessRun): ProcessRun {
  let current = run
  for (let depth = 0; current.parentPhaseRunId && depth < 16; depth++) {
    const parent = processes.getPhaseRun(current.parentPhaseRunId)
    const parentRun = parent ? processes.getProcessRun(parent.runId) : undefined
    if (!parentRun) break
    current = parentRun
  }
  return current
}

export function updateQaChecks(
  phaseRunId: string,
  patch: (current: PhaseRunQaChecks) => PhaseRunQaChecks
): PhaseRunQaChecks {
  const current = processes.getPhaseRun(phaseRunId)?.qaChecks ?? {}
  const next = patch(current)
  processes.updatePhaseRun(phaseRunId, { qaChecks: next })
  return next
}

// Server-side context of a QA tool call: the run, the step, and the story
// (or, at a wave gate, the gate) whose checks it runs.
export type QaToolContext =
  | ({
      ok: true
      root: ProcessRun
      phaseRun: ProcessPhaseRun
      checksDir: string
      recipe: AppLaunch
    } & (
      | { kind: "author"; story: StoryChecks }
      | { kind: "gate"; gate: GateChecks }
    ))
  | { ok: false; code: string; message: string }

export function qaToolContext(
  processRunId: string,
  phaseRunId: string
): QaToolContext {
  const run = processes.getProcessRun(processRunId)
  const phaseRun = processes.getPhaseRun(phaseRunId)
  if (!run || !phaseRun)
    return {
      ok: false,
      code: "unavailable",
      message: "This run is no longer available.",
    }
  const root = rootRun(run)
  const seat = phaseRun.seatAddress
    ? root.seatBindings?.seats[phaseRun.seatAddress]
    : undefined
  const phase = processes.getPhase(phaseRun.phaseId)
  const kind = qaStepKind({
    role: seat?.role,
    proofStep: !!phase?.proofStep,
    link: root.missionControl,
  })
  const base = { ok: true as const, root, phaseRun }
  if (kind === "explore")
    return {
      ok: false,
      code: "exploratory_step",
      message:
        "A user story's test step runs no checks: verify each criterion by exercising the running app yourself and save evidence. The milestone's acceptance gate writes and runs the Playwright suite after the story merges.",
    }
  if (kind === "smoke")
    return {
      ok: false,
      code: "smoke_step",
      message:
        "A merge's smoke step runs no checks: start the app, run the project's own tests, and spot-check the story's criteria in the running app. The milestone's acceptance gate runs the Playwright suite once the wave merges.",
    }
  if (kind === "gate") {
    const gate = gateChecks(root.missionControl!)
    if (gate)
      return {
        ...base,
        kind,
        gate,
        checksDir: gate.checksDir,
        recipe: gate.recipe,
      }
  } else if (kind) {
    const story = storyChecks(root.missionControl!)
    if (story)
      return {
        ...base,
        kind,
        story,
        checksDir: story.checksDir,
        recipe: story.recipe,
      }
  }
  return {
    ok: false,
    code: "unavailable",
    message:
      "QA checks are only available to a QA seat in a Mission Control user story run or acceptance gate.",
  }
}

// ── run_checks ──────────────────────────────────────────────────────────────

const TAIL_CHARS = 2000

function tail(text: string, chars = TAIL_CHARS): string {
  const trimmed = text.trim()
  return trimmed.length > chars ? `…${trimmed.slice(-chars)}` : trimmed
}

// What a check needs from the app: its declared services started (owned by
// the phase run, so they're reused across checks and stopped at phase end)
// and their URLs. A service that won't start fails the check with its output.
async function checkServices(
  root: string,
  check: AutomatedCheck,
  app: { owner: string; recipe: AppLaunch },
  signal?: AbortSignal
): Promise<
  | {
      ok: true
      command: string | null
      env: Record<string, string>
    }
  | { ok: false; output: string }
> {
  const command = check.runner === "command" ? check.command : null
  if (!check.services.length) return { ok: true, command, env: {} }
  const started = await startServices({
    owner: app.owner,
    root,
    recipe: app.recipe,
    keys: check.services,
    signal,
  })
  if (!started.ok)
    return {
      ok: false,
      output: `${started.message}\n${describeServices(started.services)}`,
    }
  const { env, ports } = serviceEnvironment(started.services)
  try {
    return {
      ok: true,
      command: command === null ? null : substitutePorts(command, null, ports),
      env,
    }
  } catch (err) {
    return {
      ok: false,
      output: `The check's command: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

// Failures that mean the check never reached the app.
const UNREACHABLE =
  /net::ERR_(?:CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|EMPTY_RESPONSE|ADDRESS_UNREACHABLE)|Cannot navigate to invalid URL|\bInvalid URL\b|\bECONNREFUSED\b/

// Why a failed check never reached the app, or null (plan 109.07).
export function unreachableReason(
  result: Pick<CheckResult, "passed" | "outputTail" | "playwright">,
  recipe: AppLaunch
): string | null {
  if (result.passed) return null
  const text = [
    result.outputTail,
    ...(result.playwright?.tests.map((t) => t.error ?? "") ?? []),
  ].join("\n")
  const match = UNREACHABLE.exec(text)
  if (!match) return null
  return `Couldn't reach the app (${match[0]}), so this says nothing about the criterion. ${
    recipe.services.length
      ? "Check that it declares the services it needs and navigates relative to its baseURL."
      : "This workspace has no app launch recipe: nothing starts the app and Playwright gets no baseURL, so the check must start the app itself (a fixture that starts it on a free port and provides baseURL)."
  }`
}

async function runOne(
  root: string,
  check: AutomatedCheck & { criterionId: string },
  storyRef: string,
  attempt: number,
  app: { owner: string; recipe: AppLaunch; checksDir: string },
  signal?: AbortSignal
): Promise<CheckResult> {
  const result = await runOneCheck(root, check, storyRef, attempt, app, signal)
  if (result.notVerifiable) return result
  const unreachable = unreachableReason(result, app.recipe)
  return unreachable ? { ...result, unreachable } : result
}

async function runOneCheck(
  root: string,
  check: AutomatedCheck & { criterionId: string },
  storyRef: string,
  attempt: number,
  app: { owner: string; recipe: AppLaunch; checksDir: string },
  signal?: AbortSignal
): Promise<CheckResult> {
  const started = Date.now()
  const base = {
    checkId: check.id,
    criterionId: check.criterionId,
    storyRef,
    attempt,
    ranAt: started,
  }
  let cwd: string
  try {
    cwd = await resolveInWorkspaceReal(root, check.cwd || ".")
  } catch (err) {
    return {
      ...base,
      passed: false,
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      outputTail: `cwd "${check.cwd}": ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const services = await checkServices(root, check, app, signal)
  if (!services.ok)
    return {
      ...base,
      passed: false,
      exitCode: null,
      timedOut: false,
      durationMs: Date.now() - started,
      outputTail: tail(services.output),
    }
  if (check.runner === "playwright") {
    const outputDir = evidenceDir(app.owner)
    let checksDir: string
    try {
      checksDir = await resolveInWorkspaceReal(root, app.checksDir)
    } catch (err) {
      return {
        ...base,
        passed: false,
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        outputTail: `checks directory "${app.checksDir}": ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    const run = await runPlaywrightCheck({
      cwd,
      checksDir,
      storyRef,
      check,
      env: services.env,
      // Traces and screenshots of failures are evidence, kept with the
      // step's other evidence (never in the repo).
      outputDir: join(
        outputDir ?? join(tmpdir(), "north-star-evidence", app.owner),
        "playwright",
        `${check.id}-${attempt}`
      ),
      signal,
    })
    return {
      ...base,
      passed: run.passed,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      durationMs: Date.now() - started,
      outputTail: tail(run.output),
      playwright: {
        ...run.runner,
        tests: run.tests,
        artifacts: run.artifacts,
      },
      ...(run.notVerifiable ? { notVerifiable: run.notVerifiable } : {}),
    }
  }
  try {
    const { stdout, stderr } = await runLongCommand(services.command!, {
      cwd,
      // CI keeps test runners non-interactive (Playwright otherwise serves
      // its HTML report after a failure and waits for Ctrl+C).
      env: {
        ...process.env,
        CI: "1",
        FORCE_COLOR: "0",
        ...services.env,
      } as Record<string, string>,
      quietLimitMs: check.timeoutMs,
      overallLimitMs: check.timeoutMs,
      signal,
    })
    return {
      ...base,
      passed: true,
      exitCode: 0,
      timedOut: false,
      durationMs: Date.now() - started,
      outputTail: tail(`${stdout}\n${stderr}`),
    }
  } catch (err) {
    const failed = err instanceof CommandError ? err : null
    return {
      ...base,
      passed: false,
      exitCode: failed?.code ?? null,
      timedOut:
        failed?.stoppedFor === "quiet" || failed?.stoppedFor === "overall",
      durationMs: Date.now() - started,
      outputTail: tail(
        failed
          ? `${failed.stdout}\n${failed.stderr}\n${failed.message}`
          : String(err)
      ),
    }
  }
}

export type RunChecksOutcome =
  | {
      ok: true
      results: CheckResult[]
      exploratory: Array<{
        storyRef: string
        criterionId: string
        id: string
        note: string
      }>
      problems: string[]
    }
  | { ok: false; code: string; message: string }

// A Playwright check on the bundled runner that couldn't launch a browser
// (no Chrome, and the test browser not downloaded or allowed yet). Checks
// that only use `request` never launch one, so they run either way.
function neededBrowser(result: CheckResult): boolean {
  return (
    !!result.notVerifiable &&
    result.playwright?.source === "bundled" &&
    result.playwright.browser === "missing"
  )
}

// Ask the user for the test browser and wait for it, rather than record the
// checks as not verifiable and burn the attempt. The wait doesn't count
// toward the phase's time limit. False when stopped first.
async function awaitTestBrowser(
  ctx: Extract<QaToolContext, { ok: true }>,
  signal?: AbortSignal
): Promise<boolean> {
  const link = ctx.root.missionControl
  if (link)
    recordEvent({
      featureId: link.featureId,
      type: "test_browser_needed",
      userStoryId: link.userStoryId,
      seatAddress: ctx.phaseRun.seatAddress,
      refId: ctx.phaseRun.id,
    })
  const release = holdPhaseClock(ctx.phaseRun.id)
  try {
    return await waitForTestBrowser(signal)
  } finally {
    release()
  }
}

// Run the story's automated checks (or the given ones) in the worktree. A
// failing check is rerun once and both attempts are recorded, so flake shows
// instead of hiding. Results are appended to the phase run.
export async function runQaChecks(input: {
  processRunId: string
  phaseRunId: string
  workspace: string
  checkIds?: string[]
  signal?: AbortSignal
}): Promise<RunChecksOutcome> {
  const ctx = qaToolContext(input.processRunId, input.phaseRunId)
  if (!ctx.ok) return ctx
  const { manifests, problems } =
    ctx.kind === "gate"
      ? await gateManifests(input.workspace, ctx.gate)
      : await manifestsForRun(input.workspace, ctx.story)
  if (!manifests.length)
    return {
      ok: false,
      code: "no_manifest",
      message: problems.join("\n") || "No check manifest was found.",
    }
  const all = manifests.flatMap(({ storyRef, manifest }) =>
    automatedChecks(manifest).map((check) => ({ storyRef, check }))
  )
  const exploratory = manifests.flatMap(({ storyRef, manifest }) =>
    Object.entries(manifest.criteria).flatMap(([criterionId, checks]) =>
      checks
        .filter((c) => c.kind === "exploratory")
        .map((c) => ({
          storyRef,
          criterionId,
          id: c.id,
          note: (c as { note: string }).note,
        }))
    )
  )
  let selected = all
  if (input.checkIds?.length) {
    const wanted = new Set(input.checkIds)
    selected = all.filter(({ check }) => wanted.has(check.id))
    const unknown = [...wanted].filter(
      (id) => !all.some(({ check }) => check.id === id)
    )
    if (unknown.length)
      return {
        ok: false,
        code: "unknown_check",
        message: `No automated check with id ${unknown.map((id) => `"${id}"`).join(", ")}. Automated checks: ${all.map(({ check }) => check.id).join(", ") || "none"}.`,
      }
  }
  const app = {
    owner: ctx.phaseRun.id,
    recipe: ctx.recipe,
    checksDir: ctx.checksDir,
  }
  // At a wave gate a result counts only for the suite it ran against.
  const suiteHash =
    ctx.kind === "gate"
      ? (await snapshotChecks(input.workspace, ctx.checksDir)).hash
      : undefined
  const key = (storyRef: string, checkId: string) => `${storyRef}\0${checkId}`
  const runAll = async (list: typeof selected) => {
    const byCheck = new Map<string, CheckResult[]>()
    for (const { storyRef, check } of list) {
      if (input.signal?.aborted) break
      const first = await runOne(
        input.workspace,
        check,
        storyRef,
        1,
        app,
        input.signal
      )
      const attempts = [first]
      // A check that couldn't run (no browser yet) or never reached the app
      // would only fail the same way again.
      if (
        !first.passed &&
        !first.notVerifiable &&
        !first.unreachable &&
        !input.signal?.aborted
      )
        attempts.push(
          await runOne(input.workspace, check, storyRef, 2, app, input.signal)
        )
      byCheck.set(key(storyRef, check.id), attempts)
    }
    return byCheck
  }
  const byCheck = await runAll(selected)
  // Checks that needed the browser wait for it, then run again.
  const waiting = selected.filter(({ storyRef, check }) =>
    byCheck.get(key(storyRef, check.id))?.some(neededBrowser)
  )
  if (
    waiting.length &&
    !input.signal?.aborted &&
    (await awaitTestBrowser(ctx, input.signal))
  )
    for (const [k, attempts] of await runAll(waiting)) byCheck.set(k, attempts)
  const results = selected.flatMap(({ storyRef, check }) =>
    (byCheck.get(key(storyRef, check.id)) ?? []).map((result) =>
      suiteHash ? { ...result, suiteHash } : result
    )
  )
  updateQaChecks(ctx.phaseRun.id, (current) => ({
    ...current,
    results: [...(current.results ?? []), ...results],
  }))
  return { ok: true, results, exploratory, problems }
}

// A compact summary for the model: per check, pass/fail/flaky, and the output
// tail of anything that didn't pass on its first attempt.
export function summarizeCheckRun(
  outcome: Extract<RunChecksOutcome, { ok: true }>
): string {
  const byCheck = new Map<string, CheckResult[]>()
  for (const r of outcome.results)
    byCheck.set(r.checkId, [...(byCheck.get(r.checkId) ?? []), r])
  const lines: string[] = []
  let passed = 0
  let failed = 0
  let flaky = 0
  let notVerifiable = 0
  let unreachable = 0
  for (const [id, attempts] of byCheck) {
    const [first, second] = attempts
    const status = first.notVerifiable
      ? "not verifiable"
      : first.unreachable
        ? "couldn't reach the app"
        : first.passed
          ? "passed"
          : second?.passed
            ? "flaky (failed, then passed on retry)"
            : first.timedOut
              ? "failed (timed out)"
              : "failed"
    if (first.notVerifiable) notVerifiable++
    else if (first.unreachable) unreachable++
    else if (first.passed) passed++
    else if (second?.passed) flaky++
    else failed++
    lines.push(
      `- ${id} (${first.storyRef} ${first.criterionId}): ${status}, ${Math.round(first.durationMs / 100) / 10}s`
    )
    if (first.notVerifiable) {
      lines.push(`  ${first.notVerifiable}`)
      continue
    }
    if (first.unreachable) lines.push(`  ${first.unreachable}`)
    // A Playwright check's tests, with the error of each that didn't pass,
    // and where its failure traces and screenshots were saved.
    const last = attempts[attempts.length - 1]
    if (last.playwright) {
      for (const test of last.playwright.tests)
        lines.push(
          `  ${test.status === "passed" ? "✓" : test.status === "skipped" ? "-" : "✗"} ${test.title} (${test.status})${
            test.error
              ? `\n${test.error
                  .split("\n")
                  .map((l) => `      ${l}`)
                  .join("\n")}`
              : ""
          }`
        )
      if (last.playwright.artifacts.length)
        lines.push(`  saved: ${last.playwright.artifacts.join(", ")}`)
    }
    if (!first.passed)
      for (const attempt of attempts)
        lines.push(
          `  attempt ${attempt.attempt} output (exit ${attempt.exitCode ?? "none"}):\n${attempt.outputTail
            .split("\n")
            .map((l) => `    ${l}`)
            .join("\n")}`
        )
  }
  const head = outcome.results.length
    ? `Ran ${byCheck.size} automated check${byCheck.size === 1 ? "" : "s"}: ${passed} passed, ${failed} failed, ${flaky} flaky${notVerifiable ? `, ${notVerifiable} not verifiable` : ""}${unreachable ? `, ${unreachable} couldn't reach the app` : ""}. Results are recorded on this step.`
    : "No automated checks to run."
  return [
    head,
    ...lines,
    ...(outcome.exploratory.length
      ? [
          "",
          "Exploratory checks (verify these yourself in the running app):",
          ...outcome.exploratory.map(
            (e) => `- ${e.id} (${e.storyRef} ${e.criterionId}): ${e.note}`
          ),
        ]
      : []),
    ...(outcome.problems.length
      ? ["", "Manifests that couldn't be used:", ...outcome.problems]
      : []),
  ].join("\n")
}

// ── the checks step: completion and freeze ──────────────────────────────────

// A local module's source: the specifier as written, or with a script
// extension or as a folder's index. Null when it can't be read.
async function readModule(
  root: string,
  from: string,
  specifier: string
): Promise<string | null> {
  const base = posix.join(posix.dirname(from), specifier)
  const candidates = [
    base,
    ...[".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts"].flatMap((ext) => [
      `${base}${ext}`,
      `${base}/index${ext}`,
    ]),
  ]
  for (const candidate of candidates) {
    try {
      const path = await resolveInWorkspaceReal(root, candidate)
      if (await isFile(path)) return await readFile(path, "utf8")
    } catch {
      // Outside the workspace or missing: try the next.
    }
  }
  return null
}

// With no app launch recipe, Playwright checks must start the app themselves
// (plan 109.07). The checks step can't finish with one that can't reach it:
// once frozen, the test step couldn't fix it.
export async function unreachableChecks(
  root: string,
  story: Pick<StoryChecks, "checksDir" | "recipe">,
  manifest: ChecksManifest
): Promise<string[]> {
  if (story.recipe.services.length) return []
  const problems: string[] = []
  for (const check of automatedChecks(manifest)) {
    if (check.runner !== "playwright" || check.services.length) continue
    const specPath = posix.join(story.checksDir, check.spec)
    const specText = await readModule(
      root,
      specPath,
      `./${posix.basename(specPath)}`
    )
    if (specText === null) continue
    const helperTexts: string[] = []
    for (const specifier of localImports(specText)) {
      const text = await readModule(root, specPath, specifier)
      if (text !== null) helperTexts.push(text)
    }
    const problem = unreachableAppProblem({
      id: check.id,
      spec: check.spec,
      specText,
      helperTexts,
    })
    if (problem) problems.push(problem)
  }
  return problems
}

// Run when a checks step's worker finishes (a playbook from before plan
// 110.04): the step completes only when the story's manifest exists and
// validates, so the wave gate can adopt it. Nothing is frozen.
export async function completeAuthorStep(input: {
  link: MissionControlRunLink
  workspace: string
}): Promise<{ ok: true; warnings: string[] } | { ok: false; message: string }> {
  const story = storyChecks(input.link)
  if (!story)
    return { ok: false, message: "The user story is no longer available." }
  const read = await readStoryManifest(input.workspace, story)
  if (!read.ok) return read
  const unreachable = await unreachableChecks(
    input.workspace,
    story,
    read.manifest
  )
  if (unreachable.length)
    return {
      ok: false,
      message: `These checks can't reach the app, so they could never verify their criteria:\n${unreachable.map((p) => `- ${p}`).join("\n")}`,
    }
  return { ok: true, warnings: read.warnings }
}

// How a check reaches the running app: through the recipe's services, or,
// with no recipe, a shared fixture that starts the app itself (plan 109.07).
// Shared by the checks step and the wave gate (plan 110.02).
export function appGuidance(
  story: Pick<StoryChecks, "checksDir" | "recipe">
): string[] {
  return [...appStartGuidance(story), NODE_SCRIPT_GUIDANCE]
}

// A check that starts a Node script (the fixture above, or a criterion about
// how the server starts): the user may have no Node, and the harness makes
// process.execPath run scripts as Node (plan 110, the runner hook).
const NODE_SCRIPT_GUIDANCE =
  '- A check that runs a Node script itself (the app\'s server, or a helper) starts it with `process.execPath` (`spawn(process.execPath, ["server.js"])`, or `fork`), not `node`: Node may not be installed, and the harness makes `process.execPath` run scripts as Node.'

function appStartGuidance(
  story: Pick<StoryChecks, "checksDir" | "recipe">
): string[] {
  return story.recipe.services.length
    ? [
        `- A check that needs the running app lists the services it needs in \`"services"\` (from this workspace's app launch recipe: ${story.recipe.services.map((service) => `\`${service.key}\``).join(", ")}). \`run_checks\` starts them first, on free ports. A Playwright check gets the first one as its \`baseURL\`; any check gets \`BASE_URL\` (the first one), \`APP_<KEY>_URL\` and \`APP_<KEY>_PORT\` in its environment, and a command check \`{port:<key>}\` in its command. Don't hard-code ports or start the app inside the check.`,
      ]
    : [
        `- This workspace has no app launch recipe, so \`run_checks\` starts nothing and gives Playwright no \`baseURL\`. A check that needs the running app starts it itself, through one shared fixture in \`${story.checksDir}/fixtures/\` (reuse it when it exists): a worker-scoped fixture that picks a free port (listen on port 0, read it, close), starts the app on it, waits until it answers over HTTP, provides that URL as \`baseURL\`, and stops the app when the worker ends. Specs import \`test\` and \`expect\` from that fixture and navigate relative to \`baseURL\` (\`page.goto("/")\`).`,
        "- The fixture decides how to start the app when it runs: the project's start command with `PORT` set when there is one (a package.json `start` or `dev` script, or `node server.js`), and otherwise a small `node:http` server over the workspace's static files (index.html and its assets). Checks run with their `cwd` (the workspace root by default) as the current directory. Never hard-code a port, never read `BASE_URL` (nothing sets it), and don't open files with `file://`: a check that can't reach the app is refused.",
      ]
}

// The checks step's kickoff: what to write and where, and how it completes.
export function authorStepNote(story: StoryChecks): string {
  return [
    "## Writing the acceptance checks",
    "Write checks for every acceptance criterion from the spec alone. Don't read or wait for the implementation: it doesn't exist yet, and checks shaped by the code tend to confirm the code instead of the criteria. Edit only the checks directory.",
    "The app doesn't exist yet, so there's no browser in this step. For UI criteria, write Playwright specs from the spec using role and text locators, and mark anything that needs eyes on the result as `exploratory`.",
    `- Reuse the page objects, fixtures, and helpers already in \`${story.checksDir}/\`. Add methods to them rather than rewriting them: other stories' checks depend on them.`,
    `- Tag each test with \`@${story.storyRef}\` and its criterion id.`,
    `- Write the manifest at \`${story.manifestPath}\`. It maps each criterion id to its checks:`,
    "```json",
    `{ "criteria": {`,
    `  "AC-1": [{ "id": "ac1-short-name", "kind": "automated", "runner": "playwright", "spec": "area/feature.spec.ts", "grep": "@AC-1"${story.recipe.services.length ? `, "services": ["${story.recipe.services[0].key}"]` : ""} }],`,
    `  "AC-2": [{ "id": "ac2-short-name", "kind": "automated", "command": "<the project's test command> --grep \\"@${story.storyRef}.*@AC-2\\"", "cwd": "", "timeoutMs": 120000 }],`,
    `  "AC-3": [{ "id": "ac3-short-name", "kind": "exploratory", "note": "What to verify by hand in the running app" }]`,
    "} }",
    "```",
    `  A Playwright check (\`"runner": "playwright"\`) names a spec file relative to \`${story.checksDir}/\` and has no command: the harness runs it, selecting this story's tests by tag (\`grep\` narrows further). It runs on the project's own Playwright when it has one, and on North Star's bundled Playwright otherwise, so don't add Playwright (or anything else) to the project. Any other automated check is a command that exits 0 when the criterion holds; select this story's tests by tag, not by file, since a spec file holds several stories' tests. \`cwd\` is workspace-relative ("" for the root). Use \`exploratory\` only for what can't be checked mechanically (exact copy, visual layout); the test step verifies those in the running app.`,
    '- Playwright conventions: locate by `getByRole`, `getByLabel`, and `getByText`, not CSS selectors; navigate relative to `baseURL` (`page.goto("/login")`); one criterion per `test()`; and name the criterion in the title, e.g. `test("redirects to the dashboard @' +
      story.storyRef +
      ' @AC-1", …)`.',
    '- An Electron app is checked with `_electron` from `@playwright/test`: `import electronPath from "electron"`, then `const app = await _electron.launch({ executablePath: electronPath, args: ["path/to/main.js"] })` and `const window = await app.firstWindow()`, and assert on `window` like a page. Pass `executablePath` so the project\'s own Electron runs. The check starts the app itself, so it needs no services and no browser.',
    ...appGuidance(story),
    "- `run_checks` runs the manifest's automated checks. Use it to confirm each check runs and fails for the right reason: the feature isn't built yet, so assertion failures are expected now. A check reported as \"couldn't reach the app\" is not one of them: it never exercised its criterion, so fix it before you finish.",
    "- This step completes only when the manifest exists and validates. The test step verifies the story by exploring the running app; the milestone's acceptance gate runs these checks against the integrated app after the story merges, and corrects them there.",
  ].join("\n")
}

// ── the test step: exploration (plan 110.04) ────────────────────────────────

// How each criterion's verification is recorded and judged (plan 109.05).
function methodLines(): string[] {
  return [
    "### How each criterion was verified",
    "Every criterion in `record_proof` says how you verified it (`method`), and the harness checks the claim against what it recorded in this step:",
    "- `app_exercised`: you drove the running app. Cite the evidence paths `browser_screenshot` (or `save_evidence`) returned in `artifacts`. A criterion you saw hold in the app needs this.",
    "- `command`: a command you ran yourself (curl, the CLI, a script in your scratch directory). Quote what it printed in the evidence. `builder_tests`: only the builder's tests; allowed, but flagged on the user story.",
    "- `code_read`: you only read the code. That never makes a criterion met: record it `not_verifiable` with a reason.",
  ]
}

// The kickoff of a user story's test step: verify by exploring the running
// app in the story's worktree, with evidence. No checks to write or run: the
// wave gate writes the suite against the integrated app.
export function exploreStepNote(story: Pick<StoryChecks, "recipe">): string {
  const services = story.recipe.services
  return [
    "## Verifying by exploration",
    "Verify every acceptance criterion yourself in the running app, in this worktree, the way a user would. There are no checks to write or run in this step: once this story merges with the rest of its wave, the milestone's acceptance gate writes and runs the Playwright suite against the integrated app. Your job here is an honest, evidence-backed answer to whether this build meets each criterion, so obviously wrong work doesn't merge.",
    services.length
      ? `- Start the app with \`app_start\` (this workspace's app launch recipe: ${services.map((service) => `\`${service.key}\``).join(", ")}) and open the URL it gives you in the browser.`
      : "- This workspace has no app launch recipe. Start the app yourself in the background with the project's own start command (a package.json `start` or `dev` script, or `node server.js`) on a free port, or serve its static files with a small local server, then open its `http://localhost:<port>` URL in the browser. Stop it before you finish. If nothing in this worktree runs yet, say so and record what you could verify.",
    "- Call `browser_snapshot` before you interact and after the page changes. Exercise each criterion's happy path, then the edges it implies: empty and invalid input, repeating the action, errors.",
    "- The snapshot can leave things out. Before you decide some text or element isn't there, take a `browser_screenshot` and look: what the screenshot shows is what the user sees.",
    "- Take a `browser_screenshot` at the moment that shows each criterion holding (or failing), and cite its path. For what a screenshot can't show, save `browser_console` / `browser_network` output with `save_evidence: true`.",
    "- Keyboard-only criteria: use `browser_press_key` (Tab, Shift+Tab, Enter, Space, Escape, arrows) from the start of the page, never the pointer. Each press reports what has focus and whether it shows a visible focus indicator.",
    "- Layout and responsive criteria: use `browser_set_viewport` (for example 375 × 812, then 1280 × 800) and screenshot each size; it reports horizontal overflow. Restore with 0 × 0.",
    "- An app the browser can't drive (a CLI, an API, a desktop app): exercise it with commands and record `command` with what they printed.",
    "- A criterion your tools really can't exercise: record it `deferred` with the reason. The milestone's acceptance gate proves it with Playwright after this story merges. It doesn't block acceptance, but verify everything you can here, and never send the build back for something you couldn't check.",
    "- Write nothing in the repository. Throwaway scripts and notes go in your scratch directory.",
    "",
    ...methodLines(),
  ].join("\n")
}

// The kickoff of a merge conflict's smoke step (plan 110.05): the merged
// result starts, the project's own tests pass, and QA spot-checks the
// conflicted story's criteria in the running app. No checks to run: frozen
// contracts made the integrator rework round after round, and the wave gate
// proves the criteria properly once the wave merges.
export function smokeStepKickoff(link: MissionControlRunLink): string | null {
  const story = storyChecks(link)
  if (!story) return null
  const entry = mergeQueue.getMergeEntryByResolutionRun(link.playbookRunId)
  return smokeStepNote(story, entry?.conflictFiles ?? [])
}

export function smokeStepNote(
  story: Pick<StoryChecks, "recipe">,
  conflictFiles: readonly string[] = []
): string {
  const services = story.recipe.services
  return [
    "## Smoke-testing the merged result",
    "The integrator resolved a merge conflict in this worktree. Check that the merged result still works: a quick, honest pass, not a full verification. There are no checks to write or run: once the wave merges, the milestone's acceptance gate runs the Playwright suite against the integrated app.",
    services.length
      ? `1. **The app starts.** Start it with \`app_start\` (this workspace's app launch recipe: ${services.map((service) => `\`${service.key}\``).join(", ")}) and open the URL it gives you in the browser.`
      : "1. **The app starts.** This workspace has no app launch recipe. Start the app yourself in the background with the project's own start command (a package.json `start` or `dev` script, or `node server.js`) on a free port, or serve its static files with a small local server, then open its `http://localhost:<port>` URL in the browser. Stop it before you finish.",
    "2. **The project's own tests pass.** Run its test command (a package.json `test` script, `pytest`, `go test ./...`, or whatever the project uses) if it has one. Quote the summary line.",
    `3. **Spot-check the story's criteria.** Exercise each acceptance criterion briefly in the running app, starting with the ones the conflicted files${conflictFiles.length ? ` (${conflictFiles.map((f) => `\`${f}\``).join(", ")})` : ""} touch. Take a \`browser_screenshot\` that shows each one and cite its path.`,
    "- If the app doesn't start or the tests fail, record the verdict `rejected` and mark the criteria that breaks `not_met`, quoting the output in the evidence.",
    "- A criterion that fails here goes to the user, who can accept the merge as is, fix it themselves, or drop the criterion. Don't ask the integrator to rework the merge for a detail the criterion doesn't ask for.",
    "- Write nothing in the repository. Throwaway scripts and notes go in your scratch directory.",
    "",
    ...methodLines(),
  ].join("\n")
}

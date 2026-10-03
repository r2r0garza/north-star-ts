import { createHash } from "crypto"
import { lstat, readdir, readFile } from "fs/promises"
import { join } from "path"
import * as features from "../db/repositories/features"
import * as processes from "../db/repositories/processes"
import type {
  CheckResult,
  ChecksChange,
  ChecksSnapshot,
  MissionControlRunLink,
  PhaseRunQaChecks,
  ProcessPhaseRun,
  ProcessRun,
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
import { userStoryCriteria } from "./user-story-objective"
import {
  automatedChecks,
  validateChecksManifest,
  type AutomatedCheck,
  type ChecksManifest,
} from "./checks-manifest"
import {
  MANIFEST_DIR,
  SCRATCH_DIR,
  storyManifestPath,
  userStoryRef,
} from "../../shared/mission-control/checks"

// QA acceptance checks in a user story run (plan 109.02). The `checks` step
// writes them and a manifest; the harness freezes the checks directory when
// that step completes, runs the checks for QA (`run_checks`), and at the start
// of the test step reports anything that changed since the freeze. All state
// lives on phase runs and is written here, never from model arguments.

// What a QA seat's step does in a user story run: a proof step verifies; any
// other QA step authors checks. Other roles, and runs without a user story,
// have no QA checks step.
export type QaStepKind = "author" | "verify"

export function qaStepKind(input: {
  role: string | null | undefined
  proofStep: boolean
  link: MissionControlRunLink | null | undefined
}): QaStepKind | null {
  if (input.role !== QA_ROLE || !input.link?.userStoryId) return null
  return input.proofStep ? "verify" : "author"
}

// ── the story's checks context ──────────────────────────────────────────────

export interface StoryChecks {
  checksDir: string
  storyRef: string
  criterionIds: string[]
  manifestPath: string
  // The milestone's story refs → criterion ids, for reverify.
  milestoneStories: Map<string, string[]>
  // A conflict resolution re-verifying the merged result.
  reverify: boolean
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
  const milestoneStories = new Map<string, string[]>()
  for (const story of features.listUserStories(milestone.id))
    milestoneStories.set(
      userStoryRef({
        featureKey: feature.key,
        milestoneKey: milestone.key,
        userStoryKey: story.key,
      }),
      userStoryCriteria(story).map((c) => c.id)
    )
  return {
    checksDir,
    storyRef,
    criterionIds: userStoryCriteria(userStory).map((c) => c.id),
    manifestPath: storyManifestPath(checksDir, storyRef),
    milestoneStories,
    reverify: link.hook === "after_each_user_story",
    recipe: recipeForLink(link),
  }
}

// ── snapshots ───────────────────────────────────────────────────────────────

async function isRepository(root: string): Promise<boolean> {
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

// Hash files. In a repository these are git blob ids written to the object
// store, so a later drift report can diff the frozen version.
async function hashFiles(
  root: string,
  paths: string[],
  repo: boolean,
  options: { write: boolean } = { write: true }
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {}
  if (repo) {
    for (let i = 0; i < paths.length; i += 200) {
      const chunk = paths.slice(i, i + 200)
      const out = await runGit(root, [
        "hash-object",
        ...(options.write ? ["-w"] : []),
        "--",
        ...chunk,
      ])
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

// The whole checks directory, not only this story's specs: shared page
// objects and fixtures are part of what a check asserts.
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

// What changed between two snapshots, sorted by path. `isOwn` marks the
// story's own specs and manifest; everything else is shared.
export function diffSnapshots(
  before: ChecksSnapshot,
  after: ChecksSnapshot,
  isOwn: (path: string) => boolean
): ChecksChange[] {
  const paths = new Set([
    ...Object.keys(before.files),
    ...Object.keys(after.files),
  ])
  const changes: ChecksChange[] = []
  for (const path of [...paths].sort()) {
    const a = before.files[path]
    const b = after.files[path]
    if (a === b) continue
    changes.push({
      path,
      change: !a ? "added" : !b ? "deleted" : "modified",
      shared: !isOwn(path),
    })
  }
  return changes
}

// A file belongs to the story when it's the story's manifest or carries its
// tag. A deleted file is read back from the frozen git blob.
async function ownFiles(
  root: string,
  story: Pick<StoryChecks, "storyRef" | "manifestPath">,
  before: ChecksSnapshot,
  after: ChecksSnapshot,
  repo: boolean
): Promise<Set<string>> {
  const own = new Set<string>([story.manifestPath])
  const tag = `@${story.storyRef}`
  const paths = new Set([
    ...Object.keys(before.files),
    ...Object.keys(after.files),
  ])
  for (const path of paths) {
    if (before.files[path] === after.files[path]) continue
    let text: string | null = null
    if (after.files[path])
      text = await readFile(join(root, path), "utf8").catch(() => null)
    else if (repo)
      text = await runGit(root, ["cat-file", "-p", before.files[path]]).catch(
        () => null
      )
    if (text?.includes(tag)) own.add(path)
  }
  return own
}

// Line counts for modified files, from the frozen and current git blobs.
async function addLineCounts(
  root: string,
  changes: ChecksChange[],
  before: ChecksSnapshot,
  after: ChecksSnapshot
): Promise<void> {
  for (const change of changes) {
    if (change.change !== "modified") continue
    const out = await runGit(root, [
      "diff",
      "--numstat",
      before.files[change.path],
      after.files[change.path],
    ]).catch(() => "")
    const [added, removed] = out.split("\t")
    if (/^\d+$/.test(added) && /^\d+$/.test(removed)) {
      change.added = Number(added)
      change.removed = Number(removed)
    }
  }
}

export async function checksDrift(
  root: string,
  story: Pick<StoryChecks, "storyRef" | "manifestPath">,
  frozen: ChecksSnapshot
): Promise<{ current: ChecksSnapshot; changed: ChecksChange[] }> {
  const current = await snapshotChecks(root, frozen.checksDir)
  if (current.hash === frozen.hash) return { current, changed: [] }
  const repo = await isRepository(root)
  const own = await ownFiles(root, story, frozen, current, repo)
  const changed = diffSnapshots(frozen, current, (p) => own.has(p))
  if (repo) await addLineCounts(root, changed, frozen, current)
  return { current, changed }
}

// ── writes outside the checks directory ─────────────────────────────────────

// The worktree's changed and untracked files with their content hashes
// ("-" for deleted). Null outside a repository.
export async function worktreeChanges(
  root: string
): Promise<Record<string, string> | null> {
  if (!(await isRepository(root))) return null
  const list = (args: string[]) =>
    runGit(root, args)
      .then((out) => out.split("\0").filter(Boolean))
      .catch(() => [] as string[])
  // Changes against HEAD (staged or not, deletions included), plus untracked
  // files git doesn't ignore. A repository without commits has only the latter.
  const paths = [
    ...new Set([
      ...(await list(["diff", "--name-only", "-z", "--no-renames", "HEAD"])),
      ...(await list(["ls-files", "-z", "--others", "--exclude-standard"])),
    ]),
  ]
  const present: string[] = []
  const state: Record<string, string> = {}
  for (const p of paths)
    if (await isFile(join(root, p))) present.push(p)
    else state[p] = "-"
  Object.assign(
    state,
    await hashFiles(root, present, true, { write: false }).catch(() => ({}))
  )
  return state
}

// Paths whose state differs between two worktreeChanges snapshots, outside
// the given workspace-relative directories.
export function changedOutside(
  before: Record<string, string>,
  after: Record<string, string>,
  allowed: string[]
): string[] {
  const inside = (p: string) =>
    allowed.some((dir) => p === dir || p.startsWith(`${dir}/`))
  const paths = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...paths].filter((p) => before[p] !== after[p] && !inside(p)).sort()
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

// The manifests run_checks uses: the story's own, or, on reverify, every
// manifest of this milestone's stories present in the merged result.
async function manifestsForRun(
  root: string,
  story: StoryChecks
): Promise<{
  manifests: Array<{ storyRef: string; manifest: ChecksManifest }>
  problems: string[]
}> {
  const refs = [story.storyRef]
  if (story.reverify) {
    const names = await readdir(
      await resolveInWorkspaceReal(root, `${story.checksDir}/${MANIFEST_DIR}`)
    ).catch(() => [] as string[])
    for (const name of names.sort()) {
      const ref = name.replace(/\.json$/, "")
      if (name.endsWith(".json") && ref !== story.storyRef)
        if (story.milestoneStories.has(ref)) refs.push(ref)
    }
  }
  const manifests: Array<{ storyRef: string; manifest: ChecksManifest }> = []
  const problems: string[] = []
  for (const ref of refs) {
    const read = await readStoryManifest(root, {
      manifestPath: storyManifestPath(story.checksDir, ref),
      criterionIds: story.milestoneStories.get(ref) ?? story.criterionIds,
      storyRef: ref,
      recipe: story.recipe,
    })
    if (read.ok) manifests.push({ storyRef: ref, manifest: read.manifest })
    else problems.push(read.message)
  }
  return { manifests, problems }
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

function runPhaseRuns(root: ProcessRun): ProcessPhaseRun[] {
  const runs = [root]
  const phaseRuns: ProcessPhaseRun[] = []
  for (let i = 0; i < runs.length; i++)
    for (const phaseRun of processes.listPhaseRuns({ runId: runs[i].id })) {
      phaseRuns.push(phaseRun)
      const child = processes.getProcessRunByParentPhaseRunId(phaseRun.id)
      if (child) runs.push(child)
    }
  return phaseRuns
}

// The newest freeze anywhere in the run (the checks step's, or a re-freeze in
// the test step).
export function latestFreeze(root: ProcessRun) {
  return runPhaseRuns(root)
    .map((pr) => pr.qaChecks?.freeze)
    .filter((f) => !!f)
    .sort((a, b) => b!.frozenAt - a!.frozenAt)[0]
}

function updateQaChecks(
  phaseRunId: string,
  patch: (current: PhaseRunQaChecks) => PhaseRunQaChecks
): PhaseRunQaChecks {
  const current = processes.getPhaseRun(phaseRunId)?.qaChecks ?? {}
  const next = patch(current)
  processes.updatePhaseRun(phaseRunId, { qaChecks: next })
  return next
}

// Server-side context of a QA tool call: the run, the step, the story.
type QaToolContext =
  | {
      ok: true
      root: ProcessRun
      phaseRun: ProcessPhaseRun
      kind: QaStepKind
      story: StoryChecks
    }
  | { ok: false; code: string; message: string }

function qaToolContext(
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
  const story = root.missionControl ? storyChecks(root.missionControl) : null
  if (!kind || !story)
    return {
      ok: false,
      code: "unavailable",
      message:
        "QA checks are only available to a QA seat in a Mission Control user story run.",
    }
  return { ok: true, root, phaseRun, kind, story }
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
      command: string
      env: Record<string, string>
    }
  | { ok: false; output: string }
> {
  if (!check.services.length)
    return { ok: true, command: check.command, env: {} }
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
      command: substitutePorts(check.command, null, ports),
      env,
    }
  } catch (err) {
    return {
      ok: false,
      output: `The check's command: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

async function runOne(
  root: string,
  check: AutomatedCheck & { criterionId: string },
  storyRef: string,
  attempt: number,
  app: { owner: string; recipe: AppLaunch },
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
  try {
    const { stdout, stderr } = await runLongCommand(services.command, {
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
  const { manifests, problems } = await manifestsForRun(
    input.workspace,
    ctx.story
  )
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
  const results: CheckResult[] = []
  const app = { owner: ctx.phaseRun.id, recipe: ctx.story.recipe }
  for (const { storyRef, check } of selected) {
    if (input.signal?.aborted) break
    const first = await runOne(
      input.workspace,
      check,
      storyRef,
      1,
      app,
      input.signal
    )
    results.push(first)
    if (!first.passed && !input.signal?.aborted)
      results.push(
        await runOne(input.workspace, check, storyRef, 2, app, input.signal)
      )
  }
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
  for (const [id, attempts] of byCheck) {
    const [first, second] = attempts
    const status = first.passed
      ? "passed"
      : second?.passed
        ? "flaky (failed, then passed on retry)"
        : first.timedOut
          ? "failed (timed out)"
          : "failed"
    if (first.passed) passed++
    else if (second?.passed) flaky++
    else failed++
    lines.push(
      `- ${id} (${first.storyRef} ${first.criterionId}): ${status}, ${Math.round(first.durationMs / 100) / 10}s`
    )
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
    ? `Ran ${byCheck.size} automated check${byCheck.size === 1 ? "" : "s"}: ${passed} passed, ${failed} failed, ${flaky} flaky. Results are recorded on this step.`
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

// Run when a checks step's worker finishes: the step completes only when the
// story's manifest exists and validates. Then the whole checks directory is
// frozen on the phase run, with any files QA changed outside its directories.
export async function completeAuthorStep(input: {
  phaseRunId: string
  link: MissionControlRunLink
  runId: string
  workspace: string
  before: Record<string, string> | null
}): Promise<{ ok: true; warnings: string[] } | { ok: false; message: string }> {
  const story = storyChecks(input.link)
  if (!story)
    return { ok: false, message: "The user story is no longer available." }
  const read = await readStoryManifest(input.workspace, story)
  if (!read.ok) return read
  const freeze = await snapshotChecks(input.workspace, story.checksDir)
  const after = input.before ? await worktreeChanges(input.workspace) : null
  const outsideWrites =
    input.before && after
      ? changedOutside(input.before, after, [story.checksDir, SCRATCH_DIR])
      : []
  updateQaChecks(input.phaseRunId, (current) => ({
    ...current,
    freeze: { ...freeze, frozenAt: Date.now() },
    outsideWrites,
  }))
  return { ok: true, warnings: read.warnings }
}

// The checks step's kickoff: what to write and where, and how it completes.
export function authorStepNote(story: StoryChecks): string {
  return [
    "## Writing the acceptance checks",
    "Write checks for every acceptance criterion from the spec alone. Don't read or wait for the implementation: it doesn't exist yet, and checks shaped by the code tend to confirm the code instead of the criteria. Edit only the checks directory.",
    `- Reuse the page objects, fixtures, and helpers already in \`${story.checksDir}/\`. Add methods to them rather than rewriting them: other stories' checks depend on them.`,
    `- Tag each test with \`@${story.storyRef}\` and its criterion id.`,
    `- Write the manifest at \`${story.manifestPath}\`. It maps each criterion id to its checks:`,
    "```json",
    `{ "criteria": {`,
    `  "AC-1": [{ "id": "ac1-short-name", "kind": "automated", "command": "<the project's test command> --grep \\"@${story.storyRef}.*@AC-1\\"", "cwd": "", "timeoutMs": 120000 }],`,
    `  "AC-2": [{ "id": "ac2-short-name", "kind": "exploratory", "note": "What to verify by hand in the running app" }]`,
    "} }",
    "```",
    "  An automated check is a command that exits 0 when the criterion holds. Select this story's tests by tag, not by file: a spec file holds several stories' tests. `cwd` is workspace-relative (\"\" for the root). Use `exploratory` only for what can't be checked mechanically (exact copy, visual layout); the test step verifies those in the running app.",
    ...(story.recipe.services.length
      ? [
          `- A check that needs the running app lists the services it needs in \`"services"\` (from this workspace's app launch recipe: ${story.recipe.services.map((service) => `\`${service.key}\``).join(", ")}). \`run_checks\` starts them first, on free ports, and gives the check their URLs: \`BASE_URL\` (the first one), \`APP_<KEY>_URL\` and \`APP_<KEY>_PORT\` in its environment, and \`{port:<key>}\` in its command. Don't hard-code ports or start the app inside the check.`,
        ]
      : []),
    "- `run_checks` runs the manifest's automated checks. Use it to confirm each check runs and fails for the right reason: the feature isn't built yet, so failures are expected now.",
    "- This step completes only when the manifest exists and validates. When it does, the checks directory is frozen: the builder may run your checks but not change them unnoticed.",
  ].join("\n")
}

// ── the test step: drift and re-freeze ──────────────────────────────────────

// Run when a verify step starts: compare the checks directory with the
// newest freeze and record drift on the phase run. Returns the kickoff note.
// A resumed step keeps the results it already recorded.
export async function startVerifyStep(input: {
  run: ProcessRun
  phaseRunId: string
  workspace: string
  resuming: boolean
}): Promise<string | null> {
  const root = rootRun(input.run)
  const story = root.missionControl ? storyChecks(root.missionControl) : null
  if (!story) return null
  const freeze = latestFreeze(root)
  const drift = freeze
    ? await checksDrift(input.workspace, story, freeze)
    : null
  const outsideWrites = runPhaseRuns(root).flatMap(
    (pr) => pr.qaChecks?.outsideWrites ?? []
  )
  updateQaChecks(input.phaseRunId, (current) => ({
    ...current,
    drift: drift?.changed.length
      ? { changed: drift.changed, detectedAt: Date.now(), resolvedAt: null }
      : undefined,
    results: input.resuming ? current.results : [],
  }))
  return verifyStepNote({
    story,
    frozen: !!freeze,
    changed: drift?.changed ?? [],
    outsideWrites: [...new Set(outsideWrites)].sort(),
  })
}

function describeChange(change: ChecksChange): string {
  const lines =
    change.added !== undefined ? ` (+${change.added} −${change.removed})` : ""
  return `- \`${change.path}\`: ${change.change}${lines}`
}

export function verifyStepNote(input: {
  story: StoryChecks
  frozen: boolean
  changed: ChecksChange[]
  outsideWrites: string[]
}): string {
  const { story } = input
  const lines = ["## QA checks"]
  if (story.reverify)
    lines.push(
      "Before any exploratory testing, call `run_checks`. On this merged result it runs the automated checks of every user story in this milestone that has a manifest, so a later story's change to a shared page object that breaks an earlier story's checks shows up here."
    )
  else if (input.frozen)
    lines.push(
      `Start by calling \`run_checks\`: it runs the automated checks in \`${story.manifestPath}\` and records the results on this step. A criterion covered by an automated check is met only when that check passes here. Verify exploratory checks yourself in the running app.`
    )
  else
    lines.push(
      `No checks were frozen for this user story (the playbook has no checks step, or it didn't finish). If \`${story.manifestPath}\` exists, \`run_checks\` runs it; otherwise verify each criterion with your own checks.`
    )
  lines.push(
    "",
    "### How each criterion was verified",
    "Every criterion in `record_proof` says how you verified it (`method`), and the harness checks the claim against what it recorded in this step:",
    "- `qa_check`: the manifest's automated checks for it passed here through `run_checks`. List every one of them in `checkIds`. A criterion with automated checks can't be met any other way, and a check that failed or didn't run here means it isn't met.",
    "- `app_exercised`: you drove the running app. Cite the evidence paths `browser_screenshot` (or `save_evidence`) returned in `artifacts`. Exploratory criteria need this.",
    "- `command`: a command you ran yourself (curl, the CLI). `builder_tests`: only the builder's tests; allowed, but flagged on the user story.",
    "- `code_read`: you only read the code. That never makes a criterion met: record it `not_verifiable` with a reason."
  )
  if (input.changed.length) {
    const own = input.changed.filter((c) => !c.shared)
    const shared = input.changed.filter((c) => c.shared)
    lines.push(
      "",
      "### The checks changed after they were frozen",
      "These files in the checks directory changed between the checks step and now, so the build step changed them. Review each diff. The proof can't be accepted until you either call `refreeze_checks` with your reason (the change is legitimate) or record a rejected proof.",
      ...(own.length
        ? ["This story's checks and manifest:", ...own.map(describeChange)]
        : []),
      ...(shared.length
        ? [
            "Shared files (page objects, fixtures, helpers) other stories' checks may use. A loosened locator or helper weakens checks without touching a spec:",
            ...shared.map(describeChange),
          ]
        : [])
    )
  }
  if (input.outsideWrites.length)
    lines.push(
      "",
      "### Files QA changed outside its directories",
      "The checks step changed these files outside the checks and scratch directories (shell commands bypass the file tools' scope). QA must not change product code; report them in the proof:",
      ...input.outsideWrites.map((p) => `- \`${p}\``)
    )
  return lines.join("\n")
}

// QA re-freezes the checks in the test step after reviewing a legitimate
// change. Clears the drift that blocked acceptance.
export async function refreezeQaChecks(input: {
  processRunId: string
  phaseRunId: string
  workspace: string
  reason: string
}): Promise<
  | { ok: true; files: number; changed: number }
  | { ok: false; code: string; message: string }
> {
  const ctx = qaToolContext(input.processRunId, input.phaseRunId)
  if (!ctx.ok) return ctx
  if (ctx.kind !== "verify")
    return {
      ok: false,
      code: "not_test_step",
      message: "Only the test step re-freezes the checks.",
    }
  const reason = input.reason.trim()
  if (!reason)
    return {
      ok: false,
      code: "bad_args",
      message: "Give the reason the changed checks are legitimate.",
    }
  const freeze = await snapshotChecks(input.workspace, ctx.story.checksDir)
  const now = Date.now()
  const next = updateQaChecks(ctx.phaseRun.id, (current) => ({
    ...current,
    freeze: { ...freeze, frozenAt: now, reason },
    ...(current.drift ? { drift: { ...current.drift, resolvedAt: now } } : {}),
  }))
  return {
    ok: true,
    files: Object.keys(freeze.files).length,
    changed: next.drift?.changed.length ?? 0,
  }
}

// Why a proof can't be accepted yet: the checks changed after the freeze and
// QA hasn't re-frozen them. Null when nothing blocks.
export function checksDriftBlock(phaseRun: ProcessPhaseRun): string | null {
  const drift = phaseRun.qaChecks?.drift
  if (!drift || drift.resolvedAt) return null
  return `The QA checks changed after they were frozen (${drift.changed.map((c) => c.path).join(", ")}). Review the changes, then call refreeze_checks with your reason if they're legitimate, or record verdict "rejected".`
}

// A builder step after QA froze the checks: where they are, and that they're
// QA's. Null when no checks were frozen in this run.
export function builderStepNote(run: ProcessRun): string | null {
  const root = rootRun(run)
  const story = root.missionControl ? storyChecks(root.missionControl) : null
  if (!story || !latestFreeze(root)) return null
  return [
    "## QA's acceptance checks",
    `QA already wrote this user story's acceptance checks; \`${story.manifestPath}\` lists them per criterion with the command that runs each. Make them pass. You may read and run them, but don't change anything in \`${story.checksDir}/\`, including shared page objects and fixtures: the test step lists every change made there since QA froze it, and the proof can't be accepted until QA reviews them. If a check looks wrong, say so in your final message instead of editing it.`,
  ].join("\n")
}

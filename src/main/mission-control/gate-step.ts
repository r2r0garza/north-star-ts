import * as features from "../db/repositories/features"
import * as processes from "../db/repositories/processes"
import * as waveGates from "../db/repositories/wave-gates"
import type {
  GateCheckChange,
  ProcessRun,
  UserStoryProof,
  WaveGateReport,
} from "../db/types"
import { runGit } from "../agent/subagents/worktrees"
import { describeServices, startServices } from "./app-launch"
import { savedEvidence } from "./evidence"
import {
  appGuidance,
  gateChecks,
  gateManifests,
  isRepository,
  qaToolContext,
  rootRun,
  snapshotChecks,
  unreachableChecks,
  updateQaChecks,
  type GateCheckStory,
  type GateChecks,
  type ManifestSet,
} from "./qa-checks"
import {
  decideGateRecord,
  parseGateSubmission,
  summarizeGateReport,
  type GateStory,
  type GateVerification,
} from "./gate-record"
import { storyManifestPath } from "../../shared/mission-control/checks"

// The wave gate's QA step (plan 110.02). In a worktree at the integration
// head, QA writes or extends the Playwright suite for every criterion in the
// batch, locating elements in the running integrated app, runs the whole
// accumulated suite with run_checks, and records the gate with record_gate.
// The harness checks the record against what run_checks recorded on this
// step; committing the suite and finishing the gate happen when the run
// settles (integration.onGateSettled).

// ── the kickoff ─────────────────────────────────────────────────────────────

// Run when the gate step starts: results from an earlier attempt of the step
// are dropped (a resumed step keeps its own), the recipe's services start
// (owned by this phase run, stopped when it ends), and the kickoff note is
// returned.
export async function startGateStep(input: {
  run: ProcessRun
  phaseRunId: string
  workspace: string
  resuming: boolean
}): Promise<string | null> {
  const root = rootRun(input.run)
  const gate = root.missionControl ? gateChecks(root.missionControl) : null
  if (!gate) return null
  if (!input.resuming)
    updateQaChecks(input.phaseRunId, (current) => ({ ...current, results: [] }))
  let services: string | null = null
  if (gate.recipe.services.length) {
    const started = await startServices({
      owner: input.phaseRunId,
      root: input.workspace,
      recipe: gate.recipe,
    }).catch((err: unknown) => ({
      ok: false as const,
      message: err instanceof Error ? err.message : String(err),
      services: [],
    }))
    services = [
      started.ok
        ? "The app is running from this workspace's launch recipe:"
        : `The app didn't start from the launch recipe: ${started.message}`,
      describeServices(started.services),
    ]
      .filter(Boolean)
      .join("\n")
  }
  return gateStepNote({
    gate,
    services,
    suite: await gateManifests(input.workspace, gate),
  })
}

// A criterion the story's own QA deferred to this gate (plan 110): its tools
// couldn't exercise it, so nothing has verified it yet.
function deferredNote(story: GateCheckStory, criterionId: string): string {
  // UserStory.proof is stored loosely (unknown); read only what's needed.
  const proof = story.userStory.proof as UserStoryProof | null
  const deferred = proof?.criteria?.find(
    (c) => c.id === criterionId && c.status === "deferred"
  )
  return deferred
    ? ` _(deferred to this gate by the story's QA, so only this gate verifies it: ${(deferred.reason ?? "its tools couldn't exercise it").replace(/\.+$/, "")}. Write an automated check for it.)_`
    : ""
}

export function gateStepNote(input: {
  gate: GateChecks
  // What the recipe's services are doing, or null without a recipe.
  services: string | null
  suite: ManifestSet
}): string {
  const { gate, suite } = input
  const batch = [...gate.stories.values()].filter((s) => s.batch)
  const present = new Set(suite.manifests.map((m) => m.storyRef))
  const earlier = suite.manifests.filter(
    (m) => !gate.stories.get(m.storyRef)?.batch
  )
  return [
    `## Acceptance gate, round ${gate.gate.round}`,
    "These user stories merged into the integration branch since the last gate. This worktree is at the integration head: the product as the user gets it. Prove every acceptance criterion of every story in the batch here, with one coherent Playwright suite.",
    "",
    "### The batch",
    ...batch.flatMap((story) => [
      `#### ${story.userStory.key}: ${story.userStory.title} (ref \`${story.storyRef}\`)`,
      ...fixLine(story, gate),
      ...story.criteria.map(
        (c) =>
          `- **${c.id}**: ${c.text}${story.waived.includes(c.id) ? " _(accepted as is by the user: don't triage it)_" : deferredNote(story, c.id)}`
      ),
      present.has(story.storyRef)
        ? `  Manifest: \`${storyManifestPath(gate.checksDir, story.storyRef)}\` (extend it; fix what doesn't hold on the integrated app).`
        : `  No manifest yet: write \`${storyManifestPath(gate.checksDir, story.storyRef)}\`.`,
    ]),
    ...waivedSection(gate),
    "",
    "### The suite",
    earlier.length
      ? `\`${gate.checksDir}/\` already holds checks for ${earlier.length} earlier user stor${earlier.length === 1 ? "y" : "ies"} (${earlier.map((m) => `\`${m.storyRef}\``).join(", ")}). They passed earlier gates: \`run_checks\` runs them too, so a regression shows up here. Reuse their page objects, fixtures, and helpers; add methods rather than rewriting them.`
      : `This is the first gate with checks in \`${gate.checksDir}/\`. Set it up for the gates after this one: page objects in \`${gate.checksDir}/pages/\`, shared setup in \`${gate.checksDir}/fixtures/\`, specs by product area in \`${gate.checksDir}/specs/\`.`,
    ...(suite.problems.length
      ? ["Manifests that can't be used yet:", ...suite.problems]
      : []),
    "",
    "### Writing the checks",
    "- Write each check from the criterion's words: what must be true, not how this code happens to do it. Assert what the criterion asks for and nothing more.",
    "- Look at the running app (the browser) only to find how to locate things: roles, accessible names, labels, visible text. Locate by `getByRole`, `getByLabel`, and `getByText`, never CSS selectors or test ids the criterion doesn't mention.",
    '- A control whose label changes with state ("Complete" → "Mark active") is located by a name valid in both states (a regular expression, or its row and role), or re-located after each action. Don\'t pin a label one story chose when another story\'s criterion changes it.',
    '- One criterion per `test()`, tagged with the story\'s ref and the criterion id, e.g. `test("… @<ref> @AC-1", …)`; navigate relative to `baseURL` (`page.goto("/")`).',
    '- Each story\'s manifest maps every criterion id to its checks: a Playwright check is `{ "id": "ac1-short-name", "kind": "automated", "runner": "playwright", "spec": "specs/area.spec.ts", "grep": "@AC-1" }` (spec relative to the checks directory, plus `"services"` when it needs the app). Prefer automated checks; mark a criterion `exploratory` only when nothing mechanical can check it, and then prove it in the browser with a screenshot.',
    ...appGuidance(gate),
    ...(input.services ? ["", input.services] : []),
    "",
    "### Running and triaging",
    "- `run_checks` with no `checkIds` runs the whole suite: this batch and every earlier story's checks. Run single checks while you work, but the record counts only results on the suite as it is when you record: after your last change, run the whole suite once more.",
    "- Triage every criterion of the batch, and every earlier criterion whose check failed here, with `record_gate`:",
    "  - `passed`: its checks pass on the current suite.",
    "  - `app_bug`: the app doesn't do what the criterion says. Its check fails, and `problem` says what the app does wrong. Don't weaken the check to make it pass; the harness turns it into a fix story that runs next, and `problem` is what its builder reads first, so make it specific.",
    "  - `check_fixed`: the check asserted a detail the criterion doesn't ask for (a label, an order, exact copy). You corrected the check and it passes now. Give the `justification`; it's shown to the user with the diff. Changing a check of an earlier story that already passed a gate needs the same, and is highlighted.",
    "  - `unreachable`: the check couldn't reach the app (setup, not the criterion). Give the `reason`; the user fixes the setup.",
    "- Never change product code: you verify it. The harness commits the checks directory to the integration branch when this step ends, whatever the outcome, so the builders of follow-up stories can run the exact failing checks.",
  ].join("\n")
}

// A fix story in the batch: what it fixes, so QA proves it with the original
// criterion's check rather than inventing a new one.
function fixLine(story: GateCheckStory, gate: GateChecks): string[] {
  const target = story.userStory.fixes
  if (!target) return []
  const original = [...gate.stories.values()].find(
    (s) => s.userStory.id === target.userStoryId
  )
  if (!original) return []
  const fixing = `  A fix story for ${original.userStory.key} ${target.criterionId} ("${target.criterion}"), which failed an earlier gate.`
  return [
    original.batch
      ? `${fixing} Prove it with that criterion's check rather than a second check of the same behavior: add this story's tag to the test's title (\`… @${original.storyRef} @${target.criterionId} @${story.storyRef} @AC-1\`) and map its criteria to it in this story's manifest.`
      : `${fixing} ${original.userStory.key} passed an earlier gate, so leave its checks as they are: give this story its own check of the criterion.`,
  ]
}

// Criteria accepted as is: their checks may still fail, and that's settled.
function waivedSection(gate: GateChecks): string[] {
  const earlier = [...gate.stories.values()].filter(
    (s) => !s.batch && s.waived.length
  )
  if (!earlier.length) return []
  return [
    "",
    "### Accepted as is",
    "The user accepted these criteria as they are at an earlier gate. Their checks may still fail; leave them and don't triage them:",
    ...earlier.map(
      (s) =>
        `- ${s.userStory.key} ${s.waived.join(", ")} (ref \`${s.storyRef}\`)`
    ),
  ]
}

// ── what changed in the checks directory ───────────────────────────────────

function parseNameStatus(out: string): Array<{ status: string; path: string }> {
  const parts = out.split("\0").filter(Boolean)
  const entries: Array<{ status: string; path: string }> = []
  for (let i = 0; i + 1 < parts.length; i += 2)
    entries.push({ status: parts[i], path: parts[i + 1] })
  return entries
}

// The checks directory's changes against the integration head the gate
// started from, workspace-relative, with the earlier (already passed)
// stories whose checks each changed file held. Empty outside a repository.
export async function gateCheckChanges(input: {
  workspace: string
  checksDir: string
  integrationBranch: string | null
  // Stories outside the batch: ref → key.
  earlier: Map<string, string>
}): Promise<GateCheckChange[]> {
  const { workspace, checksDir } = input
  if (!input.integrationBranch || !(await isRepository(workspace))) return []
  const base = await runGit(workspace, [
    "rev-parse",
    "-q",
    "--verify",
    `refs/heads/${input.integrationBranch}^{commit}`,
  ]).catch(() => "")
  if (!base) return []
  const tracked = parseNameStatus(
    await runGit(workspace, [
      "diff",
      "--name-status",
      "-z",
      "--no-renames",
      "--relative",
      base,
      "--",
      checksDir,
    ]).catch(() => "")
  )
  const untracked = (
    await runGit(workspace, [
      "ls-files",
      "-z",
      "--others",
      "--exclude-standard",
      "--",
      checksDir,
    ]).catch(() => "")
  )
    .split("\0")
    .filter(Boolean)
  const changes: GateCheckChange[] = []
  for (const { status, path } of tracked) {
    const change =
      status === "A" ? "added" : status === "D" ? "deleted" : "modified"
    let earlierStories: string[] = []
    if (change !== "added") {
      const before = await runGit(workspace, [
        "show",
        `${base}:./${path}`,
      ]).catch(() => "")
      earlierStories = [...input.earlier]
        .filter(
          ([ref]) =>
            before.includes(`@${ref}`) ||
            path === storyManifestPath(checksDir, ref)
        )
        .map(([, key]) => key)
    }
    changes.push({ path, change, earlierStories })
  }
  for (const path of untracked)
    if (!changes.some((c) => c.path === path))
      changes.push({ path, change: "added", earlierStories: [] })
  return changes.sort((a, b) => a.path.localeCompare(b.path))
}

// ── record_gate ─────────────────────────────────────────────────────────────

export type RecordGateResult =
  | { ok: true; report: WaveGateReport; message: string }
  | { ok: false; code: string; message: string }

export async function recordWaveGate(input: {
  processRunId: string
  processPhaseRunId: string
  // The gate's worktree, where the suite is read.
  workspace: string
  args: Record<string, unknown>
}): Promise<RecordGateResult> {
  const ctx = qaToolContext(input.processRunId, input.processPhaseRunId)
  if (!ctx.ok) return ctx
  if (ctx.kind !== "gate")
    return {
      ok: false,
      code: "not_gate_step",
      message: "Only the QA step of a milestone's acceptance gate records it.",
    }
  const { gate } = ctx
  const recorder = ctx.phaseRun.seatAddress
  if (!recorder)
    return {
      ok: false,
      code: "no_verifier_seat",
      message: "The gate step must run in a Mission Control seat.",
    }
  if (gate.gate.status !== "running")
    return {
      ok: false,
      code: "run_finished",
      message: "This acceptance gate has already finished.",
    }
  const stories: GateStory[] = [...gate.stories.values()].map((s) => ({
    userStoryId: s.userStory.id,
    key: s.userStory.key,
    storyRef: s.storyRef,
    criteria: s.criteria,
    batch: s.batch,
    waived: s.waived,
  }))
  const inMilestone = new Set(
    features.listUserStories(gate.milestoneId).map((s) => s.id)
  )
  const submission = parseGateSubmission(input.args, stories, inMilestone)
  if (typeof submission === "string")
    return { ok: false, code: "bad_args", message: submission }

  const suite = await gateManifests(input.workspace, gate)
  const coverage: GateVerification["coverage"] = {}
  const reachability: string[] = []
  for (const { storyRef, manifest } of suite.manifests) {
    coverage[storyRef] = Object.fromEntries(
      Object.entries(manifest.criteria).map(([id, checks]) => [
        id.toUpperCase(),
        {
          automated: checks
            .filter((c) => c.kind === "automated")
            .map((c) => c.id),
          exploratory: checks
            .filter((c) => c.kind === "exploratory")
            .map((c) => c.id),
        },
      ])
    )
    // The reachability lint (plan 109.07) moved here from the checks step:
    // a batch check that can't reach the app can never verify its criterion.
    if (gate.stories.get(storyRef)?.batch)
      reachability.push(
        ...(await unreachableChecks(input.workspace, gate, manifest))
      )
  }
  const milestone = features.getMilestone(gate.milestoneId)
  const verification: GateVerification = {
    stories,
    coverage,
    manifestProblems: suite.invalid,
    reachability,
    results: processes.getPhaseRun(ctx.phaseRun.id)?.qaChecks?.results ?? [],
    suiteHash: (await snapshotChecks(input.workspace, gate.checksDir)).hash,
    evidence: await savedEvidence(
      ctx.phaseRun.id,
      submission.stories.flatMap((s) =>
        s.criteria.flatMap((c) => c.artifacts ?? [])
      )
    ),
    checkChanges: await gateCheckChanges({
      workspace: input.workspace,
      checksDir: gate.checksDir,
      integrationBranch: milestone?.integrationBranch ?? null,
      earlier: new Map(
        stories.filter((s) => !s.batch).map((s) => [s.storyRef, s.key])
      ),
    }),
  }
  const decision = decideGateRecord({
    submission,
    verification,
    recordedBy: recorder,
    processRunId: ctx.root.id,
  })
  if (!decision.ok)
    return {
      ok: false,
      code: "gate_rejected_by_rules",
      message: decision.message,
    }
  if (!waveGates.setRunningWaveGateReport(gate.gate.id, decision.report))
    return {
      ok: false,
      code: "run_finished",
      message: "This acceptance gate has already finished.",
    }
  const failing = decision.report.stories.some((s) =>
    s.criteria.some(
      (c) => c.outcome === "app_bug" || c.outcome === "unreachable"
    )
  )
  return {
    ok: true,
    report: decision.report,
    message: `Gate recorded: ${summarizeGateReport(decision.report)}. ${
      failing
        ? "The gate fails: not every criterion passed."
        : "Every triaged criterion passed, so the gate passes."
    } When this step ends, the harness commits the checks directory to the integration branch. Recording again replaces this record. Summarize the gate and finish.`,
  }
}

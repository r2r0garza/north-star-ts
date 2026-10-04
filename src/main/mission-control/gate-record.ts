import type {
  CheckResult,
  GateCheckChange,
  GateCriterionOutcome,
  GateCriterionResult,
  GateStoryResult,
  ProofCheckResult,
  WaveGateReport,
} from "../db/types"
import type { UserStoryCriterion } from "./user-story-objective"

// The wave gate's record (plan 110.02, decision 7). QA triages every
// criterion of the batch, and every earlier criterion whose check failed on
// this run, into passed / app_bug / check_fixed / unreachable. Pure rules
// only: the record_gate tool resolves the gate, its stories, the manifests,
// the check results, and the checks directory's changes server-side and hands
// them here, so nothing identity-bearing comes from model arguments.

export const GATE_OUTCOMES: readonly GateCriterionOutcome[] = [
  "passed",
  "app_bug",
  "check_fixed",
  "unreachable",
]

export interface GateStory {
  userStoryId: string
  key: string
  storyRef: string
  criteria: UserStoryCriterion[]
  // In this gate's batch (as opposed to a story an earlier gate passed).
  batch: boolean
  // Criteria the user accepted as is (plan 110.03): never required.
  waived?: string[]
}

export interface GateVerification {
  // Every story whose checks may be in the suite: the batch and the
  // feature's earlier stories.
  stories: GateStory[]
  // Usable manifests by story ref: criterion id → its checks.
  coverage: Record<
    string,
    Record<string, { automated: string[]; exploratory: string[] }>
  >
  // A batch story whose manifest is missing or invalid → why.
  manifestProblems: Record<string, string>
  // Checks that can't reach the app (no recipe, no fixture starting it).
  reachability: string[]
  // Everything run_checks recorded on this step.
  results: CheckResult[]
  // The checks directory's hash now.
  suiteHash: string
  // Submitted artifacts that are files in this step's evidence directory.
  evidence: ReadonlySet<string>
  checkChanges: GateCheckChange[]
}

export interface GateSubmission {
  stories: Array<{
    storyRef: string
    criteria: Array<{
      id: string
      outcome: GateCriterionOutcome
      evidence: string
      checkIds?: string[]
      artifacts?: string[]
      problem?: string
      justification?: string
      reason?: string
    }>
  }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = [
    ...new Set(
      value
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter(Boolean)
    ),
  ]
  return list.length ? list : undefined
}

// Schema-validate raw tool arguments. A story is named by its ref (as
// run_checks prints it) or, for this milestone's stories, its key. Returns
// an error string for the model, or the parsed submission.
export function parseGateSubmission(
  args: Record<string, unknown>,
  stories: GateStory[],
  // The gate milestone's story ids: only their keys name a story.
  milestoneStoryIds: ReadonlySet<string>
): GateSubmission | string {
  if (!Array.isArray(args.stories) || !args.stories.length)
    return "`stories` must be an array with one entry per user story you triaged (every story in the batch)."
  const byRef = new Map(stories.map((s) => [s.storyRef, s]))
  const byKey = new Map(
    stories
      .filter((s) => milestoneStoryIds.has(s.userStoryId))
      .map((s) => [s.key, s])
  )
  const seen = new Set<string>()
  const parsed: GateSubmission["stories"] = []
  for (const [index, raw] of args.stories.entries()) {
    if (!isRecord(raw)) return `stories[${index}] must be an object.`
    const name = text(raw.story)
    const story = byRef.get(name) ?? byKey.get(name)
    if (!story)
      return `stories[${index}].story "${name}" isn't a user story in this gate's suite. Name it by its ref as run_checks prints it (${[...byRef.keys()].slice(0, 6).join(", ")}${byRef.size > 6 ? ", …" : ""}).`
    if (seen.has(story.storyRef))
      return `User story ${story.key} appears more than once.`
    seen.add(story.storyRef)
    if (!Array.isArray(raw.criteria) || !raw.criteria.length)
      return `stories[${index}].criteria must list the criteria you triaged for ${story.key}.`
    const known = new Set(story.criteria.map((c) => c.id))
    const ids = new Set<string>()
    const criteria: GateSubmission["stories"][number]["criteria"] = []
    for (const [j, c] of raw.criteria.entries()) {
      const at = `stories[${index}].criteria[${j}]`
      if (!isRecord(c)) return `${at} must be an object.`
      const id = text(c.id).toUpperCase()
      if (!known.has(id))
        return `${at}.id "${String(c.id)}" isn't one of ${story.key}'s criteria (${[...known].join(", ") || "none"}).`
      if (ids.has(id)) return `${story.key} ${id} appears more than once.`
      ids.add(id)
      if (!GATE_OUTCOMES.includes(c.outcome as GateCriterionOutcome))
        return `${at}.outcome must be one of ${GATE_OUTCOMES.join(", ")}.`
      const evidence = text(c.evidence)
      if (!evidence)
        return `${story.key} ${id} needs evidence: what ran and what you observed.`
      criteria.push({
        id,
        outcome: c.outcome as GateCriterionOutcome,
        evidence,
        ...(strings(c.checkIds) ? { checkIds: strings(c.checkIds) } : {}),
        ...(strings(c.artifacts) ? { artifacts: strings(c.artifacts) } : {}),
        ...(text(c.problem) ? { problem: text(c.problem) } : {}),
        ...(text(c.justification)
          ? { justification: text(c.justification) }
          : {}),
        ...(text(c.reason) ? { reason: text(c.reason) } : {}),
      })
    }
    parsed.push({ storyRef: story.storyRef, criteria })
  }
  return { stories: parsed }
}

// ── what the harness recorded ───────────────────────────────────────────────

export interface CheckRun {
  status: "passed" | "flaky" | "failed" | "unreachable"
  attempts: number
  // The newest run of the check was on the suite as it is now.
  current: boolean
  // Some run of the check on this step failed on an assertion (not setup).
  failedBefore: boolean
}

export function checkKey(storyRef: string, checkId: string): string {
  return `${storyRef}\0${checkId}`
}

// Each check's newest run (its first attempt, plus the retry when that
// failed), and whether any run of it failed on this step.
export function checkRuns(
  results: readonly CheckResult[],
  suiteHash: string
): Map<string, CheckRun> {
  const runs = new Map<string, CheckRun>()
  const ordered = [...results].sort(
    (a, b) => a.ranAt - b.ranAt || a.attempt - b.attempt
  )
  for (const result of ordered) {
    const key = checkKey(result.storyRef, result.checkId)
    const previous = runs.get(key)
    const setup = !!(result.unreachable || result.notVerifiable)
    const failedBefore =
      (previous?.failedBefore ?? false) || (!result.passed && !setup)
    if (result.attempt === 1 || !previous) {
      runs.set(key, {
        status: setup ? "unreachable" : result.passed ? "passed" : "failed",
        attempts: 1,
        current: result.suiteHash === suiteHash,
        failedBefore,
      })
      continue
    }
    runs.set(key, {
      ...previous,
      status:
        previous.status === "failed" && result.passed
          ? "flaky"
          : previous.status,
      attempts: previous.attempts + 1,
      failedBefore,
    })
  }
  return runs
}

function snapshot(
  storyRef: string,
  checkIds: string[],
  runs: Map<string, CheckRun>
): ProofCheckResult[] {
  return checkIds.map((checkId) => {
    const run = runs.get(checkKey(storyRef, checkId))
    return run?.current
      ? { checkId, status: run.status, attempts: run.attempts }
      : { checkId, status: "not_run", attempts: 0 }
  })
}

// ── the decision ────────────────────────────────────────────────────────────

export type GateDecision =
  | { ok: true; report: WaveGateReport }
  | { ok: false; message: string }

export function decideGateRecord(input: {
  submission: GateSubmission
  verification: GateVerification
  recordedBy: string
  processRunId: string
  now?: number
}): GateDecision {
  const { submission, verification: v } = input
  const runs = checkRuns(v.results, v.suiteHash)
  const problems: string[] = []
  const warnings: string[] = []
  const byRef = new Map(v.stories.map((s) => [s.storyRef, s]))
  const submitted = new Map(submission.stories.map((s) => [s.storyRef, s]))

  // The suite: every batch story has a usable manifest, and every automated
  // check of every manifest ran on the suite as it is now.
  for (const story of v.stories)
    if (story.batch && v.manifestProblems[story.storyRef])
      problems.push(`${story.key}: ${v.manifestProblems[story.storyRef]}`)
  problems.push(...v.reachability)
  const stale: string[] = []
  let total = 0
  let green = 0
  for (const [ref, criteria] of Object.entries(v.coverage))
    for (const { automated } of Object.values(criteria))
      for (const checkId of automated) {
        total++
        const run = runs.get(checkKey(ref, checkId))
        if (!run?.current) stale.push(checkId)
        else if (run.status === "passed" || run.status === "flaky") green++
      }
  if (stale.length)
    problems.push(
      `Run the whole suite on its current version: ${stale.length} automated check${stale.length === 1 ? " has" : "s have"} no result since the checks directory last changed (${stale.slice(0, 8).join(", ")}${stale.length > 8 ? ", …" : ""}). Call run_checks with no checkIds after your last change.`
    )

  // Every batch criterion is triaged, and so is every earlier criterion
  // whose check failed (or couldn't reach the app) on this suite.
  for (const story of v.stories) {
    const triaged = new Set(
      submitted.get(story.storyRef)?.criteria.map((c) => c.id) ?? []
    )
    const coverage = v.coverage[story.storyRef] ?? {}
    const waived = new Set(story.waived ?? [])
    const required = story.criteria
      .map((c) => c.id)
      .filter((id) => !waived.has(id))
      .filter(
        (id) =>
          story.batch ||
          (coverage[id]?.automated ?? []).some((checkId) => {
            const run = runs.get(checkKey(story.storyRef, checkId))
            return (
              run?.current &&
              (run.status === "failed" || run.status === "unreachable")
            )
          })
      )
    const missing = required.filter((id) => !triaged.has(id))
    if (missing.length)
      problems.push(
        story.batch
          ? `${story.key}: triage every criterion of the batch; missing ${missing.join(", ")}.`
          : `${story.key} passed an earlier gate, but its checks for ${missing.join(", ")} failed here: triage ${missing.length === 1 ? "it" : "them"} too.`
      )
  }

  // Each outcome's rule.
  const stories: GateStoryResult[] = []
  for (const entry of submission.stories) {
    const story = byRef.get(entry.storyRef)!
    const coverage = v.coverage[story.storyRef] ?? {}
    const criteria: GateCriterionResult[] = []
    for (const c of entry.criteria) {
      const at = `${story.key} ${c.id}`
      const automated = coverage[c.id]?.automated ?? []
      const exploratory = coverage[c.id]?.exploratory ?? []
      const known = new Set([...automated, ...exploratory])
      const foreign = (c.checkIds ?? []).filter((id) => !known.has(id))
      if (foreign.length)
        problems.push(
          `${at}: ${foreign.join(", ")} ${foreign.length === 1 ? "isn't one of its checks" : "aren't its checks"} in the manifest.`
        )
      const ran = automated.map((checkId) => ({
        checkId,
        run: runs.get(checkKey(story.storyRef, checkId)),
      }))
      const current = ran.filter((r) => r.run?.current)
      const red = current.filter((r) => r.run!.status === "failed")
      const setup = current.filter((r) => r.run!.status === "unreachable")
      const saved = (c.artifacts ?? []).filter((a) => v.evidence.has(a))
      const unsaved = (c.artifacts ?? []).filter((a) => !v.evidence.has(a))
      if (unsaved.length)
        problems.push(
          `${at}: ${unsaved.map((a) => `"${a}"`).join(", ")} ${unsaved.length === 1 ? "isn't a file" : "aren't files"} in this step's evidence directory. Cite the paths browser_screenshot (or save_evidence) returned.`
        )
      const allGreen =
        automated.length > 0 &&
        current.length === automated.length &&
        !red.length &&
        !setup.length
      switch (c.outcome) {
        case "passed":
        case "check_fixed":
          if (automated.length && !allGreen)
            problems.push(
              red.length
                ? `${at}: ${red.map((r) => r.checkId).join(", ")} failed on the current suite, so it didn't pass. Record app_bug, or correct an over-specified check and record check_fixed.`
                : setup.length
                  ? `${at}: ${setup.map((r) => r.checkId).join(", ")} couldn't reach the app. Fix the setup and run again, or record unreachable.`
                  : `${at}: its checks have no passing result on the current suite.`
            )
          if (!automated.length && !saved.length)
            problems.push(
              exploratory.length
                ? `${at}: its manifest has only exploratory checks, so passing it needs evidence from the running app: a browser_screenshot path in artifacts. Better, add an automated check for it.`
                : `${at}: no check in the manifest covers it. Write one and run it.`
            )
          if (c.outcome === "check_fixed") {
            if (!c.justification)
              problems.push(
                `${at}: check_fixed needs a justification: what the check asserted that the criterion doesn't ask for.`
              )
            if (automated.length && !ran.some((r) => r.run?.failedBefore))
              problems.push(
                `${at}: none of its checks failed on this step, so there was nothing to fix. Record passed.`
              )
            if (!story.batch)
              warnings.push(
                `Changed the check of ${story.key} ${c.id}, which passed an earlier gate: ${c.justification ?? ""}`.trim()
              )
          }
          break
        case "app_bug":
          if (!c.problem)
            problems.push(
              `${at}: app_bug needs a problem: what the app does that the criterion doesn't allow.`
            )
          if (automated.length ? !red.length : !saved.length)
            problems.push(
              automated.length
                ? `${at}: app_bug needs a check of it that failed on the current suite (on an assertion, not setup). ${setup.length ? "Its checks couldn't reach the app: record unreachable." : "Run it."}`
                : `${at}: with no automated check, app_bug needs evidence from the running app: a browser_screenshot path in artifacts.`
            )
          break
        case "unreachable":
          if (!c.reason)
            problems.push(
              `${at}: unreachable needs a reason: what kept the check from reaching the app.`
            )
          if (automated.length && !setup.length)
            problems.push(
              `${at}: none of its checks was reported as unable to reach the app on the current suite. ${red.length ? "One failed on an assertion: that's app_bug or check_fixed." : "Run them."}`
            )
          break
      }
      criteria.push({
        id: c.id,
        outcome: c.outcome,
        evidence: c.evidence,
        checks: snapshot(story.storyRef, automated, runs),
        ...(c.artifacts ? { artifacts: c.artifacts } : {}),
        ...(c.problem ? { problem: c.problem } : {}),
        ...(c.justification ? { justification: c.justification } : {}),
        ...(c.reason ? { reason: c.reason } : {}),
      })
      for (const r of current)
        if (r.run!.status === "flaky")
          warnings.push(
            `${at}: ${r.checkId} failed, then passed on retry (flaky).`
          )
    }
    const order = new Map(story.criteria.map((c, i) => [c.id, i]))
    criteria.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
    stories.push({
      userStoryId: story.userStoryId,
      key: story.key,
      storyRef: story.storyRef,
      batch: story.batch,
      criteria,
    })
  }

  // Changing an already-passed story's checks needs the same justification
  // as check_fixed, on one of that story's criteria.
  const fixedEarlier = new Set(
    submission.stories
      .filter((s) => s.criteria.some((c) => c.outcome === "check_fixed"))
      .map((s) => byRef.get(s.storyRef)!.key)
  )
  const touched = new Map<string, string[]>()
  for (const change of v.checkChanges)
    for (const key of change.earlierStories)
      touched.set(key, [...(touched.get(key) ?? []), change.path])
  for (const [key, paths] of touched)
    if (!fixedEarlier.has(key))
      problems.push(
        `You changed ${paths.map((p) => `\`${p}\``).join(", ")}, which ${paths.length === 1 ? "holds" : "hold"} checks of ${key}, a story that already passed a gate. Revert the change, or triage the criterion whose check you corrected as check_fixed with a justification.`
      )
  const shared = v.checkChanges.filter(
    (c) => c.change !== "added" && !c.earlierStories.length
  )
  if (shared.length)
    warnings.push(
      `Changed shared checks code: ${shared.map((c) => c.path).join(", ")}.`
    )

  if (problems.length)
    return {
      ok: false,
      message: `The gate record can't be accepted yet:\n${problems.map((p) => `- ${p}`).join("\n")}`,
    }
  // Batch first, in the order the stories were listed.
  stories.sort((a, b) => Number(b.batch) - Number(a.batch))
  return {
    ok: true,
    report: {
      version: 1,
      stories,
      checkChanges: v.checkChanges,
      suite: { checks: total, passed: green },
      warnings,
      recordedBy: input.recordedBy,
      recordedAt: input.now ?? Date.now(),
      processRunId: input.processRunId,
    },
  }
}

// Whether every criterion of a story passed (or had its check corrected, or
// was accepted as is by the user at an earlier gate).
export function storyPassed(story: GateStoryResult): boolean {
  return story.criteria.every(
    (c) => c.waived || c.outcome === "passed" || c.outcome === "check_fixed"
  )
}

export function isWaveGateReport(value: unknown): value is WaveGateReport {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.stories) &&
    Array.isArray(value.checkChanges)
  )
}

// One line per outcome count, for the gate's summary and the model.
export function summarizeGateReport(report: WaveGateReport): string {
  const counts: Record<GateCriterionOutcome, number> = {
    passed: 0,
    app_bug: 0,
    check_fixed: 0,
    unreachable: 0,
  }
  for (const story of report.stories)
    for (const c of story.criteria) counts[c.outcome]++
  const parts = [
    `${counts.passed} passed`,
    counts.check_fixed ? `${counts.check_fixed} with a corrected check` : "",
    counts.app_bug
      ? `${counts.app_bug} app bug${counts.app_bug === 1 ? "" : "s"}`
      : "",
    counts.unreachable ? `${counts.unreachable} couldn't reach the app` : "",
  ].filter(Boolean)
  return `${parts.join(", ")} (suite: ${report.suite.passed}/${report.suite.checks} automated checks passing)`
}

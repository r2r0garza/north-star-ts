import type {
  GateCriterionOutcome,
  GateCriterionResult,
  GateStoryResult,
  GateTestChange,
  SuiteRun,
  WaveGateReport,
} from "../db/types"
import type { UserStoryCriterion } from "./user-story-objective"

// The wave gate's record (plan 112.5). QA triages every criterion of the
// batch, and every earlier criterion whose test failed on this run. Tests
// are mapped to criteria by the tags in their titles (`@<storyRef> @AC-n`),
// not by a manifest. Pure rules only: the record_gate tool resolves the
// gate, its stories, the suite run, and the suite's changes server-side and
// hands them here, so nothing identity-bearing comes from model arguments.

export const GATE_OUTCOMES: readonly GateCriterionOutcome[] = [
  "passed",
  "app_bug",
  "check_fixed",
  "environment",
  "spec_question",
]

export interface GateStory {
  userStoryId: string
  key: string
  storyRef: string
  criteria: UserStoryCriterion[]
  // In this gate's batch (as opposed to a story an earlier gate passed).
  batch: boolean
  // Criteria the user accepted as is at an earlier gate: never required.
  waived?: string[]
}

export interface GateVerification {
  // The batch and the feature's earlier stories, whose tests may be in the
  // suite.
  stories: GateStory[]
  // The gate's latest whole-suite run.
  suiteRun: SuiteRun | null
  // The suite directory's hash now.
  suiteHash: string
  // Submitted artifacts that are files in this step's evidence directory.
  evidence: ReadonlySet<string>
  testChanges: GateTestChange[]
}

export interface GateSubmission {
  stories: Array<{
    storyRef: string
    criteria: Array<{
      id: string
      outcome: GateCriterionOutcome
      evidence: string
      artifacts?: string[]
      problem?: string
      justification?: string
      reason?: string
      question?: string
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

// ── tags ────────────────────────────────────────────────────────────────────

// A test title's tags: `@token` words.
export function titleTags(title: string): string[] {
  return [...title.matchAll(/(?:^|\s)@([^\s@]+)/g)].map((m) => m[1])
}

// Whether a test proves (ref, criterion): its title carries both tags.
// shortcut: a title with two refs and two criteria covers all four pairs;
// split such tests if it ever misattributes a failure.
export function testCovers(
  title: string,
  storyRef: string,
  criterionId: string
): boolean {
  const tags = titleTags(title)
  return (
    tags.includes(storyRef) &&
    tags.some((t) => t.toUpperCase() === criterionId.toUpperCase())
  )
}

// ── parsing ─────────────────────────────────────────────────────────────────

// Schema-validate raw tool arguments. A story is named by its ref (as its
// tests are tagged) or, for this milestone's stories, its key. Returns an
// error string for the model, or the parsed submission.
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
    const name = text(raw.story).replace(/^@/, "")
    const story = byRef.get(name) ?? byKey.get(name)
    if (!story)
      return `stories[${index}].story "${name}" isn't a user story of this gate. Name it by its ref, as its tests are tagged (${[...byRef.keys()].slice(0, 6).join(", ")}${byRef.size > 6 ? ", …" : ""}).`
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
      const optional = (key: string) =>
        text(c[key]) ? { [key]: text(c[key]) } : {}
      criteria.push({
        id,
        outcome: c.outcome as GateCriterionOutcome,
        evidence,
        ...(strings(c.artifacts) ? { artifacts: strings(c.artifacts) } : {}),
        ...optional("problem"),
        ...optional("justification"),
        ...optional("reason"),
        ...optional("question"),
      })
    }
    parsed.push({ storyRef: story.storyRef, criteria })
  }
  return { stories: parsed }
}

// ── the decision ────────────────────────────────────────────────────────────

export type GateDecision =
  | { ok: true; report: WaveGateReport }
  | { ok: false; message: string }

type SuiteTest = SuiteRun["tests"][number]

const ran = (t: SuiteTest) => t.status !== "skipped"
const failed = (t: SuiteTest) => ran(t) && t.status !== "passed"

export function decideGateRecord(input: {
  submission: GateSubmission
  verification: GateVerification
  recordedBy: string
  processRunId: string
  now?: number
}): GateDecision {
  const { submission, verification: v } = input
  const problems: string[] = []
  const warnings: string[] = []
  const byRef = new Map(v.stories.map((s) => [s.storyRef, s]))
  const submitted = new Map(submission.stories.map((s) => [s.storyRef, s]))
  const run = v.suiteRun?.hash === v.suiteHash ? v.suiteRun : null
  const tests = run?.tests ?? []
  if (!run)
    problems.push(
      v.suiteRun
        ? "The suite changed since its last run: call run_suite (the whole suite) after your last change, then record."
        : "The suite hasn't run yet: call run_suite (the whole suite), then record."
    )
  const tagged = (ref: string, id: string) =>
    tests.filter((t) => ran(t) && testCovers(t.title, ref, id))

  // Every batch criterion is triaged, and so is every earlier criterion
  // whose test failed on this run.
  for (const story of v.stories) {
    const triaged = new Set(
      submitted.get(story.storyRef)?.criteria.map((c) => c.id) ?? []
    )
    const waived = new Set(story.waived ?? [])
    const required = story.criteria
      .map((c) => c.id)
      .filter((id) => !waived.has(id))
      .filter((id) => story.batch || tagged(story.storyRef, id).some(failed))
    const missing = required.filter((id) => !triaged.has(id))
    if (missing.length)
      problems.push(
        story.batch
          ? `${story.key}: triage every criterion of the batch; missing ${missing.join(", ")}.`
          : `${story.key} passed an earlier gate, but its tests for ${missing.join(", ")} failed here: triage ${missing.length === 1 ? "it" : "them"} too.`
      )
  }

  // No failing test goes unexplained: each must prove a triaged (or waived)
  // criterion.
  if (run) {
    const accounted = (t: SuiteTest) =>
      v.stories.some((story) =>
        story.criteria.some(
          (c) =>
            testCovers(t.title, story.storyRef, c.id) &&
            ((story.waived ?? []).includes(c.id) ||
              submitted
                .get(story.storyRef)
                ?.criteria.some((s) => s.id === c.id))
        )
      )
    const loose = tests.filter((t) => failed(t) && !accounted(t))
    if (loose.length)
      problems.push(
        `${loose.length} failing test${loose.length === 1 ? " isn't" : "s aren't"} tagged with a criterion you triaged: ${loose
          .slice(0, 5)
          .map((t) => `"${t.title}"`)
          .join(
            ", "
          )}${loose.length > 5 ? ", …" : ""}. Tag each test \`@<storyRef> @AC-n\` and triage that criterion, or fix the test.`
      )
    if (run.failure && !tests.some(ran))
      problems.push(
        `The suite didn't run (${run.failure.class}: ${run.failure.signal}). ${run.failure.class === "test_defect" ? "Fix the spec so it loads, then run_suite again." : "Record the criteria environment if the app can't be reached."}`
      )
  }

  // Each outcome's rule.
  const stories: GateStoryResult[] = []
  for (const entry of submission.stories) {
    const story = byRef.get(entry.storyRef)!
    const criteria: GateCriterionResult[] = []
    for (const c of entry.criteria) {
      const at = `${story.key} ${c.id}`
      const own = tagged(story.storyRef, c.id)
      const red = own.filter(failed)
      const asserted = red.filter((t) => t.class === "feature")
      const setup = red.filter((t) => t.class === "environment")
      const saved = (c.artifacts ?? []).filter((a) => v.evidence.has(a))
      const unsaved = (c.artifacts ?? []).filter((a) => !v.evidence.has(a))
      if (unsaved.length)
        problems.push(
          `${at}: ${unsaved.map((a) => `"${a}"`).join(", ")} ${unsaved.length === 1 ? "isn't a file" : "aren't files"} in this step's evidence directory. Cite the paths browser_screenshot (or save_evidence) returned.`
        )
      switch (c.outcome) {
        case "passed":
        case "check_fixed":
          if (red.length)
            problems.push(
              `${at}: ${red.map((t) => `"${t.title}"`).join(", ")} failed on the current suite, so it didn't pass. Record app_bug, or correct an over-specified test and record check_fixed.`
            )
          if (!own.length && !saved.length)
            problems.push(
              `${at}: no test tagged \`@${story.storyRef} @${c.id}\` ran. Write one, or, if nothing mechanical can check it, prove it in the browser and cite a screenshot in artifacts.`
            )
          if (c.outcome === "check_fixed") {
            if (!c.justification)
              problems.push(
                `${at}: check_fixed needs a justification: what the test asserted that the criterion doesn't ask for.`
              )
            if (!v.testChanges.length)
              problems.push(
                `${at}: nothing in the suite changed, so no test was corrected. Record passed.`
              )
            if (!story.batch)
              warnings.push(
                `Changed the test of ${story.key} ${c.id}, which passed an earlier gate: ${c.justification ?? ""}`.trim()
              )
          }
          break
        case "app_bug":
          if (!c.problem)
            problems.push(
              `${at}: app_bug needs a problem: what the app does that the criterion doesn't allow. The fix story's builder reads it first.`
            )
          if (own.length ? !asserted.length : !saved.length)
            problems.push(
              own.length
                ? `${at}: app_bug needs a tagged test that failed on an assertion on the current suite.${setup.length ? " Its tests couldn't reach the app: record environment." : ""}`
                : `${at}: with no tagged test, app_bug needs evidence from the running app: a browser_screenshot path in artifacts.`
            )
          break
        case "environment":
          if (!c.reason)
            problems.push(
              `${at}: environment needs a reason: what kept the test from reaching the app.`
            )
          if (
            !setup.length &&
            !(run?.failure?.class === "environment" && !tests.some(ran))
          )
            problems.push(
              `${at}: none of its tests failed for the environment on the current suite.${asserted.length ? " One failed on an assertion: that's app_bug or check_fixed." : ""}`
            )
          break
        case "spec_question":
          if (story.batch)
            problems.push(
              `${at}: a spec question is for an earlier story's criterion that a later story changed. A batch criterion that fails is app_bug.`
            )
          if (!c.question)
            problems.push(
              `${at}: spec_question needs the question for the user: what the later story changed and why ${c.id} no longer holds as written.`
            )
          if (!red.length)
            problems.push(
              `${at}: its tests pass, so it still holds. Record passed (or check_fixed if you corrected its test).`
            )
          break
      }
      criteria.push({
        id: c.id,
        outcome: c.outcome,
        evidence: c.evidence,
        tests: own.map((t) => ({ title: t.title, status: t.status })),
        ...(c.artifacts ? { artifacts: c.artifacts } : {}),
        ...(c.problem ? { problem: c.problem } : {}),
        ...(c.justification ? { justification: c.justification } : {}),
        ...(c.reason ? { reason: c.reason } : {}),
        ...(c.question ? { question: c.question } : {}),
      })
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

  // Changing an earlier story's tests needs check_fixed (the criterion still
  // holds) or a spec question (it doesn't) on that story.
  const explained = new Set(
    submission.stories
      .filter((s) =>
        s.criteria.some(
          (c) => c.outcome === "check_fixed" || c.outcome === "spec_question"
        )
      )
      .map((s) => byRef.get(s.storyRef)!.key)
  )
  const touched = new Map<string, string[]>()
  for (const change of v.testChanges)
    for (const key of change.earlierStories)
      touched.set(key, [...(touched.get(key) ?? []), change.path])
  for (const [key, paths] of touched)
    if (!explained.has(key))
      problems.push(
        `You changed ${paths.map((p) => `\`${p}\``).join(", ")}, which ${paths.length === 1 ? "holds" : "hold"} tests of ${key}, a story that already passed a gate. Revert it, or triage the criterion whose test you corrected as check_fixed (it still holds) or spec_question (it no longer does).`
      )

  if (problems.length)
    return {
      ok: false,
      message: `The gate record can't be accepted yet:\n${problems.map((p) => `- ${p}`).join("\n")}`,
    }
  // Batch first, in the order the stories were listed.
  stories.sort((a, b) => Number(b.batch) - Number(a.batch))
  const counted = tests.filter(ran)
  return {
    ok: true,
    report: {
      version: 1,
      stories,
      testChanges: v.testChanges,
      suite: {
        tests: counted.length,
        passed: counted.filter((t) => t.status === "passed").length,
        hash: v.suiteHash,
      },
      warnings,
      recordedBy: input.recordedBy,
      recordedAt: input.now ?? Date.now(),
      processRunId: input.processRunId,
    },
  }
}

// Whether every criterion of a story passed (or had its test corrected, or
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
    Array.isArray(value.testChanges)
  )
}

// One line of outcome counts, for the gate's summary and the model.
export function summarizeGateReport(report: WaveGateReport): string {
  const counts: Record<GateCriterionOutcome, number> = {
    passed: 0,
    app_bug: 0,
    check_fixed: 0,
    environment: 0,
    spec_question: 0,
  }
  for (const story of report.stories)
    for (const c of story.criteria) counts[c.outcome]++
  const parts = [
    `${counts.passed} passed`,
    counts.check_fixed ? `${counts.check_fixed} with a corrected test` : "",
    counts.app_bug
      ? `${counts.app_bug} app bug${counts.app_bug === 1 ? "" : "s"}`
      : "",
    counts.environment
      ? `${counts.environment} blocked by the environment`
      : "",
    counts.spec_question
      ? `${counts.spec_question} spec question${counts.spec_question === 1 ? "" : "s"}`
      : "",
  ].filter(Boolean)
  return `${parts.join(", ")} (suite: ${report.suite.passed}/${report.suite.tests} tests passing)`
}

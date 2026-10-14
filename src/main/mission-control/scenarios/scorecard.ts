import { existsSync, readdirSync, readFileSync } from "fs"
import path from "path"
import type { AppLaunch } from "../../../shared/mission-control/app-launch"

// Scenario fixtures and the scorecard (plan 112, Method; built in 112.1). Six
// reproducible projects, one per scenario `112` must handle, each described
// by a scenario.json next to its project folder. Every behavior change in
// 112.3–112.5 is judged by re-running them and comparing scorecards, not by
// whichever real run failed last.
//
// Two tiers: the deterministic harness tier (scenarios.test.ts: start →
// readiness → one GET → stop, no orphans) and the live-model tier (plan
// 112.2, driver.ts: real Mission Control runs, several per scenario, kept as
// rates).

// The fixtures sit next to this file in the source tree. Read lazily: the
// bundled main process and ESM loaders have no __dirname to give here (the
// live driver passes the source path itself).
export function scenariosDir(): string {
  return __dirname
}

// Where recorded scorecards go, relative to the repository root.
export const SCORECARD_DIR = path.join(".plan", "112-scorecard")

// A user story's final status in a run. `unverified`: the app couldn't be
// run, so it was neither accepted nor rejected (plan 112, principle 5).
// `incomplete`: still in flight when the run stopped (a live run's cap).
export type StoryOutcome =
  | "done"
  | "rejected"
  | "unverified"
  | "failed"
  | "incomplete"
  | "not_run"

export type WaveGateOutcome = "passed" | "failed" | "not_applicable" | "not_run"

// Plan 112, design B.
export type FailureClass = "environment" | "feature" | "test_defect"

// What the harness tier expects of one recipe variant.
export type HarnessExpectation =
  // Every service becomes ready, and a GET of `/` on `service` answers below
  // 500 with a body containing each `contains` string.
  | { outcome: "ready"; smoke: { service: string; contains: string[] } }
  // `service` fails to start: its error matches `error`, and the end of its
  // output matches `tail` (the line that says why).
  | { outcome: "failed"; service: string; error: string; tail?: string }
  // Nothing to start (a greenfield folder, a library).
  | { outcome: "no_services" }

export interface ScenarioVariant {
  description: string
  // Story patches (in the scenario's patches/ folder) applied in order, for
  // a variant that runs a story branch or the merged result.
  patches?: string[]
  recipe: AppLaunch
  expect: HarnessExpectation
}

export interface ScenarioStory {
  key: string
  title: string
  goal: string
  acceptance: string[]
  dependsOn?: string[]
  // The story's branch, as a patch in patches/ (scenario 2).
  patch?: string
}

// What a live-model run should end with (plan 112.2 measures against it).
export interface LiveExpectation {
  stories: Record<string, StoryOutcome>
  waveGate: WaveGateOutcome
  failureClass: FailureClass | null
  maxStoryAttempts: number
  maxRecipeRepairs: number
  maxEscalations: number
  notes: string
}

export interface ScenarioSpec {
  version: 1
  key: string
  number: number
  title: string
  // What makes the scenario hard.
  hard: string
  // The feature intent, and a pre-authored milestone and stories, so
  // planning noise stays out of the measurement.
  intent: string
  milestone: { key: string; title: string }
  stories: ScenarioStory[]
  variants: Record<string, ScenarioVariant>
  // Commands the harness runs in the project as a sanity check of the
  // fixture itself (a library's tests, a builder's tests), with the exit
  // code each must end with.
  checks?: Array<{ label: string; command: string; exitCode: number }>
  // How the live tier sets the scenario up (plan 112.2): which recipe
  // variant the workspace starts with, or null for none.
  live?: { variant: string | null }
  expected: { live: LiveExpectation }
}

export interface LoadedScenario {
  spec: ScenarioSpec
  dir: string
  // The project folder a run copies from; never run in place.
  projectDir: string
  patchesDir: string
}

// The fixtures, in scenario order.
export function loadScenarios(root = scenariosDir()): LoadedScenario[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => existsSync(path.join(dir, "scenario.json")))
    .map((dir) => ({
      spec: JSON.parse(
        readFileSync(path.join(dir, "scenario.json"), "utf8")
      ) as ScenarioSpec,
      dir,
      projectDir: path.join(dir, "project"),
      patchesDir: path.join(dir, "patches"),
    }))
    .sort((a, b) => a.spec.number - b.spec.number)
}

// ── run records ─────────────────────────────────────────────────────────────

export type Tier = "harness" | "live"

// One run of one scenario (and, in the harness tier, one recipe variant).
export interface ScenarioRunRecord {
  scenario: string
  variant: string | null
  tier: Tier
  // Harness: ready | failed | no_services | not_runnable. Live: the run's
  // end state, e.g. as_expected, story_rejected, gate_failed, not_runnable.
  outcome: string
  // Whether the run ended the way the scenario expects.
  matched: boolean
  stories: Record<string, StoryOutcome>
  waveGate: WaveGateOutcome | null
  failureClass: FailureClass | null
  storyAttempts: number
  recipeRepairs: number
  escalations: number
  wallMs: number
  // PIDs (or process groups) still alive after teardown.
  orphans: number[]
  costUsd?: number
  detail?: string
  // ── live tier (plan 112.2) ──
  // Stopped from outside (the batch was cancelled, or the driver failed)
  // rather than settling or hitting the cap.
  aborted?: boolean
  // Why the run stopped: settled | landed | waiting_on_user | paused |
  // feature_<status> | cap | aborted | not_runnable.
  settle?: string
  // `stories`, `firstVerdicts`, and `attemptsByStory` cover every story the
  // feature ended with, including ones added during the run (another
  // milestone's as `<milestone>/<key>`).
  attemptsByStory?: Record<string, number>
  proofRevisions?: number
  // Each story's first proof verdict: scenario 6 measures the first proof,
  // whatever a later fixed attempt does.
  firstVerdicts?: Record<string, "accepted" | "rejected" | null>
  // The scenario's own stories as scored: a story split during the run
  // takes its parts' worst outcome, and its verdict is rejected when any
  // part's first proof was.
  resolvedStories?: Record<string, StoryOutcome>
  resolvedVerdicts?: Record<string, "accepted" | "rejected" | null>
  // How the plan moved while the run was going.
  planChanges?: PlanChanges
  // Which expectations held, by dimension (see LIVE_CHECKS).
  checks?: Partial<Record<LiveCheck, boolean>>
  cost?: RunCost
  model?: string | null
  provider?: string | null
  appCommit?: string | null
  scenarioVersion?: number
}

export interface PlanChanges {
  // Stories added by a seat or a proposal (not split parts).
  addedStories: string[]
  addedMilestones: string[]
  // A split story → the stories its work moved to.
  splits: Record<string, string[]>
  // Cancelled without being split.
  cancelled: string[]
}

const planChanged = (changes: PlanChanges | undefined) =>
  !!changes &&
  (changes.addedStories.length > 0 ||
    changes.addedMilestones.length > 0 ||
    changes.cancelled.length > 0 ||
    Object.keys(changes.splits).length > 0)

// Model usage for one run, from the per-round context usage log. Estimated
// when the provider didn't report usage for some round.
export interface RunCost {
  rounds: number
  inputTokens: number
  outputTokens: number
  estimated: boolean
}

export interface ScenarioSummary {
  scenario: string
  runs: number
  // Share of runs per outcome, 0–1.
  rates: Record<string, number>
  matchedRate: number
  runsWithOrphans: number
  // Live tier: how often each expectation held, how many runs changed the
  // plan on the way, and the mean cost per run.
  checkRates?: Partial<Record<LiveCheck, number>>
  runsWithPlanChanges?: number
  cost?: {
    meanWallMs: number
    meanInputTokens: number
    meanOutputTokens: number
  }
}

export interface Scorecard {
  version: 1
  label: string
  date: string
  tier: Tier
  commit: string | null
  // Live tier: the model the runs used. A baseline on another model is a
  // separate file, never a mixed one.
  model?: string | null
  provider?: string | null
  // The model selected in Settings when the runs started (seats can
  // override it, so it may differ from `model`). Adding runs to a live
  // scorecard requires the same selection.
  configuredModel?: string | null
  notes?: string
  scenarios: ScenarioSummary[]
  runs: ScenarioRunRecord[]
}

const rate = (count: number, total: number) =>
  total ? Math.round((count / total) * 1000) / 1000 : 0
const mean = (values: number[]) =>
  values.length
    ? Math.round(values.reduce((sum, v) => sum + v, 0) / values.length)
    : 0

// Per scenario: how many runs, and how often each outcome happened. Rates,
// not single results: live-model runs are noisy.
export function summarize(runs: ScenarioRunRecord[]): ScenarioSummary[] {
  const byScenario = new Map<string, ScenarioRunRecord[]>()
  for (const run of runs)
    byScenario.set(run.scenario, [...(byScenario.get(run.scenario) ?? []), run])
  return [...byScenario].map(([scenario, list]) => {
    const counts: Record<string, number> = {}
    for (const run of list) counts[run.outcome] = (counts[run.outcome] ?? 0) + 1
    return {
      scenario,
      runs: list.length,
      rates: Object.fromEntries(
        Object.entries(counts).map(([outcome, n]) => [
          outcome,
          rate(n, list.length),
        ])
      ),
      matchedRate: rate(list.filter((r) => r.matched).length, list.length),
      runsWithOrphans: list.filter((r) => r.orphans.length).length,
      ...liveSummary(list),
    }
  })
}

function liveSummary(
  list: ScenarioRunRecord[]
): Pick<ScenarioSummary, "checkRates" | "runsWithPlanChanges" | "cost"> {
  if (!list.some((r) => r.tier === "live")) return {}
  const checkRates: Partial<Record<LiveCheck, number>> = {}
  for (const check of LIVE_CHECKS) {
    const scored = list.filter((r) => r.checks?.[check] !== undefined)
    if (scored.length)
      checkRates[check] = rate(
        scored.filter((r) => r.checks?.[check]).length,
        scored.length
      )
  }
  const costed = list.filter((r) => r.cost)
  return {
    checkRates,
    runsWithPlanChanges: list.filter((r) => planChanged(r.planChanges)).length,
    cost: {
      meanWallMs: mean(list.map((r) => r.wallMs)),
      meanInputTokens: mean(costed.map((r) => r.cost!.inputTokens)),
      meanOutputTokens: mean(costed.map((r) => r.cost!.outputTokens)),
    },
  }
}

export function buildScorecard(input: {
  label: string
  date: string
  tier: Tier
  commit: string | null
  model?: string | null
  provider?: string | null
  configuredModel?: string | null
  notes?: string
  runs: ScenarioRunRecord[]
}): Scorecard {
  return {
    version: 1,
    label: input.label,
    date: input.date,
    tier: input.tier,
    commit: input.commit,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.configuredModel !== undefined
      ? { configuredModel: input.configuredModel }
      : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    scenarios: summarize(input.runs),
    runs: input.runs,
  }
}

// `.plan/112-scorecard/<date>-<label>.json`.
export function scorecardPath(date: string, label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  return path.join(SCORECARD_DIR, `${date}-${slug}.json`)
}

// An empty run record, for a tier to fill in.
export function runRecord(
  scenario: string,
  variant: string | null,
  tier: Tier,
  patch: Partial<ScenarioRunRecord> = {}
): ScenarioRunRecord {
  return {
    scenario,
    variant,
    tier,
    outcome: "not_runnable",
    matched: false,
    stories: {},
    waveGate: null,
    failureClass: null,
    storyAttempts: 0,
    recipeRepairs: 0,
    escalations: 0,
    wallMs: 0,
    orphans: [],
    ...patch,
  }
}

// ── live scoring (plan 112.2) ───────────────────────────────────────────────

// The expectations a live run is checked against, in the order a mismatch
// names the run's outcome.
export const LIVE_CHECKS = [
  "stories",
  "failureClass",
  "waveGate",
  "attempts",
  "escalations",
  "orphans",
] as const
export type LiveCheck = (typeof LIVE_CHECKS)[number]

// What the driver observed at the end of a live run, for the scenario's own
// stories (a split one resolved through its parts).
export interface LiveObservation {
  stories: Record<string, StoryOutcome>
  firstVerdicts: Record<string, "accepted" | "rejected" | null>
  attemptsByStory: Record<string, number>
  waveGate: WaveGateOutcome
  failureClass: FailureClass | null
  recipeRepairs: number
  escalations: number
  orphans: number[]
  settle: string
}

// A story meets an expected rejection when its first proof was rejected,
// even if a later fixed attempt made it done (scenario 6).
function storyMatches(
  expected: StoryOutcome,
  actual: StoryOutcome,
  firstVerdict: "accepted" | "rejected" | null
): boolean {
  if (expected === "rejected")
    return actual === "rejected" || firstVerdict === "rejected"
  return actual === expected
}

// Which expectations held, whether all did, and an outcome naming the first
// that didn't (so rates per outcome say where runs go wrong).
export function scoreLiveRun(
  expected: LiveExpectation,
  observed: LiveObservation
): {
  outcome: string
  matched: boolean
  checks: Record<LiveCheck, boolean>
} {
  const keys = Object.keys(expected.stories)
  const storyOk = (key: string) =>
    storyMatches(
      expected.stories[key],
      observed.stories[key] ?? "not_run",
      observed.firstVerdicts[key] ?? null
    )
  const checks: Record<LiveCheck, boolean> = {
    stories: keys.every(storyOk),
    failureClass: observed.failureClass === expected.failureClass,
    waveGate: observed.waveGate === expected.waveGate,
    attempts:
      Object.values(observed.attemptsByStory).every(
        (n) => n <= expected.maxStoryAttempts
      ) && observed.recipeRepairs <= expected.maxRecipeRepairs,
    escalations: observed.escalations <= expected.maxEscalations,
    orphans: observed.orphans.length === 0,
  }
  const matched = LIVE_CHECKS.every((check) => checks[check])
  return { outcome: liveOutcome(expected, observed, checks), matched, checks }
}

function liveOutcome(
  expected: LiveExpectation,
  observed: LiveObservation,
  checks: Record<LiveCheck, boolean>
): string {
  if (LIVE_CHECKS.every((check) => checks[check])) return "as_expected"
  const actual = Object.entries(observed.stories)
  if (!checks.stories) {
    if (actual.some(([, outcome]) => outcome === "incomplete"))
      return observed.settle === "cap" ? "timed_out" : "stalled"
    const misread = Object.entries(expected.stories).some(
      ([key, outcome]) =>
        outcome === "rejected" && observed.firstVerdicts[key] === "accepted"
    )
    if (misread) return "misread_accepted"
    for (const outcome of ["rejected", "unverified", "failed", "not_run"])
      if (
        actual.some(
          ([key, value]) =>
            value === outcome && expected.stories[key] !== outcome
        )
      )
        return `story_${outcome}`
    return "stories_mismatch"
  }
  if (!checks.failureClass) return `class_${observed.failureClass ?? "none"}`
  if (!checks.waveGate) return `gate_${observed.waveGate}`
  if (!checks.attempts) return "over_attempts"
  if (!checks.escalations) return "over_escalations"
  return "orphans"
}

// ── comparing scorecards ────────────────────────────────────────────────────

export interface ScenarioComparison {
  scenario: string
  verdict: "improved" | "regressed" | "unchanged" | "added" | "removed"
  matchedRate: { before: number | null; after: number | null }
  // Outcome rates that moved, after − before.
  rateChanges: Record<string, number>
  checkChanges: Partial<Record<LiveCheck, number>>
  orphanRuns: { before: number | null; after: number | null }
  cost: {
    wallMs: number | null
    inputTokens: number | null
    outputTokens: number | null
  }
}

export interface ScorecardComparison {
  before: { label: string; date: string; model: string | null }
  after: { label: string; date: string; model: string | null }
  // Comparing runs on different models measures the model, not the change.
  modelChanged: boolean
  scenarios: ScenarioComparison[]
  improved: string[]
  regressed: string[]
}

const delta = (a: number | undefined, b: number | undefined) =>
  a === undefined || b === undefined ? null : Math.round((b - a) * 1000) / 1000

// Per scenario: did the share of runs that ended as expected go up or down,
// and which outcomes and checks moved. A scenario that gained orphan runs
// regresses whatever else it did. 112.3–112.5 use this as acceptance
// evidence: keep a change only if something improved and nothing regressed.
export function compareScorecards(
  before: Scorecard,
  after: Scorecard
): ScorecardComparison {
  const keys = [
    ...new Set([
      ...before.scenarios.map((s) => s.scenario),
      ...after.scenarios.map((s) => s.scenario),
    ]),
  ].sort()
  const scenarios = keys.map((scenario): ScenarioComparison => {
    const a = before.scenarios.find((s) => s.scenario === scenario)
    const b = after.scenarios.find((s) => s.scenario === scenario)
    const rateChanges: Record<string, number> = {}
    for (const outcome of new Set([
      ...Object.keys(a?.rates ?? {}),
      ...Object.keys(b?.rates ?? {}),
    ])) {
      const change = delta(a?.rates[outcome] ?? 0, b?.rates[outcome] ?? 0)!
      if (change) rateChanges[outcome] = change
    }
    const checkChanges: Partial<Record<LiveCheck, number>> = {}
    for (const check of LIVE_CHECKS) {
      const change = delta(a?.checkRates?.[check], b?.checkRates?.[check])
      if (change) checkChanges[check] = change
    }
    const matched = delta(a?.matchedRate, b?.matchedRate)
    const orphansUp =
      !!a && !!b && b.runsWithOrphans / b.runs > a.runsWithOrphans / a.runs
    const verdict: ScenarioComparison["verdict"] = !a
      ? "added"
      : !b
        ? "removed"
        : orphansUp || (matched ?? 0) < 0
          ? "regressed"
          : (matched ?? 0) > 0
            ? "improved"
            : "unchanged"
    return {
      scenario,
      verdict,
      matchedRate: {
        before: a?.matchedRate ?? null,
        after: b?.matchedRate ?? null,
      },
      rateChanges,
      checkChanges,
      orphanRuns: {
        before: a?.runsWithOrphans ?? null,
        after: b?.runsWithOrphans ?? null,
      },
      cost: {
        wallMs: delta(a?.cost?.meanWallMs, b?.cost?.meanWallMs),
        inputTokens: delta(a?.cost?.meanInputTokens, b?.cost?.meanInputTokens),
        outputTokens: delta(
          a?.cost?.meanOutputTokens,
          b?.cost?.meanOutputTokens
        ),
      },
    }
  })
  return {
    before: {
      label: before.label,
      date: before.date,
      model: before.model ?? null,
    },
    after: { label: after.label, date: after.date, model: after.model ?? null },
    modelChanged: (before.model ?? null) !== (after.model ?? null),
    scenarios,
    improved: scenarios
      .filter((s) => s.verdict === "improved")
      .map((s) => s.scenario),
    regressed: scenarios
      .filter((s) => s.verdict === "regressed")
      .map((s) => s.scenario),
  }
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n))
const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`)

// The comparison as plain text, one block per scenario.
export function formatComparison(comparison: ScorecardComparison): string {
  const { before, after } = comparison
  const lines = [
    `${before.date} ${before.label} → ${after.date} ${after.label}`,
  ]
  if (comparison.modelChanged)
    lines.push(
      `Warning: different models (${before.model ?? "none"} → ${after.model ?? "none"}); this measures the model, not the change.`
    )
  for (const s of comparison.scenarios) {
    lines.push(
      "",
      `${s.scenario}: ${s.verdict} (as expected ${pct(s.matchedRate.before)} → ${pct(s.matchedRate.after)})`
    )
    const rates = Object.entries(s.rateChanges)
    if (rates.length)
      lines.push(
        `  outcomes: ${rates.map(([k, v]) => `${k} ${signed(Math.round(v * 100))}%`).join(", ")}`
      )
    const checks = Object.entries(s.checkChanges)
    if (checks.length)
      lines.push(
        `  checks: ${checks.map(([k, v]) => `${k} ${signed(Math.round(v * 100))}%`).join(", ")}`
      )
    const { before: orphansBefore, after: orphansAfter } = s.orphanRuns
    if (
      orphansBefore !== null &&
      orphansAfter !== null &&
      orphansBefore !== orphansAfter
    )
      lines.push(`  runs with orphans: ${orphansBefore} → ${orphansAfter}`)
    const cost = [
      s.cost.wallMs !== null && s.cost.wallMs !== 0
        ? `wall ${signed(Math.round(s.cost.wallMs / 1000))} s`
        : "",
      s.cost.inputTokens ? `input ${signed(s.cost.inputTokens)} tokens` : "",
      s.cost.outputTokens ? `output ${signed(s.cost.outputTokens)} tokens` : "",
    ].filter(Boolean)
    if (cost.length) lines.push(`  cost per run: ${cost.join(", ")}`)
  }
  lines.push(
    "",
    `Improved: ${comparison.improved.join(", ") || "none"}`,
    `Regressed: ${comparison.regressed.join(", ") || "none"}`
  )
  return lines.join("\n")
}

// ── orphans ─────────────────────────────────────────────────────────────────

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists, it's just not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

// The PIDs still alive, or whose process group still has a member (a dev
// server's watcher outliving its shell). Each service is its own group
// leader, so -pid probes what it spawned. Windows has no groups to probe.
export function orphanProcesses(pids: number[]): number[] {
  return pids.filter(
    (pid) => alive(pid) || (process.platform !== "win32" && alive(-pid))
  )
}

// Wait up to `ms` for teardown to finish, then report what's left.
export async function waitForOrphans(
  pids: number[],
  ms = 3000
): Promise<number[]> {
  const deadline = Date.now() + ms
  let left = orphanProcesses(pids)
  while (left.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    left = orphanProcesses(pids)
  }
  return left
}

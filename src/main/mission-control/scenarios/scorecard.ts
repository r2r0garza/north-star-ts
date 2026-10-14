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
// 112.2: real Mission Control runs, several per scenario, kept as rates).

export const SCENARIOS_DIR = __dirname

// Where recorded scorecards go, relative to the repository root.
export const SCORECARD_DIR = path.join(".plan", "112-scorecard")

// A user story's final status in a run. `unverified`: the app couldn't be
// run, so it was neither accepted nor rejected (plan 112, principle 5).
export type StoryOutcome =
  | "done"
  | "rejected"
  | "unverified"
  | "failed"
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
export function loadScenarios(root = SCENARIOS_DIR): LoadedScenario[] {
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
}

export interface ScenarioSummary {
  scenario: string
  runs: number
  // Share of runs per outcome, 0–1.
  rates: Record<string, number>
  matchedRate: number
  runsWithOrphans: number
}

export interface Scorecard {
  version: 1
  label: string
  date: string
  tier: Tier
  commit: string | null
  notes?: string
  scenarios: ScenarioSummary[]
  runs: ScenarioRunRecord[]
}

const rate = (count: number, total: number) =>
  total ? Math.round((count / total) * 1000) / 1000 : 0

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
    }
  })
}

export function buildScorecard(input: {
  label: string
  date: string
  tier: Tier
  commit: string | null
  notes?: string
  runs: ScenarioRunRecord[]
}): Scorecard {
  return {
    version: 1,
    label: input.label,
    date: input.date,
    tier: input.tier,
    commit: input.commit,
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

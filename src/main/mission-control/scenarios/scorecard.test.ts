import { describe, expect, it } from "vitest"
import {
  buildScorecard,
  compareScorecards,
  formatComparison,
  runRecord,
  scoreLiveRun,
  type LiveExpectation,
  type LiveObservation,
  type ScenarioRunRecord,
} from "./scorecard"

// Live-tier scoring and scorecard comparison (plan 112.2).

const expectDone: LiveExpectation = {
  stories: { greeting: "done" },
  waveGate: "passed",
  failureClass: null,
  maxStoryAttempts: 1,
  maxRecipeRepairs: 1,
  maxEscalations: 0,
  notes: "",
}

const observed = (patch: Partial<LiveObservation> = {}): LiveObservation => ({
  stories: { greeting: "done" },
  firstVerdicts: { greeting: "accepted" },
  attemptsByStory: { greeting: 1 },
  waveGate: "passed",
  failureClass: null,
  recipeRepairs: 0,
  escalations: 0,
  orphans: [],
  settle: "settled",
  ...patch,
})

describe("scoreLiveRun", () => {
  it("matches when every expectation holds", () => {
    expect(scoreLiveRun(expectDone, observed())).toEqual({
      outcome: "as_expected",
      matched: true,
      checks: {
        stories: true,
        failureClass: true,
        waveGate: true,
        attempts: true,
        escalations: true,
        orphans: true,
      },
    })
  })

  it("names the first expectation that failed", () => {
    const outcome = (patch: Partial<LiveObservation>) =>
      scoreLiveRun(expectDone, observed(patch)).outcome
    expect(outcome({ stories: { greeting: "rejected" } })).toBe(
      "story_rejected"
    )
    expect(outcome({ stories: { greeting: "unverified" } })).toBe(
      "story_unverified"
    )
    expect(
      outcome({ stories: { greeting: "incomplete" }, settle: "cap" })
    ).toBe("timed_out")
    expect(
      outcome({
        stories: { greeting: "incomplete" },
        settle: "waiting_on_user",
      })
    ).toBe("stalled")
    expect(outcome({ stories: {} })).toBe("stories_mismatch")
    expect(outcome({ failureClass: "environment" })).toBe("class_environment")
    // The wave gate doesn't exist before 112.5.
    expect(outcome({ waveGate: "not_run" })).toBe("gate_not_run")
    expect(outcome({ attemptsByStory: { greeting: 2 } })).toBe("over_attempts")
    expect(outcome({ recipeRepairs: 2 })).toBe("over_attempts")
    expect(outcome({ escalations: 1 })).toBe("over_escalations")
    const orphaned = scoreLiveRun(expectDone, observed({ orphans: [123] }))
    expect(orphaned).toMatchObject({ outcome: "orphans", matched: false })
  })

  it("scores an expected rejection on the first proof", () => {
    const misread: LiveExpectation = {
      ...expectDone,
      stories: { bill: "rejected" },
      waveGate: "not_run",
      failureClass: "feature",
    }
    const run = (patch: Partial<LiveObservation>) =>
      scoreLiveRun(
        misread,
        observed({
          waveGate: "not_run",
          failureClass: "feature",
          attemptsByStory: { bill: 1 },
          ...patch,
        })
      )
    // Rejected first, then fixed and accepted: the first proof is what counts.
    expect(
      run({
        stories: { bill: "done" },
        firstVerdicts: { bill: "rejected" },
      })
    ).toMatchObject({ outcome: "as_expected", matched: true })
    // QA accepted the misreading.
    expect(
      run({
        stories: { bill: "done" },
        firstVerdicts: { bill: "accepted" },
      })
    ).toMatchObject({ outcome: "misread_accepted", matched: false })
  })
})

const live = (
  scenario: string,
  outcome: string,
  patch: Partial<ScenarioRunRecord> = {}
): ScenarioRunRecord =>
  runRecord(scenario, null, "live", {
    outcome,
    matched: outcome === "as_expected",
    wallMs: 60_000,
    checks: { stories: outcome === "as_expected", orphans: true },
    cost: { rounds: 4, inputTokens: 4000, outputTokens: 200, estimated: false },
    ...patch,
  })

const card = (label: string, runs: ScenarioRunRecord[], model = "m1") =>
  buildScorecard({
    label,
    date: "2026-10-13",
    tier: "live",
    commit: "abc",
    model,
    provider: "p",
    runs,
  })

describe("live scorecards", () => {
  it("keeps rates, check rates, and mean cost per scenario", () => {
    const scorecard = card("baseline", [
      live("a", "as_expected"),
      live("a", "story_rejected", {
        wallMs: 120_000,
        cost: {
          rounds: 8,
          inputTokens: 8000,
          outputTokens: 400,
          estimated: true,
        },
      }),
      live("a", "story_rejected", {
        cost: undefined,
        planChanges: {
          addedStories: ["docs"],
          addedMilestones: [],
          splits: {},
          cancelled: [],
        },
      }),
    ])
    expect(scorecard.model).toBe("m1")
    expect(scorecard.scenarios).toEqual([
      {
        scenario: "a",
        runs: 3,
        rates: { as_expected: 0.333, story_rejected: 0.667 },
        matchedRate: 0.333,
        runsWithOrphans: 0,
        checkRates: { stories: 0.333, orphans: 1 },
        runsWithPlanChanges: 1,
        cost: {
          meanWallMs: 80_000,
          meanInputTokens: 6000,
          meanOutputTokens: 300,
        },
      },
    ])
  })

  it("reports improvements and regressions per scenario", () => {
    const before = card("baseline", [
      live("a", "story_rejected"),
      live("a", "story_rejected"),
      live("b", "as_expected"),
      live("b", "as_expected"),
      live("c", "as_expected"),
      live("d", "gate_not_run"),
    ])
    const after = card("recipes", [
      live("a", "as_expected"),
      live("a", "story_rejected"),
      live("b", "as_expected"),
      live("b", "story_failed"),
      // As often as expected, but now leaves a process behind.
      live("c", "as_expected", { orphans: [4242] }),
      live("d", "gate_not_run", { wallMs: 90_000 }),
      live("e", "as_expected"),
    ])
    const comparison = compareScorecards(before, after)
    expect(comparison.improved).toEqual(["a"])
    expect(comparison.regressed).toEqual(["b", "c"])
    expect(comparison.modelChanged).toBe(false)
    const byKey = Object.fromEntries(
      comparison.scenarios.map((s) => [s.scenario, s])
    )
    expect(byKey.a).toMatchObject({
      verdict: "improved",
      matchedRate: { before: 0, after: 0.5 },
      rateChanges: { as_expected: 0.5, story_rejected: -0.5 },
      checkChanges: { stories: 0.5 },
    })
    expect(byKey.c.orphanRuns).toEqual({ before: 0, after: 1 })
    expect(byKey.d).toMatchObject({
      verdict: "unchanged",
      rateChanges: {},
      cost: { wallMs: 30_000, inputTokens: 0, outputTokens: 0 },
    })
    expect(byKey.e.verdict).toBe("added")

    const text = formatComparison(comparison)
    expect(text).toContain("a: improved (as expected 0% → 50%)")
    expect(text).toContain("outcomes: story_rejected -50%, as_expected +50%")
    expect(text).toContain("runs with orphans: 0 → 1")
    expect(text).toContain("cost per run: wall +30 s")
    expect(text).toContain("Regressed: b, c")
    expect(text).toContain("Mixed: none")
    expect(byKey.c).toMatchObject({ better: [], worse: ["orphans"] })
    expect(text).not.toContain("Warning")
    expect(text).not.toContain("— → 0")
  })

  it("counts a single check moving while the matched rate stays at 0", () => {
    // Before 112.5 nothing fully matches (no wave gate), so 112.3 and 112.4
    // show up as single checks moving.
    const run = (checks: ScenarioRunRecord["checks"]) =>
      live("s", "class_none", { matched: false, checks })
    const before = card("baseline", [
      run({ stories: true, failureClass: false, attempts: true }),
      run({ stories: true, failureClass: false, attempts: true }),
    ])
    const fixed = card("recipes", [
      run({ stories: true, failureClass: true, attempts: true }),
      run({ stories: true, failureClass: false, attempts: true }),
    ])
    expect(compareScorecards(before, fixed).scenarios[0]).toMatchObject({
      verdict: "improved",
      better: ["failureClass"],
      worse: [],
      matchedRate: { before: 0, after: 0 },
    })

    // Better on one check, worse on another: not a keep.
    const traded = card("recipes", [
      run({ stories: true, failureClass: true, attempts: false }),
      run({ stories: true, failureClass: false, attempts: true }),
    ])
    const comparison = compareScorecards(before, traded)
    expect(comparison.scenarios[0]).toMatchObject({
      verdict: "mixed",
      better: ["failureClass"],
      worse: ["attempts"],
    })
    expect(comparison.mixed).toEqual(["s"])
    expect(comparison.improved).toEqual([])
    const text = formatComparison(comparison)
    expect(text).toContain("s: mixed (as expected 0% → 0%)")
    expect(text).toContain("  better: failureClass; worse: attempts")
    expect(text).toContain("Mixed: s")
  })

  it("warns when the two scorecards ran on different models", () => {
    const comparison = compareScorecards(
      card("baseline", [live("a", "as_expected")], "m1"),
      card("other", [live("a", "as_expected")], "m2")
    )
    expect(comparison.modelChanged).toBe(true)
    expect(formatComparison(comparison)).toContain(
      "Warning: different models (m1 → m2)"
    )
  })
})

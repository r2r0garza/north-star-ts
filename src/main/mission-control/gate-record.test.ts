import { describe, expect, it } from "vitest"
import type { CheckResult } from "../db/types"
import {
  checkRuns,
  decideGateRecord,
  parseGateSubmission,
  storyPassed,
  type GateStory,
  type GateVerification,
} from "./gate-record"

// The wave gate's record rules (plan 110.02, decision 7).

const SUITE = "suite-now"
const OLD = "suite-before"

const stories: GateStory[] = [
  {
    userStoryId: "s-items",
    key: "items",
    storyRef: "f.m.items",
    criteria: [
      { id: "AC-1", text: "Add an item" },
      { id: "AC-2", text: "Complete an item" },
    ],
    batch: true,
  },
  {
    userStoryId: "s-shell",
    key: "shell",
    storyRef: "f.m.shell",
    criteria: [{ id: "AC-1", text: "The app loads" }],
    batch: false,
  },
]

function result(
  storyRef: string,
  checkId: string,
  passed: boolean,
  extra: Partial<CheckResult> = {}
): CheckResult {
  return {
    checkId,
    criterionId: "AC-1",
    storyRef,
    attempt: 1,
    passed,
    exitCode: passed ? 0 : 1,
    timedOut: false,
    durationMs: 10,
    outputTail: "",
    ranAt: 1,
    suiteHash: SUITE,
    ...extra,
  }
}

function verification(patch: Partial<GateVerification> = {}): GateVerification {
  return {
    stories,
    coverage: {
      "f.m.items": {
        "AC-1": { automated: ["add"], exploratory: [] },
        "AC-2": { automated: ["complete"], exploratory: [] },
      },
      "f.m.shell": { "AC-1": { automated: ["loads"], exploratory: [] } },
    },
    manifestProblems: {},
    reachability: [],
    results: [
      result("f.m.items", "add", true),
      result("f.m.items", "complete", true),
      result("f.m.shell", "loads", true),
    ],
    suiteHash: SUITE,
    evidence: new Set(["/evidence/shot.jpg"]),
    checkChanges: [],
    ...patch,
  }
}

function submit(
  criteria: Array<Record<string, unknown>>,
  extra: Array<Record<string, unknown>> = []
) {
  const parsed = parseGateSubmission(
    {
      stories: [{ story: "items", criteria }, ...extra],
    },
    stories,
    new Set(["s-items", "s-shell"])
  )
  if (typeof parsed === "string") throw new Error(parsed)
  return parsed
}

const passedBoth = [
  { id: "AC-1", outcome: "passed", evidence: "green" },
  { id: "AC-2", outcome: "passed", evidence: "green" },
]

function decide(
  criteria: Array<Record<string, unknown>>,
  patch: Partial<GateVerification> = {},
  extra: Array<Record<string, unknown>> = []
) {
  return decideGateRecord({
    submission: submit(criteria, extra),
    verification: verification(patch),
    recordedBy: "qa@implementation",
    processRunId: "run-1",
    now: 5,
  })
}

describe("parseGateSubmission", () => {
  it("names stories by ref or, in the milestone, by key", () => {
    const parsed = parseGateSubmission(
      {
        stories: [
          { story: "f.m.items", criteria: passedBoth },
          {
            story: "shell",
            criteria: [{ id: "ac-1", outcome: "passed", evidence: "ok" }],
          },
        ],
      },
      stories,
      new Set(["s-items", "s-shell"])
    )
    expect(parsed).toMatchObject({
      stories: [
        { storyRef: "f.m.items" },
        { storyRef: "f.m.shell", criteria: [{ id: "AC-1" }] },
      ],
    })
  })

  it("refuses unknown stories, criteria, and outcomes", () => {
    const parse = (args: Record<string, unknown>) =>
      parseGateSubmission(args, stories, new Set(["s-items"]))
    expect(parse({ stories: [] })).toMatch(/one entry per user story/)
    expect(
      parse({ stories: [{ story: "nope", criteria: passedBoth }] })
    ).toMatch(/isn't a user story in this gate's suite/)
    // shell isn't in the gate's milestone, so its key doesn't name it.
    expect(
      parse({ stories: [{ story: "shell", criteria: passedBoth }] })
    ).toMatch(/isn't a user story/)
    expect(
      parse({
        stories: [
          {
            story: "items",
            criteria: [{ id: "AC-9", outcome: "passed", evidence: "x" }],
          },
        ],
      })
    ).toMatch(/isn't one of items's criteria/)
    expect(
      parse({
        stories: [
          {
            story: "items",
            criteria: [{ id: "AC-1", outcome: "fine", evidence: "x" }],
          },
        ],
      })
    ).toMatch(/outcome must be one of/)
  })
})

describe("checkRuns", () => {
  it("takes each check's newest run and remembers earlier failures", () => {
    const runs = checkRuns(
      [
        result("r", "a", false, { ranAt: 1, suiteHash: OLD }),
        result("r", "a", false, { ranAt: 2, attempt: 2, suiteHash: OLD }),
        result("r", "a", false, { ranAt: 3 }),
        result("r", "a", true, { ranAt: 4, attempt: 2 }),
        result("r", "b", false, { ranAt: 5, unreachable: "refused" }),
      ],
      SUITE
    )
    expect(runs.get("r\0a")).toEqual({
      status: "flaky",
      attempts: 2,
      current: true,
      failedBefore: true,
    })
    expect(runs.get("r\0b")).toMatchObject({
      status: "unreachable",
      failedBefore: false,
    })
  })
})

describe("decideGateRecord", () => {
  it("accepts a batch that passed on the current suite", () => {
    const decision = decide(passedBoth)
    expect(decision).toMatchObject({
      ok: true,
      report: {
        version: 1,
        suite: { checks: 3, passed: 3 },
        recordedBy: "qa@implementation",
        stories: [
          {
            key: "items",
            batch: true,
            criteria: [
              {
                id: "AC-1",
                outcome: "passed",
                checks: [{ checkId: "add", status: "passed", attempts: 1 }],
              },
              { id: "AC-2", outcome: "passed" },
            ],
          },
        ],
      },
    })
    if (decision.ok) expect(storyPassed(decision.report.stories[0])).toBe(true)
  })

  it("needs every batch criterion triaged", () => {
    const decision = decide([passedBoth[0]])
    expect(decision).toMatchObject({
      ok: false,
      message: expect.stringContaining(
        "items: triage every criterion of the batch; missing AC-2"
      ),
    })
  })

  it("needs a result for every automated check on the current suite", () => {
    const decision = decide(passedBoth, {
      results: [
        result("f.m.items", "add", true),
        result("f.m.items", "complete", true),
        result("f.m.shell", "loads", true, { suiteHash: OLD }),
      ],
    })
    expect(decision).toMatchObject({
      ok: false,
      message: expect.stringMatching(
        /Run the whole suite on its current version: 1 automated check has no result .*\(loads\)/
      ),
    })
  })

  it("won't call a failing check passed, and takes an app bug with its problem", () => {
    const red = {
      results: [
        result("f.m.items", "add", true),
        result("f.m.items", "complete", false),
        result("f.m.shell", "loads", true),
      ],
    }
    expect(decide(passedBoth, red)).toMatchObject({
      ok: false,
      message: expect.stringContaining(
        "items AC-2: complete failed on the current suite"
      ),
    })
    expect(
      decide(
        [passedBoth[0], { id: "AC-2", outcome: "app_bug", evidence: "red" }],
        red
      )
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("app_bug needs a problem"),
    })
    expect(
      decide(
        [
          passedBoth[0],
          {
            id: "AC-2",
            outcome: "app_bug",
            evidence: "red",
            problem: "Complete renames the button",
          },
        ],
        red
      )
    ).toMatchObject({ ok: true })
    // An app bug needs a red check, not a green one.
    expect(
      decide([
        passedBoth[0],
        { id: "AC-2", outcome: "app_bug", evidence: "x", problem: "y" },
      ])
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("needs a check of it that failed"),
    })
  })

  it("takes a corrected check only with an earlier failure and a justification", () => {
    const fixed = {
      results: [
        result("f.m.items", "add", true),
        result("f.m.items", "complete", false, {
          ranAt: 0,
          suiteHash: OLD,
        }),
        result("f.m.items", "complete", true, { ranAt: 2 }),
        result("f.m.shell", "loads", true),
      ],
    }
    const checkFixed = {
      id: "AC-2",
      outcome: "check_fixed",
      evidence: "passes now",
    }
    expect(decide([passedBoth[0], checkFixed], fixed)).toMatchObject({
      ok: false,
      message: expect.stringContaining("check_fixed needs a justification"),
    })
    expect(
      decide([
        passedBoth[0],
        { ...checkFixed, justification: "Pinned the label" },
      ])
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("nothing to fix. Record passed"),
    })
    expect(
      decide(
        [passedBoth[0], { ...checkFixed, justification: "Pinned the label" }],
        fixed
      )
    ).toMatchObject({ ok: true })
  })

  it("needs an earlier story's failing check triaged, and flags changes to it", () => {
    const regressed = {
      results: [
        result("f.m.items", "add", true),
        result("f.m.items", "complete", true),
        result("f.m.shell", "loads", false),
      ],
    }
    expect(decide(passedBoth, regressed)).toMatchObject({
      ok: false,
      message: expect.stringContaining(
        "shell passed an earlier gate, but its checks for AC-1 failed here"
      ),
    })
    const shellBug = {
      story: "f.m.shell",
      criteria: [
        {
          id: "AC-1",
          outcome: "app_bug",
          evidence: "blank page",
          problem: "The shell no longer loads",
        },
      ],
    }
    const decision = decide(passedBoth, regressed, [shellBug])
    expect(decision).toMatchObject({ ok: true })
    if (decision.ok) {
      expect(decision.report.stories.map((s) => [s.key, s.batch])).toEqual([
        ["items", true],
        ["shell", false],
      ])
      expect(storyPassed(decision.report.stories[1])).toBe(false)
    }
  })

  it("doesn't ask for criteria the user accepted as is (plan 110.03)", () => {
    const waived = verification({
      stories: [
        { ...stories[0], waived: ["AC-2"] },
        { ...stories[1], waived: ["AC-1"] },
      ],
      results: [
        result("f.m.items", "add", true),
        result("f.m.items", "complete", false),
        result("f.m.shell", "loads", false),
      ],
    })
    const decision = decideGateRecord({
      submission: submit([passedBoth[0]]),
      verification: waived,
      recordedBy: "qa@implementation",
      processRunId: "run-1",
    })
    expect(decision).toMatchObject({ ok: true })
  })

  it("needs a check_fixed with a justification to change an earlier story's checks", () => {
    const changed = {
      checkChanges: [
        {
          path: "e2e/specs/shell.spec.ts",
          change: "modified" as const,
          earlierStories: ["shell"],
        },
        {
          path: "e2e/pages/app.ts",
          change: "modified" as const,
          earlierStories: [],
        },
      ],
    }
    expect(decide(passedBoth, changed)).toMatchObject({
      ok: false,
      message: expect.stringContaining(
        "which holds checks of shell, a story that already passed a gate"
      ),
    })
    const decision = decide(
      passedBoth,
      {
        ...changed,
        results: [
          result("f.m.items", "add", true),
          result("f.m.items", "complete", true),
          result("f.m.shell", "loads", false, { ranAt: 0, suiteHash: OLD }),
          result("f.m.shell", "loads", true, { ranAt: 2 }),
        ],
      },
      [
        {
          story: "f.m.shell",
          criteria: [
            {
              id: "AC-1",
              outcome: "check_fixed",
              evidence: "green",
              justification: "It pinned the old heading text",
            },
          ],
        },
      ]
    )
    expect(decision).toMatchObject({ ok: true })
    if (decision.ok)
      expect(decision.report.warnings).toEqual([
        "Changed the check of shell AC-1, which passed an earlier gate: It pinned the old heading text",
        "Changed shared checks code: e2e/pages/app.ts.",
      ])
  })

  it("takes unreachable only for a check that couldn't reach the app, with a reason", () => {
    const setup = {
      results: [
        result("f.m.items", "add", true),
        result("f.m.items", "complete", false, {
          unreachable: "ERR_CONNECTION_REFUSED",
        }),
        result("f.m.shell", "loads", true),
      ],
    }
    const unreachable = { id: "AC-2", outcome: "unreachable", evidence: "x" }
    expect(decide([passedBoth[0], unreachable], setup)).toMatchObject({
      ok: false,
      message: expect.stringContaining("unreachable needs a reason"),
    })
    expect(
      decide([passedBoth[0], { ...unreachable, reason: "No server" }], setup)
    ).toMatchObject({ ok: true })
    expect(
      decide([passedBoth[0], { ...unreachable, reason: "No server" }])
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining(
        "none of its checks was reported as unable to reach the app"
      ),
    })
  })

  it("needs a manifest for every batch story and evidence for exploratory-only criteria", () => {
    expect(
      decide(passedBoth, {
        manifestProblems: { "f.m.items": "There is no check manifest." },
        coverage: {
          "f.m.shell": { "AC-1": { automated: ["loads"], exploratory: [] } },
        },
      })
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("items: There is no check manifest."),
    })
    const exploratory = {
      coverage: {
        "f.m.items": {
          "AC-1": { automated: ["add"], exploratory: [] },
          "AC-2": { automated: [], exploratory: ["look"] },
        },
        "f.m.shell": { "AC-1": { automated: ["loads"], exploratory: [] } },
      },
    }
    expect(decide(passedBoth, exploratory)).toMatchObject({
      ok: false,
      message: expect.stringContaining("only exploratory checks"),
    })
    expect(
      decide(
        [
          passedBoth[0],
          { ...passedBoth[1], artifacts: ["/evidence/shot.jpg"] },
        ],
        exploratory
      )
    ).toMatchObject({ ok: true })
    expect(
      decide(
        [passedBoth[0], { ...passedBoth[1], artifacts: ["/tmp/other.jpg"] }],
        exploratory
      )
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("isn't a file in this step's evidence"),
    })
  })
})

import { describe, expect, it } from "vitest"
import type { SuiteRun } from "../db/types"
import {
  decideGateRecord,
  parseGateSubmission,
  storyPassed,
  testCovers,
  titleTags,
  type GateStory,
  type GateSubmission,
  type GateVerification,
} from "./gate-record"

// The wave gate's record rules (plan 112.5): tests map to criteria by their
// title tags, and each outcome needs its evidence on the current suite.

const batch: GateStory = {
  userStoryId: "s1",
  key: "add",
  storyRef: "F.M1.add",
  criteria: [
    { id: "AC-1", text: "Adding shows the item" },
    { id: "AC-2", text: "Empty names are refused" },
  ],
  batch: true,
}
const earlier: GateStory = {
  userStoryId: "s0",
  key: "list",
  storyRef: "F.M1.list",
  criteria: [{ id: "AC-1", text: "The list shows" }],
  batch: false,
}

type Test = SuiteRun["tests"][number]
const pass = (title: string): Test => ({
  title,
  file: "a.spec.ts",
  status: "passed",
})
const fail = (title: string, cls: Test["class"] = "feature"): Test => ({
  title,
  file: "a.spec.ts",
  status: "failed",
  error: "expect(received).toBe(expected)",
  class: cls,
})

function verify(
  tests: Test[],
  over: Partial<GateVerification> = {}
): GateVerification {
  return {
    stories: [batch, earlier],
    suiteRun: { hash: "h1", ranAt: 1, tests },
    suiteHash: "h1",
    evidence: new Set(["shot.png"]),
    testChanges: [],
    ...over,
  }
}

type Entry = GateSubmission["stories"][number]["criteria"][number]
const sub = (
  criteria: Entry[],
  more: GateSubmission["stories"] = []
): GateSubmission => ({
  stories: [{ storyRef: batch.storyRef, criteria }, ...more],
})
const passed = (id: string): Entry => ({
  id,
  outcome: "passed",
  evidence: "ran",
})

function decide(submission: GateSubmission, verification: GateVerification) {
  return decideGateRecord({
    submission,
    verification,
    recordedBy: "pod.qa",
    processRunId: "r1",
    now: 5,
  })
}

const green = [
  pass("adds @F.M1.add @AC-1"),
  pass("refuses empty @F.M1.add @AC-2"),
  pass("shows @F.M1.list @AC-1"),
]

describe("tags", () => {
  it("reads @tags from a title and maps a test to (story, criterion)", () => {
    expect(titleTags("List › adds an item @F.M1.add @AC-1")).toEqual([
      "F.M1.add",
      "AC-1",
    ])
    expect(testCovers("adds @F.M1.add @AC-1", "F.M1.add", "AC-1")).toBe(true)
    expect(testCovers("adds @F.M1.add @AC-1", "F.M1.add", "AC-2")).toBe(false)
    expect(testCovers("adds @F.M1.addx @AC-1", "F.M1.add", "AC-1")).toBe(false)
  })
})

describe("parseGateSubmission", () => {
  it("names stories by ref or key and refuses unknown criteria", () => {
    const parsed = parseGateSubmission(
      {
        stories: [
          {
            story: "add",
            criteria: [{ id: "ac-1", outcome: "passed", evidence: "x" }],
          },
        ],
      },
      [batch, earlier],
      new Set(["s1"])
    )
    expect(parsed).toEqual({
      stories: [
        {
          storyRef: "F.M1.add",
          criteria: [{ id: "AC-1", outcome: "passed", evidence: "x" }],
        },
      ],
    })
    expect(
      parseGateSubmission(
        {
          stories: [
            {
              story: "@F.M1.add",
              criteria: [{ id: "AC-9", outcome: "passed", evidence: "x" }],
            },
          ],
        },
        [batch],
        new Set(["s1"])
      )
    ).toMatch(/isn't one of add's criteria/)
  })
})

describe("decideGateRecord", () => {
  it("accepts a fully green, fully triaged batch", () => {
    const d = decide(sub([passed("AC-1"), passed("AC-2")]), verify(green))
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.report.suite).toEqual({ tests: 3, passed: 3, hash: "h1" })
    expect(d.report.stories[0].criteria[0].tests).toEqual([
      { title: "adds @F.M1.add @AC-1", status: "passed" },
    ])
    expect(storyPassed(d.report.stories[0])).toBe(true)
  })

  it("counts only a whole-suite run on the suite as it is", () => {
    const stale = decide(
      sub([passed("AC-1"), passed("AC-2")]),
      verify(green, { suiteHash: "h2" })
    )
    expect(stale).toMatchObject({ ok: false })
    expect(!stale.ok && stale.message).toMatch(
      /suite changed since its last run/
    )
    const none = decide(
      sub([passed("AC-1"), passed("AC-2")]),
      verify([], { suiteRun: null })
    )
    expect(!none.ok && none.message).toMatch(/hasn't run yet/)
  })

  it("requires every batch criterion and every earlier criterion whose test failed", () => {
    const d = decide(
      sub([passed("AC-1")]),
      verify([...green.slice(0, 2), fail("shows @F.M1.list @AC-1")])
    )
    expect(!d.ok && d.message).toMatch(/missing AC-2/)
    expect(!d.ok && d.message).toMatch(
      /list passed an earlier gate, but its tests for AC-1 failed/
    )
  })

  it("refuses a failing test that no triaged criterion explains", () => {
    const d = decide(
      sub([passed("AC-1"), passed("AC-2")]),
      verify([...green, fail("some untagged test")])
    )
    expect(!d.ok && d.message).toMatch(/1 failing test isn't tagged/)
  })

  it("passed needs its tagged tests green, or a screenshot when none can check it", () => {
    const red = decide(
      sub([passed("AC-1"), passed("AC-2")]),
      verify([
        pass("adds @F.M1.add @AC-1"),
        fail("refuses empty @F.M1.add @AC-2"),
      ])
    )
    expect(!red.ok && red.message).toMatch(
      /AC-2: "refuses empty @F.M1.add @AC-2" failed/
    )
    const untested = decide(
      sub([passed("AC-1"), passed("AC-2")]),
      verify([pass("adds @F.M1.add @AC-1")])
    )
    expect(!untested.ok && untested.message).toMatch(/AC-2: no test tagged/)
    const shot = decide(
      sub([passed("AC-1"), { ...passed("AC-2"), artifacts: ["shot.png"] }]),
      verify([pass("adds @F.M1.add @AC-1")])
    )
    expect(shot.ok).toBe(true)
  })

  it("app_bug needs a problem and a test that failed on an assertion", () => {
    const tests = [
      pass("adds @F.M1.add @AC-1"),
      fail("refuses empty @F.M1.add @AC-2"),
    ]
    const bare = decide(
      sub([
        passed("AC-1"),
        { id: "AC-2", outcome: "app_bug", evidence: "red" },
      ]),
      verify(tests)
    )
    expect(!bare.ok && bare.message).toMatch(/app_bug needs a problem/)
    const ok = decide(
      sub([
        passed("AC-1"),
        {
          id: "AC-2",
          outcome: "app_bug",
          evidence: "red",
          problem: "Empty names are saved.",
        },
      ]),
      verify(tests)
    )
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(storyPassed(ok.report.stories[0])).toBe(false)
    const setup = decide(
      sub([
        passed("AC-1"),
        { id: "AC-2", outcome: "app_bug", evidence: "red", problem: "x" },
      ]),
      verify([tests[0], fail("refuses empty @F.M1.add @AC-2", "environment")])
    )
    expect(!setup.ok && setup.message).toMatch(/record environment/)
  })

  it("environment needs a reason and a test that couldn't reach the app", () => {
    const tests = [
      pass("adds @F.M1.add @AC-1"),
      fail("refuses empty @F.M1.add @AC-2", "environment"),
    ]
    expect(
      decide(
        sub([
          passed("AC-1"),
          {
            id: "AC-2",
            outcome: "environment",
            evidence: "refused",
            reason: "ECONNREFUSED",
          },
        ]),
        verify(tests)
      ).ok
    ).toBe(true)
    const asserted = decide(
      sub([
        passed("AC-1"),
        { id: "AC-2", outcome: "environment", evidence: "x", reason: "x" },
      ]),
      verify([tests[0], fail("refuses empty @F.M1.add @AC-2")])
    )
    expect(!asserted.ok && asserted.message).toMatch(
      /failed on an assertion: that's app_bug/
    )
  })

  it("check_fixed needs a justification and a changed suite; on an earlier story it's highlighted", () => {
    const fixedEarlier = sub(
      [passed("AC-1"), passed("AC-2")],
      [
        {
          storyRef: earlier.storyRef,
          criteria: [
            {
              id: "AC-1",
              outcome: "check_fixed",
              evidence: "green",
              justification: "It pinned the old button label.",
            },
          ],
        },
      ]
    )
    const unchanged = decide(fixedEarlier, verify(green))
    expect(!unchanged.ok && unchanged.message).toMatch(
      /nothing in the suite changed/
    )
    const change = {
      path: "e2e/list.spec.ts",
      change: "modified" as const,
      earlierStories: ["list"],
    }
    const d = decide(fixedEarlier, verify(green, { testChanges: [change] }))
    expect(d.ok).toBe(true)
    if (d.ok)
      expect(d.report.warnings[0]).toMatch(
        /Changed the test of list AC-1, which passed an earlier gate/
      )
    // Changing an earlier story's test without saying why is refused.
    const silent = decide(
      sub([passed("AC-1"), passed("AC-2")]),
      verify(green, { testChanges: [change] })
    )
    expect(!silent.ok && silent.message).toMatch(
      /holds tests of list, a story that already passed a gate/
    )
  })

  it("raises a spec question only for an earlier criterion that no longer holds", () => {
    const tests = [...green.slice(0, 2), fail("shows @F.M1.list @AC-1")]
    const question = {
      storyRef: earlier.storyRef,
      criteria: [
        {
          id: "AC-1",
          outcome: "spec_question" as const,
          evidence: "The list moved behind a tab.",
          question:
            "add moved the list behind a tab: should list's AC-1 change?",
        },
      ],
    }
    expect(
      decide(sub([passed("AC-1"), passed("AC-2")], [question]), verify(tests))
        .ok
    ).toBe(true)
    const onBatch = decide(
      sub([
        passed("AC-1"),
        { id: "AC-2", outcome: "spec_question", evidence: "x", question: "?" },
      ]),
      verify(tests)
    )
    expect(!onBatch.ok && onBatch.message).toMatch(
      /A batch criterion that fails is app_bug/
    )
    const holds = decide(
      sub([passed("AC-1"), passed("AC-2")], [question]),
      verify(green)
    )
    expect(!holds.ok && holds.message).toMatch(
      /its tests pass, so it still holds/
    )
  })
})

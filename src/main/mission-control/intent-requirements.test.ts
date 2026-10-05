import { describe, it, expect } from "vitest"
import {
  coverageRefusal,
  extractPlanLimits,
  extractRequirements,
  parseCoverage,
  parseRequirementChecks,
  planLimitRefusal,
  requirementCheckRefusal,
} from "./intent-requirements"

// The Quick List intent, whose plan dropped four behaviours and doubled the
// story limit when the planner only saw the first 320 characters of it.
const QUICK_LIST = `Build "Quick List", a tiny single-page shopping list web app.

Constraints:
- Zero dependencies. Plain HTML, CSS, and vanilla JS, plus a small Node server
  (\`server.js\`, using only the built-in \`http\` module) that serves the static
  files. Start it with \`node server.js\`.
- No build step, no framework, no package installs. Don't add a test framework.

Behavior:
1. Add items: a text input labeled "Item" and an "Add" button.
2. Complete items: each item has a checkbox.
3. Remove items: a "Clear completed" button removes every checked item.
4. Persistence: the list survives a page reload (localStorage).
5. Empty state: when the list is empty, show the text "Nothing on your list".
6. Counter: a header shows "N left", counting only unchecked items.

Keep it to one milestone with at most 3 user stories.`

describe("extractRequirements", () => {
  it("reads numbered and bulleted items with their continuation lines", () => {
    const requirements = extractRequirements(QUICK_LIST)
    expect(requirements.map((r) => r.id)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"])
    expect(requirements[0].text).toBe(
      "Zero dependencies. Plain HTML, CSS, and vanilla JS, plus a small Node server (`server.js`, using only the built-in `http` module) that serves the static files. Start it with `node server.js`."
    )
    expect(requirements[7].text).toBe('Counter: a header shows "N left", counting only unchecked items.')
  })

  it("finds none in prose", () => {
    expect(extractRequirements("Customers can be invoiced.")).toEqual([])
  })
})

describe("extractPlanLimits", () => {
  it("reads milestone and story limits", () => {
    expect(extractPlanLimits(QUICK_LIST)).toEqual({ maxMilestones: 1, maxUserStories: 3 })
  })

  it("reads per-milestone limits and singular phrasing", () => {
    expect(
      extractPlanLimits("Use a single milestone. No more than two user stories per milestone.")
    ).toEqual({ maxMilestones: 1, maxUserStoriesPerMilestone: 2 })
  })

  it("finds nothing when the intent sets no limit", () => {
    expect(extractPlanLimits("Customers can be invoiced.")).toEqual({})
  })
})

const story = (key: string, criteria: number) => ({
  key,
  title: key,
  acceptance: Array.from({ length: criteria }, (_, i) => `c${i + 1}`),
})

describe("planLimitRefusal", () => {
  it("refuses a plan with more stories than the intent allows", () => {
    const milestone = { name: "M1", outcome: "", userStories: [1, 2, 3, 4].map((n) => story(`s${n}`, 1)) }
    expect(planLimitRefusal(QUICK_LIST, [milestone])).toMatch(/at most 3 user stories; this plan has 4/)
    expect(planLimitRefusal(QUICK_LIST, [{ ...milestone, userStories: milestone.userStories.slice(0, 3) }])).toBeNull()
  })

  it("refuses a second milestone", () => {
    const m = { name: "M", outcome: "", userStories: [story("a", 1)] }
    expect(planLimitRefusal(QUICK_LIST, [m, m])).toMatch(/at most 1 milestone/)
  })
})

describe("coverageRefusal", () => {
  const requirements = extractRequirements("1. Add items\n2. Remove items")
  const plan = [{ name: "M", outcome: "", userStories: [story("list", 2)] }]

  it("names requirements no criterion covers", () => {
    const coverage = parseCoverage([{ requirement: "R1", user_story: "list", criteria: [1] }])
    expect(coverageRefusal(requirements, plan, coverage as never)).toMatch(/Not traced .*R2 \(Remove items\)/)
  })

  it("rejects criteria and stories that don't exist", () => {
    const coverage = parseCoverage([
      { requirement: "R1", user_story: "list", criteria: [3] },
      { requirement: "R2", user_story: "nope", criteria: [1] },
    ])
    const refusal = coverageRefusal(requirements, plan, coverage as never)
    expect(refusal).toMatch(/AC-3 doesn't exist/)
    expect(refusal).toMatch(/no user story "nope"/)
  })

  it("accepts full coverage, including AC-n strings", () => {
    const coverage = parseCoverage([
      { requirement: "r1", user_story: "list", criteria: ["AC-1"] },
      { requirement: "R2", user_story: "list", criteria: [2] },
    ])
    expect(coverageRefusal(requirements, plan, coverage as never)).toBeNull()
  })

  it("doesn't apply to an intent without requirements", () => {
    expect(coverageRefusal([], plan, [])).toBeNull()
  })
})

describe("requirementCheckRefusal", () => {
  const requirements = extractRequirements("1. Add items\n2. Remove items")
  const check = (value: unknown) => parseRequirementChecks(value) as never

  it("needs a judgment for every requirement", () => {
    expect(
      requirementCheckRefusal(requirements, check([{ requirement: "R1", status: "met", evidence: "AC-1" }]), true)
    ).toMatch(/Missing:\n- R2: Remove items/)
  })

  it("refuses unmet requirements, and deferral on the last milestone", () => {
    const notMet = check([
      { requirement: "R1", status: "met", evidence: "AC-1" },
      { requirement: "R2", status: "not_met" },
    ])
    expect(requirementCheckRefusal(requirements, notMet, false)).toMatch(/unmet:\n- R2/)
    const later = check([
      { requirement: "R1", status: "met", evidence: "AC-1" },
      { requirement: "R2", status: "later_milestone" },
    ])
    expect(requirementCheckRefusal(requirements, later, true)).toMatch(/last milestone/)
    expect(requirementCheckRefusal(requirements, later, false)).toBeNull()
  })

  it("needs evidence for what it calls met", () => {
    const bare = check([
      { requirement: "R1", status: "met" },
      { requirement: "R2", status: "met", evidence: "AC-2" },
    ])
    expect(requirementCheckRefusal(requirements, bare, true)).toMatch(/needs `evidence`/)
  })
})

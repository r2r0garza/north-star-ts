import { describe, it, expect } from "vitest"
import {
  parsePlan,
  validatePlan,
  assignmentBriefing,
  type FanOutPlan,
  MAX_FAN_OUT,
  decompositionRetryNote,
  fanOutDecomposePrompt,
  withObjective,
  withReworkFeedback,
  kickoffPrompt,
  eachSubtaskKickoffPrompt,
  UNATTENDED_WORK_NOTE,
  validatorPrompt,
  parseVerdict,
} from "./prompts"
import type { ProcessPhase } from "../../db/types"

const phase: ProcessPhase = {
  id: "p1",
  processId: "def1",
  key: "impl",
  name: "Implement",
  routing: "single",
  gatePolicy: "approve",
  fanOut: false,
  maxReworkRounds: 0,
  dotFolder: false,
  validator: false,
  validatorMaxIterations: 0,
  validatorAgent: null,
  subprocessId: null,
  position: 0,
}

// The acceptance case from the defect-lab-v5 audit: three defects across
// frontend, backend and docs must each be assigned exactly once with no
// overlapping write scopes.
const AGENTS = ["frontend-dev", "backend-dev", "docs-writer"]
const threeDefectPlan = (): FanOutPlan => ({
  findings: [
    { id: "F1", summary: "Login form rejects valid emails" },
    { id: "F2", summary: "/session returns 500 on expired tokens" },
    { id: "F3", summary: "README documents the wrong port" },
  ],
  assignments: [
    {
      agent: "frontend-dev",
      task: "Fix email validation in the login form",
      findings: ["F1"],
      writes: ["src/renderer/login-form.tsx"],
    },
    {
      agent: "backend-dev",
      task: "Handle expired tokens in the session route",
      findings: ["F2"],
      writes: ["src/main/session/"],
    },
    {
      agent: "docs-writer",
      task: "Correct the port in the README",
      findings: ["F3"],
      writes: ["./README.md"],
    },
  ],
})

describe("parsePlan", () => {
  it("parses the plan object out of a fence with prose around it", () => {
    const text =
      "Here is my plan:\n```json\n" +
      JSON.stringify(threeDefectPlan()) +
      "\n```\nDone."
    expect(parsePlan(text)).toEqual(threeDefectPlan())
  })

  it("trims fields and treats a missing agent as null", () => {
    const plan = parsePlan(
      '{"findings": [{"id": " F1 ", "summary": " s "}], "assignments": ' +
        '[{"task": " do it ", "findings": [" F1 ", ""], "writes": []}]}'
    )
    expect(plan).toEqual({
      findings: [{ id: "F1", summary: "s" }],
      assignments: [
        { agent: null, task: "do it", findings: ["F1"], writes: [] },
      ],
    })
  })

  it("returns null without a plan-shaped object", () => {
    expect(parsePlan("")).toBeNull()
    expect(parsePlan('["a", "b"]')).toBeNull()
    expect(parsePlan('{"assignments": []}')).toBeNull()
    expect(parsePlan("I could not plan this phase.")).toBeNull()
  })
})

describe("validatePlan", () => {
  it("accepts three defects each assigned exactly once with disjoint writes", () => {
    const plan = threeDefectPlan()
    expect(validatePlan(plan, AGENTS)).toBeNull()
    const assigned = plan.assignments.flatMap((a) => a.findings)
    expect(assigned.sort()).toEqual(["F1", "F2", "F3"])
  })

  it("accepts a single assignment holding every item", () => {
    const plan = threeDefectPlan()
    plan.assignments = [
      {
        agent: "backend-dev",
        task: "Fix all three",
        findings: ["F1", "F2", "F3"],
        writes: ["src/", "README.md"],
      },
    ]
    expect(validatePlan(plan, AGENTS)).toBeNull()
  })

  it("applies the same checks to a first-round requirements plan", () => {
    const plan: FanOutPlan = {
      findings: [
        { id: "F1", summary: "Login form component" },
        { id: "F2", summary: "/session API route" },
      ],
      assignments: [
        { agent: null, task: "Build the form", findings: ["F1"], writes: ["src/ui"] },
        { agent: null, task: "Add the route", findings: ["F1", "F2"], writes: ["src/api"] },
      ],
    }
    expect(validatePlan(plan, [])).toMatch(/"F1" is assigned to both/)
    plan.assignments[1].findings = ["F2"]
    expect(validatePlan(plan, [])).toBeNull()
  })

  it("rejects an empty work-item inventory", () => {
    const plan = threeDefectPlan()
    plan.findings = []
    expect(validatePlan(plan, AGENTS)).toMatch(/no work items/)
  })

  it("rejects a dropped item", () => {
    const plan = threeDefectPlan()
    plan.assignments.pop()
    expect(validatePlan(plan, AGENTS)).toMatch(/not assigned.*F3/)
  })

  it("rejects an item assigned twice", () => {
    const plan = threeDefectPlan()
    plan.assignments[1].findings.push("F1")
    expect(validatePlan(plan, AGENTS)).toMatch(/"F1" is assigned to both/)
  })

  it("rejects an unknown item id", () => {
    const plan = threeDefectPlan()
    plan.assignments[0].findings.push("F9")
    expect(validatePlan(plan, AGENTS)).toMatch(/"F9", which is not in findings/)
  })

  it("rejects an assignment with no items", () => {
    const plan = threeDefectPlan()
    plan.assignments[2].findings = []
    expect(validatePlan(plan, AGENTS)).toMatch(/assignment 3 covers no work items/)
  })

  it("rejects overlapping write scopes", () => {
    const plan = threeDefectPlan()
    plan.assignments[0].writes = ["src/"]
    plan.assignments[1].writes = ["src/main/x.ts"]
    expect(validatePlan(plan, AGENTS)).toMatch(/assignments 1 and 2 both write/)
    plan.assignments[0].writes = ["docs/*.md"]
    plan.assignments[1].writes = ["docs/guide.md"]
    expect(validatePlan(plan, AGENTS)).toMatch(/assignments 1 and 2/)
    plan.assignments[0].writes = ["src/main"]
    plan.assignments[1].writes = ["src/main-window.ts"]
    expect(validatePlan(plan, AGENTS)).toBeNull()
  })

  it("rejects an agent outside the pool, but ignores agents without a pool", () => {
    const plan = threeDefectPlan()
    plan.assignments[0].agent = "designer"
    expect(validatePlan(plan, AGENTS)).toMatch(/agent "designer"/)
    expect(validatePlan(plan, [])).toBeNull()
  })

  it("rejects more than MAX_FAN_OUT assignments instead of truncating", () => {
    const n = MAX_FAN_OUT + 1
    const plan: FanOutPlan = {
      findings: Array.from({ length: n }, (_, i) => ({ id: `F${i}`, summary: "" })),
      assignments: Array.from({ length: n }, (_, i) => ({
        agent: null,
        task: `t${i}`,
        findings: [`F${i}`],
        writes: [`f${i}.ts`],
      })),
    }
    expect(validatePlan(plan, [])).toMatch(/limit is 8/)
  })
})

describe("assignmentBriefing", () => {
  it("lists the owned work items and files", () => {
    const plan = threeDefectPlan()
    const b = assignmentBriefing(plan, plan.assignments[1])
    expect(b).toContain("Handle expired tokens in the session route")
    expect(b).toContain("- F2: /session returns 500 on expired tokens")
    expect(b).toContain("- `src/main/session/`")
    expect(b).not.toContain("F1")
  })
})

describe("kickoffPrompt — rework note (plan 029)", () => {
  it("omits the Requested changes section when there is no note", () => {
    const p = kickoffPrompt({ phase, objective: "ship it", upstream: [] })
    expect(p).not.toContain("## Requested changes")
    expect(p).toContain("## Your task")
  })

  it("injects the note before the task section when present", () => {
    const p = kickoffPrompt({
      phase,
      objective: "ship it",
      upstream: [],
      reworkNote: "shorten the summary",
    })
    expect(p).toContain("## Requested changes")
    expect(p).toContain("shorten the summary")
    // The feedback comes before the task instructions.
    expect(p.indexOf("## Requested changes")).toBeLessThan(
      p.indexOf("## Your task")
    )
  })

  it("frames a flag's target as a downstream finding", () => {
    const p = kickoffPrompt({
      phase,
      objective: "ship it",
      upstream: [],
      reworkNote: "login form crashes",
      reworkSource: "flagged",
    })
    expect(p).toContain("A downstream phase identified defects")
    expect(p).not.toContain("A reviewer looked")
  })

  it("frames the flagger's own finding as a re-evaluation", () => {
    const p = kickoffPrompt({
      phase,
      objective: "ship it",
      upstream: [],
      reworkNote: "You flagged an upstream phase for rework: login form crashes",
      reworkSource: "flagger",
    })
    expect(p).toContain("## Your earlier rework request")
    expect(p).toContain("Do not request rework for findings that have been resolved")
    expect(p).not.toContain("## Requested changes")
    expect(p).not.toContain("A reviewer looked")
  })

  it("ignores a blank/whitespace note", () => {
    const p = kickoffPrompt({
      phase,
      objective: "ship it",
      upstream: [],
      reworkNote: "   ",
    })
    expect(p).not.toContain("## Requested changes")
  })
})

describe("withObjective", () => {
  it("appends the objective after the briefing", () => {
    const b = withObjective("Build the frontend", "Priorities: P1, P2, P3, P4")
    expect(b.startsWith("Build the frontend")).toBe(true)
    expect(b).toContain("## Overall objective")
    expect(b).toContain("Priorities: P1, P2, P3, P4")
  })

  it("does not repeat an objective the briefing already carries", () => {
    const b = "Task\n\n## Overall objective\nspec"
    expect(withObjective(b, "spec")).toBe(b)
    expect(withObjective("Task", "  ")).toBe("Task")
  })
})

describe("withReworkFeedback", () => {
  it("appends the feedback verbatim after the briefing", () => {
    const b = withReworkFeedback(
      "Add the form fields",
      "fields missing in App.tsx"
    )
    expect(b.startsWith("Add the form fields")).toBe(true)
    expect(b).toContain("## Why this work is being redone")
    expect(b).toContain("fields missing in App.tsx")
  })

  it("leaves a first-run briefing unchanged", () => {
    expect(withReworkFeedback("Build it", undefined)).toBe("Build it")
    expect(withReworkFeedback("Build it", "  ")).toBe("Build it")
  })
})

describe("fanOutDecomposePrompt", () => {
  const agents = [
    { name: "frontend-dev", description: "React UI work" },
    { name: "backend-dev", description: "" },
  ]

  it("asks for a requirements inventory on a first run", () => {
    const p = fanOutDecomposePrompt({
      phase: { ...phase, fanOut: true },
      objective: "ship it",
      upstream: [],
      agents,
    })
    expect(p).not.toContain("## Requested changes")
    expect(p).toContain("work items (requirements)")
    expect(p).toContain("EXACTLY ONE")
    expect(p).toContain("a SINGLE assignment")
    expect(p).toContain("- `frontend-dev` — React UI work")
    expect(p).toContain("- `backend-dev`")
    expect(p).toContain('"agent": "frontend-dev"')
  })

  it("asks for a defect inventory, before the task, on a rework run", () => {
    const p = fanOutDecomposePrompt({
      phase: { ...phase, fanOut: true },
      objective: "ship it",
      upstream: [],
      agents,
      reworkNote: "split the work by platform",
    })
    expect(p).toContain("## Requested changes")
    expect(p).toContain("split the work by platform")
    expect(p).toContain("work items (reported defects)")
    expect(p.indexOf("## Requested changes")).toBeLessThan(
      p.indexOf("## Your task")
    )
  })

  it("ignores a blank note and handles an empty pool", () => {
    const p = fanOutDecomposePrompt({
      phase: { ...phase, fanOut: true },
      objective: "ship it",
      upstream: [],
      agents: [],
      reworkNote: "   ",
    })
    expect(p).not.toContain("## Requested changes")
    expect(p).not.toContain("## Available agents")
    expect(p).toContain('"agent" to null')
  })

  it("names the previous problem in the retry coda", () => {
    expect(decompositionRetryNote("work items not assigned: F3")).toContain(
      "rejected: work items not assigned: F3"
    )
    expect(decompositionRetryNote(null)).toContain("rejected.")
  })
})

describe("kickoffPrompt — dot-folder (plan 030)", () => {
  it("omits the artifact-location section when dotFolder is off", () => {
    const p = kickoffPrompt({ phase, objective: "ship it", upstream: [] })
    expect(p).not.toContain("## Where to write files")
  })

  it("steers artifacts under `.<key>/` when dotFolder is on", () => {
    const p = kickoffPrompt({
      phase: { ...phase, dotFolder: true },
      objective: "ship it",
      upstream: [],
    })
    expect(p).toContain("## Where to write files")
    expect(p).toContain("`.impl/`")
  })
})

describe("kickoffPrompt — flag-for-rework section (plan 031.2)", () => {
  it("lists upstream phases by KEY when there is upstream to flag", () => {
    const p = kickoffPrompt({
      phase,
      objective: "ship it",
      upstream: [
        { phaseName: "Design", phaseKey: "design", content: "the spec" },
        { phaseName: "Plan", phaseKey: "plan", content: "the plan" },
      ],
    })
    expect(p).toContain("## Phases you may flag for rework")
    expect(p).toContain("`design`")
    expect(p).toContain("`plan`")
    expect(p).toContain("flag_for_rework")
  })

  it("keeps harness problems in the worker's own lane", () => {
    const p = kickoffPrompt({
      phase,
      objective: "ship it",
      upstream: [{ phaseName: "Build", phaseKey: "build", content: "built" }],
    })
    expect(p).toContain("Problems with your own setup are yours")
    expect(p).toContain("a run that was killed or never finished")
    expect(p).toContain("Flag only with concrete evidence")
  })

  it("keeps tests and reports in the worker's lane and forbids no-op flags", () => {
    const p = kickoffPrompt({
      phase,
      objective: "ship it",
      upstream: [{ phaseName: "Build", phaseKey: "build", content: "built" }],
    })
    expect(p).toContain("writing or extending tests")
    expect(p).toContain(
      "If you conclude that no rework is needed, do not call it"
    )
    expect(p).toContain("do not report your phase as complete")
  })

  it("lists every flaggable ancestor, not only the direct upstream", () => {
    const p = kickoffPrompt({
      phase,
      objective: "ship it",
      upstream: [{ phaseName: "Test", phaseKey: "test", content: "ok" }],
      flaggable: [
        { phaseName: "Build", phaseKey: "build" },
        { phaseName: "Test", phaseKey: "test" },
      ],
    })
    expect(p).toContain("- `build` — Build")
    expect(p).toContain("- `test` — Test")
    expect(p).not.toContain("### Build") // the output digest stays direct-only
  })

  it("omits the section when there is nothing upstream", () => {
    const p = kickoffPrompt({ phase, objective: "ship it", upstream: [] })
    expect(p).not.toContain("## Phases you may flag for rework")
  })
})

describe("validatorPrompt (plan 031.1)", () => {
  it("includes the objective, phase output, and the strict verdict format", () => {
    const p = validatorPrompt({
      phase,
      objective: "ship the counter",
      upstream: [
        { phaseName: "Design", phaseKey: "design", content: "spec here" },
      ],
      phaseOutput: "I built the component",
    })
    expect(p).toContain("ship the counter")
    expect(p).toContain("I built the component")
    // The upstream digest is carried through.
    expect(p).toContain("Design")
    expect(p).toContain("spec here")
    // The strict JSON verdict contract is spelled out.
    expect(p).toContain('{"approved": true}')
    expect(p).toContain('"approved": false')
    expect(p).toContain('"feedback"')
  })

  it("tolerates a null phase output", () => {
    const p = validatorPrompt({
      phase,
      objective: "obj",
      upstream: [],
      phaseOutput: null,
    })
    expect(p).toContain("(no textual output)")
  })
})

describe("parseVerdict (plan 031.1)", () => {
  it("parses a bare approval object", () => {
    expect(parseVerdict('{"approved": true}')).toEqual({ approved: true })
  })

  it("parses a rejection with feedback", () => {
    expect(
      parseVerdict('{"approved": false, "feedback": "add tests"}')
    ).toEqual({ approved: false, feedback: "add tests" })
  })

  it("pulls the verdict out of a fenced block with surrounding prose", () => {
    const reply =
      'Here is my review.\n\n```json\n{"approved": false, "feedback": "fix the bug"}\n```\n\nThanks!'
    expect(parseVerdict(reply)).toEqual({
      approved: false,
      feedback: "fix the bug",
    })
  })

  it("accepts a `reason` field as feedback and string booleans", () => {
    expect(parseVerdict('{"approved": "no", "reason": "incomplete"}')).toEqual({
      approved: false,
      feedback: "incomplete",
    })
    expect(parseVerdict('{"approved": "yes"}')).toEqual({ approved: true })
  })

  it("ignores braces inside strings when matching", () => {
    expect(
      parseVerdict(
        '{"approved": false, "feedback": "the JSON {a:1} was wrong"}'
      )
    ).toEqual({ approved: false, feedback: "the JSON {a:1} was wrong" })
  })

  it("returns null when there is no parseable verdict", () => {
    expect(parseVerdict("looks good to me!")).toBeNull()
    expect(parseVerdict("")).toBeNull()
    // An object without an `approved` field is not a verdict.
    expect(parseVerdict('{"status": "done"}')).toBeNull()
  })
})

describe("unattended workers", () => {
  it("tells every kickoff that nobody will answer questions", () => {
    expect(
      kickoffPrompt({ phase, objective: "ship it", upstream: [] })
    ).toContain(UNATTENDED_WORK_NOTE)
    expect(
      eachSubtaskKickoffPrompt({
        phase,
        objective: "ship it",
        sourcePhaseName: "Split",
        subtaskContent: "part one",
      })
    ).toContain(UNATTENDED_WORK_NOTE)
  })
})

describe("phase instructions", () => {
  const withInstructions: ProcessPhase = {
    ...phase,
    instructions: "Create the manifests and install deps.",
  }

  it("sends instructions to the phase worker, decomposer, sub-task worker, and reviewer", () => {
    const prompts = [
      kickoffPrompt({ phase: withInstructions, objective: "o", upstream: [] }),
      fanOutDecomposePrompt({
        phase: withInstructions,
        objective: "o",
        upstream: [],
        agents: [],
      }),
      eachSubtaskKickoffPrompt({
        phase: withInstructions,
        objective: "o",
        sourcePhaseName: "Plan",
        subtaskContent: "x",
      }),
      validatorPrompt({
        phase: withInstructions,
        objective: "o",
        upstream: [],
        phaseOutput: "done",
      }),
    ]
    for (const p of prompts)
      expect(p).toContain("Create the manifests and install deps.")
  })

  it("leaves the prompt unchanged without instructions", () => {
    const input = { objective: "o", upstream: [] }
    expect(
      kickoffPrompt({ phase: { ...phase, instructions: "  " }, ...input })
    ).toBe(kickoffPrompt({ phase, ...input }))
  })
})

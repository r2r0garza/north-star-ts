import { describe, it, expect } from "vitest"
import {
  parseDecomposition,
  MAX_FAN_OUT,
  kickoffPrompt,
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
  position: 0,
}

// parseDecomposition is deliberately tolerant of real-world LLM output. These
// cases pin the accepted vs rejected input formats (previously uncovered — a
// brittle first-`[`/last-`]` + first-fence heuristic caused a real run to fail
// with "decomposition produced no parseable sub-tasks").
describe("parseDecomposition", () => {
  it("parses a bare JSON array of strings", () => {
    expect(parseDecomposition('["a", "b", "c"]')).toEqual(["a", "b", "c"])
  })

  it("trims strings and drops empty ones", () => {
    expect(parseDecomposition('["  a  ", "", "   ", "b"]')).toEqual(["a", "b"])
  })

  it("parses an array inside a ```json fence", () => {
    const text = 'Here is the split:\n```json\n["one", "two"]\n```'
    expect(parseDecomposition(text)).toEqual(["one", "two"])
  })

  it("parses an array inside a bare ``` fence", () => {
    expect(parseDecomposition('```\n["x", "y"]\n```')).toEqual(["x", "y"])
  })

  it("finds the JSON array after a LEADING non-JSON fence", () => {
    // A model may open with an explanatory/code fence before the real array.
    const text =
      "Plan:\n```text\nfirst do X, then Y\n```\nSub-tasks:\n" +
      '```json\n["Do X", "Do Y"]\n```'
    expect(parseDecomposition(text)).toEqual(["Do X", "Do Y"])
  })

  it("ignores prose brackets and finds the real array", () => {
    // The old first-`[`…last-`]` span would grab "[see below]…]" and fail.
    const text = 'As noted [see below], here they are: ["a", "b"]'
    expect(parseDecomposition(text)).toEqual(["a", "b"])
  })

  it("accepts an array of objects, pulling a briefing field", () => {
    const text = '[{"task": "Build the form"}, {"briefing": "Add the route"}]'
    expect(parseDecomposition(text)).toEqual(["Build the form", "Add the route"])
  })

  it("accepts objects with a sole string value when no known key matches", () => {
    expect(parseDecomposition('[{"foo": "only value"}]')).toEqual([
      "only value",
    ])
  })

  it("caps at MAX_FAN_OUT", () => {
    const many = JSON.stringify(
      Array.from({ length: MAX_FAN_OUT + 5 }, (_, i) => `t${i}`)
    )
    expect(parseDecomposition(many)).toHaveLength(MAX_FAN_OUT)
  })

  it("returns [] for empty / whitespace input", () => {
    expect(parseDecomposition("")).toEqual([])
    expect(parseDecomposition("   \n  ")).toEqual([])
  })

  it("returns [] when there is no array at all", () => {
    expect(parseDecomposition("I could not decompose this phase.")).toEqual([])
  })

  it("digs a nested array out of a wrapping object", () => {
    // A model that wraps the array (`{"tasks": [...]}`) still works — the parser
    // scans for the first bracketed run that yields briefings.
    expect(parseDecomposition('{"tasks": ["a", "b"]}')).toEqual(["a", "b"])
  })

  it("returns [] for a scalar / object with no array", () => {
    expect(parseDecomposition('{"note": "no tasks here"}')).toEqual([])
    expect(parseDecomposition('"just a string"')).toEqual([])
  })

  it("returns [] for an array of only empty strings", () => {
    expect(parseDecomposition('["", "   "]')).toEqual([])
  })

  it("returns [] for an array of objects with no string field", () => {
    expect(parseDecomposition("[{\"n\": 1}, {\"n\": 2}]")).toEqual([])
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

describe("validatorPrompt (plan 031.1)", () => {
  it("includes the objective, phase output, and the strict verdict format", () => {
    const p = validatorPrompt({
      phase,
      objective: "ship the counter",
      upstream: [{ phaseName: "Design", content: "spec here" }],
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
      parseVerdict('{"approved": false, "feedback": "the JSON {a:1} was wrong"}')
    ).toEqual({ approved: false, feedback: "the JSON {a:1} was wrong" })
  })

  it("returns null when there is no parseable verdict (caller fails open)", () => {
    expect(parseVerdict("looks good to me!")).toBeNull()
    expect(parseVerdict("")).toBeNull()
    // An object without an `approved` field is not a verdict.
    expect(parseVerdict('{"status": "done"}')).toBeNull()
  })
})

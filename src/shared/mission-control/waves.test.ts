import { describe, expect, it } from "vitest"
import {
  deriveWaves,
  findCycle,
  readySet,
  touchHintRoot,
  touchHintsOverlap,
  overlappingPairs,
  scheduleSteps,
} from "./waves"

const nodes = (ids: string[]) =>
  ids.map((id, position) => ({ id, position, status: "ready" }))
const edge = (fromUserStoryId: string, toUserStoryId: string) => ({
  fromUserStoryId,
  toUserStoryId,
})

describe("Mission Control waves", () => {
  it("derives linear, fan-out, fan-in, and diamond levels", () => {
    expect(
      deriveWaves(nodes(["a", "b", "c"]), [
        edge("a", "b"),
        edge("b", "c"),
      ]).waves.map((wave) => wave.map((item) => item.id))
    ).toEqual([["a"], ["b"], ["c"]])
    expect(
      deriveWaves(nodes(["a", "b", "c"]), [
        edge("a", "b"),
        edge("a", "c"),
      ]).waves.map((wave) => wave.map((item) => item.id))
    ).toEqual([["a"], ["b", "c"]])
    expect(
      deriveWaves(nodes(["a", "b", "c"]), [
        edge("a", "c"),
        edge("b", "c"),
      ]).waves.map((wave) => wave.map((item) => item.id))
    ).toEqual([["a", "b"], ["c"]])
    const diamond = deriveWaves(nodes(["a", "b", "c", "d"]), [
      edge("a", "b"),
      edge("a", "c"),
      edge("b", "d"),
      edge("c", "d"),
    ])
    expect(diamond.waves.map((wave) => wave.map((item) => item.id))).toEqual([
      ["a"],
      ["b", "c"],
      ["d"],
    ])
    expect(diamond.criticalPath[0]).toBe("a")
    expect(diamond.criticalPath.at(-1)).toBe("d")
  })

  it("handles an empty milestone and identifies ready user stories", () => {
    expect(deriveWaves([], []).waves).toEqual([])
    const graph = nodes(["a", "b", "c"])
    graph[0].status = "done"
    expect(
      readySet(graph, [edge("a", "b"), edge("c", "b")]).map((item) => item.id)
    ).toEqual(["c"])
  })

  it("returns the cycle path", () => {
    expect(
      findCycle(nodes(["a", "b"]), [edge("a", "b"), edge("b", "a")])
    ).toEqual(["a", "b", "a"])
    expect(() =>
      deriveWaves(nodes(["a", "b"]), [edge("a", "b"), edge("b", "a")])
    ).toThrow(/a → b → a/)
  })
})

describe("touch hints", () => {
  it("anchors a hint at its literal prefix", () => {
    expect(touchHintRoot("src/billing/**")).toBe("src/billing/")
    expect(touchHintRoot("./src/*.ts")).toBe("src/")
    expect(touchHintRoot("docs/api.md")).toBe("docs/api.md")
    expect(touchHintRoot("*.md")).toBe("")
  })

  it("overlaps on shared directories only", () => {
    expect(
      touchHintsOverlap(["src/billing/**"], ["src/billing/invoice.ts"])
    ).toBe(true)
    expect(touchHintsOverlap(["src/billing"], ["src/billing/pdf/**"])).toBe(
      true
    )
    expect(
      touchHintsOverlap(["src/billing/**"], ["src/billing-old/x.ts"])
    ).toBe(false)
    expect(touchHintsOverlap(["src/api/**"], ["src/pdf/**"])).toBe(false)
    expect(touchHintsOverlap(["**/*.ts"], ["docs/x.md"])).toBe(true)
    // No hints declare nothing.
    expect(touchHintsOverlap([], ["src/**"])).toBe(false)
  })
})

describe("scheduleSteps", () => {
  // nav-test-4's plan: every story touches runtime.py.
  const stories = [
    {
      id: "persist",
      touchHints: ["src/runtime.py", "src/cli.py"],
      position: 0,
    },
    {
      id: "claim",
      touchHints: ["src/runtime.py", "tests/test_runtime.py"],
      position: 1,
    },
    {
      id: "read",
      touchHints: ["src/runtime.py", "src/payloads.py"],
      position: 2,
    },
    {
      id: "worker",
      touchHints: ["src/worker.py", "src/runtime.py"],
      position: 3,
    },
  ]
  const edges = [
    { fromUserStoryId: "persist", toUserStoryId: "claim" },
    { fromUserStoryId: "persist", toUserStoryId: "read" },
    { fromUserStoryId: "claim", toUserStoryId: "worker" },
    { fromUserStoryId: "read", toUserStoryId: "worker" },
  ]

  it("serializes overlapping stories when they wait", () => {
    expect(
      scheduleSteps(stories, edges, { maxConcurrent: 3, overlap: "wait" })
    ).toEqual([["persist"], ["claim"], ["read"], ["worker"]])
  })

  it("runs independent overlapping stories together when parallel, within the cap", () => {
    expect(
      scheduleSteps(stories, edges, { maxConcurrent: 3, overlap: "parallel" })
    ).toEqual([["persist"], ["claim", "read"], ["worker"]])
    expect(
      scheduleSteps(stories, edges, { maxConcurrent: 1, overlap: "parallel" })
    ).toHaveLength(4)
  })

  it("treats dependencies outside the set as met", () => {
    const remaining = stories.slice(1)
    expect(
      scheduleSteps(remaining, edges, { maxConcurrent: 3, overlap: "parallel" })
    ).toEqual([["claim", "read"], ["worker"]])
  })

  it("lists only independent overlapping pairs", () => {
    expect(overlappingPairs(stories, edges)).toEqual([["claim", "read"]])
  })
})

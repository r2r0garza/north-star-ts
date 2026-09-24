import { describe, expect, it } from "vitest"
import { deriveWaves, findCycle, readySet } from "./waves"

const nodes = (ids: string[]) =>
  ids.map((id, position) => ({ id, position, status: "ready" }))
const edge = (fromSliceId: string, toSliceId: string) => ({
  fromSliceId,
  toSliceId,
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

  it("handles an empty mission and identifies ready slices", () => {
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

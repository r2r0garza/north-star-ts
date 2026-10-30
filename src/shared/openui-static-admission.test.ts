import { describe, expect, it } from "vitest"
import { admitStaticOpenui } from "./openui-static-admission"

describe("OpenUI static pre-parser admission", () => {
  it("accepts bounded inline components and inert strings", () => {
    expect(
      admitStaticOpenui(
        'root = Stack([Text("Query; @OpenUrl(hello)"), Metric("Rate", 0.75, "percent")]);'
      )
    ).toContain("\\u003b")
  })
  it.each([
    'leaf = Text("x");\nroot = Stack([leaf,leaf]);',
    "root = Stack([leaf,leaf]);",
    "root = Text(@Sum([1,2]));",
    "root = Text($secret);",
    'root = Query("tool", {});',
    'root = Mutation("tool", {});',
    'root = Text(Action([OpenUrl("https://example.com")]));',
    'root = Text("x");\nq = Query("tool", {});',
    'root = Text("x")',
    'root = Text("x", {"style":"bad"});',
    'root = Text("x" + "y");',
    'root = Text("x"); /*comment*/',
    'root = Metric("x", 1e999, "number");',
  ])("rejects non-static syntax before upstream parsing: %s", (source) => {
    expect(() => admitStaticOpenui(source)).toThrow()
  })
  it("bounds bytes, depth, nodes, text and literal work", () => {
    for (const source of [
      `root = Text("${"a".repeat(65536)}");`,
      `root = ${"Stack([".repeat(30)}Text("x")${"])".repeat(30)};`,
      `root = Stack([${Array(201).fill('Text("x")').join(",")}]);`,
      `root = Text("${"a".repeat(2001)}");`,
      `root = Stack([${Array(4001).fill("null").join(",")}]);`,
    ])
      expect(() => admitStaticOpenui(source)).toThrow()
  })
})

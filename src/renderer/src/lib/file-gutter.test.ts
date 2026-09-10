import { describe, expect, it } from "vitest"
import { buildFileGutterAnnotations } from "./file-gutter"

describe("buildFileGutterAnnotations", () => {
  it("marks pure additions at their current-file line numbers", () => {
    const diff = [
      "@@ -1,2 +1,4 @@",
      " first",
      "+second",
      "+third",
      " fourth",
    ].join("\n")

    expect(buildFileGutterAnnotations(diff, 4)).toEqual({
      2: { change: "added" },
      3: { change: "added" },
    })
  })

  it("pairs adjacent removals and additions as modified lines", () => {
    const diff = [
      "@@ -2,3 +2,3 @@",
      " context",
      "-old one",
      "-old two",
      "+new one",
      "+new two",
    ].join("\n")

    expect(buildFileGutterAnnotations(diff, 4)).toEqual({
      3: { change: "modified" },
      4: { change: "modified" },
    })
  })

  it("marks surplus removed lines before the next surviving line", () => {
    const diff = [
      "@@ -1,4 +1,2 @@",
      " first",
      "-removed one",
      "-removed two",
      " third",
    ].join("\n")

    expect(buildFileGutterAnnotations(diff, 2)).toEqual({
      2: { deletedBefore: 2 },
    })
  })

  it("anchors removals at the end of the file after the final line", () => {
    const diff = ["@@ -2,3 +2,1 @@", " second", "-third", "-fourth"].join("\n")

    expect(buildFileGutterAnnotations(diff, 2)).toEqual({
      2: { deletedAfter: 2 },
    })
  })

  it("handles replacement blocks with unequal line counts", () => {
    const diff = [
      "@@ -1,3 +1,4 @@",
      "-old one",
      "+new one",
      "+new two",
      " context",
    ].join("\n")

    expect(buildFileGutterAnnotations(diff, 4)).toEqual({
      1: { change: "modified" },
      2: { change: "added" },
    })
  })
})

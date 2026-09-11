import { describe, expect, it } from "vitest"
import {
  affectedCachedDirectories,
  parentDirectory,
  pathAffectsSelection,
} from "./files-live-refresh"

describe("files live refresh", () => {
  it("derives POSIX parent directories", () => {
    expect(parentDirectory("README.md")).toBe("")
    expect(parentDirectory("src/components/button.tsx")).toBe("src/components")
  })

  it("returns only affected directories that have already been loaded", () => {
    expect(
      affectedCachedDirectories(
        ["README.md", "src/a.ts", "src/nested/b.ts"],
        ["", "src", "src/nested"]
      )
    ).toEqual(["", "src", "src/nested"])
  })

  it("refreshes cached descendants when ignore rules change", () => {
    expect(
      affectedCachedDirectories(
        ["src/.gitignore"],
        ["", "src", "src/nested", "test"]
      )
    ).toEqual(["src", "src/nested"])
    expect(
      affectedCachedDirectories(
        [".gitignore"],
        ["", "src", "src/nested", "test"]
      )
    ).toEqual(["", "src", "src/nested", "test"])
  })

  it("returns all cached directories after watcher overflow", () => {
    expect(affectedCachedDirectories([], ["", "src", "test"], true)).toEqual([
      "",
      "src",
      "test",
    ])
  })

  it("detects direct and ancestor changes to the selected file", () => {
    expect(pathAffectsSelection("src/a.ts", "src/a.ts")).toBe(true)
    expect(pathAffectsSelection("src", "src/a.ts")).toBe(true)
    expect(pathAffectsSelection("other", "src/a.ts")).toBe(false)
  })
})

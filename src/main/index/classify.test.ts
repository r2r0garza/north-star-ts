import { describe, it, expect } from "vitest"
import { classifyFile } from "./classify"

describe("classifyFile", () => {
  const existing = { size: 100, mtime: 1000, hash: "abc" }

  it("new: tracked by walk, absent from index", () => {
    expect(classifyFile(undefined, { size: 10, mtime: 1 })).toBe("new")
  })

  it("deleted: in index, absent from walk", () => {
    expect(classifyFile(existing, undefined)).toBe("deleted")
  })

  it("unchanged: same size and mtime (no hash needed)", () => {
    expect(classifyFile(existing, { size: 100, mtime: 1000 })).toBe("unchanged")
  })

  it("changed: stat differs and hash differs", () => {
    expect(classifyFile(existing, { size: 200, mtime: 2000, hash: "xyz" })).toBe("changed")
  })

  it("unchanged: stat differs but hash matches (a touch, not an edit)", () => {
    expect(classifyFile(existing, { size: 100, mtime: 9999, hash: "abc" })).toBe("unchanged")
  })

  it("changed: stat differs, no hash provided yet (caller must hash)", () => {
    // Without a hash the fast path missed and we can't prove equality → changed.
    expect(classifyFile(existing, { size: 200, mtime: 2000 })).toBe("changed")
  })

  it("no-op on empty input", () => {
    expect(classifyFile(undefined, undefined)).toBe("unchanged")
  })
})

import { describe, expect, it } from "vitest"
import { normalizeChecksDir, userStoryRef } from "./checks"

describe("checks directory", () => {
  it("normalizes workspace-relative folders", () => {
    expect(normalizeChecksDir(" ./e2e//qa/ ")).toBe("e2e/qa")
    expect(normalizeChecksDir("tests\\acceptance")).toBe("tests/acceptance")
  })

  it("rejects the root, escapes, absolute paths, and .git", () => {
    for (const value of [
      "",
      " ",
      ".",
      "./",
      "/x",
      "../x",
      "a/../../x",
      ".git",
      3,
    ])
      expect(normalizeChecksDir(value)).toBeNull()
  })

  it("gives each user story a tag-safe reference that keys can't break", () => {
    expect(
      userStoryRef({
        featureKey: "billing",
        milestoneKey: "m1",
        userStoryKey: "invoice-model",
      })
    ).toBe("billing.m1.invoice-model")
    expect(
      userStoryRef({
        featureKey: "../x",
        milestoneKey: "a/b c",
        userStoryKey: "",
      })
    ).toBe("-x.a-b-c.-")
  })
})

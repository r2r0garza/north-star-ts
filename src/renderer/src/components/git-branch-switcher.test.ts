import { describe, expect, it } from "vitest"
import {
  BRANCH_NAME_MAX_LENGTH,
  branchNameError,
  branchPickerOptions,
  filterBranches,
} from "./git-branch-switcher"

describe("filterBranches", () => {
  const branches = [
    { name: "main", current: true },
    { name: "feature/Search-Branches", current: false },
    { name: "fix/sidebar", current: false },
  ]

  it("filters local branches case-insensitively by substring", () => {
    expect(
      filterBranches(branches, "search").map((branch) => branch.name)
    ).toEqual(["feature/Search-Branches"])
    expect(
      filterBranches(branches, "SIDE").map((branch) => branch.name)
    ).toEqual(["fix/sidebar"])
  })

  it("returns the existing order for a blank query", () => {
    expect(filterBranches(branches, "  ")).toBe(branches)
  })
})

describe("branchPickerOptions", () => {
  const branches = [
    { name: "main", current: true },
    { name: "feature/search", current: false },
  ]

  it("puts a create option after matching branches when there is no exact match", () => {
    expect(branchPickerOptions(branches, "mai")).toEqual([
      { kind: "branch", name: "main", current: true },
      { kind: "create", name: "mai", error: null },
    ])
  })

  it("does not offer creation for a case-insensitive exact match", () => {
    expect(branchPickerOptions(branches, "MAIN")).toEqual([
      { kind: "branch", name: "main", current: true },
    ])
  })

  it("returns all branches and no create option for a blank query", () => {
    expect(branchPickerOptions(branches, "  ")).toEqual([
      { kind: "branch", name: "main", current: true },
      { kind: "branch", name: "feature/search", current: false },
    ])
  })

  it("includes an invalid create option with its validation error", () => {
    expect(branchPickerOptions(branches, "bad name")).toEqual([
      {
        kind: "create",
        name: "bad name",
        error: "Enter a valid local branch name.",
      },
    ])
  })
})

describe("branchNameError", () => {
  it("accepts common slash and Unicode branch names", () => {
    expect(branchNameError(" feature/café ")).toBeNull()
    expect(branchNameError("rescue/détaché")).toBeNull()
  })

  it("rejects obviously invalid names before submission", () => {
    expect(branchNameError(" ")).toBe("Enter a branch name.")
    expect(branchNameError("-option")).toBe("Enter a valid local branch name.")
    expect(branchNameError("refs/remotes/origin/main")).toBe(
      "Enter a valid local branch name."
    )
    expect(branchNameError("bad..name")).toBe(
      "Enter a valid local branch name."
    )
    expect(branchNameError("bad name")).toBe("Enter a valid local branch name.")
    expect(branchNameError("a".repeat(BRANCH_NAME_MAX_LENGTH + 1))).toContain(
      String(BRANCH_NAME_MAX_LENGTH)
    )
  })
})

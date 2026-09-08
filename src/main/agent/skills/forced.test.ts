import { describe, expect, it } from "vitest"
import { forcedSkillNames } from "./forced"

describe("forcedSkillNames", () => {
  it("uses selected picker skills without rewriting the user message", () => {
    expect(forcedSkillNames("please commit", ["git-commit"])).toEqual({
      names: ["git-commit"],
    })
  })

  it("detects a leading slash command and strips it for the model", () => {
    expect(forcedSkillNames("/git-commit stage the fix", undefined)).toEqual({
      names: ["git-commit"],
      modelMessage: "stage the fix",
    })
  })

  it("allows an empty leading slash-command remainder", () => {
    expect(forcedSkillNames("/git-commit", undefined)).toEqual({
      names: ["git-commit"],
      modelMessage: "",
    })
  })

  it("dedupes picker and leading command selections", () => {
    expect(forcedSkillNames("/git-commit now", ["git-commit"])).toEqual({
      names: ["git-commit"],
      modelMessage: "now",
    })
  })

  it("preserves picker order before a different leading command", () => {
    expect(forcedSkillNames("/review now", ["git-commit"])).toEqual({
      names: ["git-commit", "review"],
      modelMessage: "now",
    })
  })
})

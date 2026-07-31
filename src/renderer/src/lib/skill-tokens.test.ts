import { describe, it, expect } from "vitest"
import {
  activeSlashToken,
  segmentMessage,
  expandSkillTokens,
} from "./skill-tokens"

describe("activeSlashToken", () => {
  it("detects a token at the start of the input", () => {
    expect(activeSlashToken("/git", 4)).toEqual({
      query: "git",
      start: 0,
      end: 4,
    })
  })

  it("detects a token after whitespace, caret at token end", () => {
    const text = "commit with /git"
    expect(activeSlashToken(text, text.length)).toEqual({
      query: "git",
      start: 12,
      end: 16,
    })
  })

  it("returns just-typed slash with an empty query", () => {
    expect(activeSlashToken("/", 1)).toEqual({ query: "", start: 0, end: 1 })
  })

  it("ignores a slash mid-word (URLs, paths)", () => {
    expect(activeSlashToken("https://a/b", 11)).toBeNull()
    expect(activeSlashToken("src/lib", 7)).toBeNull()
  })

  it("returns null when the caret is not in a token", () => {
    expect(activeSlashToken("/git commit", 11)).toBeNull()
  })
})

describe("segmentMessage", () => {
  const confirmed = new Set(["git-commit"])

  it("returns a single plain segment with no confirmed skills", () => {
    expect(segmentMessage("hi /git-commit", new Set())).toEqual([
      { text: "hi /git-commit", skill: null },
    ])
  })

  it("splits out a confirmed token as its own segment", () => {
    expect(segmentMessage("do /git-commit now", confirmed)).toEqual([
      { text: "do ", skill: null },
      { text: "/git-commit", skill: "git-commit" },
      { text: " now", skill: null },
    ])
  })

  it("does not match a longer word that starts with the skill name", () => {
    expect(segmentMessage("/git-committed", confirmed)).toEqual([
      { text: "/git-committed", skill: null },
    ])
  })

  it("ignores an unconfirmed token", () => {
    expect(segmentMessage("/other thing", confirmed)).toEqual([
      { text: "/other thing", skill: null },
    ])
  })
})

describe("expandSkillTokens", () => {
  it("expands a confirmed token to natural language", () => {
    expect(
      expandSkillTokens(
        "hey, let's do a commit with the /git-commit",
        new Set(["git-commit"])
      )
    ).toBe("hey, let's do a commit with the git-commit skill")
  })

  it("leaves unconfirmed tokens untouched", () => {
    expect(expandSkillTokens("/foo bar", new Set(["git-commit"]))).toBe(
      "/foo bar"
    )
  })

  it("expands every occurrence of a confirmed token", () => {
    expect(
      expandSkillTokens("/cleanup then /cleanup", new Set(["cleanup"]))
    ).toBe("cleanup skill then cleanup skill")
  })
})

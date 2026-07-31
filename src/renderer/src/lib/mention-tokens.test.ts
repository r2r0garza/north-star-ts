import { describe, it, expect } from "vitest"
import {
  activeMentionToken,
  segmentMessage,
  expandMentions,
  type ConfirmedMentions,
} from "./mention-tokens"

describe("activeMentionToken — skill (/)", () => {
  it("detects a token at the start of the input", () => {
    expect(activeMentionToken("/git", 4)).toMatchObject({
      kind: "skill",
      query: "git",
      start: 0,
      end: 4,
    })
  })

  it("detects a token after whitespace, caret at token end", () => {
    const text = "commit with /git"
    expect(activeMentionToken(text, text.length)).toMatchObject({
      kind: "skill",
      query: "git",
      start: 12,
    })
  })

  it("returns a just-typed slash with an empty query", () => {
    expect(activeMentionToken("/", 1)).toMatchObject({
      kind: "skill",
      query: "",
    })
  })

  it("ignores a slash mid-word (URLs, paths)", () => {
    expect(activeMentionToken("https://a/b", 11)).toBeNull()
    expect(activeMentionToken("src/lib", 7)).toBeNull()
  })
})

describe("activeMentionToken — file (@)", () => {
  it("detects an @ token with a path query", () => {
    const text = "look at @src/foo.ts"
    expect(activeMentionToken(text, text.length)).toMatchObject({
      kind: "file",
      query: "src/foo.ts",
      start: 8,
    })
  })

  it("opens on a bare @ with an empty query", () => {
    expect(activeMentionToken("@", 1)).toMatchObject({
      kind: "file",
      query: "",
    })
  })

  it("ignores an @ inside an email", () => {
    expect(activeMentionToken("a@b.com", 7)).toBeNull()
  })

  it("matches the leading @ of @src/foo, not the inner slash", () => {
    // Caret right after the inner path — the `/` fails the boundary rule, so
    // the whole `@src/foo` is the file token.
    expect(activeMentionToken("@src/foo", 8)).toMatchObject({
      kind: "file",
      query: "src/foo",
      start: 0,
    })
  })
})

describe("segmentMessage", () => {
  const skills: ConfirmedMentions = {
    kind: "skill",
    values: new Set(["git-commit"]),
  }
  const files: ConfirmedMentions = {
    kind: "file",
    values: new Set(["src/foo.ts"]),
  }

  it("returns a single plain segment when nothing is confirmed", () => {
    expect(segmentMessage("hi /git-commit @src/foo.ts", [])).toEqual([
      { text: "hi /git-commit @src/foo.ts", kind: null },
    ])
  })

  it("splits out a confirmed skill token", () => {
    expect(segmentMessage("do /git-commit now", [skills])).toEqual([
      { text: "do ", kind: null },
      { text: "/git-commit", kind: "skill" },
      { text: " now", kind: null },
    ])
  })

  it("splits out a confirmed file token", () => {
    expect(segmentMessage("edit @src/foo.ts please", [files])).toEqual([
      { text: "edit ", kind: null },
      { text: "@src/foo.ts", kind: "file" },
      { text: " please", kind: null },
    ])
  })

  it("segments both kinds in one pass", () => {
    const segs = segmentMessage("/git-commit on @src/foo.ts", [skills, files])
    expect(segs).toEqual([
      { text: "/git-commit", kind: "skill" },
      { text: " on ", kind: null },
      { text: "@src/foo.ts", kind: "file" },
    ])
  })

  it("does not match a longer path that starts with a confirmed path", () => {
    expect(segmentMessage("@src/foo.ts.bak", [files])).toEqual([
      { text: "@src/foo.ts.bak", kind: null },
    ])
  })

  it("ignores an unconfirmed token", () => {
    expect(segmentMessage("/other thing", [skills])).toEqual([
      { text: "/other thing", kind: null },
    ])
  })
})

describe("expandMentions", () => {
  const skills: ConfirmedMentions = {
    kind: "skill",
    values: new Set(["git-commit"]),
  }
  const files: ConfirmedMentions = {
    kind: "file",
    values: new Set(["src/foo.ts"]),
  }

  it("expands a skill token to natural language", () => {
    expect(expandMentions("hey, commit with the /git-commit", [skills])).toBe(
      "hey, commit with the git-commit skill"
    )
  })

  it("expands a file token to the bare relative path", () => {
    expect(expandMentions("please edit @src/foo.ts", [files])).toBe(
      "please edit src/foo.ts"
    )
  })

  it("expands both kinds together", () => {
    expect(
      expandMentions("use /git-commit on @src/foo.ts", [skills, files])
    ).toBe("use git-commit skill on src/foo.ts")
  })

  it("leaves unconfirmed tokens untouched", () => {
    expect(expandMentions("/foo @bar/baz", [skills, files])).toBe(
      "/foo @bar/baz"
    )
  })
})

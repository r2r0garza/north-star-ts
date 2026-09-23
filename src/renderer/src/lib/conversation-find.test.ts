import { describe, expect, it } from "vitest"
import { splitConversationFindText } from "./conversation-find"

describe("splitConversationFindText", () => {
  it("finds every non-overlapping match without regard to case", () => {
    expect(splitConversationFindText("One one ONE", "one")).toEqual([
      { text: "One", match: true },
      { text: " ", match: false },
      { text: "one", match: true },
      { text: " ", match: false },
      { text: "ONE", match: true },
    ])
  })

  it("treats punctuation as literal text", () => {
    expect(splitConversationFindText("a.b a-b a.b", "a.b")).toEqual([
      { text: "a.b", match: true },
      { text: " a-b ", match: false },
      { text: "a.b", match: true },
    ])
  })

  it("returns unmatched text for an empty or missing query", () => {
    expect(splitConversationFindText("hello", "")).toEqual([
      { text: "hello", match: false },
    ])
    expect(splitConversationFindText("hello", "world")).toEqual([
      { text: "hello", match: false },
    ])
  })
})

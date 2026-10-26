import { describe, expect, it } from "vitest"
import { liveMessageContent } from "./live-message"

describe("liveMessageContent", () => {
  it("joins text split around tool activity in display order", () => {
    expect(
      liveMessageContent([
        { kind: "text", text: "Before" },
        { kind: "tools" },
        { kind: "text", text: " after" },
      ])
    ).toBe("Before after")
  })

  it("returns an empty string for tool-only progress", () => {
    expect(liveMessageContent([{ kind: "tools" }])).toBe("")
  })
})

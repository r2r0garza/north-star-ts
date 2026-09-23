import { describe, expect, it, vi } from "vitest"
import { firstTextTimestamp, liveMessageContent } from "./live-message"

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

describe("firstTextTimestamp", () => {
  it("captures the time only when visible text first arrives", () => {
    const now = vi.fn(() => 123)

    expect(firstTextTimestamp(null, "", now)).toBeNull()
    expect(firstTextTimestamp(null, "   ", now)).toBeNull()
    expect(firstTextTimestamp(null, "Hello", now)).toBe(123)
    expect(firstTextTimestamp(123, " again", now)).toBe(123)
    expect(now).toHaveBeenCalledTimes(1)
  })

  it("starts fresh when a new turn has no timestamp", () => {
    expect(firstTextTimestamp(null, "Next", () => 456)).toBe(456)
  })
})

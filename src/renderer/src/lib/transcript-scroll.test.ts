import { describe, expect, it } from "vitest"
import {
  INITIAL_TRANSCRIPT_SCROLL_POLICY,
  isTranscriptAtEnd,
  recordTranscriptScroll,
  resetTranscriptScroll,
  settleTranscriptTurn,
  transcriptRestorePosition,
} from "./transcript-scroll"

describe("transcript scroll policy", () => {
  it("treats positions within the end threshold as still following", () => {
    expect(
      isTranscriptAtEnd({
        scrollHeight: 1000,
        scrollTop: 492,
        clientHeight: 500,
      })
    ).toBe(true)
    expect(
      isTranscriptAtEnd({
        scrollHeight: 1000,
        scrollTop: 491,
        clientHeight: 500,
      })
    ).toBe(false)
  })

  it("captures an exact restore position only when away from the end", () => {
    expect(
      transcriptRestorePosition({
        scrollHeight: 2000,
        scrollTop: 650,
        clientHeight: 500,
      })
    ).toBe(650)
    expect(
      transcriptRestorePosition({
        scrollHeight: 1000,
        scrollTop: 500,
        clientHeight: 500,
      })
    ).toBeNull()
  })

  it("suppresses the settled anchor after the reader scrolls away", () => {
    const scrolled = recordTranscriptScroll(
      INITIAL_TRANSCRIPT_SCROLL_POLICY,
      "conversation-a",
      false
    )
    const settled = settleTranscriptTurn(scrolled, "conversation-a", true)

    expect(settled.awayFromEnd.has("conversation-a")).toBe(false)
    expect(settled.suppressSettledAnchor.has("conversation-a")).toBe(true)
  })

  it("keeps the settled anchor when the reader remains at the end", () => {
    const settled = settleTranscriptTurn(
      INITIAL_TRANSCRIPT_SCROLL_POLICY,
      "conversation-a",
      true
    )

    expect(settled.suppressSettledAnchor.has("conversation-a")).toBe(false)
  })

  it("clears suppression when a new turn starts", () => {
    const settled = settleTranscriptTurn(
      recordTranscriptScroll(
        INITIAL_TRANSCRIPT_SCROLL_POLICY,
        "conversation-a",
        false
      ),
      "conversation-a",
      true
    )
    const restarted = resetTranscriptScroll(settled, "conversation-a")

    expect(restarted.awayFromEnd.has("conversation-a")).toBe(false)
    expect(restarted.suppressSettledAnchor.has("conversation-a")).toBe(false)
  })

  it("keeps scroll state scoped to its conversation", () => {
    const settled = settleTranscriptTurn(
      recordTranscriptScroll(
        INITIAL_TRANSCRIPT_SCROLL_POLICY,
        "conversation-a",
        false
      ),
      "conversation-a",
      true
    )

    expect(settled.suppressSettledAnchor.has("conversation-a")).toBe(true)
    expect(settled.suppressSettledAnchor.has("conversation-b")).toBe(false)
  })

  it("does not retain settlement suppression after leaving the conversation", () => {
    const settled = settleTranscriptTurn(
      recordTranscriptScroll(
        INITIAL_TRANSCRIPT_SCROLL_POLICY,
        "conversation-a",
        false
      ),
      "conversation-a",
      true
    )
    const leftConversation = resetTranscriptScroll(settled, "conversation-a")

    expect(leftConversation.suppressSettledAnchor.has("conversation-a")).toBe(
      false
    )
  })
})

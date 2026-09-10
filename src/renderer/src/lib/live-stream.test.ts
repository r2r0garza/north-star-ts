import { describe, expect, it } from "vitest"
import { applyStreamAttempt, type StreamCheckpointState } from "./live-stream"

type Segment = { text: string }

function state(segments: Segment[]): StreamCheckpointState<Segment> {
  return { segments, streamCheckpoints: {}, streamRetrying: false }
}

describe("applyStreamAttempt", () => {
  it("restores only the failed attempt's checkpoint before a retry", () => {
    const committed = [{ text: "earlier round" }]
    const started = applyStreamAttempt(state(committed), {
      phase: "start",
      attemptId: "round:attempt:1",
    })
    const streaming = {
      ...started,
      segments: [...started.segments, { text: "cut off" }],
    }

    const rolledBack = applyStreamAttempt(streaming, {
      phase: "rollback",
      attemptId: "round:attempt:1",
      retrying: true,
    })

    expect(rolledBack.segments).toEqual(committed)
    expect(rolledBack.streamCheckpoints).toEqual({})
    expect(rolledBack.streamRetrying).toBe(true)
  })

  it("keeps streamed segments when an attempt commits", () => {
    const started = applyStreamAttempt(state([]), {
      phase: "start",
      attemptId: "round:attempt:1",
    })
    const streaming = { ...started, segments: [{ text: "complete" }] }

    const committed = applyStreamAttempt(streaming, {
      phase: "commit",
      attemptId: "round:attempt:1",
    })

    expect(committed.segments).toEqual([{ text: "complete" }])
    expect(committed.streamCheckpoints).toEqual({})
    expect(committed.streamRetrying).toBe(false)
  })
})

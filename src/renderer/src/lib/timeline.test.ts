import { describe, expect, it } from "vitest"
import type { Message } from "@/types"
import { buildTimeline } from "./timeline"

function message(id: string, role: Message["role"], content: string): Message {
  return {
    id,
    conversationId: "conversation-1",
    seq: 1,
    role,
    content,
    toolCalls: null,
    toolCallId: null,
    toolName: null,
    tokenEstimate: null,
    createdAt: 1,
  }
}

describe("buildTimeline", () => {
  it("hides persisted background command completion runtime events", () => {
    const content =
      'Runtime event: background command completion(s).\n\n[context provenance: trust=untrusted_data channel=command source="background_command_completion"]\n' +
      "[context boundary: untrusted data]\n" +
      'DATA: {"type":"background_command_completions"}'

    expect(buildTimeline([message("runtime-event", "user", content)])).toEqual(
      []
    )
  })

  it("does not render system runtime context", () => {
    expect(
      buildTimeline([
        message("runtime-event", "system", "Background command completed."),
      ])
    ).toEqual([])
  })

  it("keeps human messages that merely mention background command completions", () => {
    const content = "Why did a background command completion appear here?"

    expect(buildTimeline([message("human-message", "user", content)])).toEqual([
      {
        kind: "text",
        key: "human-message",
        role: "user",
        content,
      },
    ])
  })
})

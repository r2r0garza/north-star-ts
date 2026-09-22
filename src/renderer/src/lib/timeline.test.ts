import { describe, expect, it } from "vitest"
import type { Message } from "@/types"
import { buildTimeline, latestAssistantTextKey } from "./timeline"

function message(
  id: string,
  role: Message["role"],
  content: string,
  createdAt = 1
): Message {
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
    createdAt,
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
        createdAt: 1,
      },
    ])
  })

  it("preserves user and assistant timestamps and message ordering", () => {
    expect(
      buildTimeline([
        message("user-1", "user", "First", 100),
        message("assistant-1", "assistant", "Second", 200),
        message("empty", "assistant", "   ", 300),
      ])
    ).toEqual([
      {
        kind: "text",
        key: "user-1",
        role: "user",
        content: "First",
        createdAt: 100,
      },
      {
        kind: "text",
        key: "assistant-1:text",
        role: "assistant",
        content: "Second",
        createdAt: 200,
      },
    ])
  })

  it("timestamps only the text item when an assistant row also has tools", () => {
    const row = message("assistant-1", "assistant", "Working", 400)
    row.toolCalls = [
      { id: "call-1", name: "read_file_tool", arguments: '{"path":"a.ts"}' },
    ]

    const items = buildTimeline([row])

    expect(items[0]).toEqual({
      kind: "text",
      key: "assistant-1:text",
      role: "assistant",
      content: "Working",
      createdAt: 400,
    })
    expect(items[1]).toMatchObject({
      kind: "tools",
      key: "assistant-1:tools",
    })
  })
})

describe("latestAssistantTextKey", () => {
  it("finds the final assistant text across newer tools and user messages", () => {
    expect(
      latestAssistantTextKey([
        {
          kind: "text",
          key: "assistant",
          role: "assistant",
          content: "Answer",
          createdAt: 1,
        },
        { kind: "tools", key: "tools", calls: [] },
        {
          kind: "text",
          key: "user",
          role: "user",
          content: "Follow-up",
          createdAt: 2,
        },
      ])
    ).toBe("assistant")
  })

  it("returns null when there is no assistant text", () => {
    expect(
      latestAssistantTextKey([
        {
          kind: "text",
          key: "user",
          role: "user",
          content: "Hello",
          createdAt: 1,
        },
      ])
    ).toBeNull()
  })
})

import { describe, expect, it, vi } from "vitest"
import type { AppendMessageInput } from "../../db/repositories/messages"
import { CliTranscriptRecorder } from "./transcript"

function capture() {
  const rows: AppendMessageInput[] = []
  const append = vi.fn((row: AppendMessageInput) => rows.push(row))
  return { rows, append }
}

describe("CLI transcript persistence", () => {
  it("preserves interleaved assistant text, tool calls, results, and final text", () => {
    const { rows, append } = capture()
    const transcript = new CliTranscriptRecorder("conversation-1", append)

    transcript.record({ type: "text", text: "I’ll inspect that. " })
    transcript.record({
      type: "tool_start",
      id: "call-1",
      name: "Read",
      arguments: '{"path":"a.ts"}',
    })
    transcript.record({
      type: "tool_start",
      id: "call-2",
      name: "Grep",
      arguments: '{"query":"needle"}',
    })
    transcript.record({ type: "text", text: "Checking both files." })
    transcript.record({ type: "tool_done", id: "call-2", result: "match" })
    transcript.record({ type: "tool_done", id: "call-1", result: "source" })
    transcript.record({ type: "text", text: "Found it." })
    transcript.persist("Found it.")

    expect(rows).toEqual([
      {
        conversationId: "conversation-1",
        role: "assistant",
        content: "I’ll inspect that. Checking both files.",
        toolCalls: [
          {
            id: "call-1",
            name: "Read",
            arguments: '{"path":"a.ts"}',
          },
          {
            id: "call-2",
            name: "Grep",
            arguments: '{"query":"needle"}',
          },
        ],
      },
      {
        conversationId: "conversation-1",
        role: "tool",
        content: "match",
        toolCallId: "call-2",
        toolName: "Grep",
      },
      {
        conversationId: "conversation-1",
        role: "tool",
        content: "source",
        toolCallId: "call-1",
        toolName: "Read",
      },
      {
        conversationId: "conversation-1",
        role: "assistant",
        content: "Found it.",
        toolCalls: null,
      },
    ])
  })

  it("uses the completed result when no assistant text streamed", () => {
    const { rows, append } = capture()
    const transcript = new CliTranscriptRecorder("conversation-1", append)

    transcript.persist("Final answer")

    expect(rows).toEqual([
      {
        conversationId: "conversation-1",
        role: "assistant",
        content: "Final answer",
        toolCalls: null,
      },
    ])
  })

  it("keeps an unfinished tool call on a stopped turn", () => {
    const { rows, append } = capture()
    const transcript = new CliTranscriptRecorder("conversation-1", append)

    transcript.record({
      type: "tool_start",
      id: "call-1",
      name: "Bash",
      arguments: '{"command":"sleep 10"}',
    })
    transcript.persist()
    transcript.persist("must not be appended twice")

    expect(rows).toEqual([
      {
        conversationId: "conversation-1",
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call-1",
            name: "Bash",
            arguments: '{"command":"sleep 10"}',
          },
        ],
      },
    ])
    expect(append).toHaveBeenCalledTimes(1)
  })
})

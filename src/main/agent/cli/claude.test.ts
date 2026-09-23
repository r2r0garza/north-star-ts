import { describe, expect, it } from "vitest"
import {
  buildClaudeArgs,
  normalizeClaudeModel,
  parseClaudeEvent,
  type ClaudeParseState,
  type CliTurnEvent,
} from "./claude"

describe("Claude Code CLI adapter", () => {
  it("uses Sonnet for an unset or legacy provider-only selection", () => {
    expect(normalizeClaudeModel(null)).toBe("sonnet")
    expect(normalizeClaudeModel("claude-code")).toBe("sonnet")
    expect(normalizeClaudeModel("opus")).toBe("opus")
  })

  it("builds first-turn argv without shell quoting", () => {
    expect(
      buildClaudeArgs({
        message: "inspect this workspace",
        sessionId: "11111111-1111-4111-8111-111111111111",
        resume: false,
        model: "sonnet",
      })
    ).toEqual([
      "-p",
      "inspect this workspace",
      "--session-id",
      "11111111-1111-4111-8111-111111111111",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "sonnet",
    ])
  })

  it("builds resume argv", () => {
    expect(
      buildClaudeArgs({
        message: "continue",
        sessionId: "session-id",
        resume: true,
        model: "fable",
      })
    ).toEqual([
      "-p",
      "continue",
      "--resume",
      "session-id",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "fable",
    ])
  })

  it("isolates one-shot utility calls from tools and session persistence", () => {
    expect(
      buildClaudeArgs({
        message: "name this conversation",
        sessionId: "11111111-1111-4111-8111-111111111111",
        resume: false,
        model: "haiku",
        isolated: true,
        systemPrompt: "Return only a title.",
      })
    ).toEqual([
      "-p",
      "name this conversation",
      "--session-id",
      "11111111-1111-4111-8111-111111111111",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "haiku",
      "--no-session-persistence",
      "--safe-mode",
      "--tools",
      "",
      "--system-prompt",
      "Return only a title.",
    ])
  })

  it("parses a final result", () => {
    const state: ClaudeParseState = {}
    parseClaudeEvent(
      {
        type: "result",
        session_id: "11111111-1111-4111-8111-111111111111",
        result: "CLAUDE_PROBE_OK",
        is_error: false,
      },
      () => {},
      state
    )
    expect(state.sessionId).toBe("11111111-1111-4111-8111-111111111111")
    expect(state.finalText).toBe("CLAUDE_PROBE_OK")
    expect(state.error).toBeUndefined()
  })

  it("parses text, tool activity, output, and final result from stream events", () => {
    const events: CliTurnEvent[] = []
    const state: ClaudeParseState = {}
    const stream = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "printf CLAUDE_TOOL_OK" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tool-1", content: "unused" },
          ],
        },
        tool_use_result: { stdout: "CLAUDE_TOOL_OK" },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "CLAUDE_STREAM_PROBE_OK" }],
        },
      },
      { type: "result", result: "CLAUDE_STREAM_PROBE_OK", is_error: false },
    ]
    for (const event of stream) {
      parseClaudeEvent(event, (event) => events.push(event), state)
    }
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_start", name: "Bash" }),
        expect.objectContaining({
          type: "tool_done",
          result: "CLAUDE_TOOL_OK",
        }),
        expect.objectContaining({
          type: "text",
          text: "CLAUDE_STREAM_PROBE_OK",
        }),
      ])
    )
    expect(state.finalText).toBe("CLAUDE_STREAM_PROBE_OK")
  })
})

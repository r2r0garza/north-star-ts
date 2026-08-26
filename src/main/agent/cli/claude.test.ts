import { readFileSync } from "fs"
import { resolve } from "path"
import { describe, expect, it, vi } from "vitest"
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

  it("parses the captured JSON result", () => {
    const fixture = readFileSync(
      resolve(process.cwd(), "cli_probes/claude/01-json.stdout"),
      "utf8"
    )
    const state: ClaudeParseState = {}
    parseClaudeEvent(JSON.parse(fixture), vi.fn(), state)
    expect(state.sessionId).toBe("11111111-1111-4111-8111-111111111111")
    expect(state.finalText).toBe("CLAUDE_PROBE_OK")
    expect(state.error).toBeUndefined()
  })

  it("parses text, tool activity, output, and final result from JSONL", () => {
    const lines = readFileSync(
      resolve(process.cwd(), "cli_probes/claude/02-stream-tool.stdout"),
      "utf8"
    )
      .trim()
      .split(/\r?\n/)
    const events: CliTurnEvent[] = []
    const state: ClaudeParseState = {}
    for (const line of lines) {
      parseClaudeEvent(JSON.parse(line), (event) => events.push(event), state)
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

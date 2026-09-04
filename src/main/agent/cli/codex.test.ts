import { readFileSync } from "fs"
import { resolve } from "path"
import { describe, expect, it, vi } from "vitest"
import {
  buildCodexArgs,
  normalizeCodexModel,
  parseCodexEvent,
  type CodexParseState,
} from "./codex"
import type { CliTurnEvent } from "./claude"

describe("Codex CLI adapter", () => {
  it("uses GPT-5.5 for unset or legacy provider-only selections", () => {
    // gpt-5.3-codex is rejected on ChatGPT-auth logins, so it can't be default.
    expect(normalizeCodexModel(null)).toBe("gpt-5.5")
    expect(normalizeCodexModel("codex-cli")).toBe("gpt-5.5")
    expect(normalizeCodexModel("gpt-5.6-sol")).toBe("gpt-5.6-sol")
  })

  it("builds first-turn argv with explicit cwd and non-git override", () => {
    expect(
      buildCodexArgs({
        cwd: "/tmp/codex-chat",
        message: "inspect this",
        skipGitRepoCheck: true,
      })
    ).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "-C",
      "/tmp/codex-chat",
      "--model",
      "gpt-5.5",
      "--skip-git-repo-check",
      "inspect this",
    ])
  })

  it("builds resume argv without the git override when git is detected", () => {
    expect(
      buildCodexArgs({
        cwd: "/workspace",
        message: "continue",
        threadId: "thread-id",
        model: "gpt-5.6-terra",
        skipGitRepoCheck: false,
      })
    ).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "-C",
      "/workspace",
      "--model",
      "gpt-5.6-terra",
      "resume",
      "thread-id",
      "continue",
    ])
  })

  it("parses thread id, command output, assistant text, and usage from JSONL", () => {
    const lines = readFileSync(
      resolve(process.cwd(), "cli_probes/codex/01-json-tool.stdout"),
      "utf8"
    )
      .trim()
      .split(/\r?\n/)
    const events: CliTurnEvent[] = []
    const state: CodexParseState = {}
    for (const line of lines) {
      parseCodexEvent(JSON.parse(line), (event) => events.push(event), state)
    }
    expect(state.threadId).toBe("01a03b92-67e5-7823-b246-a5180f091f46")
    expect(state.finalText).toBe("CODEX_STREAM_PROBE_OK")
    expect(state.usage).toEqual(expect.objectContaining({ output_tokens: 68 }))
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_start" }),
        expect.objectContaining({
          type: "tool_done",
          result: expect.stringContaining("CODEX_TOOL_OK"),
        }),
        expect.objectContaining({
          type: "text",
          text: "CODEX_STREAM_PROBE_OK",
        }),
      ])
    )
  })

  it("parses resumed assistant text from JSONL", () => {
    const lines = readFileSync(
      resolve(process.cwd(), "cli_probes/codex/02-json-resume.stdout"),
      "utf8"
    )
      .trim()
      .split(/\r?\n/)
    const state: CodexParseState = {}
    for (const line of lines) {
      parseCodexEvent(JSON.parse(line), vi.fn(), state)
    }
    expect(state.threadId).toBe("01a03b92-67e5-7823-b246-a5180f091f46")
    expect(state.finalText).toBe("CODEX_RESUME_OK")
  })
})

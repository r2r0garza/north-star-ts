import { expect, it } from "vitest"
import { buildTimeline, deriveLabel, toToolUse } from "./timeline"
import type { Message } from "@/types"

it("keeps contextual titles stable across live states and persisted replay", () => {
  const call = {
    id: "call",
    name: "exec_command",
    arguments: JSON.stringify({
      command: "cat prompt.ts",
      _activity: "Inspecting prompt construction",
    }),
  }
  const live = toToolUse(call)
  for (const status of ["running", "done", "error", "interrupted"] as const) {
    expect(deriveLabel(call.name, live.args, status)).toBe(
      "Inspecting prompt construction"
    )
  }
  const base: Message = {
    id: "base",
    conversationId: "conversation",
    seq: 0,
    role: "assistant",
    content: null,
    toolCalls: null,
    toolCallId: null,
    toolName: null,
    tokenEstimate: null,
    createdAt: 0,
  }
  const rows: Message[] = [
    { ...base, id: "assistant", role: "assistant", toolCalls: [call] },
    {
      ...base,
      id: "result",
      role: "tool",
      toolCallId: call.id,
      content: "output",
    },
  ]
  const replay = buildTimeline(rows)
  expect(replay[0].kind === "tools" && replay[0].calls[0].label).toBe(
    live.label
  )
})

it("uses friendly fallbacks without displaying search expressions", () => {
  for (const args of [
    { query: "secret|regex" },
    { pattern: "secret|regex" },
    { _activity: 12 },
  ]) {
    expect(deriveLabel("search_tool", args)).toBe("Searched project files")
  }
  expect(deriveLabel("search_tool", { path: "src" }, "running")).toBe(
    "Searching files in src"
  )
  expect(deriveLabel("exec_command", {})).toBe("Ran workspace command")
  expect(deriveLabel("poll_command", {})).toBe("Checking command output")
  expect(deriveLabel("unknown_external", {})).toBe("unknown_external")
  expect(deriveLabel("read_file_tool", { path: "src/prompt.ts" })).toBe(
    "Read prompt.ts"
  )
})

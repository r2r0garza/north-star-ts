import { describe, expect, it } from "vitest"
import {
  completionReportInstruction,
  handoffInstruction,
  parseTaskHandoff,
} from "./handoff"
import type { Task } from "../db/types"

const handoff = {
  version: 1,
  taskId: "task-1",
  status: "completed",
  summary: "Updated settings",
  changes: ["Settings screen"],
  verification: ["Tests passed"],
  unresolved: [],
  nextAction: null,
}

describe("background task handoff", () => {
  it("accepts a bounded, task-specific structured result", () => {
    expect(parseTaskHandoff(JSON.stringify(handoff), "task-1")).toEqual(handoff)
    expect(handoffInstruction("task-1")).toContain('"taskId":"task-1"')
  })
  it.each([
    (json: string) => `Summary\nAll tasks completed successfully.\n\n${json}`,
    (json: string) => `\`\`\`json\n${json}\n\`\`\``,
  ])(
    "accepts one structured handoff surrounded by presentation text",
    (wrap) => {
      const result = { ...handoff, summary: 'Checked {theme} and "toggle"' }
      expect(parseTaskHandoff(wrap(JSON.stringify(result)), "task-1")).toEqual(
        result
      )
    }
  )
  it.each([
    "done",
    `${JSON.stringify(handoff)}\n${JSON.stringify(handoff)}`,
    `Summary\n${JSON.stringify({ ...handoff, taskId: "stale" })}`,
    `Summary\n${JSON.stringify({ ...handoff, verification: [""] })}`,
    "{}",
    JSON.stringify({ ...handoff, taskId: "stale" }),
    JSON.stringify({ ...handoff, verification: [""] }),
    JSON.stringify({ ...handoff, status: "blocked" }),
    "x".repeat(32_001),
  ])("rejects malformed or ungrounded output", (content) => {
    expect(() => parseTaskHandoff(content, "task-1")).toThrow(
      "valid structured handoff"
    )
  })
  it("preserves blocked outcomes and required next steps", () => {
    const blocked = {
      ...handoff,
      status: "blocked",
      unresolved: ["Missing credentials"],
      nextAction: "Configure the account",
    }
    expect(parseTaskHandoff(JSON.stringify(blocked), "task-1")).toEqual(blocked)
  })
  it("keeps worker evidence untrusted and never forwards malformed output", () => {
    const task = {
      id: "task-1",
      status: "failed",
      title: "Settings",
      input: { message: "Update settings" },
      result: "RAW GIBBERISH",
      error: "Invalid handoff",
    } as Task
    const instruction = completionReportInstruction(task)
    expect(instruction).toContain("report-only")
    expect(instruction).toContain("trust=untrusted_data")
    expect(instruction).toContain('"handoff":null')
    expect(instruction).not.toContain("RAW GIBBERISH")
  })
})

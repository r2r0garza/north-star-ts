import { describe, expect, it } from "vitest"
import { approvePendingToolCalls, type ToolUse } from "./timeline"

function tool(status: "pending" | "approved" | "denied"): ToolUse {
  return {
    id: status,
    name: "exec_command",
    label: "Run command",
    args: {},
    rawArgs: "{}",
    status: "running",
    approval: {
      requestId: status,
      summary: "Run command",
      reason: "Requires approval",
      status,
    },
  }
}

describe("approvePendingToolCalls", () => {
  it("settles visible pending approvals when Auto mode is enabled", () => {
    const pending = tool("pending")
    const approved = tool("approved")
    const denied = tool("denied")

    const result = approvePendingToolCalls([pending, approved, denied])

    expect(result.map((call) => call.approval?.status)).toEqual([
      "approved",
      "approved",
      "denied",
    ])
    expect(result[0]).not.toBe(pending)
    expect(result[1]).toBe(approved)
    expect(result[2]).toBe(denied)
  })
})

import { expect, it } from "vitest"
import {
  commandToolSegments,
  isActiveCommandLaunch,
} from "./command-tool-segments"
import type { ToolUse } from "./timeline"

const call = (id: string, fields: Partial<ToolUse> = {}): ToolUse => ({
  id,
  name: "read_file_tool",
  label: id,
  args: {},
  rawArgs: "{}",
  status: "done",
  ...fields,
})
const running = JSON.stringify({
  status: "running",
  sessionId: "s",
  output: "",
  exitCode: null,
  signal: null,
})
const final = {
  status: "completed" as const,
  output: "final",
  exitCode: 0,
  signal: null,
}

it("distinguishes active execution from historical running snapshots", () => {
  expect(
    isActiveCommandLaunch(
      call("a", { name: "exec_command", status: "running" })
    )
  ).toBe(true)
  expect(
    isActiveCommandLaunch(
      call("a", { name: "run_shell_tool", status: "running" })
    )
  ).toBe(true)
  expect(
    isActiveCommandLaunch(
      call("a", { name: "exec_command", result: running, commandLive: running })
    )
  ).toBe(true)
  expect(
    isActiveCommandLaunch(call("a", { name: "exec_command", result: running }))
  ).toBe(false)
  expect(
    isActiveCommandLaunch(
      call("a", {
        name: "poll_command",
        status: "running",
        commandLive: running,
      })
    )
  ).toBe(false)
})

it("gives final outcomes, approval gates and interrupted execution precedence", () => {
  const active = call("a", {
    name: "exec_command",
    status: "running",
    commandLive: running,
  })
  for (const fields of [
    { commandOutcome: final },
    { commandLive: JSON.stringify(final) },
    { status: "interrupted" as const },
    { status: "error" as const },
    ...(["pending", "denied"] as const).map((status) => ({
      approval: { requestId: "r", summary: "gate", reason: "gate", status },
    })),
  ])
    expect(isActiveCommandLaunch({ ...active, ...fields })).toBe(false)
})

it("preserves order, separates concurrent commands, and coalesces ordinary runs on completion", () => {
  const a = call("a")
  const b = call("b", { name: "exec_command", status: "running" })
  const c = call("c")
  const d = call("d", { name: "exec_command", commandLive: running })
  const e = call("e")
  const parts = commandToolSegments([a, b, c, d, e])
  expect(parts.map((p) => p.kind)).toEqual([
    "group",
    "command",
    "group",
    "command",
    "group",
  ])
  expect(
    parts.flatMap((p) => (p.kind === "group" ? p.calls : [p.call]))
  ).toEqual([a, b, c, d, e])
  expect(
    commandToolSegments([
      { ...b, status: "done" },
      c,
      { ...d, commandOutcome: final },
    ])
  ).toEqual([
    {
      kind: "group",
      key: "group:b",
      calls: [{ ...b, status: "done" }, c, { ...d, commandOutcome: final }],
    },
  ])
  expect(commandToolSegments([b])[0].kind).toBe("command")
})

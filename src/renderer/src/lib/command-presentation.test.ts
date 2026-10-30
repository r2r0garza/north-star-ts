import { describe, expect, it } from "vitest"
import { renderContextEnvelope } from "../../../shared/context-provenance"
import {
  commandPresentation,
  displayedCommandOutput,
} from "./command-presentation"
const result = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    status: "completed",
    exitCode: 0,
    signal: null,
    output: "",
    ...fields,
  })
describe("command presentation", () => {
  it.each([
    [{}, "success", "Completed successfully"],
    [{ exitCode: 2 }, "failure", "Exited with code 2"],
    [{ exitCode: null }, "unknown", "Final outcome unavailable"],
    [
      { status: "running", exitCode: null, sessionId: "s" },
      "reported_running",
      "Running when reported",
    ],
    [{ status: "timed_out" }, "failure", "Timed out"],
    [{ signal: "SIGTERM" }, "failure", "Terminated"],
    [{ status: "terminated" }, "failure", "Terminated"],
    [
      { cleanupError: { path: "file", error: "permission" } },
      "failure",
      "Cleanup failed",
    ],
  ])("uses machine outcome %j", (fields, outcome, label) => {
    expect(commandPresentation("exec_command", result(fields))).toMatchObject({
      outcome,
      label,
    })
  })
  it.each([
    "{",
    "null",
    result({ status: "future" }),
    result({ exitCode: "0" }),
    result({ signal: 2 }),
    result({ durationMs: -1 }),
    result({ cleanupError: {} }),
    result({ truncated: "true" }),
    result({ status: "running" }),
    "ERROR[denied]: not run",
  ])("falls back for %s", (raw) => {
    expect(commandPresentation("exec_command", raw)).toBeNull()
  })
  it("specializes only known command tools and preserves empty output", () => {
    expect(commandPresentation("run_tests", result())).toBeNull()
    expect(commandPresentation("exec_command", undefined)).toBeNull()
    expect(
      commandPresentation("poll_command", result())?.snapshots[0]?.output
    ).toBe("")
    expect(
      commandPresentation(
        "exec_command",
        result({ output: "ERROR failed exit code 2" })
      )?.outcome
    ).toBe("success")
  })
  it("parses the full envelope before independently clipping output", () => {
    const output = "x".repeat(8000)
    const parsed = commandPresentation(
      "exec_command",
      result({
        output,
        droppedBytes: 10,
        omittedBytes: 20,
        truncated: true,
        cleanupError: { path: "a", error: "b" },
      })
    )!
    expect(parsed.outcome).toBe("failure")
    expect(parsed.snapshots[0]).toMatchObject({
      output,
      droppedBytes: 10,
      omittedBytes: 20,
    })
    expect(displayedCommandOutput(output)).toBe(
      "x".repeat(4000) + "\n…[UI clipped at 4,000 characters]"
    )
  })
  it("recognizes only anchored producer legacy status inside the exact envelope", () => {
    const wrap = (text: string) =>
      renderContextEnvelope(
        {
          trust: "untrusted_data",
          channel: "command",
          source: "run_shell_tool",
        },
        text
      )
    expect(
      commandPresentation(
        "run_shell_tool",
        wrap("[exit code 0]\n[exit code 4]")
      )
    ).toMatchObject({
      outcome: "success",
      snapshots: [{ output: "[exit code 4]" }],
    })
    expect(
      commandPresentation("run_shell_tool", wrap("stdout\n[exit code 0]"))
    ).toBeNull()
    expect(
      commandPresentation("run_shell_tool", "[exit code 0]\nstdout")
    ).toBeNull()
    expect(
      commandPresentation(
        "run_shell_tool",
        wrap("[timed out after 30ms (killed)]")
      )?.label
    ).toBe("Timed out")
    expect(
      commandPresentation(
        "run_shell_tool",
        wrap("[terminated by signal SIGTERM]")
      )?.label
    ).toBe("Terminated")
    expect(
      commandPresentation("run_shell_tool", wrap("[exit code unknown]"))
        ?.outcome
    ).toBe("unknown")
  })
  it("retains ordering and holes in mixed completion arrays", () => {
    const valid = JSON.parse(
      result({ eventId: "e", sessionId: "s", runId: "run" })
    )
    const raw = JSON.stringify({
      status: "completed",
      completions: [
        null,
        valid,
        { ...valid, exitCode: 5 },
        { ...valid, status: "future" },
      ],
    })
    const parsed = commandPresentation("wait_for_events", raw)!
    expect(parsed.snapshots).toHaveLength(4)
    expect(parsed.snapshots[0]).toBeNull()
    expect(parsed.snapshots[1]?.eventId).toBe("e")
    expect(parsed.snapshots[3]).toBeNull()
    expect(parsed.outcome).toBe("failure")
    expect(
      commandPresentation(
        "wait_for_events",
        '{"status":"empty","completions":[]}'
      )?.label
    ).toBe("No completion events")
  })
})

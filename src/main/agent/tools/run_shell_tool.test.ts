import { describe, it, expect } from "vitest"
import { tmpdir } from "os"
import { runShellTool } from "./run_shell_tool"
import type { ToolContext } from "./types"

// A context whose gate always approves, so we exercise the execution path.
const approveAll: ToolContext = {
  workspace: tmpdir(),
  gate: async () => "approved",
}

describe("run_shell_tool", () => {
  it("fails closed without a workspace (never runs with an unconfined cwd)", async () => {
    const result = await runShellTool.execute(
      { command: "echo hi" },
      { workspace: "", gate: async () => "approved" }
    )
    expect(result).toContain("ERROR[no_workspace]")
  })

  it("requires a command", async () => {
    const result = await runShellTool.execute({ command: "  " }, approveAll)
    expect(result).toContain("ERROR[bad_args]")
  })

  it("returns a denial string when the gate denies", async () => {
    const result = await runShellTool.execute(
      { command: "echo hi" },
      { workspace: tmpdir(), gate: async () => "denied" }
    )
    expect(result).toContain("ERROR[denied]")
  })

  it("returns a block string when the gate blocks (never spawns)", async () => {
    const result = await runShellTool.execute(
      { command: "echo hi" },
      { workspace: tmpdir(), gate: async () => "blocked" }
    )
    expect(result).toContain("ERROR[blocked]")
  })

  it("runs an approved command and reports exit code 0", async () => {
    const result = await runShellTool.execute(
      { command: "echo hello" },
      approveAll
    )
    expect(result).toContain("hello")
    expect(result).toContain("exit code 0")
  })

  it("preserves multibyte UTF-8 output (no per-chunk corruption)", async () => {
    // A string with multibyte chars; printed via printf so no trailing newline noise.
    const result = await runShellTool.execute(
      { command: "printf '日本語 — café 🚀'" },
      approveAll
    )
    expect(result).toContain("日本語 — café 🚀")
    expect(result).not.toContain("�") // no replacement chars
  })

  it("reports a nonzero exit code", async () => {
    const result = await runShellTool.execute({ command: "exit 3" }, approveAll)
    expect(result).toContain("exit code 3")
  })

  it("times out a long-running command", async () => {
    const result = await runShellTool.execute(
      { command: "sleep 5", timeout_ms: 100 },
      approveAll
    )
    expect(result).toContain("timed out")
  })

  it("falls back to the default timeout for a non-positive value (no instant kill)", async () => {
    // timeout_ms: 0 must NOT collapse to a 1ms kill — the command should run.
    const result = await runShellTool.execute(
      { command: "echo ok", timeout_ms: 0 },
      approveAll
    )
    expect(result).toContain("ok")
    expect(result).not.toContain("timed out")
  })
})

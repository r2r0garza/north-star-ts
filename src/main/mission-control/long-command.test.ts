import { describe, expect, it } from "vitest"
import { runLongCommand } from "./long-command"

describe("runLongCommand", () => {
  it("lets a command run as long as it keeps making progress", async () => {
    // Longer than the quiet limit overall, but never quiet that long.
    const out = await runLongCommand(
      "for i in 1 2 3 4 5; do echo step $i; sleep 0.1; done",
      { cwd: process.cwd(), quietLimitMs: 300, overallLimitMs: 10_000 }
    )
    expect(out.stdout).toContain("step 5")
  })

  it("stops a command that goes quiet, and says so", async () => {
    await expect(
      runLongCommand("echo waiting for input; sleep 5", {
        cwd: process.cwd(),
        quietLimitMs: 200,
      })
    ).rejects.toMatchObject({
      stoppedFor: "quiet",
      message: expect.stringMatching(/without any output.*waiting for input/),
    })
  })

  it("reports a failure with its exit code and last output", async () => {
    await expect(
      runLongCommand("echo nope >&2; exit 3", { cwd: process.cwd() })
    ).rejects.toMatchObject({ code: 3, message: "exited with 3: nope" })
  })
})

const nodeCommand = (code: string) =>
  `"${process.execPath}" -e "eval(Buffer.from('${Buffer.from(code).toString("base64")}', 'base64').toString('utf8'))"`

import { describe, expect, it } from "vitest"
import { runLongCommand } from "./long-command"

describe("runLongCommand", () => {
  it("lets a command run as long as it keeps making progress", async () => {
    // Longer than the quiet limit overall, but never quiet that long.
    const out = await runLongCommand(
      nodeCommand(
        "let i = 0; const t = setInterval(() => { console.log('step ' + ++i); if (i === 15) clearInterval(t) }, 100)"
      ),
      { cwd: process.cwd(), quietLimitMs: 1000, overallLimitMs: 10_000 }
    )
    expect(out.stdout).toContain("step 15")
  })

  it("stops a command that goes quiet, and says so", async () => {
    await expect(
      runLongCommand(
        nodeCommand(
          "console.log('waiting for input'); setTimeout(() => {}, 5000)"
        ),
        {
          cwd: process.cwd(),
          quietLimitMs: 1000,
        }
      )
    ).rejects.toMatchObject({
      stoppedFor: "quiet",
      message: expect.stringMatching(/without any output.*waiting for input/),
    })
  })

  it("reports a failure with its exit code and last output", async () => {
    await expect(
      runLongCommand(nodeCommand("console.error('nope'); process.exit(3)"), {
        cwd: process.cwd(),
      })
    ).rejects.toMatchObject({ code: 3, message: "exited with 3: nope" })
  })
})

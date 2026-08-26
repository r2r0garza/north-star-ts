import { spawn } from "child_process"
import { describe, expect, it } from "vitest"
import { captureSpawn } from "./spawn-util"

const nodeChild = (code: string) =>
  spawn(process.execPath, ["-e", code], {
    stdio: ["ignore", "pipe", "pipe"],
  })

describe("captureSpawn", () => {
  it("preserves observed stdout/stderr order in combined stdout", async () => {
    const child = nodeChild(`
      process.stdout.write("out-1")
      setTimeout(() => process.stderr.write("err-1"), 20)
      setTimeout(() => {
        process.stdout.write("out-2")
        process.exit(0)
      }, 40)
    `)

    const result = await captureSpawn(child, {
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
    })

    expect(result.stdout.toString("utf8")).toBe("out-1err-1out-2")
    expect(result.stderr?.toString("utf8")).toBe("err-1")
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
  })

  it("preserves stream order when the shared byte cap truncates the final chunk", async () => {
    const child = nodeChild(`
      process.stdout.write("out-1")
      setTimeout(() => process.stderr.write("err-1"), 20)
      setTimeout(() => {
        process.stdout.write("out-2")
        process.exit(0)
      }, 40)
    `)

    const result = await captureSpawn(child, {
      timeoutMs: 5_000,
      maxOutputBytes: 12,
    })

    expect(result.stdout.toString("utf8")).toBe("out-1err-1ou")
    expect(result.stderr?.toString("utf8")).toBe("err-1")
    expect(result.stdout).toHaveLength(12)
  })
})

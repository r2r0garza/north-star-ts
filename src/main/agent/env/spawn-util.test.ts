import { spawn } from "child_process"
import { describe, expect, it } from "vitest"
import { captureSpawn } from "./spawn-util"
import { once } from "events"

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
    expect(result.outputTruncated).toBe(true)
    expect(result.capturedOutputBytes).toBe(12)
    expect(result.observedOutputBytes).toBeGreaterThan(12)
  })

  it("reports bytes discarded after the cap is already full", async () => {
    const child = nodeChild(`
      process.stdout.write("12345")
      setTimeout(() => {
        process.stdout.write("67890")
        process.exit(0)
      }, 20)
    `)

    const result = await captureSpawn(child, {
      timeoutMs: 5_000,
      maxOutputBytes: 5,
    })

    expect(result.stdout.toString("utf8")).toBe("12345")
    expect(result.outputTruncated).toBe(true)
    expect(result.capturedOutputBytes).toBe(5)
    expect(result.observedOutputBytes).toBe(10)
  })
})

describe.skipIf(process.platform !== "win32")(
  "native Windows process tree",
  () => {
    it("terminates an owned descendant when the captured parent is aborted", async () => {
      const child = nodeChild(`
      const { spawn } = require('child_process')
      const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      console.log(descendant.pid)
      setInterval(() => {}, 1000)
    `)
      const controller = new AbortController()
      const captured = captureSpawn(child, {
        signal: controller.signal,
        timeoutMs: 10000,
        maxOutputBytes: 1024,
        killGroup: true,
      })
      const [line] = await once(child.stdout!, "data")
      const pid = Number(line.toString().trim())
      expect(pid).toBeGreaterThan(0)
      controller.abort()
      const result = await captured
      expect(result.aborted).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(() => process.kill(pid, 0)).toThrow()
    }, 15000)
  }
)

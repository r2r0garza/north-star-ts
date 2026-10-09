import { spawn } from "child_process"
import { once } from "events"
import { readFile } from "fs/promises"
import { describe, expect, it, vi } from "vitest"
import { captureSpawn } from "./spawn-util"

describe.skipIf(process.platform !== "linux")(
  "native Linux process groups",
  () => {
    it.each(["abort", "timeout"])(
      "terminates an owned descendant on %s",
      async (mode) => {
        const child = spawn(
          process.execPath,
          [
            "-e",
            `
      const { spawn } = require('child_process')
      const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      console.log(descendant.pid)
      setInterval(() => {}, 1000)
    `,
          ],
          { detached: true, stdio: ["ignore", "pipe", "pipe"] }
        )
        const controller = new AbortController()
        const captured = captureSpawn(child, {
          signal: controller.signal,
          timeoutMs: mode === "timeout" ? 500 : 5000,
          maxOutputBytes: 1024,
          killGroup: true,
        })
        let pid: number | undefined
        try {
          const [line] = await once(child.stdout!, "data")
          pid = Number(line.toString().trim())
          expect(pid).toBeGreaterThan(0)
          if (mode === "abort") controller.abort()
          const result = await captured
          expect(mode === "abort" ? result.aborted : result.timedOut).toBe(true)
          await vi.waitFor(async () => {
            let state: string | undefined
            try {
              state = (await readFile(`/proc/${pid}/stat`, "utf8"))
                .split(") ")[1]
                ?.split(" ")[0]
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error
            }
            expect(state === undefined || state === "Z").toBe(true)
          })
          expect(() => process.kill(child.pid!, 0)).toThrow()
        } finally {
          controller.abort()
          try {
            process.kill(-child.pid!, "SIGKILL")
          } catch {}
          await captured
        }
      }
    )
  }
)

import { execFile } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

const OUTER_TIMEOUT_MS = 3_000

describe("runContainerTestProbe hard deadline", () => {
  it(
    "cannot wedge the test suite when graceful termination is ignored",
    async () => {
      const vitestCli = resolve(
        dirname(require.resolve("vitest")),
        "vitest.mjs"
      )
      const workerTest = fileURLToPath(
        new URL(
          "./container-test-availability.deadline-worker.test.ts",
          import.meta.url
        )
      )

      const { stdout } = await execFileAsync(
        process.execPath,
        [vitestCli, "run", workerTest, "--reporter=dot"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            COWORK_PROBE_DEADLINE_WORKER: "1",
          },
          timeout: OUTER_TIMEOUT_MS,
          killSignal: "SIGKILL",
          windowsHide: true,
        }
      )

      expect(stdout).toContain("1 passed")
    },
    OUTER_TIMEOUT_MS + 1_000
  )
})

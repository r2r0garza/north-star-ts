import { performance } from "node:perf_hooks"
import { describe, expect, it } from "vitest"
import { runContainerTestProbe } from "./container-test-availability"

const PROBE_TIMEOUT_MS = 100
const COMPLETION_ALLOWANCE_MS = 1_000

describe.runIf(process.env.COWORK_PROBE_DEADLINE_WORKER === "1")(
  "runContainerTestProbe deadline worker",
  () => {
    it("hard-kills and classifies a subprocess that ignores SIGTERM", () => {
      const stubbornChild = [
        'process.on("SIGTERM", () => {})',
        "setInterval(() => {}, 1_000)",
      ].join(";")
      const startedAt = performance.now()

      const result = runContainerTestProbe(
        process.execPath,
        ["-e", stubbornChild],
        PROBE_TIMEOUT_MS
      )
      const elapsedMs = performance.now() - startedAt

      expect(elapsedMs).toBeLessThan(PROBE_TIMEOUT_MS + COMPLETION_ALLOWANCE_MS)
      expect(result).toMatchObject({
        code: null,
        enoent: false,
        timedOut: true,
        timeoutMs: PROBE_TIMEOUT_MS,
      })
    })
  }
)

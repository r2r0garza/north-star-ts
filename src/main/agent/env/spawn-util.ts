import { spawn } from "child_process"
import type { ChildProcess } from "child_process"
import type { ExecResult, ExecOptions } from "./types"

// Capture a spawned child's combined stdout+stderr, enforce a timeout, cap the
// captured bytes, and honor an abort signal — then resolve an ExecResult. This
// is the byte-for-byte logic from run_shell_tool's original `run()`, factored
// out so LocalEnvironment (spawning the command directly) and ContainerEnvironment
// (spawning `docker exec …`) share identical capture semantics.
//
// Chunks are collected as raw Buffers and decoded ONCE by the caller: decoding
// each chunk separately would corrupt any multibyte UTF-8 character that straddles
// a chunk boundary (common in non-ASCII build/test output). The byte cap is
// enforced on accumulated Buffer length, not a char-indexed string slice.
//
// The child must be spawned with stdio stdout/stderr piped. stdin handling is the
// caller's concern (run_shell closes it; container writeFile pipes to it).
export function captureSpawn(
  child: ChildProcess,
  opts: Pick<ExecOptions, "timeoutMs" | "maxOutputBytes" | "signal"> & {
    // When true, kill the child's whole process group instead of just the child.
    // LocalEnvironment spawns `detached` (the child leads its own group), so a
    // group kill reaps grandchildren a `shell: true` command forked (a pipeline,
    // `npm run build` → node, etc.) — a bare child.kill would orphan them. The
    // container backend spawns a non-detached `docker exec` client and leaves this
    // off (process.kill(-pid) on a non-leader would hit the wrong group).
    killGroup?: boolean
  }
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let bytes = 0
    let timedOut = false
    let aborted = opts.signal?.aborted === true
    let settled = false

    const capture = (target: Buffer[], chunk: Buffer) => {
      if (bytes >= opts.maxOutputBytes) return
      const room = opts.maxOutputBytes - bytes
      // Keep at most `room` bytes of this chunk, then ignore the rest. Slicing the
      // Buffer (byte-indexed) is correct; decoding happens once in the caller.
      const keep = chunk.length > room ? chunk.subarray(0, room) : chunk
      target.push(keep)
      bytes += keep.length
    }
    child.stdout?.on("data", (chunk: Buffer) => capture(stdoutChunks, chunk))
    child.stderr?.on("data", (chunk: Buffer) => capture(stderrChunks, chunk))

    // The one kill path shared by the timeout and the abort seam. With killGroup,
    // SIGKILL the whole process group (negative pid) so a shell wrapper's forked
    // grandchildren die too; the group kill can throw ESRCH if the group is
    // already gone, so swallow it and fall back to killing the child directly.
    const terminate = () => {
      if (opts.killGroup && child.pid) {
        if (process.platform === "win32") {
          const killer = spawn(
            "taskkill",
            ["/pid", String(child.pid), "/T", "/F"],
            {
              stdio: "ignore",
            }
          )
          const fallback = () => {
            try {
              child.kill("SIGKILL")
            } catch {
              // child already dead — nothing to do
            }
          }
          killer.on("error", fallback)
          killer.on("close", (code) => {
            if (code !== 0) fallback()
          })
          return
        }
        try {
          process.kill(-child.pid, "SIGKILL")
          return
        } catch {
          // group already gone (ESRCH) or not a leader — fall through to child.kill
        }
      }
      try {
        child.kill("SIGKILL")
      } catch {
        // child already dead — nothing to do
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, opts.timeoutMs)

    // Abort seam: a fired signal kills the child the same way a timeout does. The
    // listener is removed on close so an aborted-after-completion signal can't
    // reach a dead child.
    const onAbort = () => {
      aborted = true
      terminate()
    }
    if (opts.signal) {
      if (opts.signal.aborted) terminate()
      else opts.signal.addEventListener("abort", onAbort, { once: true })
    }

    const finish = (result: ExecResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener("abort", onAbort)
      resolve(result)
    }

    child.on("error", (err) => {
      const message = `Failed to start command: ${err.message}`
      finish({
        stdout: Buffer.from(message),
        stderr: Buffer.from(message),
        exitCode: null,
        signal: null,
        timedOut,
        aborted,
        spawnError: err.message,
      })
    })
    child.on("close", (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks)
      const stderr = Buffer.concat(stderrChunks)
      finish({
        stdout: Buffer.concat([stdout, stderr]),
        stderr,
        exitCode: code,
        signal,
        timedOut,
        aborted,
      })
    })
  })
}

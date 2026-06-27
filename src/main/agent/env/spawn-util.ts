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
  opts: Pick<ExecOptions, "timeoutMs" | "maxOutputBytes" | "signal">
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let timedOut = false
    let settled = false

    const capture = (chunk: Buffer) => {
      if (bytes >= opts.maxOutputBytes) return
      const room = opts.maxOutputBytes - bytes
      // Keep at most `room` bytes of this chunk, then ignore the rest. Slicing the
      // Buffer (byte-indexed) is correct; decoding happens once in the caller.
      const keep = chunk.length > room ? chunk.subarray(0, room) : chunk
      chunks.push(keep)
      bytes += keep.length
    }
    child.stdout?.on("data", capture)
    child.stderr?.on("data", capture)

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, opts.timeoutMs)

    // Abort seam: a fired signal kills the child the same way a timeout does.
    // With no signal (the case today), this is inert. The listener is removed on
    // close so an aborted-after-completion signal can't reach a dead child.
    const onAbort = () => child.kill("SIGKILL")
    if (opts.signal) {
      if (opts.signal.aborted) child.kill("SIGKILL")
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
      finish({
        stdout: Buffer.from(`Failed to start command: ${err.message}`),
        exitCode: null,
        signal: null,
        timedOut,
      })
    })
    child.on("close", (code, signal) => {
      finish({ stdout: Buffer.concat(chunks), exitCode: code, signal, timedOut })
    })
  })
}

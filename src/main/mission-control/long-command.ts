import { spawn } from "child_process"

// Running setup and regeneration commands whose length nobody can predict
// (plan 106.11): an install can take seconds or twenty minutes. A command is
// stopped only when it goes quiet for a long stretch (no output: probably
// hung, e.g. waiting on a prompt nobody will answer) or passes a generous
// overall cap. Never a short fixed timeout.

// No output for this long: stopped as hung.
export const QUIET_LIMIT_MS = 30 * 60_000
// Backstop for a command that keeps printing forever.
export const OVERALL_LIMIT_MS = 4 * 60 * 60_000

const OUTPUT_KEEP = 64 * 1024

export class CommandError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string,
    readonly stoppedFor: "quiet" | "overall" | "aborted" | null
  ) {
    super(message)
  }
}

function minutes(ms: number) {
  const m = Math.round(ms / 60_000)
  return m >= 60 && m % 60 === 0
    ? `${m / 60} hour${m === 60 ? "" : "s"}`
    : `${m} minutes`
}

// Resolves with the output on exit 0; rejects with a CommandError otherwise.
export function runLongCommand(
  command: string,
  options: {
    cwd: string
    env?: Record<string, string>
    quietLimitMs?: number
    overallLimitMs?: number
    // Stops the command (and what it spawned) when aborted.
    signal?: AbortSignal
  }
): Promise<{ stdout: string; stderr: string }> {
  const quietLimit = options.quietLimitMs ?? QUIET_LIMIT_MS
  const overallLimit = options.overallLimitMs ?? OVERALL_LIMIT_MS
  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32"
    const child = spawn(
      isWin ? "cmd.exe" : "/bin/sh",
      isWin ? ["/d", "/s", "/c", command] : ["-c", command],
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // Its own process group, so stopping it stops what it spawned.
        detached: !isWin,
      }
    )
    let stdout = ""
    let stderr = ""
    let stoppedFor: "quiet" | "overall" | "aborted" | null = null
    const keep = (text: string) =>
      text.length > OUTPUT_KEEP ? text.slice(-OUTPUT_KEEP) : text
    const stop = (why: "quiet" | "overall" | "aborted") => {
      stoppedFor = why
      try {
        if (!isWin && child.pid) process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
    }
    let quiet = setTimeout(() => stop("quiet"), quietLimit)
    const heard = () => {
      clearTimeout(quiet)
      quiet = setTimeout(() => stop("quiet"), quietLimit)
    }
    const overall = setTimeout(() => stop("overall"), overallLimit)
    const onAbort = () => stop("aborted")
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener("abort", onAbort, { once: true })
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = keep(stdout + chunk.toString("utf8"))
      heard()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = keep(stderr + chunk.toString("utf8"))
      heard()
    })
    const done = () => {
      clearTimeout(quiet)
      clearTimeout(overall)
      options.signal?.removeEventListener("abort", onAbort)
    }
    child.on("error", (error) => {
      done()
      reject(new CommandError(error.message, null, stdout, stderr, null))
    })
    child.on("close", (code) => {
      done()
      if (code === 0 && !stoppedFor) {
        resolve({ stdout, stderr })
        return
      }
      const message =
        stoppedFor === "quiet"
          ? `stopped after ${minutes(quietLimit)} without any output (it may be waiting for input or hung)`
          : stoppedFor === "overall"
            ? `stopped after running for ${minutes(overallLimit)}`
            : stoppedFor === "aborted"
              ? "stopped"
              : `exited with ${code ?? "a signal"}`
      // Callers show the message; end it with what the command last said.
      const last = (stderr.trim() || stdout.trim())
        .split("\n")
        .slice(-3)
        .join(" ")
        .slice(-300)
      reject(
        new CommandError(
          last ? `${message}: ${last}` : message,
          code,
          stdout,
          stderr,
          stoppedFor
        )
      )
    })
  })
}

import { execFile, spawn } from "child_process"
import { toolEnv } from "./tool-env"

// Bounded process execution for workspace analysis (plan 106.11). Every call
// has a timeout and an output cap, and never throws: the result says what
// happened, because a missing tool is a finding, not a crash.

export interface ExecResult {
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  // The executable wasn't found.
  missing: boolean
  timedOut: boolean
}

const MAX_OUTPUT = 4 * 1024 * 1024

// Tests stand in for project tools (never Git), so fixtures don't depend on
// what's installed on the machine running them. Return null to fall through.
export interface FakeTools {
  run?(file: string, args: string[], cwd: string): ExecResult | null
  shell?(command: string, cwd: string): ExecResult | null
}
let fakeTools: FakeTools | null = null
export function setFakeToolsForTests(fake: FakeTools | null): void {
  fakeTools = fake
}

export function run(
  file: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number; env?: Record<string, string> }
): Promise<ExecResult> {
  if (fakeTools?.run && file !== "git") {
    const faked = fakeTools.run(file, args, options.cwd)
    if (faked) return Promise.resolve(faked)
  }
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 15_000,
        maxBuffer: MAX_OUTPUT,
        env: options.env ?? toolEnv(),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const err = error as
          | (NodeJS.ErrnoException & { killed?: boolean; code?: unknown })
          | null
        resolve({
          ok: !err,
          exitCode: !err ? 0 : typeof err.code === "number" ? err.code : null,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          missing: err?.code === "ENOENT",
          timedOut: !!err?.killed,
        })
      }
    )
  })
}

// A shell command line (a probe from a recipe), run with /bin/sh. Only
// commands North Star composed itself come through here.
export function runShellLine(
  command: string,
  options: { cwd: string; timeoutMs?: number; signal?: AbortSignal }
): Promise<ExecResult> {
  if (fakeTools?.shell) {
    const faked = fakeTools.shell(command, options.cwd)
    if (faked) return Promise.resolve(faked)
  }
  return new Promise((resolve) => {
    const isWin = process.platform === "win32"
    const child = spawn(
      isWin ? "cmd.exe" : "/bin/sh",
      isWin ? ["/d", "/s", "/c", command] : ["-c", command],
      {
        cwd: options.cwd,
        env: toolEnv(),
        windowsHide: true,
      }
    )
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const cap = (acc: string, chunk: Buffer) =>
      acc.length > MAX_OUTPUT ? acc : acc + chunk.toString("utf8")
    child.stdout.on("data", (chunk: Buffer) => (stdout = cap(stdout, chunk)))
    child.stderr.on("data", (chunk: Buffer) => (stderr = cap(stderr, chunk)))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, options.timeoutMs ?? 30_000)
    const onAbort = () => child.kill("SIGKILL")
    options.signal?.addEventListener("abort", onAbort, { once: true })
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      resolve({
        ok: false,
        exitCode: null,
        stdout,
        stderr: stderr || error.message,
        missing: error.code === "ENOENT",
        timedOut,
      })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      // A shell reports "command not found" as 127.
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        stdout,
        stderr,
        missing: code === 127,
        timedOut,
      })
    })
  })
}

export function git(cwd: string, args: string[], timeoutMs = 15_000) {
  return run("git", args, { cwd, timeoutMs })
}

export function outputTail(result: ExecResult, max = 1200): string {
  const text = `${result.stdout}${result.stderr}`.trim()
  return text.length > max ? `…${text.slice(text.length - max)}` : text
}

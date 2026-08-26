import { spawn } from "child_process"
import type { ChildProcess } from "child_process"
import { randomUUID } from "crypto"
import { EventEmitter } from "events"
import {
  readFile,
  writeFile,
  rename,
  link,
  mkdir,
  stat,
  readdir,
  unlink,
} from "fs/promises"
import { isAbsolute, relative, resolve, join } from "path"
import { tmpdir } from "os"
import { StringDecoder } from "string_decoder"
import * as pty from "node-pty"
import { captureSpawn } from "./spawn-util"
import { readHostTextLines } from "./read-text-lines"
import { buildRipgrepArgs, parseRipgrepJson } from "./ripgrep"
import {
  assertLocalProfileSupported,
  buildDarwinSandboxProfile,
  sandboxExecPath,
} from "./local-profiles"
import { resolveInWorkspace, resolveInWorkspaceReal } from "../tools/workspace"
import type {
  Environment,
  ExecResult,
  ExecOptions,
  DirEntry,
  StatInfo,
  SearchOptions,
  SearchResult,
  ReadTextLinesOptions,
  ReadTextLinesResult,
  SpawnCommandOptions,
  CommandSessionHandle,
  CommandChunk,
  CommandExit,
  LocalRuntimeProfile,
} from "./types"

export function normalizeHostShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== "win32") return command
  // Windows commonly has no `python3.exe` on PATH, or has the Microsoft Store
  // app-execution alias that exits without useful captured output. Prefer the
  // Python Launcher, which is the standard way to request Python 3 on Windows.
  return command.replace(/^(\s*)python3(?:\.exe)?\b/i, "$1py -3")
}

function quoteWindowsArg(arg: string): string {
  return `"${arg.replace(/"/g, '\\"')}"`
}

function resolveRipgrepPath(): string {
  try {
    // Dynamic require keeps dev/test usable before node_modules is installed and
    // lets electron-builder unpack the packaged binary from node_modules.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("@vscode/ripgrep") as { rgPath?: string }
    if (mod.rgPath) return mod.rgPath
  } catch {
    // Fall through to PATH lookup for development and focused tests.
  }
  return "rg"
}

function shellForCommand(
  command: string,
  platform: NodeJS.Platform = process.platform
): { file: string; args: string[] } {
  if (platform === "win32") {
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command],
    }
  }
  return { file: process.env.SHELL || "sh", args: ["-lc", command] }
}

function shellForCapturedCommand(
  command: string,
  platform: NodeJS.Platform = process.platform
): { file: string; args: string[] } {
  if (platform === "win32") return shellForCommand(command, platform)
  return { file: "/bin/sh", args: ["-c", command] }
}

export function materializePythonHeredocCommand(
  command: string,
  scriptPath: string,
  platform: NodeJS.Platform = process.platform
): { command: string; script: string } | null {
  if (platform !== "win32") return null

  const start = command.match(
    /^\s*(python3(?:\.exe)?|python(?:\.exe)?|py(?:\.exe)?(?:\s+-3)?)\s+-\s+<<-?\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))[ \t]*(?:\r?\n)/i
  )
  if (!start) return null

  const interpreter = start[1]
  const delimiter = start[2] ?? start[3] ?? start[4]
  const rest = command.slice(start[0].length)
  const lines = rest.split(/\r?\n/)
  const end = lines.findIndex((line) => line.trim() === delimiter)
  if (end < 0) return null

  const trailing = lines
    .slice(end + 1)
    .join("\n")
    .trim()
  if (trailing) return null

  const runner = normalizeHostShellCommand(
    `${interpreter} ${quoteWindowsArg(scriptPath)}`,
    platform
  )
  return { command: runner, script: lines.slice(0, end).join("\n") }
}

// The default backend: runs file ops through workspace path resolvers, while
// shell commands execute under the selected Local runtime profile. `host-access`
// runs directly on the host with `cwd` set to the workspace; stronger labels are
// accepted only when backed by a dependable OS adapter.
// This is a behavior-preserving wrapper over exactly what the tools did before
// this seam existed — fs/promises, child_process.spawn, and the workspace path
// resolvers — so existing tool tests pass unchanged.
export class LocalEnvironment implements Environment {
  constructor(
    private readonly workspace: string,
    private readonly profile: LocalRuntimeProfile = "host-access"
  ) {
    assertLocalProfileSupported(profile)
  }

  get localRuntimeProfile(): LocalRuntimeProfile {
    return this.profile
  }

  resolve(path: string): Promise<string> {
    return resolveInWorkspaceReal(this.workspace, path)
  }

  resolveLexical(path: string): string {
    return resolveInWorkspace(this.workspace, path)
  }

  readFile(path: string): Promise<Buffer> {
    return readFile(path)
  }

  readTextLines(
    path: string,
    opts: ReadTextLinesOptions
  ): Promise<ReadTextLinesResult> {
    return readHostTextLines(path, opts)
  }

  writeFile(path: string, data: string): Promise<void> {
    this.assertWritable(path)
    return writeFile(path, data, "utf8")
  }

  rename(from: string, to: string): Promise<void> {
    this.assertWritable(from)
    this.assertWritable(to)
    return rename(from, to)
  }

  installFileNoReplace(from: string, to: string): Promise<void> {
    this.assertWritable(from)
    this.assertWritable(to)
    return link(from, to)
  }

  removeFile(path: string): Promise<void> {
    this.assertWritable(path)
    return unlink(path)
  }

  async mkdirp(path: string): Promise<void> {
    this.assertWritable(path)
    await mkdir(path, { recursive: true })
  }

  stat(path: string): Promise<StatInfo> {
    return stat(path)
  }

  readdir(path: string): Promise<DirEntry[]> {
    return readdir(path, { withFileTypes: true })
  }

  // Run `command` through the user's shell with `opts.cwd` as its working
  // directory. The capture/cap/timeout/abort logic lives in captureSpawn
  // (shared with the container backend); this just spawns the process. stdin is
  // closed so the command can't block waiting for input.
  //
  // `detached: true` makes the child its own process-group leader, so on abort or
  // timeout captureSpawn can SIGKILL the whole group (killGroup) — otherwise a
  // `shell: true` command that forked children (a pipeline, `npm run build` → node)
  // would orphan them when only the sh wrapper is killed. We keep stdio piped (the
  // parent holds the handles) and deliberately do NOT call child.unref(): the child
  // stays tied to this turn, not surviving it.
  //
  // Windows does not support POSIX process groups/negative-PID kills. More
  // importantly, `detached: true` gives the shell a separate console there, which
  // can make simple commands appear to run while returning no captured bytes.
  // Keep the shell attached on Windows and let captureSpawn use taskkill for
  // timeout/abort cleanup.
  async exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    let cleanupPath: string | null = null
    let commandToRun = normalizeHostShellCommand(command)
    const scriptPath = join(
      tmpdir(),
      `cowork-python-heredoc-${randomUUID()}.py`
    )
    const materialized = materializePythonHeredocCommand(command, scriptPath)
    if (materialized) {
      await writeFile(scriptPath, materialized.script, "utf8")
      cleanupPath = scriptPath
      commandToRun = materialized.command
    }

    const child = this.spawnShell(commandToRun, opts.cwd, [
      "ignore",
      "pipe",
      "pipe",
    ])
    try {
      return await captureSpawn(child, { ...opts, killGroup: true })
    } finally {
      if (cleanupPath) {
        await unlink(cleanupPath).catch(() => {})
      }
    }
  }

  async spawnCommand(
    command: string,
    opts: SpawnCommandOptions
  ): Promise<CommandSessionHandle> {
    const commandToRun = normalizeHostShellCommand(command)
    if (opts.tty) {
      const shell = this.shellInvocation(commandToRun, false)
      const term = pty.spawn(shell.file, shell.args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: opts.cwd,
        env: { ...process.env, TERM: "xterm-256color" },
      })
      return new PtyCommandHandle(term, opts.signal)
    }

    const child = this.spawnShell(commandToRun, opts.cwd, [
      "pipe",
      "pipe",
      "pipe",
    ])
    return new ChildProcessCommandHandle(child, {
      killGroup: true,
      signal: opts.signal,
    })
  }

  // Grep the workspace through ripgrep, parsing `--json` so file names and
  // content are never split with ad-hoc delimiters. Patterns/globs are argv data.
  async search(opts: SearchOptions): Promise<SearchResult> {
    const child = spawn(resolveRipgrepPath(), buildRipgrepArgs(opts), {
      cwd: opts.root,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    })
    const res = await captureSpawn(child, {
      timeoutMs: 30_000,
      maxOutputBytes: 16 * 1024 * 1024,
      signal: opts.signal,
      killGroup: true,
    })
    if (res.exitCode != null && res.exitCode > 1) {
      const message = res.stdout.toString("utf8").trim()
      throw new Error(message || "ripgrep failed")
    }
    return parseRipgrepJson(res.stdout, opts)
  }

  async dispose(): Promise<void> {
    // Nothing to clean up on the host.
  }

  private shellInvocation(
    command: string,
    captured = true
  ): { file: string; args: string[] } {
    const shell = captured
      ? shellForCapturedCommand(command)
      : shellForCommand(command)
    if (this.profile === "host-access") return shell
    if (process.platform !== "darwin") {
      throw new Error(`Local profile is unavailable: ${this.profile}`)
    }
    return {
      file: sandboxExecPath(),
      args: [
        "-p",
        buildDarwinSandboxProfile(this.profile, this.workspace),
        shell.file,
        ...shell.args,
      ],
    }
  }

  private spawnShell(
    command: string,
    cwd: string,
    stdio: ["ignore" | "pipe", "pipe", "pipe"] | ["pipe", "pipe", "pipe"]
  ): ChildProcess {
    if (this.profile === "host-access") {
      return spawn(command, {
        cwd,
        shell: true,
        detached: process.platform !== "win32",
        stdio,
      })
    }
    const shell = this.shellInvocation(command, true)
    return spawn(shell.file, shell.args, {
      cwd,
      shell: false,
      detached: process.platform !== "win32",
      stdio,
    })
  }

  private assertWritable(path: string): void {
    if (this.profile === "host-access") return
    if (this.profile === "read-only") {
      throw new Error("Local read-only profile blocks filesystem writes.")
    }
    if (!isInside(this.workspace, path) && !isInside(tmpdir(), path)) {
      throw new Error(
        "Local workspace-write profile blocks writes outside the workspace."
      )
    }
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

class ChildProcessCommandHandle
  extends EventEmitter<{
    data: [CommandChunk]
    exit: [CommandExit]
  }>
  implements CommandSessionHandle
{
  private readonly stdoutDecoder = new StringDecoder("utf8")
  private readonly stderrDecoder = new StringDecoder("utf8")
  private closed = false

  constructor(
    private readonly child: ChildProcess,
    private readonly opts: { killGroup: boolean; signal?: AbortSignal }
  ) {
    super()
    child.stdout?.on("data", (chunk: Buffer) =>
      this.emitDecoded("stdout", chunk, this.stdoutDecoder)
    )
    child.stderr?.on("data", (chunk: Buffer) =>
      this.emitDecoded("stderr", chunk, this.stderrDecoder)
    )
    child.on("error", (err) => {
      this.emit("data", {
        stream: "stderr",
        data: Buffer.from(`Failed to start command: ${err.message}`),
      })
    })
    child.on("close", (exitCode, signal) => {
      this.closed = true
      this.flushDecoder("stdout", this.stdoutDecoder)
      this.flushDecoder("stderr", this.stderrDecoder)
      this.opts.signal?.removeEventListener("abort", this.onAbort)
      this.emit("exit", { exitCode, signal })
    })
    if (opts.signal) {
      if (opts.signal.aborted) this.kill()
      else opts.signal.addEventListener("abort", this.onAbort, { once: true })
    }
  }

  onData(cb: (chunk: CommandChunk) => void): void {
    this.on("data", cb)
  }

  onExit(cb: (exit: CommandExit) => void): void {
    this.on("exit", cb)
  }

  write(data: string): void {
    if (!this.closed && this.child.stdin?.writable) this.child.stdin.write(data)
  }

  closeStdin(): void {
    if (!this.closed && this.child.stdin?.writable) this.child.stdin.end()
  }

  interrupt(): void {
    if (this.closed) return
    if (process.platform === "win32") {
      this.kill()
      return
    }
    try {
      if (this.opts.killGroup && this.child.pid) {
        process.kill(-this.child.pid, "SIGINT")
      } else {
        this.child.kill("SIGINT")
      }
    } catch {
      this.child.kill("SIGINT")
    }
  }

  kill(): void {
    if (this.closed) return
    if (this.opts.killGroup && this.child.pid) {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], {
          stdio: "ignore",
        }).on("error", () => this.child.kill("SIGKILL"))
        return
      }
      try {
        process.kill(-this.child.pid, "SIGKILL")
        return
      } catch {
        // Fall back to killing the direct child.
      }
    }
    try {
      this.child.kill("SIGKILL")
    } catch {
      // Already dead.
    }
  }

  private readonly onAbort = () => this.kill()

  private emitDecoded(
    stream: "stdout" | "stderr",
    chunk: Buffer,
    decoder: StringDecoder
  ): void {
    const decoded = decoder.write(chunk)
    if (decoded) this.emit("data", { stream, data: Buffer.from(decoded) })
  }

  private flushDecoder(
    stream: "stdout" | "stderr",
    decoder: StringDecoder
  ): void {
    const decoded = decoder.end()
    if (decoded) this.emit("data", { stream, data: Buffer.from(decoded) })
  }
}

class PtyCommandHandle
  extends EventEmitter<{
    data: [CommandChunk]
    exit: [CommandExit]
  }>
  implements CommandSessionHandle
{
  private closed = false

  constructor(
    private readonly term: pty.IPty,
    private readonly signal?: AbortSignal
  ) {
    super()
    term.onData((data) =>
      this.emit("data", { stream: "pty", data: Buffer.from(data) })
    )
    term.onExit(({ exitCode, signal }) => {
      this.closed = true
      this.signal?.removeEventListener("abort", this.onAbort)
      this.emit("exit", {
        exitCode,
        signal: typeof signal === "string" ? signal : null,
      })
    })
    if (signal) {
      if (signal.aborted) this.kill()
      else signal.addEventListener("abort", this.onAbort, { once: true })
    }
  }

  onData(cb: (chunk: CommandChunk) => void): void {
    this.on("data", cb)
  }

  onExit(cb: (exit: CommandExit) => void): void {
    this.on("exit", cb)
  }

  write(data: string): void {
    if (!this.closed) this.term.write(data)
  }

  closeStdin(): void {
    if (!this.closed) this.term.write("\x04")
  }

  interrupt(): void {
    if (!this.closed) this.term.write("\x03")
  }

  kill(): void {
    if (this.closed) return
    try {
      this.term.kill()
    } catch {
      // Already dead.
    }
  }

  private readonly onAbort = () => this.kill()
}

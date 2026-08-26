import { spawn } from "child_process"
import type { ChildProcess } from "child_process"
import { randomUUID } from "crypto"
import { EventEmitter } from "events"
import { writeFile, unlink } from "fs/promises"
import { isAbsolute, relative, resolve, join } from "path"
import { tmpdir } from "os"
import { StringDecoder } from "string_decoder"
import * as pty from "node-pty"
import { captureSpawn } from "./spawn-util"
import {
  buildRipgrepArgs,
  parseRipgrepJson,
  throwForRipgrepExecutionFailure,
} from "./ripgrep"
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

type SpawnFn = typeof spawn

interface LocalEnvironmentDeps {
  resolveRipgrepPath?: () => string
  spawn?: SpawnFn
  pythonPath?: string
  searchTimeoutMs?: number
  searchMaxOutputBytes?: number
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
    private readonly profile: LocalRuntimeProfile = "host-access",
    private readonly deps: LocalEnvironmentDeps = {}
  ) {
    assertLocalProfileSupported(profile)
  }

  get localRuntimeProfile(): LocalRuntimeProfile {
    return this.profile
  }

  resolve(path: string): Promise<string> {
    assertScopedFsSupported()
    return resolveInWorkspaceReal(this.workspace, path)
  }

  resolveLexical(path: string): string {
    return resolveInWorkspace(this.workspace, path)
  }

  readFile(path: string): Promise<Buffer> {
    return safeReadFile(this.workspace, path, this.deps.pythonPath)
  }

  readTextLines(
    path: string,
    opts: ReadTextLinesOptions
  ): Promise<ReadTextLinesResult> {
    return readTextLinesFromBuffer(
      safeReadFile(this.workspace, path, this.deps.pythonPath),
      opts
    )
  }

  writeFile(path: string, data: string): Promise<void> {
    this.assertWritable(path)
    return runSafeFs(
      this.workspace,
      "write_file",
      { path, data },
      this.deps.pythonPath
    )
  }

  chmod(path: string, mode: number): Promise<void> {
    this.assertWritable(path)
    return runSafeFs(
      this.workspace,
      "chmod",
      { path, mode },
      this.deps.pythonPath
    )
  }

  rename(from: string, to: string): Promise<void> {
    this.assertWritable(from)
    this.assertWritable(to)
    return runSafeFs(
      this.workspace,
      "rename",
      { from, to },
      this.deps.pythonPath
    )
  }

  installFileNoReplace(from: string, to: string): Promise<void> {
    this.assertWritable(from)
    this.assertWritable(to)
    return runSafeFs(this.workspace, "link", { from, to }, this.deps.pythonPath)
  }

  removeFile(path: string): Promise<void> {
    this.assertWritable(path)
    return runSafeFs(this.workspace, "unlink", { path }, this.deps.pythonPath)
  }

  async mkdirp(path: string): Promise<void> {
    this.assertWritable(path)
    await runSafeFs(this.workspace, "mkdirp", { path }, this.deps.pythonPath)
  }

  async stat(path: string): Promise<StatInfo> {
    const info = await safeStat(this.workspace, path, this.deps.pythonPath)
    return {
      size: info.size,
      mode: info.mode,
      isFile: () => info.type === "file",
      isDirectory: () => info.type === "dir",
    }
  }

  readdir(path: string): Promise<DirEntry[]> {
    return safeReaddir(this.workspace, path, this.deps.pythonPath)
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
    const spawnFn = this.deps.spawn ?? spawn
    const child = spawnFn(
      this.deps.pythonPath ?? "python3",
      [
        "-c",
        SAFE_RG_SCRIPT,
        this.workspace,
        opts.root,
        (this.deps.resolveRipgrepPath ?? resolveRipgrepPath)(),
        ...buildRipgrepArgs(opts),
      ],
      {
        cwd: this.workspace,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      }
    )
    const res = await captureSpawn(child, {
      timeoutMs: this.deps.searchTimeoutMs ?? 30_000,
      maxOutputBytes: this.deps.searchMaxOutputBytes ?? 16 * 1024 * 1024,
      signal: opts.signal,
      killGroup: true,
    })
    throwForRipgrepExecutionFailure(
      res.exitCode === 127
        ? {
            ...res,
            exitCode: null,
            spawnError:
              res.stderr?.toString("utf8").trim() ||
              res.stdout.toString("utf8").trim(),
          }
        : res
    )
    return absolutizeSearchPaths(
      parseRipgrepJson(res.stdout, opts, res),
      opts.root
    )
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

function assertScopedFsSupported(): void {
  if (process.platform === "win32") {
    throw new Error(
      "Local filesystem tools require no-follow directory-relative operations, which are unavailable on this platform."
    )
  }
}

const SAFE_FS_SCRIPT = String.raw`
import base64, json, os, stat, sys

def fail_closed(message):
    raise RuntimeError(message)

def rel_parts(root, target):
    root_abs = os.path.realpath(root)
    target_abs = os.path.realpath(target)
    rel = os.path.relpath(target_abs, root_abs)
    if rel == os.curdir:
        return []
    if rel == os.pardir or rel.startswith(os.pardir + os.sep) or os.path.isabs(rel):
        fail_closed("path is outside the workspace")
    return [p for p in rel.split(os.sep) if p and p != os.curdir]

def open_root(root):
    return os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

def open_dir_child(parent_fd, name):
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)

def open_parent(root, target):
    parts = rel_parts(root, target)
    root_fd = open_root(root)
    fds = [root_fd]
    try:
        current = root_fd
        for part in parts[:-1]:
            current = open_dir_child(current, part)
            fds.append(current)
        return fds, current, (parts[-1] if parts else ".")
    except BaseException:
        close_all(fds)
        raise

def close_all(fds):
    for fd in reversed(fds):
        try: os.close(fd)
        except OSError: pass

def read_file(root, path):
    fds, parent, name = open_parent(root, path)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            chunks = []
            while True:
                chunk = os.read(fd, 1024 * 1024)
                if not chunk:
                    break
                chunks.append(chunk)
            return {"data": base64.b64encode(b"".join(chunks)).decode("ascii")}
        finally:
            os.close(fd)
    finally:
        close_all(fds)

def write_file(root, path, data):
    fds, parent, name = open_parent(root, path)
    try:
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o666, dir_fd=parent)
        try:
            os.write(fd, data.encode("utf-8"))
        finally:
            os.close(fd)
        return {}
    finally:
        close_all(fds)

def chmod_file(root, path, mode):
    fds, parent, name = open_parent(root, path)
    try:
        os.chmod(name, int(mode), dir_fd=parent, follow_symlinks=False)
        return {}
    finally:
        close_all(fds)

def rename_file(root, src, dst):
    src_fds, src_parent, src_name = open_parent(root, src)
    dst_fds, dst_parent, dst_name = open_parent(root, dst)
    try:
        os.rename(src_name, dst_name, src_dir_fd=src_parent, dst_dir_fd=dst_parent)
        return {}
    finally:
        close_all(dst_fds)
        close_all(src_fds)

def link_file(root, src, dst):
    src_fds, src_parent, src_name = open_parent(root, src)
    dst_fds, dst_parent, dst_name = open_parent(root, dst)
    try:
        os.link(src_name, dst_name, src_dir_fd=src_parent, dst_dir_fd=dst_parent, follow_symlinks=False)
        return {}
    finally:
        close_all(dst_fds)
        close_all(src_fds)

def unlink_file(root, path):
    fds, parent, name = open_parent(root, path)
    try:
        os.unlink(name, dir_fd=parent)
        return {}
    finally:
        close_all(fds)

def mkdirp(root, path):
    parts = rel_parts(root, path)
    root_fd = open_root(root)
    fds = [root_fd]
    try:
        current = root_fd
        for part in parts:
            try:
                os.mkdir(part, 0o777, dir_fd=current)
            except FileExistsError:
                pass
            current = open_dir_child(current, part)
            fds.append(current)
        return {}
    finally:
        close_all(fds)

def stat_path(root, path):
    fds, parent, name = open_parent(root, path)
    try:
        st = os.stat(name, dir_fd=parent, follow_symlinks=False)
        typ = "dir" if stat.S_ISDIR(st.st_mode) else "file" if stat.S_ISREG(st.st_mode) else "other"
        return {"size": st.st_size, "mode": stat.S_IMODE(st.st_mode), "type": typ}
    finally:
        close_all(fds)

def readdir_path(root, path):
    fd = open_root(root)
    fds = [fd]
    try:
        current = fd
        for part in rel_parts(root, path):
            current = open_dir_child(current, part)
            fds.append(current)
        entries = []
        for name in os.listdir(current):
            try:
                st = os.stat(name, dir_fd=current, follow_symlinks=False)
                typ = "dir" if stat.S_ISDIR(st.st_mode) else "file" if stat.S_ISREG(st.st_mode) else "other"
            except OSError:
                typ = "other"
            entries.append({"name": name, "type": typ})
        return {"entries": entries}
    finally:
        close_all(fds)

req = json.load(sys.stdin)
root = req["root"]
op = req["op"]
args = req.get("args", {})
if op == "read_file":
    result = read_file(root, args["path"])
elif op == "write_file":
    result = write_file(root, args["path"], args["data"])
elif op == "chmod":
    result = chmod_file(root, args["path"], args["mode"])
elif op == "rename":
    result = rename_file(root, args["from"], args["to"])
elif op == "link":
    result = link_file(root, args["from"], args["to"])
elif op == "unlink":
    result = unlink_file(root, args["path"])
elif op == "mkdirp":
    result = mkdirp(root, args["path"])
elif op == "stat":
    result = stat_path(root, args["path"])
elif op == "readdir":
    result = readdir_path(root, args["path"])
else:
    fail_closed("unknown op")
json.dump(result, sys.stdout)
`

const SAFE_RG_SCRIPT = String.raw`
import os, sys

def fail_closed(message):
    raise RuntimeError(message)

def rel_parts(root, target):
    root_abs = os.path.realpath(root)
    target_abs = os.path.realpath(target)
    rel = os.path.relpath(target_abs, root_abs)
    if rel == os.curdir:
        return []
    if rel == os.pardir or rel.startswith(os.pardir + os.sep) or os.path.isabs(rel):
        fail_closed("path is outside the workspace")
    return [p for p in rel.split(os.sep) if p and p != os.curdir]

try:
    fd = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    fds = [fd]
    current = fd
    for part in rel_parts(sys.argv[1], sys.argv[2]):
        current = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
        fds.append(current)
    os.fchdir(current)
    rg = sys.argv[3]
    args = [rg] + [("." if arg == sys.argv[2] else arg) for arg in sys.argv[4:]]
    try:
        os.execv(rg, args)
    except OSError as exc:
        print(str(exc), file=sys.stderr)
        os._exit(127)
except BaseException as exc:
    print(str(exc), file=sys.stderr)
    os._exit(127)
finally:
    for item in reversed(fds):
        try: os.close(item)
        except OSError: pass
`

async function runSafeFs<T>(
  workspace: string,
  op: string,
  args: Record<string, unknown>,
  pythonPath = "python3"
): Promise<T> {
  assertScopedFsSupported()
  const child = spawn(pythonPath, ["-c", SAFE_FS_SCRIPT], {
    cwd: workspace,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  })
  child.stdin.end(JSON.stringify({ root: workspace, op, args }))
  const res = await captureSpawn(child, {
    timeoutMs: 30_000,
    maxOutputBytes: 32 * 1024 * 1024,
    killGroup: false,
  })
  if (res.exitCode !== 0) {
    const message =
      res.stderr?.toString("utf8").trim() ||
      res.stdout.toString("utf8").trim() ||
      res.spawnError ||
      "safe local filesystem operation failed"
    throw new Error(message)
  }
  return JSON.parse(res.stdout.toString("utf8") || "{}") as T
}

async function safeReadFile(
  workspace: string,
  path: string,
  pythonPath?: string
): Promise<Buffer> {
  const result = await runSafeFs<{ data: string }>(
    workspace,
    "read_file",
    { path },
    pythonPath
  )
  return Buffer.from(result.data, "base64")
}

async function safeStat(
  workspace: string,
  path: string,
  pythonPath?: string
): Promise<{ size: number; mode: number; type: string }> {
  return runSafeFs(workspace, "stat", { path }, pythonPath)
}

async function safeReaddir(
  workspace: string,
  path: string,
  pythonPath?: string
): Promise<DirEntry[]> {
  const result = await runSafeFs<{
    entries: Array<{ name: string; type: string }>
  }>(workspace, "readdir", { path }, pythonPath)
  return result.entries.map((entry) => ({
    name: entry.name,
    isFile: () => entry.type === "file",
    isDirectory: () => entry.type === "dir",
  }))
}

function absolutizeSearchPaths(
  result: SearchResult,
  root: string
): SearchResult {
  const absolute = (path: string) =>
    isAbsolute(path) ? path : resolve(root, path)
  return {
    ...result,
    matches: result.matches.map((match) => ({
      ...match,
      path: absolute(match.path),
    })),
    files: result.files.map(absolute),
    counts: result.counts.map((count) => ({
      ...count,
      path: absolute(count.path),
    })),
  }
}

async function readTextLinesFromBuffer(
  bytes: Promise<Buffer>,
  opts: ReadTextLinesOptions
): Promise<ReadTextLinesResult> {
  const { createHash } = await import("crypto")
  const data = await bytes
  if (data.subarray(0, 8000).includes(0)) throw new Error("BINARY_FILE")
  const text = data.toString("utf8")
  const lines =
    text === ""
      ? [""]
      : text.endsWith("\n")
        ? text.slice(0, -1).split("\n")
        : text.split("\n")
  const offset = Math.max(1, Math.floor(opts.offset))
  const limit = Math.max(1, Math.floor(opts.limit))
  const maxBytes = Math.max(1, Math.floor(opts.maxBytes))
  const selected: string[] = []
  let returnedBytes = 0
  let truncated = false
  let lineTooLong = false
  let skippedLineRemainder = false
  for (let i = offset - 1; i < lines.length && selected.length < limit; i++) {
    const line = lines[i] ?? ""
    const separatorBytes = selected.length > 0 ? 1 : 0
    const lineBytes = Buffer.byteLength(line, "utf8")
    if (returnedBytes + separatorBytes + lineBytes > maxBytes) {
      truncated = true
      if (selected.length === 0) {
        const prefix = utf8Prefix(line, maxBytes)
        selected.push(prefix)
        returnedBytes = Buffer.byteLength(prefix, "utf8")
        lineTooLong = true
        skippedLineRemainder = true
      }
      break
    }
    selected.push(line)
    returnedBytes += separatorBytes + lineBytes
  }
  const endLine = selected.length ? offset + selected.length - 1 : offset - 1
  const hasMore = truncated || offset - 1 + selected.length < lines.length
  return {
    text: selected.join("\n"),
    startLine: offset,
    endLine,
    hasMore,
    nextOffset: hasMore ? endLine + 1 : undefined,
    fileBytes: data.length,
    truncated,
    revision: hasMore
      ? undefined
      : createHash("sha256").update(data).digest("hex"),
    lineTooLong: lineTooLong || undefined,
    skippedLineRemainder: skippedLineRemainder || undefined,
  }
}

function utf8Prefix(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text
  let out = ""
  let bytes = 0
  for (const char of text) {
    const next = Buffer.byteLength(char, "utf8")
    if (bytes + next > maxBytes) break
    out += char
    bytes += next
  }
  return out
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

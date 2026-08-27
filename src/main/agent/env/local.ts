import { spawn } from "child_process"
import type { ChildProcess } from "child_process"
import { createHash, randomUUID } from "crypto"
import { EventEmitter } from "events"
import { constants } from "fs"
import {
  chmod as fsChmod,
  link as fsLink,
  lstat,
  mkdir as fsMkdir,
  open as fsOpen,
  readdir as fsReaddir,
  realpath,
  rename as fsRename,
  unlink as fsUnlink,
  writeFile,
} from "fs/promises"
import { isAbsolute, relative, resolve, join, sep } from "path"
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
  ListDirOptions,
  ListDirResult,
  ReadTextLinesOptions,
  ReadTextLinesResult,
  SpawnCommandOptions,
  CommandSessionHandle,
  CommandChunk,
  CommandExit,
  CommandCleanupError,
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
  platform?: NodeJS.Platform
  searchTimeoutMs?: number
  searchMaxOutputBytes?: number
  unlinkTempFile?: (path: string) => Promise<void>
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
    return resolveInWorkspaceReal(this.workspace, path)
  }

  resolveLexical(path: string): string {
    return resolveInWorkspace(this.workspace, path)
  }

  readFile(path: string): Promise<Buffer> {
    return safeReadFile(this.workspace, path)
  }

  readTextLines(
    path: string,
    opts: ReadTextLinesOptions
  ): Promise<ReadTextLinesResult> {
    return safeReadTextLines(this.workspace, path, opts)
  }

  writeFile(path: string, data: string): Promise<void> {
    this.assertWritable(path)
    return safeWriteFile(this.workspace, path, data)
  }

  chmod(path: string, mode: number): Promise<void> {
    this.assertWritable(path)
    return safeChmod(this.workspace, path, mode)
  }

  rename(from: string, to: string): Promise<void> {
    this.assertWritable(from)
    this.assertWritable(to)
    return safeRename(this.workspace, from, to)
  }

  installFileNoReplace(from: string, to: string): Promise<void> {
    this.assertWritable(from)
    this.assertWritable(to)
    return safeLink(this.workspace, from, to)
  }

  removeFile(path: string): Promise<void> {
    this.assertWritable(path)
    return safeUnlink(this.workspace, path)
  }

  async mkdirp(path: string): Promise<void> {
    this.assertWritable(path)
    await safeMkdirp(this.workspace, path)
  }

  async stat(path: string): Promise<StatInfo> {
    const info = await safeStat(this.workspace, path)
    return {
      size: info.size,
      mode: info.mode,
      isFile: () => info.type === "file",
      isDirectory: () => info.type === "dir",
    }
  }

  readdir(path: string): Promise<DirEntry[]> {
    return safeReaddir(this.workspace, path)
  }

  listDir(path: string, opts: ListDirOptions): Promise<ListDirResult> {
    return safeListDir(this.workspace, path, opts)
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
    const platform = this.deps.platform ?? process.platform
    let commandToRun = normalizeHostShellCommand(command, platform)
    const scriptPath = join(
      tmpdir(),
      `cowork-python-heredoc-${randomUUID()}.py`
    )
    const materialized = materializePythonHeredocCommand(
      command,
      scriptPath,
      platform
    )
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
      const result = await captureSpawn(child, { ...opts, killGroup: true })
      if (!cleanupPath) return result
      const cleanupError = await this.cleanupTempFile(cleanupPath)
      cleanupPath = null
      return cleanupError ? { ...result, cleanupError } : result
    } finally {
      if (cleanupPath) await this.cleanupTempFile(cleanupPath)
    }
  }

  async spawnCommand(
    command: string,
    opts: SpawnCommandOptions
  ): Promise<CommandSessionHandle> {
    let cleanupPath: string | null = null
    const platform = this.deps.platform ?? process.platform
    let commandToRun = normalizeHostShellCommand(command, platform)
    const scriptPath = join(
      tmpdir(),
      `cowork-python-heredoc-${randomUUID()}.py`
    )
    const materialized = materializePythonHeredocCommand(
      command,
      scriptPath,
      platform
    )
    if (materialized) {
      await writeFile(scriptPath, materialized.script, "utf8")
      cleanupPath = scriptPath
      commandToRun = materialized.command
    }

    let handle: CommandSessionHandle
    if (opts.tty) {
      const shell = this.shellInvocation(commandToRun, false)
      try {
        const term = pty.spawn(shell.file, shell.args, {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: opts.cwd,
          env: { ...process.env, TERM: "xterm-256color" },
        })
        handle = new PtyCommandHandle(term, opts.signal)
      } catch (error) {
        if (cleanupPath) await this.cleanupTempFile(cleanupPath)
        throw error
      }
      return cleanupPath
        ? new CleanupCommandHandle(handle, cleanupPath, (path) =>
            this.cleanupTempFile(path)
          )
        : handle
    }

    try {
      const child = this.spawnShell(commandToRun, opts.cwd, [
        "pipe",
        "pipe",
        "pipe",
      ])
      handle = new ChildProcessCommandHandle(child, {
        killGroup: true,
        signal: opts.signal,
      })
    } catch (error) {
      if (cleanupPath) await this.cleanupTempFile(cleanupPath)
      throw error
    }
    return cleanupPath
      ? new CleanupCommandHandle(handle, cleanupPath, (path) =>
          this.cleanupTempFile(path)
        )
      : handle
  }

  private commandPlatform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform
  }

  private async cleanupTempFile(
    path: string
  ): Promise<CommandCleanupError | undefined> {
    try {
      await (this.deps.unlinkTempFile ?? fsUnlink)(path)
      return undefined
    } catch (error) {
      return {
        path,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private commandSpawn(): SpawnFn {
    return this.deps.spawn ?? spawn
  }

  // Grep the workspace through ripgrep, parsing `--json` so file names and
  // content are never split with ad-hoc delimiters. Patterns/globs are argv data.
  async search(opts: SearchOptions): Promise<SearchResult> {
    const spawnFn = this.deps.spawn ?? spawn
    const root = await assertScopedLocalPath(this.workspace, opts.root, {
      requireLeaf: true,
      requireDirectory: true,
    })
    const child = spawnFn(
      (this.deps.resolveRipgrepPath ?? resolveRipgrepPath)(),
      buildRipgrepArgs({ ...opts, root }).map((arg) =>
        arg === root ? "." : arg
      ),
      {
        cwd: root,
        shell: false,
        detached: this.commandPlatform() !== "win32",
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
    const platform = this.commandPlatform()
    const shell = captured
      ? shellForCapturedCommand(command, platform)
      : shellForCommand(command, platform)
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
      return this.commandSpawn()(command, {
        cwd,
        shell: true,
        detached: this.commandPlatform() !== "win32",
        stdio,
      })
    }
    const shell = this.shellInvocation(command, true)
    return this.commandSpawn()(shell.file, shell.args, {
      cwd,
      shell: false,
      detached: this.commandPlatform() !== "win32",
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
  return rel === "" || (!isParentTraversal(rel) && !isAbsolute(rel))
}

function isParentTraversal(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`)
}

interface ScopedPathOptions {
  requireLeaf?: boolean
  requireDirectory?: boolean
  allowMissingLeaf?: boolean
}

async function assertScopedLocalPath(
  workspace: string,
  path: string,
  opts: ScopedPathOptions = {}
): Promise<string> {
  const lexicalRoot = resolve(workspace)
  const root = await realpath(workspace)
  const lexicalTarget = resolve(path)
  const target = isInside(lexicalRoot, lexicalTarget)
    ? join(root, relative(lexicalRoot, lexicalTarget))
    : lexicalTarget
  if (!isInside(root, target)) {
    throw new Error(
      `Path "${path}" is outside the workspace and is not allowed.`
    )
  }

  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Workspace root is not a real directory.")
  }

  const rel = relative(root, target)
  const parts = rel ? rel.split(/[\\/]+/).filter(Boolean) : []
  let current = root
  const requiredParts =
    opts.allowMissingLeaf && parts.length > 0 ? parts.slice(0, -1) : parts

  for (const part of requiredParts) {
    current = join(current, part)
    const stat = await lstat(current)
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Path "${path}" resolves through a symlink and is not allowed.`
      )
    }
    if (!stat.isDirectory() && current !== target) {
      throw new Error(`Path "${path}" has a non-directory parent.`)
    }
  }

  if (opts.allowMissingLeaf && parts.length > 0) {
    try {
      const leafStat = await lstat(target)
      if (leafStat.isSymbolicLink()) {
        throw new Error(
          `Path "${path}" resolves through a symlink and is not allowed.`
        )
      }
      if (opts.requireDirectory && !leafStat.isDirectory()) {
        throw new Error(`Path "${path}" is not a directory.`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    return target
  }

  if (opts.requireLeaf || opts.requireDirectory) {
    const leafStat = await lstat(target)
    if (leafStat.isSymbolicLink()) {
      throw new Error(
        `Path "${path}" resolves through a symlink and is not allowed.`
      )
    }
    if (opts.requireDirectory && !leafStat.isDirectory()) {
      throw new Error(`Path "${path}" is not a directory.`)
    }
  }

  return target
}

async function safeOpenNoFollow(path: string, flags: number, mode?: number) {
  return fsOpen(path, flags | constants.O_NOFOLLOW, mode)
}

async function safeReadFile(workspace: string, path: string): Promise<Buffer> {
  const target = await assertScopedLocalPath(workspace, path, {
    requireLeaf: true,
  })
  const handle = await safeOpenNoFollow(target, constants.O_RDONLY)
  try {
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

async function safeReadTextLines(
  workspace: string,
  path: string,
  opts: ReadTextLinesOptions
): Promise<ReadTextLinesResult> {
  const data = await safeReadFile(workspace, path)
  if (data.subarray(0, 8000).includes(0)) throw new Error("BINARY_FILE")

  const offset = Math.max(1, Math.floor(opts.offset))
  const limit = Math.max(1, Math.floor(opts.limit))
  const maxBytes = Math.max(1, Math.floor(opts.maxBytes))
  const physicalLines = splitPhysicalLines(data)
  const selected: string[] = []
  let returnedBytes = 0
  let endLine = offset - 1
  let hasMore = false
  let truncated = false
  let lineTooLong = false
  let skippedLineRemainder = false

  for (let index = offset - 1; index < physicalLines.length; index += 1) {
    if (selected.length >= limit) {
      hasMore = true
      break
    }

    const raw = physicalLines[index]
    const sep = selected.length > 0 ? 1 : 0
    if (returnedBytes + sep + raw.length > maxBytes) {
      truncated = true
      hasMore = true
      if (selected.length === 0) {
        const prefix = utf8SafePrefix(raw, maxBytes)
        selected.push(prefix.text)
        returnedBytes = prefix.bytes
        endLine = index + 1
        lineTooLong = true
        skippedLineRemainder = true
      }
      break
    }

    selected.push(raw.toString("utf8"))
    returnedBytes += sep + raw.length
    endLine = index + 1
  }

  return {
    text: selected.join("\n"),
    startLine: offset,
    endLine,
    hasMore,
    nextOffset: hasMore ? endLine + 1 : undefined,
    fileBytes: data.length,
    truncated,
    revision: createHash("sha256").update(data).digest("hex"),
    lineTooLong: lineTooLong || undefined,
    skippedLineRemainder: skippedLineRemainder || undefined,
  }
}

async function safeStat(
  workspace: string,
  path: string
): Promise<{ size: number; mode: number; type: string }> {
  const target = await assertScopedLocalPath(workspace, path, {
    requireLeaf: true,
  })
  const stat = await lstat(target)
  return {
    size: stat.size,
    mode: stat.mode & 0o777,
    type: stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other",
  }
}

async function safeReaddir(
  workspace: string,
  path: string
): Promise<DirEntry[]> {
  const result = await safeListDir(workspace, path, {})
  return result.entries
}

async function safeListDir(
  workspace: string,
  path: string,
  opts: Partial<ListDirOptions>
): Promise<ListDirResult> {
  const target = await assertScopedLocalPath(workspace, path, {
    requireLeaf: true,
    requireDirectory: true,
  })
  const entries: DirEntry[] = []
  let totalBytes = 0
  let truncated = false
  let capReason: ListDirResult["capReason"] | undefined

  for (const entry of await fsReaddir(target, { withFileTypes: true })) {
    const nameBytes = Buffer.byteLength(entry.name, "utf8")
    if (opts.maxEntries != null && entries.length >= opts.maxEntries) {
      truncated = true
      capReason = "entryCount"
      break
    }
    if (
      opts.maxBytes != null &&
      entries.length > 0 &&
      totalBytes + nameBytes > opts.maxBytes
    ) {
      truncated = true
      capReason = "nameBytes"
      break
    }
    entries.push({
      name: entry.name,
      isFile: () => entry.isFile(),
      isDirectory: () => entry.isDirectory(),
    })
    totalBytes += nameBytes
  }

  return { entries, truncated, capReason }
}

async function safeWriteFile(
  workspace: string,
  path: string,
  data: string
): Promise<void> {
  const target = await assertScopedLocalPath(workspace, path, {
    allowMissingLeaf: true,
  })
  const handle = await safeOpenNoFollow(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
    0o666
  )
  try {
    await handle.writeFile(data, "utf8")
  } finally {
    await handle.close()
  }
}

async function safeChmod(
  workspace: string,
  path: string,
  mode: number
): Promise<void> {
  const target = await assertScopedLocalPath(workspace, path, {
    requireLeaf: true,
  })
  await fsChmod(target, mode)
}

async function safeRename(
  workspace: string,
  from: string,
  to: string
): Promise<void> {
  const source = await assertScopedLocalPath(workspace, from, {
    requireLeaf: true,
  })
  const target = await assertScopedLocalPath(workspace, to, {
    allowMissingLeaf: true,
  })
  await fsRename(source, target)
}

async function safeLink(
  workspace: string,
  from: string,
  to: string
): Promise<void> {
  const source = await assertScopedLocalPath(workspace, from, {
    requireLeaf: true,
  })
  const target = await assertScopedLocalPath(workspace, to, {
    allowMissingLeaf: true,
  })
  await fsLink(source, target)
}

async function safeUnlink(workspace: string, path: string): Promise<void> {
  const target = await assertScopedLocalPath(workspace, path, {
    requireLeaf: true,
  })
  await fsUnlink(target)
}

async function safeMkdirp(workspace: string, path: string): Promise<void> {
  const lexicalRoot = resolve(workspace)
  const root = await realpath(workspace)
  const lexicalTarget = resolve(path)
  const target = isInside(lexicalRoot, lexicalTarget)
    ? join(root, relative(lexicalRoot, lexicalTarget))
    : lexicalTarget
  if (!isInside(root, target)) {
    throw new Error(
      `Path "${path}" is outside the workspace and is not allowed.`
    )
  }
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Workspace root is not a real directory.")
  }

  const rel = relative(root, target)
  const parts = rel ? rel.split(/[\\/]+/).filter(Boolean) : []
  let current = root
  for (const part of parts) {
    current = join(current, part)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink()) {
        throw new Error(
          `Path "${path}" resolves through a symlink and is not allowed.`
        )
      }
      if (!stat.isDirectory()) {
        throw new Error(`Path "${path}" has a non-directory parent.`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await fsMkdir(current)
    }
  }
}

function splitPhysicalLines(data: Buffer): Buffer[] {
  if (data.length === 0) return [Buffer.alloc(0)]
  const lines: Buffer[] = []
  let start = 0
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] !== 0x0a) continue
    let end = index
    if (end > start && data[end - 1] === 0x0d) end -= 1
    lines.push(data.subarray(start, end))
    start = index + 1
  }
  if (start < data.length) lines.push(data.subarray(start))
  return lines
}

function utf8SafePrefix(
  raw: Buffer,
  byteLimit: number
): {
  text: string
  bytes: number
} {
  let prefix = raw.subarray(0, byteLimit)
  while (prefix.length > 0) {
    const text = prefix.toString("utf8")
    if (!text.includes("\ufffd")) return { text, bytes: prefix.length }
    prefix = prefix.subarray(0, prefix.length - 1)
  }
  return { text: "", bytes: 0 }
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

class CleanupCommandHandle
  extends EventEmitter<{
    data: [CommandChunk]
    exit: [CommandExit]
  }>
  implements CommandSessionHandle
{
  constructor(
    private readonly inner: CommandSessionHandle,
    private readonly cleanupPath: string,
    private readonly cleanup: (
      path: string
    ) => Promise<CommandCleanupError | undefined>
  ) {
    super()
    inner.onData((chunk) => this.emit("data", chunk))
    inner.onExit((exit) => {
      void this.cleanup(this.cleanupPath).then((cleanupError) =>
        this.emit("exit", cleanupError ? { ...exit, cleanupError } : exit)
      )
    })
  }

  onData(cb: (chunk: CommandChunk) => void): void {
    this.on("data", cb)
  }

  onExit(cb: (exit: CommandExit) => void): void {
    this.on("exit", cb)
  }

  write(data: string): void {
    this.inner.write(data)
  }

  closeStdin(): void {
    this.inner.closeStdin()
  }

  interrupt(): void {
    this.inner.interrupt()
  }

  kill(): void {
    this.inner.kill()
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

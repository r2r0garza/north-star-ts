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
  ListDirOptions,
  ListDirResult,
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
  platform?: NodeJS.Platform
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
    return safeReadTextLines(this.workspace, path, opts, this.deps.pythonPath)
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

  listDir(path: string, opts: ListDirOptions): Promise<ListDirResult> {
    return safeListDir(this.workspace, path, opts, this.deps.pythonPath)
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
        if (cleanupPath) await unlink(cleanupPath).catch(() => {})
        throw error
      }
      return cleanupPath
        ? new CleanupCommandHandle(handle, cleanupPath)
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
      if (cleanupPath) await unlink(cleanupPath).catch(() => {})
      throw error
    }
    return cleanupPath ? new CleanupCommandHandle(handle, cleanupPath) : handle
  }

  private commandPlatform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform
  }

  private commandSpawn(): SpawnFn {
    return this.deps.spawn ?? spawn
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
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function assertScopedFsSupported(): void {
  if (process.platform === "win32") {
    throw new Error(
      "Local filesystem tools require no-follow directory-relative operations, which are unavailable on this platform."
    )
  }
}

export const SAFE_FS_SCRIPT = String.raw`
import base64, codecs, hashlib, json, os, stat, sys

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

def utf8_safe_prefix(raw, byte_limit):
    prefix = raw[:byte_limit]
    while prefix:
        try:
            return prefix.decode("utf-8"), len(prefix)
        except UnicodeDecodeError:
            prefix = prefix[:-1]
    return "", 0

def read_text_lines(root, path, offset, limit, max_bytes):
    offset = max(1, int(offset))
    limit = max(1, int(limit))
    max_bytes = max(1, int(max_bytes))
    sniff = 8000
    chunk_size = 65536

    fds, parent, name = open_parent(root, path)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            file_size = os.fstat(fd).st_size
            digest = hashlib.sha256()
            lines = []
            current = 1
            end_line = 0
            returned_bytes = 0
            has_more = False
            truncated = False
            line_too_long = False
            skipped_line_remainder = False
            reached_eof = False
            stopped = False
            page_full = False
            pending = b""
            sniffed = b""
            line_bytes = 0
            line_parts = []
            prefix = bytearray()
            decoder = codecs.getincrementaldecoder("utf-8")("replace")
            discarding_requested_line = False

            def reset_line():
                nonlocal line_bytes, line_parts, prefix, decoder, discarding_requested_line
                line_bytes = 0
                line_parts = []
                prefix = bytearray()
                decoder = codecs.getincrementaldecoder("utf-8")("replace")
                discarding_requested_line = False

            def append_requested(raw):
                nonlocal line_bytes, line_parts, prefix, discarding_requested_line
                if discarding_requested_line:
                    line_bytes += len(raw)
                    return
                sep = 1 if lines else 0
                if returned_bytes + sep + line_bytes + len(raw) <= max_bytes:
                    if not lines and len(prefix) < max_bytes:
                        prefix.extend(raw[: max_bytes - len(prefix)])
                    text = decoder.decode(raw, final=False)
                    if text:
                        line_parts.append(text)
                    line_bytes += len(raw)
                    return

                if not lines:
                    take = max(0, max_bytes - len(prefix))
                    if take:
                        prefix.extend(raw[:take])
                line_bytes += len(raw)
                discarding_requested_line = True

            def finish_line():
                nonlocal current, end_line, returned_bytes, has_more, truncated
                nonlocal line_too_long, skipped_line_remainder, stopped, page_full

                if current < offset:
                    current += 1
                    reset_line()
                    return

                if len(lines) >= limit:
                    has_more = True
                    stopped = True
                    return

                sep = 1 if lines else 0
                if returned_bytes + sep + line_bytes > max_bytes:
                    truncated = True
                    has_more = True
                    if not lines:
                        text, used = utf8_safe_prefix(bytes(prefix), max_bytes)
                        lines.append(text)
                        returned_bytes = used
                        end_line = current
                        line_too_long = True
                        skipped_line_remainder = True
                        current += 1
                    stopped = True
                    reset_line()
                    return

                tail = decoder.decode(b"", final=True)
                if tail:
                    line_parts.append(tail)
                lines.append("".join(line_parts))
                returned_bytes += sep + line_bytes
                end_line = current
                current += 1
                if len(lines) >= limit:
                    page_full = True
                reset_line()

            while True:
                chunk = os.read(fd, chunk_size)
                if not chunk:
                    reached_eof = True
                    break
                digest.update(chunk)
                if len(sniffed) < sniff:
                    take = min(sniff - len(sniffed), len(chunk))
                    sniffed += chunk[:take]
                    if b"\0" in sniffed:
                        return {"error": "binary"}
                if page_full:
                    has_more = True
                    stopped = True
                    break
                pending += chunk
                while pending and not stopped:
                    nl = pending.find(b"\n")
                    if nl >= 0:
                        part = pending[:nl]
                        pending = pending[nl + 1:]
                        append_requested(part)
                        finish_line()
                        if page_full and pending:
                            has_more = True
                            stopped = True
                    else:
                        append_requested(pending)
                        pending = b""
                if stopped:
                    break

            if reached_eof and (line_bytes > 0 or file_size == 0):
                finish_line()

            result = {
                "text": "\n".join(lines),
                "startLine": offset,
                "endLine": end_line if lines else offset - 1,
                "hasMore": has_more,
                "fileBytes": file_size,
                "truncated": truncated,
            }
            if has_more:
                result["nextOffset"] = end_line + 1
            if reached_eof:
                result["revision"] = digest.hexdigest()
            if line_too_long:
                result["lineTooLong"] = True
            if skipped_line_remainder:
                result["skippedLineRemainder"] = True
            return result
        finally:
            os.close(fd)
    finally:
        close_all(fds)

def write_all(fd, data, write=os.write):
    view = memoryview(data)
    written_total = 0
    while written_total < len(view):
        try:
            written = write(fd, view[written_total:])
        except InterruptedError:
            continue
        if written <= 0:
            fail_closed("write made no progress")
        written_total += written

def planned_write_factory(plan):
    calls = {"index": 0}
    def planned_write(fd, chunk):
        if calls["index"] >= len(plan):
            return os.write(fd, chunk)
        step = plan[calls["index"]]
        calls["index"] += 1
        if step == "interrupt":
            raise InterruptedError()
        if step == "zero":
            return 0
        if step == "error":
            raise OSError("injected write failure")
        count = int(step)
        if count < 0:
            fail_closed("invalid write test plan")
        to_write = min(count, len(chunk))
        if to_write == 0:
            return 0
        return os.write(fd, chunk[:to_write])
    return planned_write

def write_file(root, path, data, write=os.write):
    fds, parent, name = open_parent(root, path)
    try:
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o666, dir_fd=parent)
        try:
            encoded = data.encode("utf-8")
            # Success means every byte was accepted by the fd; durability remains unchanged and does not include fsync.
            write_all(fd, encoded, write)
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

def listdir_path(root, path, max_entries=None, max_bytes=None):
    fd = open_root(root)
    fds = [fd]
    try:
        current = fd
        for part in rel_parts(root, path):
            current = open_dir_child(current, part)
            fds.append(current)
        entries = []
        total_bytes = 0
        truncated = False
        cap_reason = None
        scan = os.scandir(current)
        try:
            for item in scan:
                name = item.name
                name_bytes = len(name.encode("utf-8"))
                if max_entries is not None and len(entries) >= max_entries:
                    truncated = True
                    cap_reason = "entryCount"
                    break
                if max_bytes is not None and entries and total_bytes + name_bytes > max_bytes:
                    truncated = True
                    cap_reason = "nameBytes"
                    break
                try:
                    st = item.stat(follow_symlinks=False)
                    typ = "dir" if stat.S_ISDIR(st.st_mode) else "file" if stat.S_ISREG(st.st_mode) else "other"
                except OSError:
                    typ = "other"
                entries.append({"name": name, "type": typ})
                total_bytes += name_bytes
        finally:
            scan.close()
        return {"entries": entries, "truncated": truncated, "capReason": cap_reason}
    finally:
        close_all(fds)

def readdir_path(root, path):
    return {"entries": listdir_path(root, path)["entries"]}

req = json.load(sys.stdin)
root = req["root"]
op = req["op"]
args = req.get("args", {})
if op == "read_file":
    result = read_file(root, args["path"])
elif op == "read_text_lines":
    result = read_text_lines(root, args["path"], args["offset"], args["limit"], args["maxBytes"])
elif op == "write_file":
    result = write_file(root, args["path"], args["data"])
elif op == "__test_write_file_with_plan":
    result = write_file(root, args["path"], args["data"], planned_write_factory(args["plan"]))
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
elif op == "listdir":
    result = listdir_path(root, args["path"], args.get("maxEntries"), args.get("maxBytes"))
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

async function safeReadTextLines(
  workspace: string,
  path: string,
  opts: ReadTextLinesOptions,
  pythonPath?: string
): Promise<ReadTextLinesResult> {
  const result = await runSafeFs<ReadTextLinesResult | { error: string }>(
    workspace,
    "read_text_lines",
    {
      path,
      offset: Math.max(1, Math.floor(opts.offset)),
      limit: Math.max(1, Math.floor(opts.limit)),
      maxBytes: Math.max(1, Math.floor(opts.maxBytes)),
    },
    pythonPath
  )
  if ("error" in result) {
    throw new Error(result.error === "binary" ? "BINARY_FILE" : result.error)
  }
  return result
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
  const result = await safeListDir(workspace, path, {}, pythonPath)
  return result.entries
}

async function safeListDir(
  workspace: string,
  path: string,
  opts: Partial<ListDirOptions>,
  pythonPath?: string
): Promise<ListDirResult> {
  const result = await runSafeFs<{
    entries: Array<{ name: string; type: string }>
    truncated?: boolean
    capReason?: ListDirResult["capReason"]
  }>(
    workspace,
    opts.maxEntries == null && opts.maxBytes == null ? "readdir" : "listdir",
    { path, maxEntries: opts.maxEntries, maxBytes: opts.maxBytes },
    pythonPath
  )
  const entries = result.entries.map((entry) => ({
    name: entry.name,
    isFile: () => entry.type === "file",
    isDirectory: () => entry.type === "dir",
  }))
  return {
    entries,
    truncated: result.truncated ?? false,
    capReason: result.capReason,
  }
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
    private readonly cleanupPath: string
  ) {
    super()
    inner.onData((chunk) => this.emit("data", chunk))
    inner.onExit((exit) => {
      void unlink(this.cleanupPath)
        .catch((error) => {
          this.emit("data", {
            stream: "stderr",
            data: Buffer.from(
              `Failed to remove temporary Python heredoc script ${this.cleanupPath}: ${(error as Error).message}\n`
            ),
          })
        })
        .finally(() => this.emit("exit", exit))
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

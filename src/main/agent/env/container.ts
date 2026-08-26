import { spawn } from "child_process"
import type { ChildProcess } from "child_process"
import { EventEmitter } from "events"
import { relative, posix } from "path"
import { StringDecoder } from "string_decoder"
import { resolveInWorkspace } from "../tools/workspace"
import { captureSpawn } from "./spawn-util"
import { hostCliEnv } from "./host-cli-env"
import {
  buildRipgrepArgs,
  parseRipgrepJson,
  SearchPatternError,
  throwForRipgrepExecutionFailure,
} from "./ripgrep"
import { systemSlug } from "../../config/system-name"
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
} from "./types"

export interface ContainerConfig {
  // Both binaries are CLI-compatible for the operations we need (run/exec/inspect
  // /stop/rm + bind mounts), so one class handles both, parameterized by binary.
  runtime: "docker" | "podman"
  image: string
  // Host path bind-mounted into the container at MOUNT.
  workspace: string
  // Stable per-conversation id so the same container is reused across turns.
  conversationId: string
  searchMaxOutputBytes?: number
}

// Fixed in-container mount point for the workspace. The host workspace is bound
// here, so an in-container path is MOUNT + (path relative to the host workspace).
const MOUNT = "/workspace"

// Result of a raw runtime CLI invocation (used internally for file ops, which
// expect a clean success/failure rather than the tool-facing ExecResult shape).
interface CliResult {
  stdout: Buffer
  stderr: string
  code: number | null
}

// Runs commands and file ops inside an OCI container, with the workspace bind-
// mounted so changes flow live to the host (no file-sync subsystem needed). A
// minimal implementation to validate the Environment abstraction: start/reuse a
// per-conversation container, exec commands, route file ops through the CLI, and
// dispose cleanly. Out of scope here: settings UI, approval changes, auto runtime
// selection, image building. See .plan/006 for documented follow-ups.
export class ContainerEnvironment implements Environment {
  private readonly name: string

  constructor(private readonly cfg: ContainerConfig) {
    // Container names allow [a-zA-Z0-9][a-zA-Z0-9_.-]*; ids may contain other
    // chars, so sanitize to keep `run --name` valid.
    const safeId = cfg.conversationId.replace(/[^a-zA-Z0-9_.-]/g, "-")
    this.name = `${systemSlug()}-env-${safeId}`
  }

  // Spawn the runtime binary with raw args, capturing stdout (as a Buffer, for
  // binary-safe file reads), stderr, and the exit code. `input` is written to the
  // child's stdin when provided (used by writeFile's base64 pipe).
  private async runtimeCli(args: string[], input?: string): Promise<CliResult> {
    const env = await hostCliEnv()
    return new Promise((resolve) => {
      const child = spawn(this.cfg.runtime, args, {
        env,
        stdio: [input != null ? "pipe" : "ignore", "pipe", "pipe"],
      })
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout?.on("data", (c: Buffer) => out.push(c))
      child.stderr?.on("data", (c: Buffer) => err.push(c))
      child.on("error", (e) =>
        resolve({ stdout: Buffer.alloc(0), stderr: e.message, code: null })
      )
      child.on("close", (code) =>
        resolve({
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(err).toString("utf8"),
          code,
        })
      )
      if (input != null) {
        child.stdin?.end(input)
      }
    })
  }

  // Map an in-environment absolute path (under MOUNT) — or a model-supplied
  // workspace-relative path — to its in-container path. Both `resolve` and exec's
  // cwd produce MOUNT-rooted paths, so this is mostly identity; it also maps a
  // host workspace path (exec passes ctx.workspace as cwd) back under MOUNT.
  private toContainerPath(p: string): string {
    if (p.startsWith(MOUNT)) return p
    // A host path inside the workspace → MOUNT + relative segment.
    const rel = relative(this.cfg.workspace, p)
    return rel ? posix.join(MOUNT, rel.split(/[\\/]/).join("/")) : MOUNT
  }

  // Confirm the runtime is installed, ensure the image is present, and start (or
  // reuse) the per-conversation container. Throws a clear error if the runtime is
  // unavailable so the caller can fail closed and fall back to Local.
  async start(): Promise<void> {
    const version = await this.runtimeCli(["--version"])
    if (version.code !== 0) {
      throw new Error(
        `${this.cfg.runtime} is not available on this machine` +
          (version.stderr ? `: ${version.stderr.trim()}` : "")
      )
    }

    // Reuse a running container of the same name across turns (idempotent start).
    const running = await this.runtimeCli([
      "inspect",
      "-f",
      "{{.State.Running}}",
      this.name,
    ])
    if (
      running.code === 0 &&
      running.stdout.toString("utf8").trim() === "true"
    ) {
      return
    }

    // Ensure the image exists locally (basics only: inspect, else pull).
    const img = await this.runtimeCli(["image", "inspect", this.cfg.image])
    if (img.code !== 0) {
      const pull = await this.runtimeCli(["pull", this.cfg.image])
      if (pull.code !== 0) {
        throw new Error(
          `failed to pull image ${this.cfg.image}: ${pull.stderr.trim()}`
        )
      }
    }

    // A stopped-but-present container would make `run --name` collide; remove any
    // leftover before creating a fresh one.
    await this.runtimeCli(["rm", "-f", this.name])

    const run = await this.runtimeCli([
      "run",
      "-d",
      "--name",
      this.name,
      "-v",
      `${this.cfg.workspace}:${MOUNT}`,
      "-w",
      MOUNT,
      this.cfg.image,
      "sleep",
      "infinity",
    ])
    if (run.code !== 0) {
      throw new Error(`failed to start container: ${run.stderr.trim()}`)
    }
  }

  resolveLexical(path: string): string {
    // Lexical confinement against the host workspace (rejects `..`/absolute),
    // then map into the container. The bind-mount boundary backstops symlink
    // escapes the lexical check can't see (the container sees only MOUNT).
    const host = resolveInWorkspace(this.cfg.workspace, path)
    return this.toContainerPath(host)
  }

  async resolve(path: string): Promise<string> {
    // MVP: lexical guard only. Full realpath-in-container parity is a follow-up
    // (see .plan/006) — the mount boundary already confines real access to MOUNT.
    return this.resolveLexical(path)
  }

  async readFile(path: string): Promise<Buffer> {
    // base64 over the pipe is binary-safe (no encoding/NUL corruption), so the
    // tool's binary detection and utf8 decode behave exactly as on the host.
    const p = this.toContainerPath(path)
    const res = await this.runtimeCli([
      "exec",
      this.name,
      "sh",
      "-c",
      `base64 < ${shq(p)}`,
    ])
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || `cannot read ${path}`)
    }
    return Buffer.from(res.stdout.toString("utf8"), "base64")
  }

  async readTextLines(
    path: string,
    opts: ReadTextLinesOptions
  ): Promise<ReadTextLinesResult> {
    const p = this.toContainerPath(path)
    const offset = Math.max(1, Math.floor(opts.offset))
    const limit = Math.max(1, Math.floor(opts.limit))
    const maxBytes = Math.max(1, Math.floor(opts.maxBytes))
    const script = `
python3 - "$1" "$2" "$3" "$4" <<'PY'
import hashlib, json, os, sys

path = sys.argv[1]
offset = max(1, int(sys.argv[2]))
limit = max(1, int(sys.argv[3]))
max_bytes = max(1, int(sys.argv[4]))
sniff = 8000

with open(path, "rb") as f:
    head = f.read(sniff)
    if b"\\0" in head:
        print(json.dumps({"error": "binary"}))
        raise SystemExit(0)
    f.seek(0)
    digest = hashlib.sha256()
    lines = []
    current = 1
    end_line = 0
    returned_bytes = 0
    has_more = False
    truncated = False
    line_too_long = False
    skipped_line_remainder = False
    reached_eof = True
    raw = b""

    for raw in f:
        digest.update(raw)
        try:
            line = raw[:-1] if raw.endswith(b"\\n") else raw
            text = line.decode("utf-8")
        except UnicodeDecodeError:
            print(json.dumps({"error": "decode"}))
            raise SystemExit(0)

        if current < offset:
            current += 1
            continue

        if len(lines) >= limit:
            has_more = True
            reached_eof = False
            break

        sep = 1 if lines else 0
        if returned_bytes + sep + len(line) > max_bytes:
            truncated = True
            has_more = True
            reached_eof = False
            if not lines:
                prefix = line[:max_bytes]
                while prefix:
                    try:
                        text = prefix.decode("utf-8")
                        break
                    except UnicodeDecodeError:
                        prefix = prefix[:-1]
                else:
                    text = ""
                lines.append(text)
                returned_bytes = len(prefix)
                end_line = current
                line_too_long = True
                skipped_line_remainder = True
            break

        lines.append(text)
        returned_bytes += sep + len(line)
        end_line = current
        current += 1

    if reached_eof:
        tail = f.read()
        if tail:
            digest.update(tail)

result = {
    "text": "\\n".join(lines),
    "startLine": offset,
    "endLine": end_line if lines else offset - 1,
    "hasMore": has_more,
    "fileBytes": os.stat(path).st_size,
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
print(json.dumps(result))
PY
`
    const res = await this.runtimeCli([
      "exec",
      this.name,
      "sh",
      "-c",
      script,
      "read-text-lines",
      p,
      String(offset),
      String(limit),
      String(maxBytes),
    ])
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || `cannot read ${path}`)
    }
    const parsed = JSON.parse(res.stdout.toString("utf8")) as
      | ReadTextLinesResult
      | { error: string }
    if ("error" in parsed) {
      throw new Error(parsed.error === "binary" ? "BINARY_FILE" : parsed.error)
    }
    return parsed
  }

  async writeFile(path: string, data: string): Promise<void> {
    // Pipe base64 to `base64 -d` so arbitrary content needs no shell quoting and
    // stays binary-safe.
    const p = this.toContainerPath(path)
    const b64 = Buffer.from(data, "utf8").toString("base64")
    const res = await this.runtimeCli(
      ["exec", "-i", this.name, "sh", "-c", `base64 -d > ${shq(p)}`],
      b64
    )
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || `cannot write ${path}`)
    }
  }

  async chmod(path: string, mode: number): Promise<void> {
    const p = this.toContainerPath(path)
    const normalized = (mode & 0o7777).toString(8)
    const res = await this.runtimeCli([
      "exec",
      this.name,
      "chmod",
      normalized,
      p,
    ])
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || `cannot chmod ${path}`)
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const res = await this.runtimeCli([
      "exec",
      this.name,
      "mv",
      "-f",
      this.toContainerPath(from),
      this.toContainerPath(to),
    ])
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || `cannot rename ${from} -> ${to}`)
    }
  }

  async installFileNoReplace(from: string, to: string): Promise<void> {
    const res = await this.runtimeCli([
      "exec",
      this.name,
      "ln",
      "-T",
      this.toContainerPath(from),
      this.toContainerPath(to),
    ])
    if (res.code !== 0) {
      throw new Error(
        res.stderr.trim() || `cannot install ${from} without replacing ${to}`
      )
    }
  }

  async removeFile(path: string): Promise<void> {
    const res = await this.runtimeCli([
      "exec",
      this.name,
      "rm",
      "-f",
      this.toContainerPath(path),
    ])
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || `cannot remove ${path}`)
    }
  }

  async mkdirp(path: string): Promise<void> {
    const res = await this.runtimeCli([
      "exec",
      this.name,
      "mkdir",
      "-p",
      this.toContainerPath(path),
    ])
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || `cannot mkdir ${path}`)
    }
  }

  async stat(path: string): Promise<StatInfo> {
    // `%s` = size in bytes, `%F` = file type description, `%a` = permission bits
    // in octal. A nonzero exit (e.g.
    // ENOENT) throws, so read/edit's `catch → not_found` fires just as on the host.
    const p = this.toContainerPath(path)
    const res = await this.runtimeCli([
      "exec",
      this.name,
      "sh",
      "-c",
      `stat -c '%s %F %a' ${shq(p)}`,
    ])
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || `no such file: ${path}`)
    }
    const text = res.stdout.toString("utf8").trim()
    const sp = text.indexOf(" ")
    const size = Number(text.slice(0, sp))
    const rest = text.slice(sp + 1)
    const modeSep = rest.lastIndexOf(" ")
    const kind = modeSep >= 0 ? rest.slice(0, modeSep) : rest
    const parsedMode =
      modeSep >= 0 ? Number.parseInt(rest.slice(modeSep + 1), 8) : NaN
    const isDir = kind === "directory"
    const isReg = kind === "regular file" || kind === "regular empty file"
    return {
      size: Number.isFinite(size) ? size : 0,
      mode: Number.isFinite(parsedMode) ? parsedMode & 0o7777 : undefined,
      isFile: () => isReg,
      isDirectory: () => isDir,
    }
  }

  async readdir(path: string): Promise<DirEntry[]> {
    // `ls -Ap1`: one entry per line, dotfiles except ./.. (-A), trailing `/` on
    // directories (-p). A trailing slash marks a directory; everything else is
    // treated as a file (symlinks/sockets are rare in a workspace and callers'
    // try/catch skips anything unreadable). Exact types are a follow-up.
    const p = this.toContainerPath(path)
    const res = await this.runtimeCli([
      "exec",
      this.name,
      "sh",
      "-c",
      `ls -Ap1 ${shq(p)}`,
    ])
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || `cannot list ${path}`)
    }
    return res.stdout
      .toString("utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const isDir = line.endsWith("/")
        const name = isDir ? line.slice(0, -1) : line
        return {
          name,
          isDirectory: () => isDir,
          isFile: () => !isDir,
        }
      })
  }

  async exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    // Run the model's command in the container shell, in the mapped cwd. The
    // inner command's exit code propagates through `docker exec`. Capture/cap/
    // timeout/abort are shared with the local backend via captureSpawn.
    //
    // Follow-up (see .plan/005.1): killing the host `exec` client (on timeout or
    // abort) does not stop the in-container process. The signal seam is wired and
    // we intentionally do NOT pass killGroup here — the docker/podman exec client
    // is not a detached group leader; an in-container kill needs its own design.
    const env = await hostCliEnv()
    const child = spawn(
      this.cfg.runtime,
      [
        "exec",
        "-w",
        this.toContainerPath(opts.cwd),
        this.name,
        "sh",
        "-c",
        command,
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] }
    )
    return captureSpawn(child, opts)
  }

  async spawnCommand(
    command: string,
    opts: SpawnCommandOptions
  ): Promise<CommandSessionHandle> {
    const env = await hostCliEnv()
    const args = [
      "exec",
      "-i",
      ...(opts.tty ? ["-t"] : []),
      "-w",
      this.toContainerPath(opts.cwd),
      this.name,
      "sh",
      "-c",
      command,
    ]
    const child = spawn(this.cfg.runtime, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    return new ContainerCommandHandle(child, opts.signal)
  }

  // Bulk content search as ONE in-container command (vs. hundreds of per-file
  // exec round-trips). Prefers ripgrep with JSON events. If rg is absent, uses a
  // bounded Python fallback that receives all model-supplied data as argv.
  async search(opts: SearchOptions): Promise<SearchResult> {
    const root = this.toContainerPath(opts.root)
    const hasRg = await this.runtimeCli([
      "exec",
      this.name,
      "sh",
      "-c",
      "command -v rg >/dev/null 2>&1",
    ])

    if (hasRg.code === 0) {
      const env = await hostCliEnv()
      const child = spawn(
        this.cfg.runtime,
        ["exec", this.name, "rg", ...buildRipgrepArgs({ ...opts, root })],
        { env, stdio: ["ignore", "pipe", "pipe"] }
      )
      const res = await captureSpawn(child, {
        timeoutMs: 30_000,
        maxOutputBytes: this.cfg.searchMaxOutputBytes ?? 16 * 1024 * 1024,
        signal: opts.signal,
      })
      throwForRipgrepExecutionFailure(res)
      return parseRipgrepJson(res.stdout, { ...opts, root }, res)
    }

    return this.searchWithPythonFallback({ ...opts, root })
  }

  private async searchWithPythonFallback(
    opts: SearchOptions
  ): Promise<SearchResult> {
    const script = `
python3 - "$@" <<'PY'
import fnmatch, json, os, re, sys

root, query, mode, case_mode, result_mode = sys.argv[1:6]
before = int(sys.argv[6])
after = int(sys.argv[7])
include_hidden = sys.argv[8] == "1"
max_results = int(sys.argv[9])
max_file_bytes = int(sys.argv[10])
globs = json.loads(sys.argv[11])

flags = 0
if case_mode == "insensitive" or (case_mode == "smart" and query.lower() == query):
    flags = re.IGNORECASE
pattern = re.escape(query) if mode == "fixed" else query
try:
    regex = re.compile(pattern, flags)
except re.error as e:
    print(json.dumps({"error": str(e)}))
    raise SystemExit(2)

def posix_rel(path):
    return os.path.relpath(path, root).replace(os.sep, "/")

def hidden_path(rel):
    return any(part.startswith(".") for part in rel.split("/") if part not in ("", "."))

def glob_allowed(rel):
    if not globs:
        return True
    included = False
    has_include = any(not g.startswith("!") for g in globs)
    if not has_include:
        included = True
    for glob in globs:
        neg = glob.startswith("!")
        pat = glob[1:] if neg else glob
        pats = [pat]
        if pat.startswith("**/"):
            pats.append(pat[3:])
        if any(fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(os.path.basename(rel), p) for p in pats):
            included = not neg
    return included

matches = []
files = []
file_set = set()
counts = {}
total = 0
capped = False

for dirpath, dirnames, filenames in os.walk(root):
    rel_dir = posix_rel(dirpath)
    if not include_hidden:
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
    for name in filenames:
        path = os.path.join(dirpath, name)
        rel = posix_rel(path)
        if not include_hidden and hidden_path(rel):
            continue
        if not glob_allowed(rel):
            continue
        try:
            if os.path.getsize(path) > max_file_bytes:
                continue
            with open(path, "rb") as f:
                data = f.read()
            if b"\\0" in data[:8000]:
                continue
            text = data.decode("utf-8")
        except Exception:
            continue

        lines = text.splitlines()
        matched_lines = []
        for idx, line in enumerate(lines):
            found = list(regex.finditer(line))
            if not found:
                continue
            total += len(found)
            counts[path] = counts.get(path, 0) + len(found)
            if path not in file_set:
                if result_mode == "files" and len(files) >= max_results:
                    capped = True
                else:
                    file_set.add(path)
                    files.append(path)
            matched_lines.append((idx, found[0].start() + 1))

        if result_mode == "content" and matched_lines:
            emitted = set()
            for idx, col in matched_lines:
                start = max(0, idx - before)
                end = min(len(lines), idx + after + 1)
                for out_idx in range(start, end):
                    if out_idx in emitted:
                        continue
                    emitted.add(out_idx)
                    if len(matches) >= max_results:
                        capped = True
                        break
                    matches.append({
                        "path": path,
                        "line": out_idx + 1,
                        "column": col if out_idx == idx else None,
                        "text": lines[out_idx],
                        "kind": "match" if out_idx == idx else "context",
                    })
                if capped:
                    break
        if result_mode == "count" and len(counts) > max_results:
            capped = True

result = {
    "engine": "grep",
    "result": result_mode,
    "matches": matches,
    "files": files[:max_results],
    "counts": [{"path": p, "matches": c} for p, c in list(counts.items())[:max_results]],
    "totalMatches": total,
    "capped": capped,
    "reducedFeatures": ["container image does not include rg; Python fallback does not support .gitignore files"],
}

print(json.dumps(result))
PY
`
    const res = await this.runtimeCli([
      "exec",
      this.name,
      "sh",
      "-c",
      script,
      "search-fallback",
      opts.root,
      opts.query,
      opts.mode,
      opts.case,
      opts.result,
      String(opts.beforeContext),
      String(opts.afterContext),
      opts.includeHidden ? "1" : "0",
      String(opts.maxResults),
      String(opts.maxFileBytes),
      JSON.stringify(opts.globs),
    ])
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || "search fallback failed")
    }
    const parsed = JSON.parse(res.stdout.toString("utf8")) as
      | SearchResult
      | { error: string }
    if ("error" in parsed) {
      throw new SearchPatternError(
        `Invalid regular expression: ${parsed.error}`
      )
    }
    return parsed
  }

  async dispose(): Promise<void> {
    // Simplest correct lifecycle for the MVP: force-remove (SIGKILL + remove) in
    // one step. We deliberately don't `stop` first — the container runs
    // `sleep infinity`, which ignores SIGTERM, so `stop` would block on its full
    // grace period before killing. `rm -f` kills immediately. (Keeping the
    // container warm across turns is a possible later optimization — out of scope.)
    await this.runtimeCli(["rm", "-f", this.name])
  }
}

// Single-quote a path for `sh -c`, escaping embedded single quotes. Paths are
// already workspace-confined (no `..`/absolute escapes), but names can contain
// spaces or quotes, so they must be quoted before interpolation.
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

class ContainerCommandHandle
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
    private readonly signal?: AbortSignal
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
      this.signal?.removeEventListener("abort", this.onAbort)
      this.emit("exit", { exitCode, signal })
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
    if (!this.closed && this.child.stdin?.writable) this.child.stdin.write(data)
  }

  closeStdin(): void {
    if (!this.closed && this.child.stdin?.writable) this.child.stdin.end()
  }

  interrupt(): void {
    if (this.closed) return
    try {
      this.child.kill("SIGINT")
    } catch {
      // Already dead.
    }
  }

  kill(): void {
    if (this.closed) return
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

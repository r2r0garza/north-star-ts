import { spawn } from "child_process"
import type { ChildProcess } from "child_process"
import { EventEmitter } from "events"
import { relative, posix } from "path"
import { StringDecoder } from "string_decoder"
import { resolveInWorkspace } from "../tools/workspace"
import { captureProcess, captureSpawn } from "./spawn-util"
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
  runtimeCliTimeoutMs?: number
  runtimeCliMaxOutputBytes?: number
  runtimeCliReadFileMaxOutputBytes?: number
  runtimeSpawn?: typeof spawn
  hostCliEnv?: typeof hostCliEnv
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
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted?: boolean
  spawnError?: string
  outputTruncated?: boolean
  capturedOutputBytes?: number
  observedOutputBytes?: number
}

interface RuntimeCliOptions {
  timeoutMs?: number
  maxOutputBytes?: number
  signal?: AbortSignal
}

// Production runtime CLI bounds. Ordinary Docker/Podman calls get 30s and 1 MiB;
// `run` gets 60s for container startup, `pull` gets 5m/4 MiB for progress output,
// and full-file base64 reads get 16 MiB before failing as truncated.
const RUNTIME_CLI_TIMEOUT_MS = 30_000
const RUNTIME_CLI_START_TIMEOUT_MS = 60_000
const RUNTIME_CLI_PULL_TIMEOUT_MS = 300_000
const RUNTIME_CLI_MAX_OUTPUT_BYTES = 1024 * 1024
const RUNTIME_CLI_PULL_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const RUNTIME_CLI_READ_FILE_MAX_OUTPUT_BYTES = 16 * 1024 * 1024

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
  private async runtimeCli(
    args: string[],
    input?: string,
    opts: RuntimeCliOptions = {}
  ): Promise<CliResult> {
    const env = await (this.cfg.hostCliEnv ?? hostCliEnv)()
    const child = (this.cfg.runtimeSpawn ?? spawn)(this.cfg.runtime, args, {
      env,
      stdio: [input != null ? "pipe" : "ignore", "pipe", "pipe"],
    })
    if (input != null) {
      child.stdin?.end(input)
    }
    const res = await captureProcess(child, {
      timeoutMs:
        opts.timeoutMs ??
        this.cfg.runtimeCliTimeoutMs ??
        RUNTIME_CLI_TIMEOUT_MS,
      maxOutputBytes:
        opts.maxOutputBytes ??
        this.cfg.runtimeCliMaxOutputBytes ??
        RUNTIME_CLI_MAX_OUTPUT_BYTES,
      signal: opts.signal,
    })
    return {
      stdout: res.stdout,
      stderr: res.stderr.toString("utf8"),
      code: res.exitCode,
      signal: res.signal,
      timedOut: res.timedOut,
      aborted: res.aborted,
      spawnError: res.spawnError,
      outputTruncated: res.outputTruncated,
      capturedOutputBytes: res.capturedOutputBytes,
      observedOutputBytes: res.observedOutputBytes,
    }
  }

  private ensureCompleteCliResult(res: CliResult, fallback: string): void {
    if (res.timedOut) {
      throw new Error(`${fallback} timed out after runtime CLI deadline`)
    }
    if (res.aborted) {
      throw new Error(`${fallback} was aborted`)
    }
    if (res.outputTruncated) {
      const captured =
        typeof res.capturedOutputBytes === "number"
          ? ` after ${res.capturedOutputBytes} captured bytes`
          : ""
      throw new Error(`${fallback} exceeded runtime CLI output cap${captured}`)
    }
    if (res.spawnError) {
      throw new Error(`${fallback}: ${res.spawnError}`)
    }
  }

  private throwForCliFailure(res: CliResult, fallback: string): void {
    this.ensureCompleteCliResult(res, fallback)
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || fallback)
    }
  }

  private parseCliJson<T>(res: CliResult, fallback: string): T {
    this.ensureCompleteCliResult(res, fallback)
    try {
      return JSON.parse(res.stdout.toString("utf8")) as T
    } catch (error) {
      throw new Error(
        `${fallback}: invalid runtime CLI JSON output: ${(error as Error).message}`
      )
    }
  }

  private cliFailureMessage(res: CliResult, fallback: string): string {
    if (res.timedOut) return `${fallback} timed out after runtime CLI deadline`
    if (res.aborted) return `${fallback} was aborted`
    if (res.outputTruncated) {
      return `${fallback} exceeded runtime CLI output cap`
    }
    if (res.spawnError) return `${fallback}: ${res.spawnError}`
    return res.stderr.trim() || fallback
  }

  // Map an in-environment absolute path (under MOUNT) — or a model-supplied
  // workspace-relative path — to its in-container path. Both `resolve` and exec's
  // cwd produce MOUNT-rooted paths, so this is mostly identity; it also maps a
  // host workspace path (exec passes ctx.workspace as cwd) back under MOUNT.
  private toContainerPath(p: string): string {
    if (isInsideContainerPath(MOUNT, p)) return p
    // A host path inside the workspace → MOUNT + relative segment.
    const rel = relative(this.cfg.workspace, p)
    return rel ? posix.join(MOUNT, rel.split(/[\\/]/).join("/")) : MOUNT
  }

  // Confirm the runtime is installed, ensure the image is present, and start (or
  // reuse) the per-conversation container. Throws a clear error if the runtime is
  // unavailable so the caller can fail closed and fall back to Local.
  async start(): Promise<void> {
    const version = await this.runtimeCli(["--version"])
    this.ensureCompleteCliResult(version, `${this.cfg.runtime} --version`)
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
    this.ensureCompleteCliResult(
      running,
      `${this.cfg.runtime} inspect ${this.name}`
    )
    if (
      running.code === 0 &&
      running.stdout.toString("utf8").trim() === "true"
    ) {
      return
    }

    // Ensure the image exists locally (basics only: inspect, else pull).
    const img = await this.runtimeCli(["image", "inspect", this.cfg.image])
    this.ensureCompleteCliResult(
      img,
      `${this.cfg.runtime} image inspect ${this.cfg.image}`
    )
    if (img.code !== 0) {
      const pull = await this.runtimeCli(["pull", this.cfg.image], undefined, {
        timeoutMs: RUNTIME_CLI_PULL_TIMEOUT_MS,
        maxOutputBytes: RUNTIME_CLI_PULL_MAX_OUTPUT_BYTES,
      })
      if (pull.code !== 0) {
        throw new Error(
          this.cliFailureMessage(pull, `failed to pull image ${this.cfg.image}`)
        )
      }
    }

    // A stopped-but-present container would make `run --name` collide; remove any
    // leftover before creating a fresh one.
    const removed = await this.runtimeCli(["rm", "-f", this.name])
    this.ensureCompleteCliResult(
      removed,
      `${this.cfg.runtime} rm -f ${this.name}`
    )

    const run = await this.runtimeCli(
      [
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
      ],
      undefined,
      { timeoutMs: RUNTIME_CLI_START_TIMEOUT_MS }
    )
    if (run.code !== 0) {
      throw new Error(this.cliFailureMessage(run, "failed to start container"))
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
    const target = this.resolveLexical(path)
    const script = `
import json, os, sys

mount = sys.argv[1]
target = sys.argv[2]

def inside(parent, child):
    rel = os.path.relpath(child, parent)
    return rel == "." or (not rel.startswith("..") and not os.path.isabs(rel))

probe = target
suffix = []
while True:
    try:
        real = os.path.realpath(probe)
        if not inside(mount, real):
            print(json.dumps({"error": "outside"}))
            sys.exit(2)
        print(json.dumps({"path": os.path.normpath(os.path.join(real, *reversed(suffix)))}))
        sys.exit(0)
    except OSError:
        parent = os.path.dirname(probe)
        if parent == probe:
            print(json.dumps({"error": "unvalidated"}))
            sys.exit(3)
        suffix.append(os.path.basename(probe))
        probe = parent
`
    const res = await this.runtimeCli([
      "exec",
      this.name,
      "python3",
      "-c",
      script,
      MOUNT,
      target,
    ])
    this.ensureCompleteCliResult(res, `Path "${path}" could not be validated.`)
    const parsed = this.parseCliJson<{ path: string } | { error: string }>(
      res,
      `Path "${path}" could not be validated.`
    )
    if ("error" in parsed) {
      throw new Error(
        parsed.error === "outside"
          ? `Path "${path}" resolves (via symlink) outside the workspace and is not allowed.`
          : `Path "${path}" could not be validated against the workspace.`
      )
    }
    if (res.code !== 0) {
      throw new Error(
        res.stderr.trim() || `Path "${path}" could not be validated.`
      )
    }
    return parsed.path
  }

  async readFile(path: string): Promise<Buffer> {
    // base64 over the pipe is binary-safe (no encoding/NUL corruption), so the
    // tool's binary detection and utf8 decode behave exactly as on the host.
    const p = this.toContainerPath(path)
    const res = await this.runtimeCli(
      ["exec", this.name, "sh", "-c", `base64 < ${shq(p)}`],
      undefined,
      {
        maxOutputBytes:
          this.cfg.runtimeCliReadFileMaxOutputBytes ??
          RUNTIME_CLI_READ_FILE_MAX_OUTPUT_BYTES,
      }
    )
    this.throwForCliFailure(res, `cannot read ${path}`)
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
import codecs, hashlib, json, os, sys

path = sys.argv[1]
offset = max(1, int(sys.argv[2]))
limit = max(1, int(sys.argv[3]))
max_bytes = max(1, int(sys.argv[4]))
sniff = 8000
chunk_size = 65536

def utf8_safe_prefix(raw, byte_limit):
    prefix = raw[:byte_limit]
    while prefix:
        try:
            return prefix.decode("utf-8"), len(prefix)
        except UnicodeDecodeError:
            prefix = prefix[:-1]
    return "", 0

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
    reached_eof = False
    stopped = False
    pending = b""
    line_bytes = 0
    line_parts = []
    prefix = bytearray()
    decoder = codecs.getincrementaldecoder("utf-8")()
    discarding_requested_line = False

    def reset_line():
        global line_bytes, line_parts, prefix, decoder, discarding_requested_line
        line_bytes = 0
        line_parts = []
        prefix = bytearray()
        decoder = codecs.getincrementaldecoder("utf-8")()
        discarding_requested_line = False

    def append_requested(raw):
        global line_bytes, line_parts, prefix, discarding_requested_line
        if discarding_requested_line:
            line_bytes += len(raw)
            return
        sep = 1 if lines else 0
        if returned_bytes + sep + line_bytes + len(raw) <= max_bytes:
            if not lines and len(prefix) < max_bytes:
                prefix.extend(raw[: max_bytes - len(prefix)])
            try:
                text = decoder.decode(raw, final=False)
            except UnicodeDecodeError:
                print(json.dumps({"error": "decode"}))
                raise SystemExit(0)
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
            return

        line_bytes += len(raw)
        discarding_requested_line = True

    def finish_line():
        global current, end_line, returned_bytes, has_more, truncated
        global line_too_long, skipped_line_remainder, stopped

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

        try:
            tail = decoder.decode(b"", final=True)
        except UnicodeDecodeError:
            print(json.dumps({"error": "decode"}))
            raise SystemExit(0)
        if tail:
            line_parts.append(tail)
        lines.append("".join(line_parts))
        returned_bytes += sep + line_bytes
        end_line = current
        current += 1
        reset_line()

    while True:
        chunk = f.read(chunk_size)
        if not chunk:
            reached_eof = True
            break
        digest.update(chunk)
        pending += chunk
        while pending and not stopped:
            nl = pending.find(b"\\n")
            if nl >= 0:
                part = pending[:nl]
                pending = pending[nl + 1:]
                append_requested(part)
                finish_line()
            else:
                append_requested(pending)
                pending = b""
        if stopped:
            break

    if reached_eof and (line_bytes > 0 or os.stat(path).st_size == 0):
        finish_line()

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
    this.throwForCliFailure(res, `cannot read ${path}`)
    const parsed = this.parseCliJson<ReadTextLinesResult | { error: string }>(
      res,
      `cannot read ${path}`
    )
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
    this.throwForCliFailure(res, `cannot write ${path}`)
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
    this.throwForCliFailure(res, `cannot chmod ${path}`)
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
    this.throwForCliFailure(res, `cannot rename ${from} -> ${to}`)
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
    this.throwForCliFailure(
      res,
      `cannot install ${from} without replacing ${to}`
    )
  }

  async removeFile(path: string): Promise<void> {
    const res = await this.runtimeCli([
      "exec",
      this.name,
      "rm",
      "-f",
      this.toContainerPath(path),
    ])
    this.throwForCliFailure(res, `cannot remove ${path}`)
  }

  async mkdirp(path: string): Promise<void> {
    const res = await this.runtimeCli([
      "exec",
      this.name,
      "mkdir",
      "-p",
      this.toContainerPath(path),
    ])
    this.throwForCliFailure(res, `cannot mkdir ${path}`)
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
    this.throwForCliFailure(res, `no such file: ${path}`)
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
    this.throwForCliFailure(res, `cannot list ${path}`)
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
    const hasRg = await this.runtimeCli(
      ["exec", this.name, "sh", "-c", "command -v rg >/dev/null 2>&1"],
      undefined,
      { signal: opts.signal }
    )
    this.ensureCompleteCliResult(hasRg, "container rg capability probe")

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
    const res = await this.runtimeCli(
      [
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
      ],
      undefined,
      { signal: opts.signal }
    )
    this.ensureCompleteCliResult(res, "search fallback failed")
    const parsed = this.parseCliJson<SearchResult | { error: string }>(
      res,
      "search fallback failed"
    )
    if ("error" in parsed) {
      throw new SearchPatternError(
        `Invalid regular expression: ${parsed.error}`
      )
    }
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || "search fallback failed")
    }
    return parsed
  }

  async dispose(): Promise<void> {
    // Simplest correct lifecycle for the MVP: force-remove (SIGKILL + remove) in
    // one step. We deliberately don't `stop` first — the container runs
    // `sleep infinity`, which ignores SIGTERM, so `stop` would block on its full
    // grace period before killing. `rm -f` kills immediately. (Keeping the
    // container warm across turns is a possible later optimization — out of scope.)
    const res = await this.runtimeCli(["rm", "-f", this.name])
    this.throwForCliFailure(res, `cannot dispose container ${this.name}`)
  }
}

// Single-quote a path for `sh -c`, escaping embedded single quotes. Paths are
// already workspace-confined (no `..`/absolute escapes), but names can contain
// spaces or quotes, so they must be quoted before interpolation.
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function isInsideContainerPath(parent: string, child: string): boolean {
  const rel = posix.relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !posix.isAbsolute(rel))
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

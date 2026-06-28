import { spawn } from "child_process"
import { relative, posix } from "path"
import { resolveInWorkspace } from "../tools/workspace"
import { captureSpawn } from "./spawn-util"
import type {
  Environment,
  ExecResult,
  ExecOptions,
  DirEntry,
  StatInfo,
  SearchOptions,
  SearchResult,
  SearchMatch,
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
    this.name = `cowork-env-${safeId}`
  }

  // Spawn the runtime binary with raw args, capturing stdout (as a Buffer, for
  // binary-safe file reads), stderr, and the exit code. `input` is written to the
  // child's stdin when provided (used by writeFile's base64 pipe).
  private runtimeCli(args: string[], input?: string): Promise<CliResult> {
    return new Promise((resolve) => {
      const child = spawn(this.cfg.runtime, args, {
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
    if (running.code === 0 && running.stdout.toString("utf8").trim() === "true") {
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
    // `%s` = size in bytes, `%F` = file type description. A nonzero exit (e.g.
    // ENOENT) throws, so read/edit's `catch → not_found` fires just as on the host.
    const p = this.toContainerPath(path)
    const res = await this.runtimeCli([
      "exec",
      this.name,
      "sh",
      "-c",
      `stat -c '%s %F' ${shq(p)}`,
    ])
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || `no such file: ${path}`)
    }
    const text = res.stdout.toString("utf8").trim()
    const sp = text.indexOf(" ")
    const size = Number(text.slice(0, sp))
    const kind = text.slice(sp + 1)
    const isDir = kind === "directory"
    const isReg = kind === "regular file" || kind === "regular empty file"
    return {
      size: Number.isFinite(size) ? size : 0,
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

  exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    // Run the model's command in the container shell, in the mapped cwd. The
    // inner command's exit code propagates through `docker exec`. Capture/cap/
    // timeout/abort are shared with the local backend via captureSpawn.
    //
    // Follow-up (see .plan/005.1): killing the host `exec` client (on timeout or
    // abort) does not stop the in-container process. The signal seam is wired and
    // we intentionally do NOT pass killGroup here — the docker/podman exec client
    // is not a detached group leader; an in-container kill needs its own design.
    const child = spawn(
      this.cfg.runtime,
      ["exec", "-w", this.toContainerPath(opts.cwd), this.name, "sh", "-c", command],
      { stdio: ["ignore", "pipe", "pipe"] }
    )
    return captureSpawn(child, opts)
  }

  // Bulk content search as ONE in-container command (vs. hundreds of per-file
  // exec round-trips). Prefers ripgrep; falls back to `grep -R` driven by `find`
  // when rg isn't in the image. Both emit `path:line:text`, capped by `head`.
  // Confinement holds (search runs under the mapped root, inside the mount);
  // ignore rules match the host walk (prune skipDirs, size cap, skip binary,
  // include dotfiles); the caller applies output truncation to the result.
  async search(opts: SearchOptions): Promise<SearchResult> {
    const root = this.toContainerPath(opts.root)
    const pattern = shq(opts.pattern)

    // ripgrep: --no-ignore + --hidden so it walks like the host (no .gitignore
    // handling, dotfiles included); we prune only the explicit skipDirs.
    const rgExcludes = opts.skipDirs
      .map((d) => `-g ${shq(`!${d}`)}`)
      .join(" ")
    const rgGlob = opts.glob ? ` --iglob ${shq(`*${opts.glob}*`)}` : ""
    const rg =
      `rg --line-number --no-heading --with-filename --color never ` +
      `--hidden --no-ignore --max-filesize ${opts.maxFileBytes} ` +
      `${rgExcludes}${rgGlob} -e ${pattern} ${shq(root)}`

    // grep fallback: find prunes skipDirs and bounds file size, xargs feeds grep
    // -I (skip binary) -n -H -E. /dev/null guarantees a filename prefix.
    const prune = opts.skipDirs
      .map((d) => `-name ${shq(d)}`)
      .join(" -o ")
    const findGlob = opts.glob ? ` -iname ${shq(`*${opts.glob}*`)}` : ""
    const grep =
      `find ${shq(root)} ${prune ? `\\( ${prune} \\) -prune -o ` : ""}` +
      `-type f${findGlob} -size -${opts.maxFileBytes + 1}c -print0 ` +
      `| xargs -0 -r grep -I -n -H -E -e ${pattern} /dev/null`

    // Try rg, else grep. `head` enforces the global cap. rg/grep exit 1 on "no
    // matches" (not an error); only treat a missing-everything case as failure.
    const script =
      `if command -v rg >/dev/null 2>&1; then ${rg}; else ${grep}; fi ` +
      `| head -n ${opts.maxResults}`
    const res = await this.runtimeCli(["exec", this.name, "sh", "-c", script])

    const out = res.stdout.toString("utf8")
    // A nonzero exit with no output is the "no matches" case — return empty.
    if (!out) return { matches: [], capped: false }

    const matches: SearchMatch[] = []
    for (const raw of out.split("\n")) {
      if (!raw) continue
      // `path:line:text` — split on the first two colons only (text may contain
      // colons; the path is absolute under the mount so the first colon is safe).
      const c1 = raw.indexOf(":")
      if (c1 < 0) continue
      const c2 = raw.indexOf(":", c1 + 1)
      if (c2 < 0) continue
      const line = Number(raw.slice(c1 + 1, c2))
      if (!Number.isFinite(line)) continue
      matches.push({
        path: raw.slice(0, c1),
        line,
        text: raw.slice(c2 + 1).trim(),
      })
    }
    return { matches, capped: matches.length >= opts.maxResults }
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

import { spawn } from "child_process"
import { randomUUID } from "crypto"
import {
  readFile,
  writeFile,
  rename,
  mkdir,
  stat,
  readdir,
  unlink,
} from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { captureSpawn } from "./spawn-util"
import { readHostTextLines } from "./read-text-lines"
import { buildRipgrepArgs, parseRipgrepJson } from "./ripgrep"
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

// The default backend: runs commands and file ops directly on the host, confined
// to `workspace`. A behavior-preserving wrapper over exactly what the tools did
// before this seam existed — fs/promises, child_process.spawn, and the workspace
// path resolvers — so existing tool tests pass unchanged.
export class LocalEnvironment implements Environment {
  constructor(private readonly workspace: string) {}

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
    return writeFile(path, data, "utf8")
  }

  rename(from: string, to: string): Promise<void> {
    return rename(from, to)
  }

  removeFile(path: string): Promise<void> {
    return unlink(path)
  }

  async mkdirp(path: string): Promise<void> {
    await mkdir(path, { recursive: true })
  }

  stat(path: string): Promise<StatInfo> {
    return stat(path)
  }

  readdir(path: string): Promise<DirEntry[]> {
    return readdir(path, { withFileTypes: true })
  }

  // Run `command` through the user's shell, confined to `opts.cwd`. The capture/
  // cap/timeout/abort logic lives in captureSpawn (shared with the container
  // backend); this just spawns the process. stdin is closed so the command can't
  // block waiting for input.
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

    const child = spawn(commandToRun, {
      cwd: opts.cwd,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    })
    try {
      return await captureSpawn(child, { ...opts, killGroup: true })
    } finally {
      if (cleanupPath) {
        await unlink(cleanupPath).catch(() => {})
      }
    }
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
}

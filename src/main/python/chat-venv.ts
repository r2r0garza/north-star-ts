import { execFile } from "child_process"
import { access, constants } from "fs/promises"
import { homedir } from "os"
import { join, posix } from "path"
import { hostCliEnv } from "../agent/env/host-cli-env"
import { dataDirName } from "../config/system-name"
import { workspaceManagesPython } from "./project-python"

// The app's shared Python venv for interactive chat turns: ~/.<system-slug>/venv.
// A chat's `pip install` for a one-off script lands here instead of the user's
// global (often PEP 668 "externally managed") interpreter. Only runChat opts in,
// and the subagents a chat spawns inherit it; Mission Control seats, Playbooks,
// background tasks and the external CLIs never see it. The path follows
// dataDirName(), so a rebrand moves it.

export type ChatVenvStatus =
  | { state: "ready"; dir: string }
  | { state: "unavailable"; reason: string }

export interface ChatVenvOverlay {
  // Directories to put ahead of everything else on PATH.
  prependPath: string[]
  vars: Record<string, string>
}

interface ExecResult {
  ok: boolean
  output: string
}

export interface ChatVenvDeps {
  platform?: NodeJS.Platform
  home?: string
  env?: () => Promise<NodeJS.ProcessEnv>
  run?: (
    file: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    timeoutMs: number
  ) => Promise<ExecResult>
  isExecutable?: (path: string) => Promise<boolean>
  exists?: (path: string) => Promise<boolean>
}

const HEALTH_TIMEOUT_MS = 15_000
const CREATE_TIMEOUT_MS = 180_000

export function chatVenvDir(home: string = homedir()): string {
  return join(home, dataDirName(), "venv")
}

export function chatVenvBinDir(
  dir: string,
  platform: NodeJS.Platform = process.platform
): string {
  return platform === "win32" ? join(dir, "Scripts") : join(dir, "bin")
}

function venvPython(dir: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? join(dir, "Scripts", "python.exe")
    : join(dir, "bin", "python")
}

function defaultRun(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env, timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          output: `${stdout ?? ""}${stderr ?? ""}`.trim() || String(err ?? ""),
        })
      }
    )
  })
}

async function defaultIsExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

// The interpreter to build the venv from, resolved against the user's
// login-shell PATH so Homebrew/pyenv Python wins over the system one. On macOS,
// /usr/bin/python3 is a stub until the Command Line Tools are installed, and
// running it opens an install dialog — skip it unless `xcode-select -p` says the
// tools are present. Windows goes through the Python Launcher first.
async function resolveBaseInterpreter(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  run: NonNullable<ChatVenvDeps["run"]>,
  isExecutable: NonNullable<ChatVenvDeps["isExecutable"]>
): Promise<{ file: string; args: string[] } | null> {
  if (platform === "win32") {
    for (const candidate of [
      { file: "py", args: ["-3"] },
      { file: "python", args: [] },
    ]) {
      const probe = await run(
        candidate.file,
        [...candidate.args, "-c", "import venv"],
        env,
        HEALTH_TIMEOUT_MS
      )
      if (probe.ok) return candidate
    }
    return null
  }

  let cltChecked: boolean | undefined
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) continue
    const file = posix.join(dir, "python3")
    if (!(await isExecutable(file))) continue
    if (platform === "darwin" && file === "/usr/bin/python3") {
      cltChecked ??= (
        await run("/usr/bin/xcode-select", ["-p"], env, HEALTH_TIMEOUT_MS)
      ).ok
      if (!cltChecked) continue
    }
    return { file, args: [] }
  }
  return null
}

// Check the venv by running it, not by checking the folder exists: a venv is
// tied to the interpreter that built it, and a `brew upgrade python` can leave a
// folder whose python no longer starts. A broken one is rebuilt with --clear
// (its installed packages go with it; skills reinstall what they need).
export async function ensureChatVenvWith(
  deps: ChatVenvDeps = {}
): Promise<ChatVenvStatus> {
  const platform = deps.platform ?? process.platform
  const run = deps.run ?? defaultRun
  const isExecutable = deps.isExecutable ?? defaultIsExecutable
  const exists = deps.exists ?? defaultExists
  const dir = chatVenvDir(deps.home)
  const env = { ...(await (deps.env ?? hostCliEnv)()) }
  // Never build or probe the venv from inside some other active venv.
  delete env.VIRTUAL_ENV
  delete env.PYTHONHOME

  const python = venvPython(dir, platform)
  const healthy = async () =>
    (await exists(python)) &&
    (await run(python, ["-c", "import sys, pip"], env, HEALTH_TIMEOUT_MS)).ok
  if (await healthy()) return { state: "ready", dir }

  const base = await resolveBaseInterpreter(env, platform, run, isExecutable)
  if (!base) {
    return { state: "unavailable", reason: "no Python 3 interpreter found" }
  }
  const created = await run(
    base.file,
    [...base.args, "-m", "venv", "--clear", dir],
    env,
    CREATE_TIMEOUT_MS
  )
  if (!created.ok) {
    return {
      state: "unavailable",
      reason: `creating ${dir} failed: ${created.output}`,
    }
  }
  if (!(await healthy())) {
    return { state: "unavailable", reason: `${dir} was created but won't run` }
  }
  return { state: "ready", dir }
}

// One check per app run: kicked off in the background at startup, and awaited
// by chat turns so the first turn never races the creation. A missing Python is
// remembered until restart rather than re-probed on every turn.
let ensurePromise: Promise<ChatVenvStatus> | undefined

export function ensureChatVenv(): Promise<ChatVenvStatus> {
  ensurePromise ??= ensureChatVenvWith().catch((err) => ({
    state: "unavailable" as const,
    reason: err instanceof Error ? err.message : String(err),
  }))
  return ensurePromise
}

export function chatVenvOverlay(
  dir: string,
  platform: NodeJS.Platform = process.platform
): ChatVenvOverlay {
  return {
    prependPath: [chatVenvBinDir(dir, platform)],
    vars: { VIRTUAL_ENV: dir },
  }
}

// The overlay for one interactive chat turn, or null when the venv isn't
// available or the workspace brings its own Python environment.
export async function resolveChatVenvOverlay(
  workspace: string | undefined,
  deps: {
    ensure?: () => Promise<ChatVenvStatus>
    managesPython?: (root: string) => Promise<boolean>
    platform?: NodeJS.Platform
  } = {}
): Promise<ChatVenvOverlay | null> {
  const status = await (deps.ensure ?? ensureChatVenv)()
  if (status.state !== "ready") return null
  if (
    workspace &&
    (await (deps.managesPython ?? workspaceManagesPython)(workspace))
  ) {
    return null
  }
  return chatVenvOverlay(status.dir, deps.platform)
}

export const CHAT_VENV_PROMPT =
  "## Python packages\n" +
  "`python`, `python3` and `pip` in this session resolve to the app's own virtual environment. " +
  "When a command or script needs a missing package, install it with `pip install <package>` — it goes into that environment. " +
  "Never install globally: don't use `sudo`, `--user`, `--break-system-packages`, or a system interpreter path."

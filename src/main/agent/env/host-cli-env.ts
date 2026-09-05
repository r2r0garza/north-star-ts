import { spawn } from "child_process"
import { delimiter } from "path"

// GUI-launched desktop apps often inherit a minimal PATH. On macOS in
// particular, Finder/Dock launches usually miss Homebrew and Docker Desktop CLI
// locations, even though the same commands resolve in a login shell.
export const HOST_CLI_EXTRA_PATHS = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/opt/podman/bin",
  "/Applications/Docker.app/Contents/Resources/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
].filter(Boolean)

// Login-shell variables that describe the probe process rather than the command
// we are about to run. PATH is merged separately (order matters); the rest would
// actively mislead a child — a stale PWD, the probe's own SHLVL, or a TERM that
// contradicts how we wired the child's stdio.
const SHELL_LOCAL_VARS = new Set([
  "PATH",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  "TERM",
  "TMPDIR",
])

// The probe's stdout is not trustworthy on its own: an interactive rc file may
// print a banner, a version-manager notice, or a compinit warning. Frame the
// payload with sentinels and read only what sits between them.
const ENV_BEGIN = "__NS_HOST_ENV_BEGIN__"
const ENV_END = "__NS_HOST_ENV_END__"

// `env -0` because environment values may legally contain newlines. Absolute
// path so the probe still works if the shell's own PATH is broken. The syntax is
// shared by sh, bash, zsh and fish, so no per-shell command is needed.
const PROBE_COMMAND = `printf '%s' '${ENV_BEGIN}'; /usr/bin/env -0; printf '%s' '${ENV_END}'`

// An interactive login shell is what actually reproduces the user's PATH. zsh
// reads .zshrc only when interactive, and bash reads .bashrc only when
// interactive — and that is precisely where nvm, pnpm, rbenv and friends install
// their exports. A plain `-l -c` misses all of it.
//
// `-i` is the riskier flag, though: an rc file that expects a TTY can hang until
// the timeout. So try interactive first and fall back to the non-interactive
// login shell, which is strictly what this probe used to do — a broken
// interactive rc degrades to the old behavior instead of to nothing.
const PROBE_ATTEMPTS: { args: string[]; timeoutMs: number }[] = [
  { args: ["-i", "-l", "-c", PROBE_COMMAND], timeoutMs: 5000 },
  { args: ["-l", "-c", PROBE_COMMAND], timeoutMs: 2000 },
]

let cachedLoginShellEnv: NodeJS.ProcessEnv | null | undefined

function runProbe(
  shell: string,
  args: string[],
  base: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(shell, args, {
      env: base,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const chunks: Buffer[] = []
    let settled = false
    const done = (value: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      done(null)
    }, timeoutMs)
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk))
    child.on("error", () => done(null))
    // The exit code is deliberately ignored: an interactive shell can exit
    // non-zero for reasons unrelated to the payload (a failing rc line, a
    // trailing job-control complaint). The sentinels decide whether the output
    // is usable.
    child.on("close", () => done(Buffer.concat(chunks).toString("utf8")))
  })
}

export function parseProbeOutput(raw: string): NodeJS.ProcessEnv | null {
  const start = raw.indexOf(ENV_BEGIN)
  if (start < 0) return null
  const end = raw.lastIndexOf(ENV_END)
  if (end < start) return null

  const parsed: NodeJS.ProcessEnv = {}
  for (const entry of raw.slice(start + ENV_BEGIN.length, end).split("\0")) {
    const eq = entry.indexOf("=")
    // A name must be non-empty, so `eq > 0`; values may be empty or contain '='.
    if (eq > 0) parsed[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return Object.keys(parsed).length > 0 ? parsed : null
}

async function readLoginShellEnv(
  base: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv | null> {
  if (process.platform === "win32") return null
  const shell = base.SHELL || "/bin/zsh"
  for (const attempt of PROBE_ATTEMPTS) {
    const raw = await runProbe(shell, attempt.args, base, attempt.timeoutMs)
    const parsed = raw === null ? null : parseProbeOutput(raw)
    if (parsed) return parsed
  }
  return null
}

// Merge the login shell's environment over the inherited one. The inherited env
// is the floor, so Electron-internal variables survive; the login shell wins
// where both define a name, which is what makes JAVA_HOME, PNPM_HOME, NVM_DIR
// and the like reach agent commands. Callers layer explicit overrides on top.
export function buildHostCliEnv(
  base: NodeJS.ProcessEnv = process.env,
  loginShellEnv?: NodeJS.ProcessEnv | null
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base }
  for (const [key, value] of Object.entries(loginShellEnv ?? {})) {
    if (value === undefined || SHELL_LOCAL_VARS.has(key)) continue
    merged[key] = value
  }

  // The login shell's PATH comes FIRST, because it is the ordering the user
  // actually sees in their terminal and their rc file expresses real intent —
  // `export PATH="$(brew --prefix)/opt/python@3.12/libexec/bin:$PATH"` means
  // "prefer this python over the system one". Appending it instead lets a
  // GUI-inherited /usr/bin shadow every version-managed tool that also exists
  // system-wide: python3 would resolve to /usr/bin/python3 (3.9) while the same
  // command in the user's terminal gives 3.12. Tools with no system-wide twin
  // (node under nvm, pnpm) resolve either way, which makes the wrong order look
  // correct right up until it isn't.
  //
  // The inherited PATH follows, so anything only the app knows about still
  // resolves, and the fallbacks stay last. A failed probe leaves the inherited
  // PATH first exactly as before.
  const seen = new Set<string>()
  const homeLocalBin = base.HOME ? `${base.HOME}/.local/bin` : ""
  merged.PATH = [
    ...(loginShellEnv?.PATH ?? "").split(delimiter),
    ...(base.PATH ?? "").split(delimiter),
    ...HOST_CLI_EXTRA_PATHS,
    homeLocalBin,
  ]
    .filter((p) => {
      if (!p || seen.has(p)) return false
      seen.add(p)
      return true
    })
    .join(delimiter)

  return merged
}

export async function hostCliEnv(
  base: NodeJS.ProcessEnv = process.env
): Promise<NodeJS.ProcessEnv> {
  if (cachedLoginShellEnv === undefined) {
    cachedLoginShellEnv = await readLoginShellEnv(base)
  }
  return buildHostCliEnv(base, cachedLoginShellEnv)
}

// The probe result is cached for the process lifetime (it spawns a shell and
// sources dotfiles). Tests that exercise probing need that cache cleared.
export function resetHostCliEnvCache(): void {
  cachedLoginShellEnv = undefined
}

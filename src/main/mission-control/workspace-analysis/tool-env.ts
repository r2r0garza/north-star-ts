import { execFile } from "child_process"
import { homedir } from "os"
import path from "path"

// The user's own PATH, as their login shell builds it (nvm, pnpm, pyenv,
// Homebrew — whatever their .zprofile/.zshrc set up). Read once, in the
// background; until it's known, the directory list below stands in.
let shellPath: string[] | null = null
let shellPathPending: Promise<void> | null = null

const MARK = "__NORTH_STAR_PATH__"

export function warmShellPath(): Promise<void> {
  // Tests fake the tools; never spawn the developer's shell there.
  if (process.platform === "win32" || shellPath || process.env.VITEST)
    return Promise.resolve()
  shellPathPending ??= new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh"
    execFile(
      shell,
      ["-ilc", `printf '${MARK}%s${MARK}' "$PATH"`],
      { timeout: 5000, env: { ...process.env, TERM: "dumb" } },
      (_error, stdout) => {
        const match = new RegExp(`${MARK}(.*?)${MARK}`).exec(
          String(stdout ?? "")
        )
        shellPath = match ? match[1].split(path.delimiter).filter(Boolean) : []
        resolve()
      }
    )
  })
  return shellPathPending
}

// The environment project tools run in (plan 106.11): probes, setup steps, and
// fixes. A GUI-launched macOS app inherits launchd's short PATH
// (/usr/bin:/bin:…), so uv, cargo, or a version manager's shims are "not
// found", and /usr/bin/python3 (Apple's old 3.9) shadows Homebrew's python3.
// Add the usual per-user and package-manager bin directories ahead of the
// system ones, the way a login shell orders them. Entries already on the
// PATH before the system directories keep their place.
export function toolEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  home = homedir(),
  shell: string[] | null = shellPath
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === "string") env[k] = v
  }
  if (platform === "win32") return env
  const existing = (env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const system = (dir: string) =>
    /^\/(usr\/)?s?bin$|^\/System\/|^\/Library\/Apple\//.test(dir)
  const firstSystem = existing.findIndex(system)
  const head = firstSystem < 0 ? existing : existing.slice(0, firstSystem)
  const tail = firstSystem < 0 ? [] : existing.slice(firstSystem)
  const paths: string[] = []
  // The login shell's order first: it's what the user's terminal uses.
  for (const dir of [...(shell ?? []).filter((d) => !system(d)), ...head])
    if (!paths.includes(dir)) paths.push(dir)
  for (const dir of [
    path.join(home, "Library", "pnpm"),
    path.join(home, "Library", "pnpm", "bin"),
    path.join(home, ".local", "share", "pnpm"),
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local", "share", "mise", "shims"),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".pyenv", "shims"),
    path.join(home, ".rbenv", "shims"),
    path.join(home, ".nodenv", "shims"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".deno", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, "go", "bin"),
    path.join(home, ".dotnet"),
    path.join(home, ".dotnet", "tools"),
    path.join(home, ".sdkman", "candidates", "java", "current", "bin"),
    path.join(home, ".sdkman", "candidates", "gradle", "current", "bin"),
    path.join(home, ".sdkman", "candidates", "maven", "current", "bin"),
    path.join(home, ".sdkman", "candidates", "kotlin", "current", "bin"),
    path.join(home, "fvm", "default", "bin"),
    path.join(home, ".pub-cache", "bin"),
    path.join(home, ".composer", "vendor", "bin"),
    path.join(home, ".config", "composer", "vendor", "bin"),
    path.join(home, ".swiftly", "bin"),
    "/usr/local/go/bin",
    "/opt/homebrew/sbin",
    "/usr/local/sbin",
  ]) {
    if (!paths.includes(dir)) paths.push(dir)
  }
  for (const dir of [
    ...(shell ?? []).filter(system),
    ...tail,
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ])
    if (!paths.includes(dir)) paths.push(dir)
  env.PATH = paths.join(path.delimiter)
  // Tools must never stop to ask: a probe or a background step has no one to
  // answer. (The integrated terminal sets its own TERM and stays interactive.)
  env.CI = env.CI ?? "1"
  env.GIT_TERMINAL_PROMPT = "0"
  return env
}

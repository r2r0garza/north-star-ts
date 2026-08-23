import { spawn } from "child_process"
import { basename, delimiter } from "path"

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

let cachedLoginShellPath: string | null | undefined

function readLoginShellPath(
  base: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  if (process.platform === "win32") return Promise.resolve(null)

  const shell = base.SHELL || "/bin/zsh"
  const name = basename(shell)
  const args =
    name === "fish"
      ? ["-l", "-c", "string join : $PATH"]
      : ["-l", "-c", 'printf "%s" "$PATH"']

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
    }, 2000)
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk))
    child.on("error", () => done(null))
    child.on("close", (code) => {
      const path = Buffer.concat(chunks).toString("utf8").trim()
      done(code === 0 && path ? path : null)
    })
  })
}

export function buildHostCliEnv(
  base: NodeJS.ProcessEnv = process.env,
  loginShellPath?: string | null
): NodeJS.ProcessEnv {
  const seen = new Set<string>()
  const homeLocalBin = base.HOME ? `${base.HOME}/.local/bin` : ""
  const paths = [
    ...(base.PATH ?? "").split(delimiter),
    ...(loginShellPath ?? "").split(delimiter),
    ...HOST_CLI_EXTRA_PATHS,
    homeLocalBin,
  ]
    .filter((p) => {
      if (!p || seen.has(p)) return false
      seen.add(p)
      return true
    })
    .join(delimiter)

  return { ...base, PATH: paths }
}

export async function hostCliEnv(
  base: NodeJS.ProcessEnv = process.env
): Promise<NodeJS.ProcessEnv> {
  if (cachedLoginShellPath === undefined) {
    cachedLoginShellPath = await readLoginShellPath(base)
  }
  return buildHostCliEnv(base, cachedLoginShellPath)
}

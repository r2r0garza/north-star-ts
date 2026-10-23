import { readFile, realpath, stat } from "fs/promises"
import { basename, dirname, extname, join, relative } from "path"
import { resolveInWorkspaceReal } from "../agent/tools/workspace"

// Validation and resolution of a model-supplied Electron launch (plan 119
// Phase B). Everything here runs before approval and again right before spawn,
// so the approved descriptor is the one that executes.

export type Isolation =
  // North Star's own --test-profile contract: userData AND home redirected.
  | "north-star-test-profile"
  // Generic Electron: only userData via --user-data-dir. The app's own code
  // can still write to the real home directory.
  | "electron-user-data-dir"

export interface LaunchDescriptor {
  executable: string
  entry: string
  cwd: string
  args: string[]
  isolation: Isolation
  startupTimeoutMs: number
}

export class LaunchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string
  ) {
    super(message)
  }
}

export const MAX_ARGS = 32
export const MAX_ARG_CHARS = 1024
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000

// Flags the host owns (transport, profile) or that weaken the target's
// security model. Matched on the flag name, with or without a value.
const RESERVED_FLAG =
  /^--?(remote-debugging|inspect|debug|user-data-dir|test-profile|no-sandbox|disable-web-security|disable-site-isolation|allow-running-insecure-content|js-flags|remote-allow-origins|load-extension|ignore-certificate-errors|enable-logging|no-zygote|single-process)(=|$|-)/i

const PACKAGED = /\.(app|exe|appimage|dmg|asar)$/i
const SCRIPT = /\.(c|m)?js$/i

export function validateArgs(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((a) => typeof a !== "string"))
    throw new LaunchError("bad_args", "`args` must be an array of strings.")
  if (value.length > MAX_ARGS)
    throw new LaunchError("bad_args", `At most ${MAX_ARGS} args are allowed.`)
  for (const arg of value as string[]) {
    if (arg.length > MAX_ARG_CHARS || arg.includes("\0"))
      throw new LaunchError("bad_args", "An argument is too long or has NUL.")
    if (RESERVED_FLAG.test(arg))
      throw new LaunchError(
        "unsafe_flag",
        `The flag "${arg.split("=")[0]}" is reserved by the host or weakens the app's security model.`
      )
  }
  return value as string[]
}

export function validateStartupTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_STARTUP_TIMEOUT_MS
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1_000 ||
    value > 120_000
  )
    throw new LaunchError(
      "bad_args",
      "`startup_timeout_ms` must be an integer from 1000 to 120000."
    )
  return value
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false
  )
}

// The workspace's own development Electron: node_modules/electron nearest the
// app entry, searched up to the workspace root. path.txt is read as data —
// the package's index.js is never executed in the host.
async function resolveElectronExecutable(
  workspace: string,
  appDir: string
): Promise<string> {
  for (let dir = appDir; ; dir = dirname(dir)) {
    const pkg = join(dir, "node_modules", "electron")
    const pathTxt = await readFile(join(pkg, "path.txt"), "utf8").catch(
      () => null
    )
    if (pathTxt !== null) {
      const executable = join(pkg, "dist", pathTxt.trim())
      try {
        return await realpath(executable)
      } catch {
        throw new LaunchError(
          "electron_missing",
          `The workspace Electron package has no binary at ${relative(workspace, executable)}.`,
          "Reinstall dependencies (a separate, approved command)."
        )
      }
    }
    if (dir === workspace || dirname(dir) === dir) break
  }
  throw new LaunchError(
    "electron_missing",
    "No development Electron runtime (node_modules/electron) was found for this app in the workspace.",
    "Install the workspace's dependencies first (a separate, approved command). Bundled/packaged apps are not supported."
  )
}

export async function resolveLaunch(
  workspace: string,
  input: {
    entry?: unknown
    args?: unknown
    cwd?: unknown
    startup_timeout_ms?: unknown
  },
  hostPackageName: string | null
): Promise<LaunchDescriptor> {
  if (typeof input.entry !== "string" || !input.entry.trim())
    throw new LaunchError(
      "bad_args",
      "`entry` is required: the app directory (with package.json) or its main script, relative to the workspace."
    )
  if (PACKAGED.test(input.entry.trim().replace(/[/\\]+$/, "")))
    throw new LaunchError(
      "unsupported_packaged",
      "Bundled/packaged Electron apps are not supported; launch a development app entry from the workspace."
    )
  const args = validateArgs(input.args)
  const startupTimeoutMs = validateStartupTimeout(input.startup_timeout_ms)
  if (input.cwd !== undefined && typeof input.cwd !== "string")
    throw new LaunchError("bad_args", "`cwd` must be a string.")

  const realWorkspace = await realpath(workspace)
  let entry: string
  let cwd: string
  try {
    entry = await realpath(
      await resolveInWorkspaceReal(workspace, input.entry.trim())
    )
    cwd = await realpath(
      await resolveInWorkspaceReal(workspace, (input.cwd as string) ?? ".")
    )
  } catch (error) {
    throw new LaunchError(
      "bad_path",
      error instanceof Error ? error.message : String(error)
    )
  }
  if (!(await isDirectory(cwd)))
    throw new LaunchError("bad_path", "`cwd` is not a directory.")

  const entryIsDir = await isDirectory(entry)
  const appDir = entryIsDir ? entry : dirname(entry)
  let packageName: string | null = null
  if (entryIsDir) {
    const raw = await readFile(join(entry, "package.json"), "utf8").catch(
      () => null
    )
    if (raw === null)
      throw new LaunchError(
        "bad_entry",
        `${basename(entry)} has no package.json; pass the app directory or its main script.`
      )
    let pkg: { name?: unknown; main?: unknown }
    try {
      pkg = JSON.parse(raw)
    } catch {
      throw new LaunchError("bad_entry", "The app's package.json is not JSON.")
    }
    packageName = typeof pkg.name === "string" ? pkg.name : null
    const main = typeof pkg.main === "string" ? pkg.main : "index.js"
    const mainExists = await stat(join(entry, main)).then(
      (s) => s.isFile(),
      () => false
    )
    if (!mainExists)
      throw new LaunchError(
        "missing_build",
        `The app's main script ${main} does not exist.`,
        "Build the app first (a separate, approved command such as the project's build script)."
      )
  } else if (!SCRIPT.test(extname(entry))) {
    throw new LaunchError(
      "bad_entry",
      "`entry` must be an app directory or a .js/.cjs/.mjs main script."
    )
  }

  return {
    executable: await resolveElectronExecutable(realWorkspace, appDir),
    entry,
    cwd,
    args,
    isolation:
      hostPackageName && packageName === hostPackageName
        ? "north-star-test-profile"
        : "electron-user-data-dir",
    startupTimeoutMs,
  }
}

// Approval identity: binds every input that changes what executes.
export function launchIdentity(d: LaunchDescriptor): string {
  return `electron_launch:${JSON.stringify([d.executable, d.entry, d.cwd, d.args, d.isolation])}`
}

import { lstat, readdir, realpath } from "fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "path"
import type { ToolContext } from "./types"

export interface SkillResourceRoot {
  name: string
  root: string
}

export function isSkillResourceUri(path: string): boolean {
  return path.startsWith("skill://")
}

export function registerSkillResourceRoot(
  ctx: ToolContext,
  root: SkillResourceRoot
): void {
  ctx.skillResourceRoots ??= {}
  registerSkillResourceRootInMap(ctx.skillResourceRoots, root)
}

export function registerSkillResourceRootInMap(
  roots: Record<string, string>,
  root: SkillResourceRoot
): void {
  roots[root.name] = root.root
}

export async function resolveSkillResourcePath(
  ctx: ToolContext,
  uri: string
): Promise<string> {
  const parsed = parseSkillResourceUri(uri)
  const root = ctx.skillResourceRoots?.[parsed.name]
  if (!root) {
    throw new Error(
      `Unknown or inactive skill resource root: ${parsed.name}. Call read_skill for that skill before using ${uri}.`
    )
  }

  const lexicalTarget = resolve(root, parsed.relativePath || ".")
  if (!isInside(root, lexicalTarget)) {
    throw new Error("Skill resource path is outside the skill root.")
  }

  await assertExactPath(root, parsed.relativePath)
  const realRoot = await realpath(root)
  const realTarget = await realpath(lexicalTarget)
  if (!isInside(realRoot, realTarget)) {
    throw new Error(
      "Skill resource path resolves through a symlink outside the skill root."
    )
  }

  const stat = await lstat(realTarget)
  if (stat.isSymbolicLink()) {
    throw new Error("Skill resource path resolves through a symlink.")
  }
  return realTarget
}

export interface CommandSkillResource {
  uri: string
  path: string
}

const SKILL_URI_PREFIX = "skill://"
// What ends a skill:// token depends on the quoting context it sits in.
const TOKEN_END = {
  none: /[\s;&|<>()'"`$\\]/,
  '"': /[\s"`$\\]/,
  "'": /[\s']/,
} as const

// Rewrites every skill://name/path token in a shell command to the resolved
// real path, quoted for the context it appears in. Each token goes through
// resolveSkillResourcePath, so the command inherits the same activation,
// traversal, exact-case, and symlink checks as read_file. Throws on any token
// that fails them; the caller must not run the command in that case.
export async function resolveSkillResourcesInCommand(
  ctx: ToolContext,
  command: string,
  platform: NodeJS.Platform = process.platform
): Promise<{ command: string; resources: CommandSkillResource[] }> {
  if (!command.includes(SKILL_URI_PREFIX)) return { command, resources: [] }
  const windows = platform === "win32"
  const resources: CommandSkillResource[] = []
  let out = ""
  let quote: "'" | '"' | null = null
  let i = 0
  while (i < command.length) {
    if (
      command.startsWith(SKILL_URI_PREFIX, i) &&
      !/[A-Za-z0-9+.-]/.test(command[i - 1] ?? "")
    ) {
      const endPattern = TOKEN_END[quote ?? "none"]
      let end = i + SKILL_URI_PREFIX.length
      while (end < command.length && !endPattern.test(command[end])) end += 1
      const uri = command.slice(i, end)
      const path = await resolveSkillResourcePath(ctx, uri)
      resources.push({ uri, path })
      out += quotePathForShell(path, quote, windows)
      i = end
      continue
    }
    const ch = command[i]
    if (ch === "\\" && quote !== "'" && !windows) {
      out += command.slice(i, i + 2)
      i += 2
      continue
    }
    if (quote === null && (ch === '"' || (ch === "'" && !windows))) quote = ch
    else if (ch === quote) quote = null
    out += ch
    i += 1
  }
  return { command: out, resources }
}

function quotePathForShell(
  path: string,
  quote: "'" | '"' | null,
  windows: boolean
): string {
  // Control characters and backticks quote differently across sh, zsh, fish,
  // and cmd.exe; refusing is safer than guessing which one runs the command.
  if (/[\x00-\x1f`]/.test(path)) {
    throw new Error(
      "Skill resource path contains characters that cannot be quoted safely for the shell."
    )
  }
  if (windows) {
    if (/["%]/.test(path)) {
      throw new Error(
        "Skill resource path contains characters that cannot be quoted safely for cmd.exe."
      )
    }
    return quote === '"' ? path : `"${path}"`
  }
  if (quote === '"') return path.replace(/["$\\]/g, "\\$&")
  const singleQuoted = path.replace(/'/g, `'\\''`)
  return quote === "'" ? singleQuoted : `'${singleQuoted}'`
}

// Every activated skill root, both as registered and as its real path, so a
// write guard matches whichever spelling a command uses.
export async function activeSkillResourceRootPaths(
  ctx: ToolContext
): Promise<string[]> {
  const roots = new Set<string>()
  for (const root of Object.values(ctx.skillResourceRoots ?? {})) {
    roots.add(resolve(root))
    try {
      roots.add(await realpath(root))
    } catch {
      // A missing root has nothing to protect.
    }
  }
  return [...roots]
}

function parseSkillResourceUri(uri: string): {
  name: string
  relativePath: string
} {
  if (uri.includes("\0")) throw new Error("Skill resource URI contains NUL.")

  const match = /^skill:\/\/([^/?#]+)(?:\/([^?#]*))?$/.exec(uri)
  if (!match) throw new Error("Invalid skill resource URI.")

  const name = match[1]
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name)) {
    throw new Error(`Invalid skill name in resource URI: ${name}`)
  }

  let relativePath: string
  try {
    relativePath = decodeURIComponent(match[2] ?? "")
  } catch {
    throw new Error("Invalid skill resource URI.")
  }
  if (relativePath.includes("\0")) {
    throw new Error("Skill resource URI contains NUL.")
  }
  if (relativePath && isAbsolute(relativePath)) {
    throw new Error(`Absolute skill resource paths are not allowed: ${uri}`)
  }
  const segments = relativePath.split(/[\\/]+/).filter(Boolean)
  if (segments.includes("..")) {
    throw new Error(
      `Parent traversal is not allowed in skill resources: ${uri}`
    )
  }

  return { name, relativePath: segments.join("/") }
}

async function assertExactPath(
  root: string,
  relativePath: string
): Promise<void> {
  if (!relativePath) return
  let current = root
  for (const segment of relativePath.split("/")) {
    const names = await readdir(current)
    if (!names.includes(segment)) {
      throw Object.assign(new Error(`ENOENT: ${segment}`), { code: "ENOENT" })
    }
    current = join(current, segment)
    const stat = await lstat(current)
    if (stat.isSymbolicLink()) {
      throw new Error("Skill resource path resolves through a symlink.")
    }
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  )
}

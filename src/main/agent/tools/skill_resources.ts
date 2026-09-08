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

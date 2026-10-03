import { basename, dirname, isAbsolute, join, relative, sep } from "path"
import type { Environment } from "../env/types"
import { toolError } from "./output"
import type { ToolContext } from "./types"

// A turn's write scope (plan 109.01): the workspace-relative directories the
// write-family tools may change. Absent means the whole workspace, as before.
// Set server-side from the seat's role (a Mission Control `qa` seat gets its
// checks directory and the run's scratch directory), never from
// model arguments.
export interface WriteScope {
  allow: string[]
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  )
}

// The real path a write to `path` would change. `followLeaf: false` is for
// tools that act on the entry itself (move, delete): a symlink there is moved
// or removed, not followed, so only its parent is resolved.
async function realTarget(
  env: Environment,
  path: string,
  followLeaf: boolean
): Promise<string> {
  if (followLeaf) return env.resolve(path)
  const lexical = env.resolveLexical(path)
  const root = env.resolveLexical(".")
  if (lexical === root) return env.resolve(".")
  const parent = relative(root, dirname(lexical)) || "."
  return join(await env.resolve(parent), basename(lexical))
}

// Null when every path may be written under ctx.writeScope; otherwise the
// `out_of_scope` tool error naming the allowed directories, so the model can
// recover. Compares real paths: `..` and symlinks out of an allowed directory
// are refused, and so is an allowed directory that is itself a symlink (its
// real location is somewhere the scope never named).
export async function writeScopeError(
  ctx: ToolContext,
  env: Environment,
  paths: string[],
  opts: { followLeaf?: boolean } = {}
): Promise<string | null> {
  const scope = ctx.writeScope
  if (!scope) return null
  const allowedList = scope.allow.map((dir) => `${dir}/`).join(", ")
  const refuse = (path: string) =>
    toolError(
      "out_of_scope",
      `This seat may only write inside ${allowedList || "no directories"}; "${path}" is outside them.`,
      "write checks and notes inside the allowed directories, and report problems in product code as findings instead of changing it"
    )

  const realRoot = await env.resolve(".")
  const allowed: string[] = []
  for (const dir of scope.allow) {
    try {
      const real = await env.resolve(dir)
      if (real === join(realRoot, dir)) allowed.push(real)
    } catch {
      // An allowed directory that can't be resolved grants nothing.
    }
  }
  for (const path of paths) {
    let target: string
    try {
      target = await realTarget(env, path, opts.followLeaf ?? true)
    } catch {
      return refuse(path)
    }
    if (!allowed.some((dir) => isInside(dir, target))) return refuse(path)
  }
  return null
}

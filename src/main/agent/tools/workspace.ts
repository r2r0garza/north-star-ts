import { resolve, relative, isAbsolute, dirname } from "path"
import { realpath } from "fs/promises"

// Resolve a model-supplied path against the workspace root and guarantee the
// result stays inside it. Throws on any attempt to escape (`..`, absolute
// paths, symlink-style traversal via `..`). Returns the safe absolute path.
//
// This is a LEXICAL check only: it catches `..` and absolute paths but cannot
// detect a symlink inside the workspace that points outside it. Use
// `resolveInWorkspaceReal` for any tool that opens the resulting path.
export function resolveInWorkspace(workspace: string, path: string): string {
  const target = resolve(workspace, path || ".")
  const rel = relative(workspace, target)
  const escapes = rel.startsWith("..") || isAbsolute(rel)
  if (escapes) {
    throw new Error(
      `Path "${path}" is outside the workspace and is not allowed.`
    )
  }
  return target
}

// Returns true when `child` is the same as, or nested inside, `parent` —
// purely lexical (both must already be absolute, normalized paths).
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

// Like `resolveInWorkspace`, but additionally follows symlinks via realpath to
// guarantee the *real* target stays inside the *real* workspace root — closing
// the symlink-escape hole the lexical check can't see. For paths that don't
// exist yet (creating a new file), it validates the nearest existing ancestor
// instead, so writes/edits to new files still work. Returns the lexically safe
// absolute path (NOT the realpath) so callers operate on the in-workspace path.
export async function resolveInWorkspaceReal(
  workspace: string,
  path: string
): Promise<string> {
  // Lexical guard first (cheap, rejects the obvious `..`/absolute cases).
  const target = resolveInWorkspace(workspace, path)

  // Resolve the workspace root once; if the root itself can't be resolved we
  // can't make any safety guarantee, so fail closed.
  const realRoot = await realpath(workspace)

  // Walk up from the target to the nearest ancestor that actually exists, then
  // realpath that. A not-yet-created file is fine as long as its real parent is
  // inside the workspace.
  let probe = target
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const real = await realpath(probe)
      if (!isInside(realRoot, real)) {
        throw new Error(
          `Path "${path}" resolves (via symlink) outside the workspace and is not allowed.`
        )
      }
      return target
    } catch (err) {
      // Re-throw our own escape error; ENOENT means this ancestor doesn't exist
      // yet, so step up to its parent and try again.
      if (err instanceof Error && err.message.includes("outside the workspace")) {
        throw err
      }
      const parent = dirname(probe)
      if (parent === probe) {
        // Reached the filesystem root without finding an existing ancestor.
        throw new Error(
          `Path "${path}" could not be validated against the workspace.`
        )
      }
      probe = parent
    }
  }
}

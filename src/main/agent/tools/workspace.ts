import { resolve, relative, isAbsolute } from "path"

// Resolve a model-supplied path against the workspace root and guarantee the
// result stays inside it. Throws on any attempt to escape (`..`, absolute
// paths, symlink-style traversal via `..`). Returns the safe absolute path.
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

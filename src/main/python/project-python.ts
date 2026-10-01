import { readdir } from "fs/promises"
import { join } from "path"

// Whether a workspace manages its own Python environment. Interactive chat
// turns put the app's shared venv first on PATH (see chat-venv.ts); a project
// with its own environment must keep it, or `pip install -r requirements.txt`
// would land in the app's venv instead of the project's.
//
// The environment can live anywhere in the tree (backend/.venv, services/api/env,
// .tox/py312), so this looks for the file every venv has at its root rather than
// guessing folder names. Poetry and Pipenv keep their venvs outside the project
// by default, so their manifests count too; uv's lockfile is included so a uv
// project that hasn't synced its .venv yet is still recognized.
const MARKER_FILES = new Set([
  "pyvenv.cfg",
  "poetry.lock",
  "Pipfile",
  "uv.lock",
])

// Heavy or irrelevant trees. Deliberately not walk.ts's DEFAULT_SKIP_DIRS: that
// list prunes .venv, which is exactly what this scan has to see.
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "build",
  ".next",
  ".cache",
  "__pycache__",
  "target",
  "vendor",
])

// Root is depth 0, so the default reaches root/a/b/c — enough for
// monorepo/backend/.venv and services/api/.venv without crawling a large tree.
const DEFAULT_MAX_DEPTH = 3
// A hard stop on directories read, so a very wide workspace can't stall a turn.
const DEFAULT_MAX_DIRS = 2000

export interface ProjectPythonScanOptions {
  maxDepth?: number
  maxDirs?: number
}

// Breadth-first so shallow markers are found before the directory budget runs
// out. Symlinks are not followed (Dirent.isDirectory() is false for them).
// Unreadable directories are skipped; a failure never throws.
export async function workspaceManagesPython(
  root: string,
  opts: ProjectPythonScanOptions = {}
): Promise<boolean> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxDirs = opts.maxDirs ?? DEFAULT_MAX_DIRS
  let queue: string[] = [root]
  let visited = 0
  for (let depth = 0; depth <= maxDepth && queue.length > 0; depth++) {
    const next: string[] = []
    for (const dir of queue) {
      if (visited++ >= maxDirs) return false
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.isFile() && MARKER_FILES.has(entry.name)) return true
        if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
          next.push(join(dir, entry.name))
        }
      }
    }
    queue = next
  }
  return false
}

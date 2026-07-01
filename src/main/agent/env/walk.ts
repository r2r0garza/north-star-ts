import { readFile, readdir, stat } from "fs/promises"
import { join, relative, sep, extname } from "path"
import ignore, { type Ignore } from "ignore"
import type { DirEntry } from "./types"

// Directories always pruned from a walk regardless of .gitignore — heavy, noisy,
// or VCS internals that no consumer wants indexed or searched. Mirrors the
// skipDirs convention the search tool already passed in.
export const DEFAULT_SKIP_DIRS = [
  ".git",
  "node_modules",
  "dist",
  "out",
  "build",
  ".next",
  ".venv",
  ".cache",
]

// Lockfiles: kept in the file map (they exist) but flagged so deeper stages
// (symbol extraction, later embeddings) can skip their huge machine-generated
// bodies.
const LOCKFILES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock"])

// A file's cheap, stat-only metadata. The walk deliberately does NOT read file
// content — the indexer's incremental fast-path compares (size, mtime) and only
// reads/hashes files that actually changed, so reading every body during the
// walk would defeat cheap re-runs. Consumers that need content read it via the
// `path` themselves (search, hashing, extraction).
export interface WalkedFile {
  // Absolute path on the host.
  path: string
  // Path relative to the walk root, POSIX-normalized (forward slashes).
  relPath: string
  size: number
  mtime: number
  // A known dependency lockfile (indexed but excluded from deep stages).
  isLockfile: boolean
  ext: string
}

export interface WalkOptions {
  root: string
  // Directory basenames to prune. Defaults to DEFAULT_SKIP_DIRS.
  skipDirs?: string[]
  // Files larger than this are skipped entirely.
  maxFileBytes: number
  // A prepared .gitignore matcher (see loadGitignore). When present, a path it
  // matches (relative, POSIX) is pruned.
  gitignore?: Ignore
  // Cooperative cancellation: checked between entries so a paused/cancelled index
  // stops promptly.
  signal?: AbortSignal
}

// Whether a just-read buffer looks binary: a NUL byte in the first 8KB. Shared so
// search and (later) symbol extraction classify text/binary identically.
export function isBinaryBuffer(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0)
}

// POSIX-normalize a relative path so gitignore matching and stored paths are
// stable across platforms (the `ignore` package expects forward slashes).
function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/")
}

// Build an Ignore matcher from a workspace's root .gitignore. Returns undefined
// if there's no .gitignore (nothing to match). Nested .gitignore files are not
// merged in v1 — the root file covers the common case; deeper support is additive.
export async function loadGitignore(root: string): Promise<Ignore | undefined> {
  try {
    const content = await readFile(join(root, ".gitignore"), "utf8")
    return ignore().add(content)
  } catch {
    return undefined
  }
}

// Recursively yield every file under `root` (stat-only), pruning skipDirs and
// gitignored paths and oversized files. Shared by the search tool and the
// workspace indexer so both honor the same ignore rules. Unreadable dirs/files
// are skipped rather than aborting the whole walk.
export async function* walkFiles(opts: WalkOptions): AsyncGenerator<WalkedFile> {
  const skip = new Set(opts.skipDirs ?? DEFAULT_SKIP_DIRS)
  const ig = opts.gitignore

  async function* walk(dir: string): AsyncGenerator<WalkedFile> {
    if (opts.signal?.aborted) return
    let entries: DirEntry[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (opts.signal?.aborted) return
      const full = join(dir, entry.name)
      const rel = toPosix(relative(opts.root, full))
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue
        // `ignore` matches directory rules when the path ends with a slash.
        if (ig && rel && ig.ignores(`${rel}/`)) continue
        yield* walk(full)
        continue
      }
      if (!entry.isFile()) continue
      if (ig && rel && ig.ignores(rel)) continue
      try {
        const info = await stat(full)
        if (info.size > opts.maxFileBytes) continue
        yield {
          path: full,
          relPath: rel,
          size: info.size,
          mtime: Math.floor(info.mtimeMs),
          isLockfile: LOCKFILES.has(entry.name),
          ext: extname(entry.name),
        }
      } catch {
        // Unreadable file — skip.
      }
    }
  }

  yield* walk(opts.root)
}

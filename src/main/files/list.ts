import { walkFiles, loadGitignore } from "../agent/env/walk"

// Backs the composer's `@`-mention file picker. Walks the workspace with the
// shared gitignore-aware walker (same ignore rules as search/indexing), caches
// the workspace-relative path list per root for a short TTL, and filters that
// cached list server-side per keystroke. This keeps the picker responsive on
// large repos (one walk per open, then cheap in-memory filtering) and works
// regardless of whether the workspace has been indexed.

// Cap results returned to the renderer — a typeahead only needs a screenful,
// and it bounds the IPC payload.
const RESULT_LIMIT = 50
// How long a walked path list stays fresh. Short enough that new files appear
// on the next `@` after a beat; long enough that consecutive keystrokes reuse
// one walk. Time is passed in (Date.now is not called at module scope) so the
// cache is testable and deterministic.
const CACHE_TTL_MS = 15_000
// No size ceiling for mentions — the user may reference any file. (The indexer
// caps at 2 MB, but that's a content concern; here we only need the path.)
const MAX_FILE_BYTES = Number.POSITIVE_INFINITY

type CacheEntry = { paths: string[]; at: number }
const cache = new Map<string, CacheEntry>()

// Walk `root`, returning workspace-relative POSIX paths sorted by path. Cached
// per root for CACHE_TTL_MS. `now` is injected for testability.
async function workspacePaths(root: string, now: number): Promise<string[]> {
  const hit = cache.get(root)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.paths
  const gitignore = await loadGitignore(root)
  const paths: string[] = []
  for await (const file of walkFiles({
    root,
    gitignore,
    maxFileBytes: MAX_FILE_BYTES,
  })) {
    paths.push(file.relPath)
  }
  paths.sort()
  cache.set(root, { paths, at: now })
  return paths
}

// The last path segment (basename) of a POSIX relative path.
function basename(p: string): string {
  const i = p.lastIndexOf("/")
  return i === -1 ? p : p.slice(i + 1)
}

// Rank a path against a lowercased query. Higher is better; 0 means no match.
// Basename matches beat full-path matches, and a prefix beats a mid-string hit,
// so typing "foo" surfaces `foo.ts` above `src/unfoo/bar.ts`.
function score(path: string, query: string): number {
  const lowerPath = path.toLowerCase()
  const base = basename(lowerPath)
  if (query === "") return 1
  if (base === query) return 100
  if (base.startsWith(query)) return 80
  if (base.includes(query)) return 60
  if (lowerPath.startsWith(query)) return 40
  if (lowerPath.includes(query)) return 20
  return 0
}

// Filter+rank the workspace file list for a typeahead query. Empty query
// returns the first RESULT_LIMIT paths (sorted). Returns workspace-relative
// POSIX paths, capped at RESULT_LIMIT.
export async function listWorkspaceFiles(
  root: string,
  query: string,
  now: number
): Promise<string[]> {
  const paths = await workspacePaths(root, now)
  const q = query.trim().toLowerCase()
  if (q === "") return paths.slice(0, RESULT_LIMIT)
  return (
    paths
      .map((path) => ({ path, s: score(path, q) }))
      .filter((r) => r.s > 0)
      // Ties broken by shorter path first (closer to root reads as more relevant),
      // then lexicographically for stable ordering.
      .sort(
        (a, b) =>
          b.s - a.s ||
          a.path.length - b.path.length ||
          (a.path < b.path ? -1 : 1)
      )
      .slice(0, RESULT_LIMIT)
      .map((r) => r.path)
  )
}

import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { watch, type FSWatcher } from "chokidar"

export type WorkspaceFilesChangedEvent = {
  workspace: string
  paths: string[]
  overflow?: boolean
}

export type WorkspaceFileWatch = {
  updateDirectories: (directories: string[]) => Promise<void>
  close: () => Promise<void>
}

const DEFAULT_DEBOUNCE_MS = 150
const MAX_WATCHED_DIRECTORIES = 256
const GIT_DIRECTORY = /(^|[/\\])\.git([/\\]|$)/

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/")
}

export function workspaceRelativePath(
  workspace: string,
  changedPath: string
): string | null {
  const rel = relative(workspace, changedPath)
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    return null
  }
  return toPosix(rel)
}

function watchedDirectoryPaths(
  root: string,
  directories: string[]
): Set<string> {
  const paths = new Set<string>([root])
  for (const directory of directories) {
    if (paths.size >= MAX_WATCHED_DIRECTORIES) break
    const path = resolve(root, directory || ".")
    const rel = relative(root, path)
    if (
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel) ||
      GIT_DIRECTORY.test(rel)
    ) {
      continue
    }
    paths.add(path)
  }
  return paths
}

export async function watchWorkspaceFiles(
  workspace: string,
  onChange: (event: WorkspaceFilesChangedEvent) => void,
  debounceMs = DEFAULT_DEBOUNCE_MS
): Promise<WorkspaceFileWatch> {
  const root = await realpath(workspace)
  const pending = new Set<string>()
  let watched = new Set<string>([root])
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const flush = () => {
    timer = null
    if (closed || pending.size === 0) return
    const paths = [...pending].sort()
    pending.clear()
    onChange({ workspace, paths })
  }
  const queue = (path: string) => {
    const relPath = workspaceRelativePath(root, path)
    if (!relPath || GIT_DIRECTORY.test(relPath)) return
    pending.add(relPath)
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, debounceMs)
  }

  const watcher: FSWatcher = watch(root, {
    depth: 0,
    ignoreInitial: true,
    atomic: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 20,
    },
    ignored: (path) => GIT_DIRECTORY.test(relative(root, path)),
  })
  watcher.on("add", queue)
  watcher.on("addDir", queue)
  watcher.on("change", queue)
  watcher.on("unlink", queue)
  watcher.on("unlinkDir", queue)
  watcher.on("error", () => {
    if (!closed) onChange({ workspace, paths: [], overflow: true })
  })

  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      watcher.once("ready", resolveReady)
      watcher.once("error", rejectReady)
    })
  } catch (error) {
    closed = true
    await watcher.close()
    throw error
  }

  return {
    updateDirectories: async (directories) => {
      if (closed) return
      const next = watchedDirectoryPaths(root, directories)
      const removed = [...watched].filter((path) => !next.has(path))
      const added = [...next].filter((path) => !watched.has(path))
      watched = next
      if (removed.length) await watcher.unwatch(removed)
      if (added.length) watcher.add(added)
    },
    close: async () => {
      closed = true
      if (timer) clearTimeout(timer)
      pending.clear()
      await watcher.close()
    },
  }
}

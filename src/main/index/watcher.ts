import { execFile } from "node:child_process"
import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { watch, type FSWatcher } from "chokidar"
import { DEFAULT_SKIP_DIRS, loadGitignore } from "../agent/env/walk"
import {
  getRunByWorkspace,
  listEnabledRuns,
} from "../db/repositories/index-runs"
import { getTask } from "../db/repositories/tasks"
import { getWorkspace } from "../db/repositories/workspaces"
import type { TaskStatus } from "../db/types"
import type { TaskRunner } from "../tasks/runner"
import type { IndexService } from "./service"

const execFileAsync = promisify(execFile)
const FILE_DEBOUNCE_MS = 750
const GIT_DEBOUNCE_MS = 100
const GIT_TIMEOUT_MS = 3_000
const LIVE_STATUSES = new Set<TaskStatus>([
  "queued",
  "running",
  "waiting_for_approval",
])
const RESUMABLE_STATUSES = new Set<TaskStatus>(["paused", "interrupted"])

type WorkspaceWatchState = {
  workspaceId: string
  root: string
  fileWatcher: FSWatcher | null
  gitWatcher: FSWatcher | null
  fileTimer: ReturnType<typeof setTimeout> | null
  gitTimer: ReturnType<typeof setTimeout> | null
  pendingIndex: boolean
  metadataRefresh: Promise<void>
  reloadIgnore: boolean
  closed: boolean
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/")
}

function relativePath(root: string, path: string): string | null {
  const rel = relative(root, path)
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

function isSkippedPath(path: string): boolean {
  return path.split("/").some((part) => DEFAULT_SKIP_DIRS.includes(part))
}

async function resolveGitWatchPaths(root: string): Promise<string[]> {
  const git = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: root,
        timeout: GIT_TIMEOUT_MS,
      })
      const value = stdout.trim()
      return value ? (isAbsolute(value) ? value : resolve(root, value)) : null
    } catch {
      return null
    }
  }

  const head = await git([
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "HEAD",
  ])
  if (!head) return []
  const packedRefs = await git([
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "packed-refs",
  ])
  let refPath: string | null = null
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["symbolic-ref", "--quiet", "HEAD"],
      { cwd: root, timeout: GIT_TIMEOUT_MS }
    )
    const ref = stdout.trim()
    if (ref) {
      refPath = await git([
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        ref,
      ])
    }
  } catch {
    // Detached HEAD has no current loose ref to watch.
  }
  return [
    ...new Set(
      [head, packedRefs, refPath].filter((path): path is string => !!path)
    ),
  ]
}

export class IndexWatcher {
  private readonly watches = new Map<string, WorkspaceWatchState>()
  private readonly starting = new Map<string, Promise<void>>()
  private enabled = true
  private readonly unsubscribeRunner: () => void

  constructor(
    private readonly runner: TaskRunner,
    private readonly indexService: IndexService
  ) {
    this.unsubscribeRunner = runner.subscribe((taskId, event) => {
      if (event.type !== "status_change") return
      this.onTaskStatus(taskId, event.to)
    })
  }

  async reconcile(): Promise<void> {
    if (!this.enabled) return
    const enabledIds = new Set(listEnabledRuns().map((run) => run.workspaceId))
    await Promise.all(
      [...this.watches.keys()]
        .filter((workspaceId) => !enabledIds.has(workspaceId))
        .map((workspaceId) => this.stop(workspaceId))
    )
    await Promise.all(
      [...enabledIds].map((workspaceId) => this.start(workspaceId))
    )
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled
    if (enabled) await this.reconcile()
    else {
      await Promise.all(this.starting.values())
      await this.closeWatches()
    }
  }

  start(workspaceId: string): Promise<void> {
    if (!this.enabled || this.watches.has(workspaceId)) return Promise.resolve()
    const existing = this.starting.get(workspaceId)
    if (existing) return existing
    const opening = this.open(workspaceId).finally(() => {
      if (this.starting.get(workspaceId) === opening) {
        this.starting.delete(workspaceId)
      }
    })
    this.starting.set(workspaceId, opening)
    return opening
  }

  private async open(workspaceId: string): Promise<void> {
    if (!this.enabled || this.watches.has(workspaceId)) return
    const run = getRunByWorkspace(workspaceId)
    const workspace = getWorkspace(workspaceId)
    if (!run?.enabled || !workspace) return

    try {
      const root = await realpath(workspace.path)
      const gitignore = await loadGitignore(root)
      const state: WorkspaceWatchState = {
        workspaceId,
        root,
        fileWatcher: null,
        gitWatcher: null,
        fileTimer: null,
        gitTimer: null,
        pendingIndex: false,
        metadataRefresh: Promise.resolve(),
        reloadIgnore: false,
        closed: false,
      }
      const ignored = (path: string) => {
        const rel = relativePath(root, path)
        if (!rel) return false
        if (rel === ".gitignore") return false
        if (isSkippedPath(rel)) return true
        return gitignore?.ignores(rel) || gitignore?.ignores(`${rel}/`) || false
      }
      if (!this.enabled) return
      state.fileWatcher = watch(root, {
        ignoreInitial: true,
        atomic: true,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
        ignored,
      })
      const queueFile = (path: string) => {
        if (state.closed) return
        const rel = relativePath(root, path)
        if (!rel || ignored(path)) return
        if (rel === ".gitignore") state.reloadIgnore = true
        if (state.fileTimer) clearTimeout(state.fileTimer)
        state.fileTimer = setTimeout(() => {
          state.fileTimer = null
          const reloadIgnore = state.reloadIgnore
          state.reloadIgnore = false
          this.requestIndex(state)
          if (reloadIgnore) void this.restart(workspaceId)
        }, FILE_DEBOUNCE_MS)
      }
      state.fileWatcher.on("add", queueFile)
      state.fileWatcher.on("addDir", queueFile)
      state.fileWatcher.on("change", queueFile)
      state.fileWatcher.on("unlink", queueFile)
      state.fileWatcher.on("unlinkDir", queueFile)
      state.fileWatcher.on("error", (error) =>
        console.warn(
          `[index-watcher] workspace watch failed for ${root}:`,
          error
        )
      )
      this.watches.set(workspaceId, state)
      await this.replaceGitWatcher(state)
    } catch (error) {
      console.warn(
        `[index-watcher] could not watch workspace ${workspace.path}:`,
        error
      )
    }
  }

  async stop(workspaceId: string): Promise<void> {
    await this.starting.get(workspaceId)
    const state = this.watches.get(workspaceId)
    if (!state) return
    this.watches.delete(workspaceId)
    state.closed = true
    if (state.fileTimer) clearTimeout(state.fileTimer)
    if (state.gitTimer) clearTimeout(state.gitTimer)
    await Promise.all([state.fileWatcher?.close(), state.gitWatcher?.close()])
  }

  async stopAll(): Promise<void> {
    this.enabled = false
    this.unsubscribeRunner()
    await Promise.all(this.starting.values())
    await this.closeWatches()
  }

  private async closeWatches(): Promise<void> {
    await Promise.all(
      [...this.watches.keys()].map((workspaceId) => this.stop(workspaceId))
    )
  }

  private async restart(workspaceId: string): Promise<void> {
    await this.stop(workspaceId)
    await this.start(workspaceId)
  }

  private requestIndex(state: WorkspaceWatchState): void {
    const run = getRunByWorkspace(state.workspaceId)
    if (!run?.enabled) {
      void this.stop(state.workspaceId)
      return
    }
    const task = run.taskId ? getTask(run.taskId) : undefined
    if (task && LIVE_STATUSES.has(task.status)) {
      state.pendingIndex = true
      return
    }
    if (task && RESUMABLE_STATUSES.has(task.status)) {
      state.pendingIndex = true
      return
    }
    state.pendingIndex = false
    this.indexService.ensureRunning(state.workspaceId, "low")
  }

  private onTaskStatus(taskId: string, status: TaskStatus): void {
    for (const state of this.watches.values()) {
      const run = getRunByWorkspace(state.workspaceId)
      if (run?.taskId !== taskId) continue
      if (status === "queued") {
        state.pendingIndex = false
      } else if (
        !LIVE_STATUSES.has(status) &&
        !RESUMABLE_STATUSES.has(status) &&
        state.pendingIndex
      ) {
        state.pendingIndex = false
        this.indexService.ensureRunning(state.workspaceId, "low")
      }
    }
  }

  private async replaceGitWatcher(state: WorkspaceWatchState): Promise<void> {
    await state.gitWatcher?.close()
    if (state.closed) return
    const paths = await resolveGitWatchPaths(state.root)
    if (paths.length === 0 || state.closed) {
      state.gitWatcher = null
      return
    }
    const watcher = watch(paths, { ignoreInitial: true, atomic: true })
    const queue = () => {
      if (state.closed) return
      if (state.gitTimer) clearTimeout(state.gitTimer)
      state.gitTimer = setTimeout(() => {
        state.gitTimer = null
        state.metadataRefresh = state.metadataRefresh
          .catch(() => undefined)
          .then(() => this.indexService.refreshMetadata(state.workspaceId))
          .catch((error) =>
            console.warn(
              `[index-watcher] git metadata refresh failed for ${state.root}:`,
              error
            )
          )
        void this.replaceGitWatcher(state)
      }, GIT_DEBOUNCE_MS)
    }
    watcher.on("add", queue)
    watcher.on("change", queue)
    watcher.on("unlink", queue)
    watcher.on("error", (error) =>
      console.warn(`[index-watcher] git watch failed for ${state.root}:`, error)
    )
    state.gitWatcher = watcher
  }
}

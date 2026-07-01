import { ipcMain } from "electron"
import type { TaskRunner } from "../tasks/runner"
import type { IndexService } from "../index/service"
import { getRunByWorkspace, setEnabled } from "../db/repositories/index-runs"
import { getTask } from "../db/repositories/tasks"
import { getIndexing } from "../settings/service"
import type { IndexPriority, TaskStatus } from "../db/types"

// Status the renderer paints for a workspace's index (initial/reattach snapshot).
// Live updates ride the existing `task:event` tail (index_progress events); this
// is the one-shot read the strip uses before any live event arrives.
export interface IndexStatus {
  enabled: boolean
  stage: string | null
  filesScanned: number
  filesTotal: number
  taskId: string | null
  taskStatus: TaskStatus | null
}

// The index-specific IPC channels (plan 008). Pause/resume/cancel reuse the
// `task:*` verbs — an index run IS a durable task — so these add only what's
// index-specific: clear, per-workspace enable/disable, and the status snapshot.
export function registerIndexHandlers(runner: TaskRunner, service: IndexService): void {
  // Manually (re)start indexing for a workspace — the UI "Start"/"Rebuild"
  // action. ensureRunning is idempotent: a no-op if a build is already live, else
  // it enqueues a fresh one. Covers restarting after cancel/clear/completion.
  ipcMain.handle(
    "index:start",
    (_e, payload: { workspaceId: string; priority?: IndexPriority }) => {
      const run = getRunByWorkspace(payload.workspaceId)
      service.ensureRunning(payload.workspaceId, payload.priority ?? run?.priority ?? "low")
    }
  )

  // Clear a workspace's index: cancel any live task, drop all rows, reset the run.
  ipcMain.handle("index:clear", (_e, workspaceId: string) => {
    const run = getRunByWorkspace(workspaceId)
    if (run?.taskId) runner.cancel(run.taskId)
    service.clear(workspaceId)
  })

  // Enable/disable indexing for one workspace. Disable cancels any live task;
  // enable kicks a fresh run at the given (or low) priority.
  ipcMain.handle(
    "index:setEnabled",
    (_e, payload: { workspaceId: string; enabled: boolean; priority?: IndexPriority }) => {
      setEnabled(payload.workspaceId, payload.enabled)
      const run = getRunByWorkspace(payload.workspaceId)
      if (!payload.enabled) {
        if (run?.taskId) runner.cancel(run.taskId)
        return
      }
      service.ensureRunning(payload.workspaceId, payload.priority ?? run?.priority ?? "low")
    }
  )

  // One-shot status snapshot for the strip's first paint / reattach.
  ipcMain.handle("index:status", (_e, workspaceId: string): IndexStatus => {
    const run = getRunByWorkspace(workspaceId)
    const task = run?.taskId ? getTask(run.taskId) : undefined
    return {
      enabled: run?.enabled ?? getIndexing().autoIndexNewWorkspaces,
      stage: run?.stage ?? null,
      filesScanned: run?.filesScanned ?? 0,
      filesTotal: run?.filesTotal ?? 0,
      taskId: run?.taskId ?? null,
      taskStatus: task?.status ?? null,
    }
  })
}

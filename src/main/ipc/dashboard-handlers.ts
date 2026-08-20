import { ipcMain } from "electron"
import type { TaskRunner } from "../tasks/runner"
import type { DashboardService } from "../dashboards/service"

// Dashboard-refresh IPC channels (plan 033.3). Pause/resume/cancel and live
// progress reuse the generic `task:*` verbs + the `tasks.onEvent` tail (a refresh
// IS a durable task), so these add only what's dashboard-specific: kicking off a
// deterministic refresh and blessing a recipe for unattended re-runs.
export function registerDashboardHandlers(
  _runner: TaskRunner,
  service: DashboardService
): void {
  // Re-fetch every widget's data by replaying its stored recipe (no LLM).
  // Idempotent: a no-op if a refresh for this dashboard is already in flight.
  // Returns the task id (or null when nothing was enqueued) so the renderer can
  // follow it on the task tail.
  ipcMain.handle(
    "dashboard:refresh",
    (_e, dashboardId: string, maxAgeMs?: number) => {
      const task = service.ensureRefresh(dashboardId, maxAgeMs ?? 0)
      return task ? task.id : null
    }
  )

  // Bless a widget's recipe so subsequent unattended refreshes are authorized:
  // writes a durable action_allowlist rule keyed by the reconstructed identity
  // (workspace-scoped for shell via its cwd, global for a web URL), then triggers
  // a refresh. Returns { ok, taskId } or { ok: false, reason } so the UI can
  // explain a recipe that can't be blessed (e.g. a command with no cwd).
  ipcMain.handle("dashboard:approveRecipe", (_e, widgetId: string) =>
    service.approveRecipe(widgetId)
  )
}

import { ipcMain } from "electron"
import type { WorkspaceAnalysisService } from "../mission-control/workspace-analysis"

// Workspace setup findings (plan 106.11). The renderer names findings by key
// and selections by id; it never sends a command, path, or settings patch.
export function registerWorkspaceAnalysisHandlers(
  analysis: WorkspaceAnalysisService
): void {
  ipcMain.handle("missionControl:analysis:get", (_event, featureId: string) =>
    analysis.get(featureId)
  )
  ipcMain.handle(
    "missionControl:analysis:checkFreshness",
    (_event, featureId: string) => analysis.checkFreshness(featureId)
  )
  // Starts the analysis and returns at once; progress arrives through
  // missionControl:analysis:changed.
  ipcMain.handle(
    "missionControl:analysis:analyze",
    (_event, featureId: string) => {
      const started = analysis.analyze(featureId)
      started.catch((error) =>
        console.warn("[workspace-analysis] analysis failed:", error)
      )
      return analysis.get(featureId)
    }
  )
  ipcMain.handle(
    "missionControl:analysis:cancel",
    (_event, featureId: string) => analysis.cancel(featureId)
  )
  ipcMain.handle(
    "missionControl:analysis:applyFix",
    (_event, featureId: string, key: string, alternative?: number | null) =>
      analysis.applyFix(featureId, key, alternative ?? null)
  )
  ipcMain.handle(
    "missionControl:analysis:previewApplyAll",
    (_event, featureId: string) => analysis.previewApplyAll(featureId)
  )
  ipcMain.handle(
    "missionControl:analysis:applyAll",
    (_event, featureId: string, selected: string[]) =>
      analysis.applyAll(
        featureId,
        Array.isArray(selected)
          ? selected.filter((s) => typeof s === "string")
          : []
      )
  )
  ipcMain.handle(
    "missionControl:analysis:dismiss",
    (_event, featureId: string, key: string, dismissed: boolean) =>
      analysis.dismiss(featureId, key, dismissed !== false)
  )
  ipcMain.handle("missionControl:analysis:run", (_event, featureId: string) =>
    analysis.getRun(featureId)
  )
  ipcMain.handle("missionControl:analysis:cancelRun", (_event, runId: string) =>
    analysis.cancelRun(runId)
  )
}

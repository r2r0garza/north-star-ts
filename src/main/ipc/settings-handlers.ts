import { ipcMain } from "electron"
import * as settingsService from "../settings/service"
import { checkRuntimes } from "../agent/env/runtime-check"
import type {
  ExecutionSettings,
  PermissionSettings,
  IndexingSettings,
} from "../settings/service"

// Registers the `settings:` IPC channels. All route through the settings service
// so its in-memory cache stays coherent with the DB. Registered alongside the db
// handlers, after app.whenReady(). This slice covers execution backend + approval
// policy only; LLM/API-key settings are a later slice.
export function registerSettingsHandlers(): void {
  ipcMain.handle("settings:getExecution", () => settingsService.getExecution())
  ipcMain.handle("settings:setExecution", (_e, next: ExecutionSettings) =>
    settingsService.setExecution(next)
  )

  ipcMain.handle("settings:getPermissions", () => settingsService.getPermissions())
  ipcMain.handle("settings:setPermissions", (_e, next: PermissionSettings) =>
    settingsService.setPermissions(next)
  )

  ipcMain.handle("settings:getIndexing", () => settingsService.getIndexing())
  ipcMain.handle("settings:setIndexing", (_e, next: IndexingSettings) =>
    settingsService.setIndexing(next)
  )

  // Runtime availability for the backend picker. `recheck` forces a fresh probe
  // (e.g. the user just started Docker Desktop); otherwise cached results return.
  ipcMain.handle("settings:checkRuntimes", (_e, recheck?: boolean) =>
    checkRuntimes(recheck === true)
  )
}

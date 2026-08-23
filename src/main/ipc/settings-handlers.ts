import { ipcMain } from "electron"
import * as settingsService from "../settings/service"
import { checkRuntimes } from "../agent/env/runtime-check"
import { IDES } from "../ide/open"
import type {
  ExecutionSettings,
  PermissionSettings,
  MemorySettings,
  TitleGenerationSettings,
  IndexingSettings,
  SkillSourcesSettings,
  AgentSourcesSettings,
  McpSourcesSettings,
  BrowserSettings,
  ThemeSettings,
  IdeSettings,
  NotificationSettings,
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

  ipcMain.handle("settings:getPermissions", () =>
    settingsService.getPermissions()
  )
  ipcMain.handle("settings:setPermissions", (_e, next: PermissionSettings) =>
    settingsService.setPermissions(next)
  )

  ipcMain.handle("settings:getIndexing", () => settingsService.getIndexing())
  ipcMain.handle("settings:setIndexing", (_e, next: IndexingSettings) =>
    settingsService.setIndexing(next)
  )

  ipcMain.handle("settings:getMemory", () => settingsService.getMemory())
  ipcMain.handle("settings:setMemory", (_e, next: MemorySettings) =>
    settingsService.setMemory(next)
  )
  ipcMain.handle("settings:getTitleGeneration", () =>
    settingsService.getTitleGeneration()
  )
  ipcMain.handle(
    "settings:setTitleGeneration",
    (_e, next: TitleGenerationSettings) =>
      settingsService.setTitleGeneration(next)
  )

  ipcMain.handle("settings:getSkillSources", () =>
    settingsService.getSkillSources()
  )
  ipcMain.handle("settings:setSkillSources", (_e, next: SkillSourcesSettings) =>
    settingsService.setSkillSources(next)
  )

  ipcMain.handle("settings:getAgentSources", () =>
    settingsService.getAgentSources()
  )
  ipcMain.handle("settings:setAgentSources", (_e, next: AgentSourcesSettings) =>
    settingsService.setAgentSources(next)
  )

  ipcMain.handle("settings:getMcpSources", () =>
    settingsService.getMcpSources()
  )
  ipcMain.handle("settings:setMcpSources", (_e, next: McpSourcesSettings) =>
    settingsService.setMcpSources(next)
  )

  ipcMain.handle("settings:getBrowser", () => settingsService.getBrowser())
  ipcMain.handle("settings:setBrowser", (_e, next: BrowserSettings) =>
    settingsService.setBrowser(next)
  )

  ipcMain.handle("settings:getTheme", () => settingsService.getTheme())
  ipcMain.handle("settings:setTheme", (_e, next: ThemeSettings) =>
    settingsService.setTheme(next)
  )

  ipcMain.handle("settings:getIde", () => settingsService.getIde())
  ipcMain.handle("settings:setIde", (_e, next: IdeSettings) =>
    settingsService.setIde(next)
  )

  ipcMain.handle("settings:getNotifications", () =>
    settingsService.getNotifications()
  )
  ipcMain.handle(
    "settings:setNotifications",
    (_e, next: NotificationSettings) => settingsService.setNotifications(next)
  )
  // Static IDE registry (id + label) for the Settings dropdown.
  ipcMain.handle("settings:getIdeOptions", () =>
    IDES.map(({ id, label }) => ({ id, label }))
  )

  // Runtime availability for the backend picker. `recheck` forces a fresh probe
  // (e.g. the user just started Docker Desktop); otherwise cached results return.
  ipcMain.handle("settings:checkRuntimes", (_e, recheck?: boolean) =>
    checkRuntimes(recheck === true)
  )
}

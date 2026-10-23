import { BrowserWindow, ipcMain } from "electron"
import type { ElectronAppManager } from "../electron-apps/manager"

// Host-owned visibility and stop control for agent-launched Electron apps
// (plan 119). The renderer can list and stop sessions; it cannot launch.
export function registerElectronAppHandlers(apps: ElectronAppManager): void {
  ipcMain.handle("electron-apps:list", () => apps.list())
  ipcMain.handle("electron-apps:stop", (_event, sessionId: string) =>
    apps.stop(sessionId)
  )
  apps.on("change", () => {
    const sessions = apps.list()
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed())
        window.webContents.send("electron-apps:changed", sessions)
  })
}

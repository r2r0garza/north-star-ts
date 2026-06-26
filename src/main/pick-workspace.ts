import { dialog, BrowserWindow } from "electron"

export interface PickResult {
  path?: string
  canceled?: boolean
}

// Opens the real native OS folder picker via Electron's dialog API.
// Cross-platform (macOS/Windows/Linux) with correct window ownership —
// no osascript, no focus quirks.
export async function pickWorkspace(): Promise<PickResult> {
  const win = BrowserWindow.getFocusedWindow() ?? undefined
  const result = win
    ? await dialog.showOpenDialog(win, {
        title: "Select a workspace folder",
        properties: ["openDirectory", "createDirectory"],
      })
    : await dialog.showOpenDialog({
        title: "Select a workspace folder",
        properties: ["openDirectory", "createDirectory"],
      })

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true }
  }
  return { path: result.filePaths[0] }
}

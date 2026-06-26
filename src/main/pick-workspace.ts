import { dialog, BrowserWindow, type OpenDialogOptions } from "electron"

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

export interface PickFilesResult {
  paths?: string[]
  canceled?: boolean
}

// Opens the native OS file picker (multi-select) for attaching files to a chat.
// Files only — directories are attached via the workspace picker, not here.
export async function pickFiles(): Promise<PickFilesResult> {
  const win = BrowserWindow.getFocusedWindow() ?? undefined
  const options: OpenDialogOptions = {
    title: "Attach files",
    properties: ["openFile", "multiSelections"],
  }
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options)

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true }
  }
  return { paths: result.filePaths }
}

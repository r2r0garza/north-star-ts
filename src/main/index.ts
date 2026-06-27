import { app, shell, BrowserWindow, ipcMain } from "electron"
import { join } from "path"
import { config as loadEnv } from "dotenv"

// Load .env.local before anything reads process.env. Next did this for us;
// Electron does not, so the NEXT_apiKey override must be loaded explicitly.
// `override: false` keeps real system env vars winning over the file, but the
// agent's own NEXT_apiKey-first fallback still prioritizes the file's key.
loadEnv({ path: join(app.getAppPath(), ".env.local") })

import { runChat, resolveApproval, stopChat, type ChatRequest } from "./agent"
import { pickWorkspace, pickFiles } from "./pick-workspace"
import { registerDbHandlers } from "./ipc/db-handlers"
import { closeDb } from "./db/connection"

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    // Remove the OS title bar so the sidebar/chat reach the top. On macOS,
    // `hiddenInset` keeps the traffic-light buttons floating over the top-left
    // (i.e. over the sidebar); other platforms get a frameless top via
    // `titleBarStyle: "hidden"`.
    titleBarStyle: "hidden",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 18 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  })

  mainWindow.on("ready-to-show", () => mainWindow.show())

  // Tell the renderer when fullscreen changes — in fullscreen the macOS traffic
  // lights are hidden, so the UI shifts its sidebar toggle to the left edge.
  const sendFullScreen = (value: boolean) =>
    mainWindow.webContents.send("window:fullscreen", value)
  mainWindow.on("enter-full-screen", () => sendFullScreen(true))
  mainWindow.on("leave-full-screen", () => sendFullScreen(false))

  // Open external links in the user's browser, not inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: "deny" }
  })

  // electron-vite injects the dev server URL in development; in production we
  // load the built renderer HTML from disk.
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"))
  }
}

// IPC handlers — the renderer reaches these through the preload bridge.
// `chat` runs the agentic loop and streams events back to the calling renderer
// over the "chat:event" channel; the invoke resolves with the final result.
ipcMain.handle("chat", (event, req: ChatRequest) =>
  runChat(req, (chatEvent) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send("chat:event", chatEvent)
    }
  })
)
// Resolve an approval the agent loop is paused on. Fire-and-forget from the
// renderer's perspective: it just unblocks the gate in runChat.
ipcMain.handle(
  "chat:approve",
  (
    _event,
    payload: {
      requestId: string
      decision: "approved" | "denied"
      remember?: "workspace"
    }
  ) => {
    resolveApproval(payload.requestId, payload.decision, payload.remember)
  }
)
// Cancel an in-flight turn (the Stop button). Aborts the controller in runChat,
// which kills the in-flight LLM stream, releases any pending approval gate, and
// unwinds the loop. No-op if nothing is running for that conversation.
ipcMain.handle("chat:stop", (_event, conversationId: string) => {
  stopChat(conversationId)
})
ipcMain.handle("pick-workspace", () => pickWorkspace())
ipcMain.handle("pick-files", () => pickFiles())
// Initial fullscreen state, queried by the renderer on mount.
ipcMain.handle("is-fullscreen", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  return win?.isFullScreen() ?? false
})

app.whenReady().then(() => {
  // Register DB-backed IPC handlers now — the connection opens lazily on first
  // use, after userData is available.
  registerDbHandlers()
  createWindow()

  app.on("activate", () => {
    // macOS: re-create a window when the dock icon is clicked and none are open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  // macOS apps typically stay active until the user quits explicitly.
  if (process.platform !== "darwin") app.quit()
})

// Flush the WAL and close the DB cleanly on quit.
app.on("will-quit", () => closeDb())

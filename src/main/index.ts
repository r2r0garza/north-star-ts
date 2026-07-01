import { app, shell, BrowserWindow, ipcMain } from "electron"
import { join } from "path"
import { config as loadEnv } from "dotenv"

// Load .env.local before anything reads process.env. The API key is no longer
// read from env at runtime (it's stored per provider account, encrypted via
// safeStorage), but a key found here on first launch is migrated into a seeded
// Portkey account by seedProviderFromEnvIfEmpty so existing dev setups keep
// working. Other env-driven config (e.g. COWORK_ENV_RUNTIME) still relies on this.
loadEnv({ path: join(app.getAppPath(), ".env.local") })

import { runChat, resolveApproval, resolveQuestion, stopChat, type ChatRequest } from "./agent"
import { pickWorkspace, pickFiles } from "./pick-workspace"
import { registerDbHandlers } from "./ipc/db-handlers"
import { registerSettingsHandlers } from "./ipc/settings-handlers"
import { registerProviderHandlers } from "./ipc/provider-handlers"
import { registerTaskHandlers } from "./ipc/task-handlers"
import { registerIndexHandlers } from "./ipc/index-handlers"
import { TaskRunner } from "./tasks/runner"
import { IndexService } from "./index/service"
import { seedProviderFromEnvIfEmpty } from "./settings/bootstrap"
import { closeDb } from "./db/connection"

// The durable task runner — a singleton owned by the main process. Started in
// app.whenReady (after the DB handlers register) and stopped on will-quit.
const taskRunner = new TaskRunner()
// The workspace indexer (plan 008), driven as a deterministic task kind on the
// runner above. Holds the runner reference so ensureRunning can enqueue.
const indexService = new IndexService(taskRunner)

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
  runChat(
    req,
    (chatEvent) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("chat:event", chatEvent)
      }
    },
    // Let a live turn hand work to the background (run_todos_in_background). The
    // runner singleton lives here; runChat can't import it (cycle).
    (input) => taskRunner.enqueue(input)
  )
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
// Deliver the user's answers to a pending ask_user_question. Fire-and-forget;
// unblocks the `ask` promise in runChat.
ipcMain.handle(
  "chat:answer",
  (
    _event,
    payload: {
      requestId: string
      answers: Array<{ selected: string[]; other?: string }>
    }
  ) => {
    resolveQuestion(payload.requestId, payload.answers)
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
  registerDbHandlers(indexService)
  registerSettingsHandlers()
  registerProviderHandlers()
  // Start the durable task runner now that the DB handlers are registered (it
  // reads the task tables synchronously). reconcile() marks any task left
  // mid-flight by a previous run as interrupted; the pump then drains the queue.
  // Future background producers (indexing, maintenance) register their task
  // kinds here via taskRunner.registerKind(...) BEFORE start() — reconcile()
  // consults the registry to decide which orphaned kinds auto-resume.
  // todo_run: a handed-off todo list. Auto-resume so a long list survives a
  // restart and continues (plan 016).
  taskRunner.registerKind("todo_run", { autoResume: true })
  // workspace_index: deterministic (no LLM) executor; auto-resume so a paused or
  // crash-interrupted index continues from its cursor on next boot (plan 008).
  taskRunner.registerKind("workspace_index", {
    autoResume: true,
    run: indexService.execute,
  })
  taskRunner.start()
  registerTaskHandlers(taskRunner)
  registerIndexHandlers(taskRunner, indexService)
  // Migrate a pre-settings env-configured key into a stored provider account, so
  // existing dev setups keep working without re-entering it (no-op once any
  // account exists). After this, the stored key is the source of truth.
  seedProviderFromEnvIfEmpty()
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

// Stop the task runner (abort in-flight tasks; next boot's reconcile recovers
// them) and flush the WAL + close the DB cleanly on quit.
app.on("will-quit", () => {
  void taskRunner.stop()
  closeDb()
})

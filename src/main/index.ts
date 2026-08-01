import { app, shell, BrowserWindow, ipcMain } from "electron"
import { join } from "path"
import { config as loadEnv } from "dotenv"

// Load .env.local before anything reads process.env. The API key is no longer
// read from env at runtime (it's stored per provider account, encrypted via
// safeStorage), but a key found here on first launch is migrated into a seeded
// Portkey account by seedProviderFromEnvIfEmpty so existing dev setups keep
// working. Other env-driven config (e.g. COWORK_ENV_RUNTIME) still relies on this.
loadEnv({ path: join(app.getAppPath(), ".env.local") })

import {
  runChat,
  resolveApproval,
  resolveQuestion,
  stopChat,
  type ChatRequest,
} from "./agent"
import { pickWorkspace, pickFiles } from "./pick-workspace"
import { skillSources } from "./agent/skills/sources"
import { loadSkills, listSource } from "./agent/skills/loader"
import type { SkillSourceRow, SkillSourceKind } from "./agent/skills/types"
import * as settingsService from "./settings/service"
import { listWorkspaceFiles } from "./files/list"
import { registerDbHandlers } from "./ipc/db-handlers"
import { registerSettingsHandlers } from "./ipc/settings-handlers"
import { registerProviderHandlers } from "./ipc/provider-handlers"
import { registerTaskHandlers } from "./ipc/task-handlers"
import { registerIndexHandlers } from "./ipc/index-handlers"
import { TaskRunner } from "./tasks/runner"
import { IndexService } from "./index/service"
import { SummaryService, SUMMARIZE_KIND } from "./summaries/service"
import { BrowserManager } from "./browser/manager"
import { seedProviderFromEnvIfEmpty } from "./settings/bootstrap"
import { closeDb } from "./db/connection"

// The durable task runner — a singleton owned by the main process. Started in
// app.whenReady (after the DB handlers register) and stopped on will-quit.
const taskRunner = new TaskRunner()
// The workspace indexer (plan 008), driven as a deterministic task kind on the
// runner above. Holds the runner reference so ensureRunning can enqueue.
const indexService = new IndexService(taskRunner)
// The rolling conversation summarizer (plan 019), driven as a task kind on the
// runner. Holds the runner reference so the post-turn trigger can enqueue.
const summaryService = new SummaryService(taskRunner)
// The agent's browser (secondary window + WebContentsView driven over CDP).
// Owned here so runChat can hand each live turn a signal-bound handle; disposed
// on will-quit. Lazily creates its window on first agent use.
const browserManager = new BrowserManager()

// Module-level handle to the main app window, so pushes from services that don't
// own it (the browser manager forwarding picked elements) can reach its renderer.
// Assigned in createWindow; the browser manager reads it via the forwarder below.
let mainWindow: BrowserWindow | null = null

// Route picked elements from the agent browser to the main app renderer, where
// they surface as a pending composer chip. Reads mainWindow lazily so it works
// regardless of creation order; no-ops if the window is gone.
browserManager.setPickForwarder((element) => {
  const wc = mainWindow?.webContents
  if (wc && !wc.isDestroyed()) wc.send("browser:element-picked", element)
})

// Route a browser tab click to the main app renderer so it switches to that
// conversation (the bidirectional binding — see main.tsx's listener).
browserManager.setConversationActivator((conversationId) => {
  const wc = mainWindow?.webContents
  if (wc && !wc.isDestroyed())
    wc.send("browser:activate-conversation", conversationId)
})

// Ask the app to open its right panel in Browser mode (the sidebar equivalent of
// revealing the separate window — used on agent navigation / handoff when the
// browser surface is "sidebar").
browserManager.setOpenRequester(() => {
  const wc = mainWindow?.webContents
  if (wc && !wc.isDestroyed()) wc.send("browser:request-open")
})

// Mirror the active tab's pick-mode + tab state to the app renderer, so the
// sidebar browser chrome (URL/loading + "Pick" toggle) tracks the true state —
// the counterpart of the pushes that already feed the separate window's chrome.
browserManager.setAppPickModeEmitter((active) => {
  const wc = mainWindow?.webContents
  if (wc && !wc.isDestroyed()) wc.send("browser:pick-mode", active)
})
browserManager.setAppTabsEmitter((tabs) => {
  const wc = mainWindow?.webContents
  if (wc && !wc.isDestroyed()) wc.send("browser:tabs", tabs)
})

function createWindow(): void {
  // Local const for in-function use (clean non-null narrowing in the closures
  // below); the module-level `mainWindow` mirrors it for external pushes.
  const win = new BrowserWindow({
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
  mainWindow = win
  // Give the browser manager this window so it can embed the agent browser's
  // WebContentsView in the right-hand panel (the "sidebar" surface).
  browserManager.setMainWindow(win)

  win.on("ready-to-show", () => win.show())
  // Drop the module reference when the window is gone so pushes no-op instead of
  // hitting a destroyed webContents.
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null
  })

  // Tell the renderer when fullscreen changes — in fullscreen the macOS traffic
  // lights are hidden, so the UI shifts its sidebar toggle to the left edge.
  const sendFullScreen = (value: boolean) =>
    win.webContents.send("window:fullscreen", value)
  win.on("enter-full-screen", () => sendFullScreen(true))
  win.on("leave-full-screen", () => sendFullScreen(false))

  // Open external links in the user's browser, not inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: "deny" }
  })

  // electron-vite injects the dev server URL in development; in production we
  // load the built renderer HTML from disk.
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"))
  }
}

// IPC handlers — the renderer reaches these through the preload bridge.
// `chat` runs the agentic loop and streams events back to the calling renderer
// over the "chat:event" channel; the invoke resolves with the final result.
ipcMain.handle("chat", async (event, req: ChatRequest) => {
  const result = await runChat(
    req,
    (chatEvent) => {
      if (!event.sender.isDestroyed()) {
        // Tag every event with its conversation so the renderer's per-turn
        // listener can ignore events from other in-flight turns. Without this,
        // a second turn's listener also receives the first turn's tokens
        // (single broadcast channel) and streams them into the wrong bubble.
        event.sender.send("chat:event", {
          conversationId: req.conversationId,
          event: chatEvent,
        })
      }
    },
    // Let a live turn hand work to the background (run_todos_in_background). The
    // runner singleton lives here; runChat can't import it (cycle).
    (input) => taskRunner.enqueue(input),
    // Give the live turn a browser handle scoped to its conversation's tab and
    // bound to its abort signal. req.conversationId is already in scope here, so
    // no agent-loop signature change is needed to thread it (Option B).
    (signal) => browserManager.handleForTurn(req.conversationId, signal)
  )
  // After the turn's transcript is persisted, consider refreshing the rolling
  // conversation summary (plan 019). Threshold + debounce + dedupe live inside
  // maybeSummarize; the LLM call itself runs out of band in the task runner, so
  // this adds no latency to the turn just completed.
  summaryService.maybeSummarize(req.conversationId)
  return result
})
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
// Agent-browser chrome → main: user-driven navigation/reload from the secondary
// window's URL bar. Fire-and-forget; not gated (the human is driving their own
// browser). The chrome reaches these via its own preload bridge.
ipcMain.handle("browser:navigate", (_event, url: string) => {
  if (typeof url === "string" && url.trim()) browserManager.userNavigate(url.trim())
})
ipcMain.handle("browser:reload", () => browserManager.userReload())
// Toggle element-pick mode from the chrome's "Pick element" button.
ipcMain.handle("browser:set-pick-mode", (_event, active: boolean) => {
  browserManager.setPickMode(!!active)
})
// Chrome tab click → ask the app to switch to that conversation (bidirectional).
ipcMain.handle("browser:activate-conversation", (_event, id: string) => {
  if (typeof id === "string" && id) browserManager.requestConversationActivation(id)
})
// Main app renderer → main: the user switched to this conversation; show its tab
// (or hide if null / no tab). This drives which tab is visible.
ipcMain.handle(
  "browser:set-active-conversation",
  (_event, conversationId: string | null) => {
    browserManager.setActiveConversation(
      typeof conversationId === "string" ? conversationId : null
    )
  }
)
// Main app renderer → main: the right-panel Browser slot reported its on-screen
// rectangle (device-independent px), so the embedded WebContentsView can be laid
// out to match. A null rect hides the embed (panel closed / not in Browser mode /
// obscured by a modal). Fire-and-forget — layout is idempotent.
ipcMain.handle(
  "browser:report-bounds",
  (
    _event,
    bounds: { x: number; y: number; width: number; height: number } | null
  ) => {
    browserManager.reportSidebarBounds(
      bounds && typeof bounds.width === "number" ? bounds : null
    )
  }
)
// Choose the display surface: "sidebar" embeds the active tab in the app panel;
// "window" pops it out into the separate Agent Browser window.
ipcMain.handle("browser:set-surface", (_event, surface: string) => {
  if (surface === "window" || surface === "sidebar") {
    browserManager.setSurface(surface)
  }
})
ipcMain.handle("pick-workspace", () => pickWorkspace())
ipcMain.handle("pick-files", () => pickFiles())
// List available skills (name + description only) for the composer's slash
// menu. Resolves the same source dirs the agent uses at turn time, so the
// picker shows exactly what the model can read via read_skill. `body`/`path`
// are dropped — the renderer only needs to display and match on name/desc.
ipcMain.handle("skills:list", async (_event, workspace?: string) => {
  const skills = await loadSkills(skillSources(workspace))
  return skills.map(({ name, description }) => ({ name, description }))
})
// Enumerate the skill sources (built-in + custom) for Settings → Capabilities,
// each tagged with its kind and its current skill count. Mirrors the ordering
// in skillSources() so the table matches the load order. The workspace rows are
// only included when a workspace is passed.
ipcMain.handle(
  "skills:sources",
  async (_event, workspace?: string): Promise<SkillSourceRow[]> => {
    const custom = settingsService.getSkillSources().folders
    const entries: Array<{ path: string; kind: SkillSourceKind }> = [
      { path: join(app.getAppPath(), "skills"), kind: "app" },
      { path: join(app.getPath("home"), ".cowork", "skills"), kind: "user" },
      ...custom.map((path) => ({ path, kind: "custom" as const })),
    ]
    if (workspace) {
      entries.push({
        path: join(workspace, ".github", "skills"),
        kind: "github",
      })
      entries.push({
        path: join(workspace, ".cowork", "skills"),
        kind: "workspace",
      })
    }
    return Promise.all(
      entries.map(async ({ path, kind }) => ({
        path,
        kind,
        skillCount: (await listSource(path)).length,
      }))
    )
  }
)
// List workspace files (relative POSIX paths) for the composer's `@`-mention
// menu, filtered by the typed query server-side. Backed by a cached
// gitignore-aware walk so large repos stay responsive. Returns [] with no
// workspace (e.g. Chat mode).
ipcMain.handle(
  "files:list",
  async (_event, workspace: string, query: string) => {
    if (!workspace?.trim()) return []
    return listWorkspaceFiles(workspace.trim(), query ?? "", Date.now())
  }
)
// Initial fullscreen state, queried by the renderer on mount.
ipcMain.handle("is-fullscreen", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  return win?.isFullScreen() ?? false
})

app.whenReady().then(() => {
  // Register DB-backed IPC handlers now — the connection opens lazily on first
  // use, after userData is available.
  registerDbHandlers(indexService, taskRunner, (id) =>
    browserManager.closeTab(id)
  )
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
    // Observable/cancellable via the indexing panel, and born source-less by
    // design — exempt from the plan 022 orphan reaper.
    hasIndependentSurface: true,
    run: indexService.execute,
  })
  // summarize: deterministic (one bounded LLM call, no agentic loop) executor for
  // the rolling conversation summary (plan 019). autoResume:false — a stale
  // summary is harmless and the next turn re-triggers, so there's no need to
  // resume across a restart. Deliberately NOT hasIndependentSurface: a summarize
  // task is born source-less and, unlike a runaway, is safe to reap — so the plan
  // 022 orphan reaper cleans any leftover summarize task (and its empty forked
  // worker conversation) at the next boot rather than letting them accumulate.
  taskRunner.registerKind(SUMMARIZE_KIND, {
    autoResume: false,
    run: summaryService.execute,
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

// Before the quit sequence closes windows, clear the agent browser's user-close
// veto. That veto hides-instead-of-closes on a normal user close (so a session
// survives a stray window close), but during quit it would cancel the quit and
// leave the process (and its renderer children) running. Runs before will-quit.
app.on("before-quit", () => {
  browserManager.prepareForQuit()
})

// Stop the task runner (abort in-flight tasks; next boot's reconcile recovers
// them) and flush the WAL + close the DB cleanly on quit.
app.on("will-quit", () => {
  void taskRunner.stop()
  browserManager.dispose()
  closeDb()
})

import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  Notification,
  nativeTheme,
} from "electron"
import { join, resolve, basename, dirname, sep, extname } from "path"
import { readFile, writeFile, unlink, mkdir, rm } from "fs/promises"
import { existsSync } from "fs"
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
  setAutoModeForConversation,
  type ChatRequest,
} from "./agent"
import {
  pickWorkspace,
  pickFiles,
  pickSkillImport,
  pickAgentImport,
} from "./pick-workspace"
import {
  skillSources,
  initUserSkills,
  userSkillsDir,
} from "./agent/skills/sources"
import {
  loadSkills,
  listSource,
  validateName as validateSkillName,
  skillScaffold,
} from "./agent/skills/loader"
import {
  importSkillFromMarkdown,
  importSkillFromZip,
} from "./agent/skills/import"
import { agentSources, userAgentsDir } from "./agent/agents/sources"
import {
  loadAgents,
  listSource as listAgentSource,
  serializeAgent,
  validateName as validateAgentName,
  type AgentFields,
} from "./agent/agents/loader"
import { importAgentFromMarkdown } from "./agent/agents/import"
import type {
  SkillSourceRow,
  SkillSourceKind,
  SkillCatalogEntry,
  SkillTree,
  SkillFolder,
} from "./agent/skills/types"
import type {
  AgentSourceRow,
  AgentSourceKind,
  AgentTree,
  AgentFolder,
} from "./agent/agents/types"
import { listWorkspaces } from "./db/repositories/workspaces"
import * as settingsService from "./settings/service"
import { listWorkspaceFiles } from "./files/list"
import { readGitBranch } from "./index/metadata"
import { gitDiffFile } from "./git/diff"
import { openInIde } from "./ide/open"
import { resolveInWorkspaceReal } from "./agent/tools/workspace"
import { registerDbHandlers } from "./ipc/db-handlers"
import { registerSettingsHandlers } from "./ipc/settings-handlers"
import { registerProviderHandlers } from "./ipc/provider-handlers"
import { registerTaskHandlers } from "./ipc/task-handlers"
import { registerIndexHandlers } from "./ipc/index-handlers"
import { TaskRunner } from "./tasks/runner"
import { IndexService } from "./index/service"
import { SummaryService, SUMMARIZE_KIND } from "./summaries/service"
import { ProcessService, PROCESS_RUN_KIND } from "./tasks/process/service"
import { registerProcessHandlers } from "./ipc/process-handlers"
import { BrowserManager } from "./browser/manager"
import { seedProviderFromEnvIfEmpty } from "./settings/bootstrap"
import { closeDb } from "./db/connection"
import {
  dataDirName,
  systemDisplayName,
  mainAgentName,
} from "./config/system-name"
import { resolveBrandTheme } from "./config/theme"

// The durable task runner — a singleton owned by the main process. Started in
// app.whenReady (after the DB handlers register) and stopped on will-quit.
const taskRunner = new TaskRunner()
// The workspace indexer (plan 008), driven as a deterministic task kind on the
// runner above. Holds the runner reference so ensureRunning can enqueue.
const indexService = new IndexService(taskRunner)
// The rolling conversation summarizer (plan 019), driven as a task kind on the
// runner. Holds the runner reference so the post-turn trigger can enqueue.
const summaryService = new SummaryService(taskRunner)
// The Process engine (plan 025), driven as the deterministic `process_run` task
// kind. Holds the runner reference so startRun can enqueue the orchestrator task.
const processService = new ProcessService(taskRunner)
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
      remember?: "workspace" | "conversation"
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
// Flip Auto mode on an already-running turn (the composer dropdown, changed
// mid-turn). Reaches the live loop's setAutoMode so the gate honors it on the
// next gated action; turning Auto on also clears any pending approval prompt.
ipcMain.handle(
  "chat:setAutoMode",
  (_event, conversationId: string, on: boolean) => {
    setAutoModeForConversation(conversationId, on)
  }
)
// Agent-browser chrome → main: user-driven navigation/reload from the secondary
// window's URL bar. Fire-and-forget; not gated (the human is driving their own
// browser). The chrome reaches these via its own preload bridge.
ipcMain.handle("browser:navigate", (_event, url: string) => {
  if (typeof url === "string" && url.trim())
    browserManager.userNavigate(url.trim())
})
ipcMain.handle("browser:reload", () => browserManager.userReload())
// Chrome/panel "×" → main: user closes the active conversation's browser tab
// when they no longer need it. Frees the view; a later navigate reopens a fresh
// one. Fire-and-forget (the tab strip pushes the resulting empty state).
ipcMain.handle("browser:close", () => browserManager.userClose())
// Main app renderer → main: the app's resolved theme changed (light/dark). Drive
// Electron's nativeTheme so the pop-out Agent Browser window's chrome — which
// uses the `Canvas`/`CanvasText` system colors under `color-scheme: light dark`
// (see src/renderer/browser.html) — follows the app instead of the OS setting.
ipcMain.handle("browser:set-theme", (_event, theme: "light" | "dark") => {
  nativeTheme.themeSource = theme === "dark" ? "dark" : "light"
})
// Toggle element-pick mode from the chrome's "Pick element" button.
ipcMain.handle("browser:set-pick-mode", (_event, active: boolean) => {
  browserManager.setPickMode(!!active)
})
// Chrome tab click → ask the app to switch to that conversation (bidirectional).
ipcMain.handle("browser:activate-conversation", (_event, id: string) => {
  if (typeof id === "string" && id)
    browserManager.requestConversationActivation(id)
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
// Single-select .md/.zip picker for the Skills view's Import affordance.
ipcMain.handle("pick-skill-import", () => pickSkillImport())
// Multi-select .agent.md picker for the Agents view's Import affordance.
ipcMain.handle("pick-agent-import", () => pickAgentImport())
// List available skills (name + description only) for the composer's slash
// menu. Resolves the same source dirs the agent uses at turn time, so the
// picker shows exactly what the model can read via read_skill. `body`/`path`
// are dropped — the renderer only needs to display and match on name/desc.
ipcMain.handle("skills:list", async (_event, workspace?: string) => {
  const skills = await loadSkills(skillSources(workspace))
  return skills.map(({ name, description }) => ({ name, description }))
})

// List the USER-INVOCABLE custom agents (name + description) for the composer's
// agent picker. Resolves the same source dirs the agent loop uses at turn time,
// so the dropdown shows exactly the agents a user may select. Non-invocable
// agents are excluded here (they're only reachable as another agent's child).
ipcMain.handle("agents:list", async (_event, workspace?: string) => {
  const agents = await loadAgents(agentSources(workspace))
  return agents
    .filter((a) => a.userInvocable)
    .map(({ name, description }) => ({ name, description }))
})

// The kind-tagged agent-source dirs for a workspace, in load order. Mirrors
// skillSourceEntries: user + user-registered custom folders, plus the workspace
// dirs when a workspace is passed. Backs agents:sources (counts) for the Settings
// → Capabilities "Agent folders" table.
function agentSourceEntries(
  workspace?: string
): Array<{ path: string; kind: AgentSourceKind }> {
  const custom = settingsService.getAgentSources().folders
  const dataDir = dataDirName()
  const entries: Array<{ path: string; kind: AgentSourceKind }> = [
    { path: userAgentsDir(), kind: "user" },
    ...custom.map((path) => ({ path, kind: "custom" as const })),
  ]
  if (workspace) {
    entries.push({ path: join(workspace, ".github", "agents"), kind: "github" })
    entries.push({
      path: join(workspace, dataDir, "agents"),
      kind: "workspace",
    })
  }
  return entries
}

// Enumerate the agent sources (user + custom) for Settings → Capabilities, each
// tagged with its kind and its current agent count. Mirrors the load order.
ipcMain.handle(
  "agents:sources",
  async (_event, workspace?: string): Promise<AgentSourceRow[]> => {
    return Promise.all(
      agentSourceEntries(workspace).map(async ({ path, kind }) => ({
        path,
        kind,
        agentCount: (await listAgentSource(path)).length,
      }))
    )
  }
)
// The nested catalog for the Agents view: Global (the user dir) + one node per
// KNOWN workspace + one node per registered custom folder, each with its loaded
// agents. Enumerates workspaces itself so the view populates with no active
// conversation. Folders are included even when empty. Mirrors skills:tree.
ipcMain.handle("agents:tree", async (): Promise<AgentTree> => {
  const dataDir = dataDirName()
  const toFolder = async (
    path: string,
    label: string,
    kind: AgentFolder["kind"]
  ): Promise<AgentFolder> => ({
    path,
    label,
    kind,
    agents: await listAgentSource(path),
  })

  const global = [await toFolder(userAgentsDir(), "Global", "user")]

  const workspaces = await Promise.all(
    listWorkspaces().map(async (ws) => ({
      label: ws.name ?? baseName(ws.path),
      path: ws.path,
      folders: await Promise.all([
        toFolder(
          join(ws.path, ".github", "agents"),
          ".github/agents",
          "github"
        ),
        toFolder(
          join(ws.path, dataDir, "agents"),
          `${dataDir}/agents`,
          "workspace"
        ),
      ]),
    }))
  )

  const custom = await Promise.all(
    settingsService
      .getAgentSources()
      .folders.map((folder) => toFolder(folder, baseName(folder), "custom"))
  )

  return { global, workspaces, custom }
})
// Read an agent's raw `<name>.agent.md` contents for the in-app editor. Any known
// agent source (including read-only workspace/github dirs) is readable.
ipcMain.handle(
  "agents:read",
  async (_event, filePath: string): Promise<string> => {
    assertAgentPath(filePath)
    return readFile(filePath, "utf-8")
  }
)
// Save an edited agent. Takes structured fields (not raw YAML) — the serializer
// lives in the main process so YAML construction never ships to the renderer. Only
// paths inside a WRITABLE root (user + custom) are accepted; workspace/github
// agents are read-only in this UI.
ipcMain.handle(
  "agents:save",
  async (_event, filePath: string, fields: AgentFields): Promise<void> => {
    assertAgentWritablePath(filePath)
    // The name must match the file stem (the loader enforces this at read time);
    // reject a mismatch up front so a save can't silently produce an agent that
    // won't load under its own name.
    const stem = basename(filePath).slice(0, -AGENT_SUFFIX.length)
    const nameErr = validateAgentName(fields.name, stem)
    if (nameErr) throw new Error(nameErr)
    await writeFile(filePath, serializeAgent(fields), "utf-8")
  }
)
// Create a new agent: scaffold a minimal valid `<name>.agent.md` into a writable
// source dir. Validates the target dir is writable, the name matches the loader's
// rules, and no same-name file already exists there. Returns the new file's path.
ipcMain.handle(
  "agents:create",
  async (
    _event,
    {
      dir,
      name,
      description,
    }: { dir: string; name: string; description: string }
  ): Promise<string> => {
    const resolvedDir = resolve(dir)
    if (!writableAgentRoots().includes(resolvedDir)) {
      throw new Error(
        `Refusing to create an agent outside a writable source: ${dir}`
      )
    }
    const nameErr = validateAgentName(name, name)
    if (nameErr) throw new Error(nameErr)
    const filePath = join(resolvedDir, `${name}${AGENT_SUFFIX}`)
    // Reject a collision — createExclusive via the 'wx' flag would also work, but an
    // explicit check gives a clearer error and matches the skills-create intent.
    if (existsSync(filePath)) {
      throw new Error(`An agent named '${name}' already exists here.`)
    }
    await mkdir(resolvedDir, { recursive: true })
    const contents = serializeAgent({
      name,
      description:
        description || "Describe what this agent does and when to use it.",
      // tools/skills omitted → "all" (the permissive default); children omitted →
      // cannot spawn. userInvocable true so it shows in the picker immediately.
      userInvocable: true,
      body: `You are ${name}.\n\nDescribe the agent's role and instructions here.\n`,
    })
    await writeFile(filePath, contents, "utf-8")
    return filePath
  }
)
// Delete an agent file. Writable roots only (never a read-only workspace/github
// agent). The renderer confirms before calling.
ipcMain.handle(
  "agents:delete",
  async (_event, filePath: string): Promise<void> => {
    assertAgentWritablePath(filePath)
    await unlink(filePath)
  }
)
// Import an agent from disk into a writable source dir. `sourcePath` is a
// `.agent.md` file; `dir` is the target writable root (exact-match validated,
// like agents:create). The file is copied verbatim; the name is derived+validated
// (name === stem) inside the import helper — a bad file / name mismatch /
// collision throws a clear message the renderer surfaces via toast. The renderer
// calls this once per file for one-or-more (best-effort) import. Returns the new
// file's path so the renderer can select it.
ipcMain.handle(
  "agents:import",
  async (
    _event,
    { sourcePath, dir }: { sourcePath: string; dir: string }
  ): Promise<string> => {
    const resolvedDir = resolve(dir)
    if (!writableAgentRoots().includes(resolvedDir)) {
      throw new Error(
        `Refusing to import an agent outside a writable source: ${dir}`
      )
    }
    return importAgentFromMarkdown(sourcePath, resolvedDir)
  }
)
// Reveal an agent file in the OS file manager (Finder on macOS, Explorer on
// Windows) with the file selected. Guarded by assertAgentPath so only a
// `.agent.md` inside a known agent source can be shown.
ipcMain.handle(
  "agents:reveal",
  async (_event, filePath: string): Promise<void> => {
    assertAgentPath(filePath)
    shell.showItemInFolder(resolve(filePath))
  }
)
// The kind-tagged skill-source dirs for a workspace, in load order. Shared by
// skills:sources (counts), skills:catalog (full skills), and skills:write (path
// allow-list). The app-bundled dir is intentionally absent — it only seeds the
// user dir once and is never a live source. Workspace rows only when a workspace
// is passed.
function skillSourceEntries(
  workspace?: string
): Array<{ path: string; kind: SkillSourceKind }> {
  const custom = settingsService.getSkillSources().folders
  const dataDir = dataDirName()
  const entries: Array<{ path: string; kind: SkillSourceKind }> = [
    { path: userSkillsDir(), kind: "user" },
    ...custom.map((path) => ({ path, kind: "custom" as const })),
  ]
  if (workspace) {
    entries.push({ path: join(workspace, ".github", "skills"), kind: "github" })
    entries.push({
      path: join(workspace, dataDir, "skills"),
      kind: "workspace",
    })
  }
  return entries
}

// Enumerate the skill sources (user + custom) for Settings → Capabilities, each
// tagged with its kind and its current skill count. Mirrors the load order.
ipcMain.handle(
  "skills:sources",
  async (_event, workspace?: string): Promise<SkillSourceRow[]> => {
    return Promise.all(
      skillSourceEntries(workspace).map(async ({ path, kind }) => ({
        path,
        kind,
        skillCount: (await listSource(path)).length,
      }))
    )
  }
)
// Full skill catalog for the Skills view: each source dir with its loaded skills
// (SkillMetadata incl. body + absolute path), tagged by kind so the renderer can
// group into Global (user) / Workspace (github + workspace) / Custom (custom).
// NOT de-duped across sources — each source shows its own skills.
ipcMain.handle(
  "skills:catalog",
  async (_event, workspace?: string): Promise<SkillCatalogEntry[]> => {
    return Promise.all(
      skillSourceEntries(workspace).map(async ({ path, kind }) => ({
        path,
        kind,
        skills: await listSource(path),
      }))
    )
  }
)
// The nested catalog for the Skills view: Global (the user dir) + one node per
// KNOWN workspace (every repo the app has opened, not just the active one) + one
// node per registered custom folder, each with its loaded skills. Enumerates
// workspaces itself so the view populates with no active conversation. Folders
// are included even when empty (the view shows them so the user sees every repo).
ipcMain.handle("skills:tree", async (): Promise<SkillTree> => {
  const dataDir = dataDirName()
  const toFolder = async (
    path: string,
    label: string,
    kind: SkillFolder["kind"]
  ): Promise<SkillFolder> => ({
    path,
    label,
    kind,
    skills: await listSource(path),
  })

  const global = [await toFolder(userSkillsDir(), "Global", "user")]

  const workspaces = await Promise.all(
    listWorkspaces().map(async (ws) => ({
      label: ws.name ?? baseName(ws.path),
      path: ws.path,
      folders: await Promise.all([
        toFolder(
          join(ws.path, ".github", "skills"),
          ".github/skills",
          "github"
        ),
        toFolder(
          join(ws.path, dataDir, "skills"),
          `${dataDir}/skills`,
          "workspace"
        ),
      ]),
    }))
  )

  const custom = await Promise.all(
    settingsService
      .getSkillSources()
      .folders.map((folder) => toFolder(folder, baseName(folder), "custom"))
  )

  return { global, workspaces, custom }
})
// Read a SKILL.md's raw contents (frontmatter + body) for the in-app editor.
// Only paths that live inside a known skill source are allowed (see below).
ipcMain.handle(
  "skills:read",
  async (_event, filePath: string): Promise<string> => {
    assertSkillPath(filePath)
    return readFile(filePath, "utf-8")
  }
)
// Reveal a skill's SKILL.md in the OS file manager (Finder on macOS, Explorer on
// Windows) with the file selected — a cross-platform one-liner via shell. Guarded
// by assertSkillPath so only a SKILL.md inside a known skill source can be shown.
ipcMain.handle(
  "skills:reveal",
  async (_event, filePath: string): Promise<void> => {
    assertSkillPath(filePath)
    shell.showItemInFolder(resolve(filePath))
  }
)
// Save an edited SKILL.md back to disk. Validates the path is a SKILL.md inside a
// known skill source before writing — the renderer only ever passes catalog
// paths, but the handler must not trust arbitrary input.
ipcMain.handle(
  "skills:write",
  async (_event, filePath: string, content: string): Promise<void> => {
    assertSkillPath(filePath)
    await writeFile(filePath, content, "utf-8")
  }
)
// Create a new skill: scaffold a `<dir>/<name>/SKILL.md` with valid frontmatter
// + a starter body into a writable source dir. Validates the target dir is
// writable, the name matches the loader's rules (also enforcing name === the new
// subdirectory), and no same-name skill folder already exists there. Returns the
// new SKILL.md path so the renderer can drop straight into editing it.
ipcMain.handle(
  "skills:create",
  async (
    _event,
    {
      dir,
      name,
      description,
      body,
    }: { dir: string; name: string; description: string; body?: string }
  ): Promise<string> => {
    const resolvedDir = resolve(dir)
    if (!writableSkillRoots().includes(resolvedDir)) {
      throw new Error(
        `Refusing to create a skill outside a writable source: ${dir}`
      )
    }
    // validateName also enforces name === dirName, so the skill subdir is the name.
    const nameErr = validateSkillName(name, name)
    if (nameErr) throw new Error(nameErr)
    const skillDir = join(resolvedDir, name)
    if (existsSync(skillDir)) {
      throw new Error(`A skill named '${name}' already exists here.`)
    }
    await mkdir(skillDir, { recursive: true })
    const filePath = join(skillDir, "SKILL.md")
    await writeFile(filePath, skillScaffold(name, description, body), "utf-8")
    return filePath
  }
)
// Import a skill from disk into a writable source dir. `sourcePath` is a .md
// (a SKILL.md) or a .zip of a skill folder; `dir` is the target writable root
// (exact-match validated, like skills:create). The name is derived from the
// SKILL.md frontmatter inside the import helpers; a collision / bad name / zip
// problem throws a clear message the renderer surfaces via toast. Returns the
// new SKILL.md path so the renderer can select it.
ipcMain.handle(
  "skills:import",
  async (
    _event,
    { sourcePath, dir }: { sourcePath: string; dir: string }
  ): Promise<string> => {
    const resolvedDir = resolve(dir)
    if (!writableSkillRoots().includes(resolvedDir)) {
      throw new Error(
        `Refusing to import a skill outside a writable source: ${dir}`
      )
    }
    const ext = extname(sourcePath).toLowerCase()
    if (ext === ".zip") {
      return importSkillFromZip(sourcePath, resolvedDir)
    }
    if (ext === ".md" || ext === ".markdown") {
      return importSkillFromMarkdown(sourcePath, resolvedDir)
    }
    throw new Error("Import a .md (SKILL.md) or a .zip of a skill folder.")
  }
)
// Delete a skill. Removes the whole skill FOLDER (the SKILL.md's parent dir),
// writable roots only (never a read-only workspace/github skill). The renderer
// passes the SKILL.md path and confirms before calling.
ipcMain.handle(
  "skills:delete",
  async (_event, filePath: string): Promise<void> => {
    assertSkillWritablePath(filePath)
    // filePath is <root>/<name>/SKILL.md — remove its parent folder, not just the file.
    await rm(dirname(resolve(filePath)), { recursive: true, force: true })
  }
)
// Basename of a path, tolerating a trailing separator (e.g. "/a/b/" -> "b").
function baseName(p: string): string {
  return basename(p.replace(/[/\\]+$/, "")) || p
}
// All skill-source roots the Skills view can read/write: the user dir + every
// custom folder + BOTH workspace dirs for EVERY known workspace. The guard must
// cover all workspaces (not just the active one) because the view now edits
// skills across every repo the app knows about.
function allSkillRoots(): string[] {
  const dataDir = dataDirName()
  const roots = [userSkillsDir(), ...settingsService.getSkillSources().folders]
  for (const ws of listWorkspaces()) {
    roots.push(join(ws.path, ".github", "skills"))
    roots.push(join(ws.path, dataDir, "skills"))
  }
  return roots.map((r) => resolve(r))
}
// Guard for skills:read/write. Requires the basename to be SKILL.md and the file
// to resolve inside one of the known skill-source dirs. Throws otherwise. The
// `resolved === root || startsWith(root + sep)` check rejects both path traversal
// (../) and sibling-prefix tricks (e.g. "skills-evil" vs "skills").
function assertSkillPath(filePath: string): void {
  const resolved = resolve(filePath)
  if (basename(resolved) !== "SKILL.md") {
    throw new Error(`Refusing non-SKILL.md path: ${filePath}`)
  }
  const inside = allSkillRoots().some(
    (root) => resolved === root || resolved.startsWith(root + sep)
  )
  if (!inside) {
    throw new Error(`Refusing skill path outside known sources: ${filePath}`)
  }
}
// The WRITABLE skill roots: user dir + registered custom folders only. Workspace
// (.github/skills, .<system>/skills) dirs are read-only in this UI — the app won't
// drop skill folders into a repo the user may not intend to commit to. Mirrors
// writableAgentRoots().
function writableSkillRoots(): string[] {
  return [userSkillsDir(), ...settingsService.getSkillSources().folders].map(
    (r) => resolve(r)
  )
}
// Guard for skills:delete. Like assertSkillPath (basename SKILL.md) but restricted
// to WRITABLE roots, so a read-only workspace/github skill can't be deleted. The
// deleted target is the SKILL.md's PARENT folder; requiring the parent to sit
// under a writable root (and the file to be a SKILL.md) keeps the rm scoped.
function assertSkillWritablePath(filePath: string): void {
  const resolved = resolve(filePath)
  if (basename(resolved) !== "SKILL.md") {
    throw new Error(`Refusing non-SKILL.md path: ${filePath}`)
  }
  const inside = writableSkillRoots().some((root) =>
    resolved.startsWith(root + sep)
  )
  if (!inside) {
    throw new Error(
      `Refusing to modify a skill outside a writable source: ${filePath}`
    )
  }
}
// Agent files are flat `<name>.agent.md` (a suffix, not a fixed basename like
// SKILL.md), so the guards match on the suffix.
const AGENT_SUFFIX = ".agent.md"
// ALL agent-source roots the Agents view can read: user + custom + BOTH workspace
// dirs for EVERY known workspace. Read is permitted everywhere; writes use the
// narrower writableAgentRoots().
function allAgentRoots(): string[] {
  const dataDir = dataDirName()
  const roots = [userAgentsDir(), ...settingsService.getAgentSources().folders]
  for (const ws of listWorkspaces()) {
    roots.push(join(ws.path, ".github", "agents"))
    roots.push(join(ws.path, dataDir, "agents"))
  }
  return roots.map((r) => resolve(r))
}
// The WRITABLE agent roots: user dir + registered custom folders only. Workspace
// (.github/agents, .<system>/agents) dirs are read-only in this UI — the app won't
// drop files into a repo the user may not intend to commit to.
function writableAgentRoots(): string[] {
  return [userAgentsDir(), ...settingsService.getAgentSources().folders].map(
    (r) => resolve(r)
  )
}
// Guard for agents:read. Basename must end with `.agent.md` and resolve inside a
// known agent-source dir. Same traversal / sibling-prefix protection as skills.
function assertAgentPath(filePath: string): void {
  const resolved = resolve(filePath)
  if (!basename(resolved).endsWith(AGENT_SUFFIX)) {
    throw new Error(`Refusing non-.agent.md path: ${filePath}`)
  }
  const inside = allAgentRoots().some(
    (root) => resolved === root || resolved.startsWith(root + sep)
  )
  if (!inside) {
    throw new Error(`Refusing agent path outside known sources: ${filePath}`)
  }
}
// Guard for agents:save/delete. Like assertAgentPath but restricted to WRITABLE
// roots, so a read-only workspace/github agent can't be overwritten or deleted.
function assertAgentWritablePath(filePath: string): void {
  const resolved = resolve(filePath)
  if (!basename(resolved).endsWith(AGENT_SUFFIX)) {
    throw new Error(`Refusing non-.agent.md path: ${filePath}`)
  }
  const inside = writableAgentRoots().some(
    (root) => resolved === root || resolved.startsWith(root + sep)
  )
  if (!inside) {
    throw new Error(
      `Refusing to modify an agent outside a writable source: ${filePath}`
    )
  }
}
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
// Read the current git branch for a workspace folder. Returns the branch name
// string, a short SHA when the HEAD is detached, or null when the folder is not
// a git repo. Prefers the `git` CLI (correct for worktrees/subdirs/packed refs),
// falling back to a direct .git/HEAD read when git isn't on PATH.
ipcMain.handle("git:branch", async (_event, path: string) => {
  if (!path?.trim()) return null
  const result = await readGitBranch(path.trim())
  if (!result) return null
  const val = result.value as {
    branch?: string
    detached?: boolean
    sha?: string
  }
  return val.branch ?? val.sha ?? null
})
// Show an OS desktop notification. The renderer decides WHETHER to notify (it
// knows which conversation is on screen and whether the window is focused) and
// calls this only when it wants one shown. Clicking the notification focuses the
// app window and — when the payload names a conversation — asks the renderer to
// switch to it (same channel the browser tab activator uses). No-ops silently if
// the OS doesn't support notifications.
ipcMain.on(
  "notifications:show",
  (
    _event,
    payload: { title: string; body: string; conversationId?: string }
  ) => {
    if (!Notification.isSupported()) return
    const title = payload?.title?.trim()
    if (!title) return
    const n = new Notification({
      title,
      body: payload?.body ?? "",
      silent: false,
    })
    n.on("click", () => {
      const win = mainWindow
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      const cid = payload?.conversationId
      if (cid && !win.webContents.isDestroyed()) {
        win.webContents.send("browser:activate-conversation", cid)
      }
    })
    n.show()
  }
)
// Git diff for one workspace-relative file, backing the changed-file pills'
// hover + the sidebar "Changes" review. Returns null when the workspace isn't a
// git repo (renderer falls back to current content) or the path escapes it.
ipcMain.handle(
  "git:diff",
  async (_event, workspace: string, relPath: string) => {
    if (!workspace?.trim() || !relPath?.trim()) return null
    // Confine: reject a path that escapes the workspace before shelling out.
    try {
      await resolveInWorkspaceReal(workspace.trim(), relPath.trim())
    } catch {
      return null
    }
    return gitDiffFile(workspace.trim(), relPath.trim())
  }
)
// Open a workspace file in the user's chosen IDE (Settings → Editor) — the click
// target of a code changed-file pill. Opens the repo root first (focuses an
// existing IDE window or opens the folder), then the file. "system" hands the
// file to the OS default app. Confined to the workspace. Returns "" on success
// or a short error string.
ipcMain.handle(
  "open-in-editor",
  async (_event, workspace: string, relPath: string) => {
    if (!workspace?.trim() || !relPath?.trim()) return "No path."
    let abs: string
    try {
      abs = await resolveInWorkspaceReal(workspace.trim(), relPath.trim())
    } catch {
      return "Path is outside the workspace."
    }
    return openInIde(workspace.trim(), abs, settingsService.getIde().ide)
  }
)
// Initial fullscreen state, queried by the renderer on mount.
ipcMain.handle("is-fullscreen", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  return win?.isFullScreen() ?? false
})
// The customizable system name (from NEXT_system_name). Registered as a
// synchronous handler so the renderer can set document.title on first paint
// without an async flash of the static HTML title. See config/system-name.ts.
ipcMain.on("system:name", (event) => {
  event.returnValue = {
    displayName: systemDisplayName(),
    dataDirName: dataDirName(),
    mainAgentName: mainAgentName(),
    // The effective brand theme, resolving the persisted in-app override over the
    // NEXT_accent_color / NEXT_neutral_color env presets over the built-in
    // defaults (DB > env > default); null when nothing overrides globals.css.
    theme: resolveBrandTheme(),
  }
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
  // process_run: the DAG orchestrator (plan 025). Deterministic executor seam —
  // the orchestrator is scheduling logic; the phases it drives are LLM work run
  // INLINE via runAgentLoop in forked workers (the spawnSubagent precedent), not
  // re-enqueued (which would deadlock under the concurrency cap on a blocking
  // wait). autoResume so a run interrupted by a quit resumes at its persisted
  // per-phase frontier. hasIndependentSurface: a run may be started headlessly
  // and is observable via the 026 monitor, so it's exempt from the 022 reaper.
  taskRunner.registerKind(PROCESS_RUN_KIND, {
    autoResume: true,
    hasIndependentSurface: true,
    run: processService.execute,
  })
  taskRunner.start()
  registerTaskHandlers(taskRunner)
  registerProcessHandlers(taskRunner, processService)
  registerIndexHandlers(taskRunner, indexService)
  // Migrate a pre-settings env-configured key into a stored provider account, so
  // existing dev setups keep working without re-entering it (no-op once any
  // account exists). After this, the stored key is the source of truth.
  seedProviderFromEnvIfEmpty()
  // Materialize the user-level skills dir (~/.<system>/skills) and, on first
  // launch only, seed it with the app-bundled skills so users get editable
  // copies of the built-ins.
  initUserSkills()
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

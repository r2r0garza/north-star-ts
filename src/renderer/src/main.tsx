import React, { useCallback, useEffect, useRef, useState } from "react"
import ReactDOM from "react-dom/client"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar, MODE_TO_VIEW, type View } from "@/components/sidebar"
import { SidebarToggle } from "@/components/sidebar-toggle"
import {
  ActivityPanel,
  ActivityToggle,
  HeaderThemeToggle,
  readActivityOpen,
  readActivityPanelWidth,
  writeActivityOpen,
  type SidebarTab,
  type SidebarTabKind,
} from "@/components/activity-panel"
import { SettingsScreen } from "@/components/settings-screen"
import { SkillsScreen } from "@/components/skills-screen"
import { AgentsScreen } from "@/components/agents-screen"
import { McpScreen } from "@/components/mcp-screen"
import { ProcessScreen } from "@/components/process-screen"
import { DashboardsScreen } from "@/components/dashboards-screen"
import { StartupGuideDialog } from "@/components/startup-guide-dialog"
import { TaskTranscriptSheet } from "@/components/task-transcript-sheet"
import { TaskCompletionToasts } from "@/components/task-completion-toasts"
import {
  TerminalDrawer,
  TerminalToggle,
  useTerminalShortcut,
} from "@/components/terminal-drawer"
import { Toaster } from "@/components/ui/sonner"
import type { Mode, Task } from "@/types"
import { maybeNotify, refreshNotificationSettings } from "@/lib/notify"
import { applyThemeCss } from "@/lib/theme"
import { cn } from "@/lib/utils"
import App, { type AppHandle } from "./App"

const DEFAULT_MODE_TO_VIEW = {
  chat: "Chat",
  interactive: "Interactive",
  north_star: "North Star",
} as const satisfies Record<string, View>

// Deterministic infrastructure task kinds that repaint their own UI in place and
// run automatically (on open / poll), so a completion OS-notification would just
// be noise. Excluded from the background-task notification handler below.
const SILENT_TASK_KINDS = new Set(["dashboard_refresh", "workspace_index"])

// Tracks window fullscreen state so the sidebar toggle can reposition (the
// macOS traffic lights disappear in fullscreen, freeing the left edge).
function Shell() {
  const isMac = window.cowork.platform === "darwin"
  const reserveWindowControls = !isMac
  const [fullscreen, setFullscreen] = useState(false)
  // The active view, switched from the sidebar button group. North Star and
  // Interactive share the workspace-backed panel; Chat has its own.
  const [view, setView] = useState<View>("North Star")
  // The conversation currently shown. null = a fresh (uncreated) conversation;
  // it's created lazily on first send.
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null)
  // The project a fresh (uncreated) conversation will belong to — set when "+"
  // is clicked on a project section, null for an unassigned/"No Project" one.
  // Consumed by App to adopt the project's directory and stamp project_id on
  // create. Irrelevant once an existing conversation is selected (App reads the
  // project from the stored row).
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null)
  // Bumped whenever conversations change so the sidebar list refetches.
  const [refreshKey, setRefreshKey] = useState(0)
  const refreshConversations = () => setRefreshKey((k) => k + 1)
  useEffect(
    () =>
      window.cowork.db.conversations.onChange(() => {
        setRefreshKey((key) => key + 1)
      }),
    []
  )
  // Conversations with a turn currently streaming, reported up from App (which
  // owns the state). Drives the per-row spinner in the sidebar.
  const [runningConvos, setRunningConvos] = useState<Set<string>>(new Set())
  // Conversations whose turn is blocked waiting on the user (approval/question/
  // handoff), reported up from App. Drives the sidebar's "needs you" indicator,
  // which takes precedence over the running spinner.
  const [waitingConvos, setWaitingConvos] = useState<Set<string>>(new Set())
  // Whether the Settings sheet is open (opened from the sidebar gear).
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Whether the Skills view is open (opened from the sidebar footer). An in-panel
  // destination in the center region (sidebar stays visible); browses/edits
  // SKILL.md files. Mutually exclusive with Agents/Processes.
  const [skillsOpen, setSkillsOpen] = useState(false)
  // Whether the Agents view is open (opened from the sidebar footer). An in-panel
  // destination in the center region; authors <name>.agent.md agents.
  const [agentsOpen, setAgentsOpen] = useState(false)
  // Whether the Process view is open (opened from the sidebar footer). An in-panel
  // destination in the center region; authors process DAGs + monitors live runs.
  const [processOpen, setProcessOpen] = useState(false)
  // Whether the MCP view is open (opened from the sidebar footer). An in-panel
  // destination in the center region; browses/edits mcp.json server configs.
  const [mcpOpen, setMcpOpen] = useState(false)
  // Whether the Dashboards view is open (opened from the sidebar footer). An
  // in-panel destination in the center region; authors/views live dashboards
  // (plan 033). Mutually exclusive with the other footer overlays.
  const [dashboardsOpen, setDashboardsOpen] = useState(false)
  const [startupGuideOpen, setStartupGuideOpen] = useState(false)
  // Which tab Settings opens on. First launch (no provider configured) opens
  // straight to Providers so the user can set one up.
  const [settingsTab, setSettingsTab] = useState("backend")
  // Whether the right-hand Workspace Activity panel is open. Controlled here so
  // the toggle can live in the drag bar (macOS swallows clicks on floating
  // elements that merely overlap it) and "Run in background" can reveal it when
  // a task starts. Seeded from — and persisted back to — the panel's cookie.
  const [activityOpen, setActivityOpen] = useState(readActivityOpen)
  const [activityPanelWidth, setActivityPanelWidth] = useState(() =>
    readActivityOpen() ? readActivityPanelWidth() : 0
  )
  const [sidebarTabState, setSidebarTabState] = useState<{
    tabs: SidebarTab[]
    activeTabId: string | null
  }>({ tabs: [], activeTabId: null })
  const [terminalOpenByConversation, setTerminalOpenByConversation] = useState<
    Record<string, boolean>
  >({})
  const [freshTerminalConversationId, setFreshTerminalConversationId] =
    useState(() => crypto.randomUUID())
  const [adoptedTerminalConversation, setAdoptedTerminalConversation] =
    useState<{ from: string; to: string } | null>(null)
  const appRef = useRef<AppHandle | null>(null)
  const setActivity = (open: boolean) => {
    setActivityOpen(open)
    writeActivityOpen(open)
  }
  const closeFreshTerminalSessions = useCallback((conversationId: string) => {
    void window.cowork.terminal
      .list()
      .then((sessions) =>
        Promise.all(
          sessions
            .filter((session) => session.conversationId === conversationId)
            .map((session) => window.cowork.terminal.kill(session.id))
        )
      )
      .catch((err) => {
        console.warn("[terminal] failed to close fresh sessions:", err)
      })
  }, [])
  const openSidebarTab = useCallback((kind: SidebarTabKind) => {
    setSidebarTabState((state) => {
      const existing = state.tabs.find((tab) => tab.kind === kind)
      const tab = existing ?? { id: crypto.randomUUID(), kind }
      return {
        tabs: existing ? state.tabs : [...state.tabs, tab],
        activeTabId: tab.id,
      }
    })
    setActivity(true)
  }, [])
  const closeSidebarTab = useCallback((id: string) => {
    setSidebarTabState((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === id)
      const tabs = state.tabs.filter((tab) => tab.id !== id)
      if (tabs.length === 0) {
        setActivity(false)
        return { tabs, activeTabId: null }
      }
      return {
        tabs,
        activeTabId:
          state.activeTabId === id
            ? tabs[Math.min(index, tabs.length - 1)].id
            : state.activeTabId,
      }
    })
  }, [])
  // The active conversation's workspace root, reported up from App. Needed by the
  // sidebar's Changes review (git diffs + file:// previews) and browser opens.
  const [workspacePath, setWorkspacePath] = useState("")
  const terminalConversationId =
    activeConversationId ?? freshTerminalConversationId
  const terminalAvailable =
    view !== "Chat" &&
    terminalConversationId !== "" &&
    workspacePath.trim() !== ""
  const terminalOpen =
    terminalAvailable && terminalConversationId
      ? (terminalOpenByConversation[terminalConversationId] ?? false)
      : false
  const setTerminalOpenForActive = useCallback(
    (open: boolean | ((open: boolean) => boolean)) => {
      if (!terminalConversationId) return
      setTerminalOpenByConversation((state) => {
        const current = state[terminalConversationId] ?? false
        const next = typeof open === "function" ? open(current) : open
        return { ...state, [terminalConversationId]: next }
      })
    },
    [terminalConversationId]
  )
  const toggleTerminal = useCallback(() => {
    if (!terminalAvailable) return
    setTerminalOpenForActive((open) => !open)
  }, [setTerminalOpenForActive, terminalAvailable])
  // Open the Files tab when a transcript turn's "Review all" / "+N more" is clicked.
  const openFiles = () => openSidebarTab("files")
  // Open a workspace-relative html file in the sidebar agent browser.
  const openHtmlInBrowser = (relPath: string) => {
    if (!workspacePath) return
    window.cowork.setBrowserSurface("sidebar")
    openSidebarTab("browser")
    window.cowork.browserNavigate(`file://${workspacePath}/${relPath}`)
  }
  // The background task whose read-only transcript is open (null = closed).
  // Opened from the Workspace Activity panel or a completion toast.
  const [viewingTask, setViewingTask] = useState<Task | null>(null)
  // Whether the activity panel's History section is expanded (collapsed by
  // default). Owned here so a completion toast can force it open with the panel.
  const [historyExpanded, setHistoryExpanded] = useState(false)
  // Open the panel and reveal History — the completion toast's action.
  const revealHistory = () => {
    openSidebarTab("info")
    setHistoryExpanded(true)
  }
  // Popping the browser out gives the chat its width back; docking reopens the
  // panel and leaves its existing tabs intact.
  const handleBrowserPoppedOutChange = (poppedOut: boolean) => {
    setActivity(!poppedOut)
  }
  // Keep the theme control immediately to the left of Terminal when the right
  // panel is closed. When it opens, it moves left by the panel's width so it
  // remains in the main content area.
  const rightControlOffset = reserveWindowControls ? 140 : 16
  const terminalRightOffset = rightControlOffset + 32
  // Once the panel is open, the theme control sits just outside its left edge;
  // Terminal and the panel toggle remain within the panel's header area.
  const themeRightOffset = activityPanelWidth
    ? activityPanelWidth + 8
    : terminalAvailable
      ? terminalRightOffset + 30
      : rightControlOffset + 32

  useTerminalShortcut(terminalAvailable, toggleTerminal)

  useEffect(() => {
    window.cowork.isFullScreen().then(setFullscreen)
    return window.cowork.onFullScreenChange(setFullscreen)
  }, [])

  useEffect(() => {
    let cancelled = false
    window.cowork.settings
      .getConversations()
      .then((settings) => {
        if (!cancelled) setView(DEFAULT_MODE_TO_VIEW[settings.defaultMode])
      })
      .catch((err) => {
        console.warn("[settings] failed to load conversation settings:", err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Brand the window title from the customizable system name (NEXT_system_name),
  // overriding the static "Cowork" baked into index.html.
  useEffect(() => {
    document.title = window.cowork.system().displayName
  }, [])

  useEffect(() => {
    let cancelled = false
    window.cowork.settings
      .getOnboarding()
      .then((settings) => {
        if (!cancelled && !settings.hideStartupGuide) {
          setStartupGuideOpen(true)
        }
      })
      .catch((err) => {
        console.warn("[settings] failed to load onboarding settings:", err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Tell the agent browser which conversation is active, so it shows that
  // conversation's tab (or hides if this is a fresh/uncreated one).
  useEffect(() => {
    window.cowork.setActiveConversation(activeConversationId)
  }, [activeConversationId])

  // Reverse binding: clicking a tab in the agent browser switches the app to
  // that conversation. Resolve its mode to pick the right view, then reuse the
  // same path as a sidebar click.
  useEffect(() => {
    return window.cowork.onActivateConversation((id) => {
      void window.cowork.db.conversations.get(id).then((convo) => {
        if (convo) handleSelectConversation(id, convo.mode)
      })
    })
  }, [])

  // Desktop notifications for background tasks / delegated subagents finishing.
  // Global (not conversation-scoped like TaskCompletionToasts): a task can finish
  // for any conversation while you're looking at another. Resolve the task row for
  // its title + source conversation, then let maybeNotify apply the focus/view
  // gate (a task whose source conversation is on-screen and focused is silent).
  useEffect(() => {
    return window.cowork.tasks.onEvent((payload) => {
      const kind = payload.event.type
      if (kind !== "task_completed" && kind !== "task_failed") return
      void window.cowork.db.tasks
        .get(payload.taskId)
        .then((task) => {
          if (!task) return
          // Deterministic infrastructure kinds update their own UI surface in
          // place (a dashboard refresh repaints its widgets; an index updates the
          // strip) and run on open / poll — notifying on each would spam. Never
          // OS-notify for them, regardless of source.
          const taskKind = (task.input as { kind?: string } | null)?.kind
          if (taskKind && SILENT_TASK_KINDS.has(taskKind)) return
          // Source-less tasks are infrastructure with their own UI surface
          // (workspace_index) — born sourceConversationId=null by design. They're
          // not user-facing background work, so don't notify about them.
          const convoId = task.sourceConversationId
          if (!convoId) return
          void maybeNotify({
            kind: "taskComplete",
            title: task.title?.trim() || "Background task",
            body:
              kind === "task_failed"
                ? "A background task failed."
                : "A background task finished.",
            conversationId: convoId,
            isViewing: activeConversationId === convoId,
          })
        })
        .catch(() => {
          // Best-effort — a lookup failure just means no notification.
        })
    })
  }, [activeConversationId])

  // The agent navigated (with reveal-on-use) or a handoff needs the browser:
  // open and activate the Browser sidebar tab.
  useEffect(() => {
    return window.cowork.onBrowserRequestOpen(() => {
      openSidebarTab("browser")
    })
  }, [openSidebarTab])

  // First launch: if no LLM provider is configured yet, open Settings to the
  // Providers tab so the user configures one before sending a message.
  useEffect(() => {
    window.cowork.providers.hasActive().then((active) => {
      if (!active) {
        setSettingsTab("providers")
        setSettingsOpen(true)
      }
    })
  }, [])

  function openSettings(tab = "backend") {
    setSettingsTab(tab)
    setSettingsOpen(true)
    setAgentsOpen(false)
    setSkillsOpen(false)
    setProcessOpen(false)
    setMcpOpen(false)
    setDashboardsOpen(false)
  }

  // Cmd+, (macOS) / Ctrl+, (Windows/Linux) opens Settings — the platform's
  // conventional shortcut. metaKey||ctrlKey covers both without a platform check.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "," && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setSettingsOpen(true)
        setAgentsOpen(false)
        setSkillsOpen(false)
        setProcessOpen(false)
        setMcpOpen(false)
        setDashboardsOpen(false)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  // Switching views starts a fresh conversation for that view (the sidebar
  // shows prior ones to reopen).
  function handleViewChange(next: View) {
    if (!activeConversationId) {
      closeFreshTerminalSessions(freshTerminalConversationId)
    }
    setView(next)
    setActiveConversationId(null)
    setPendingProjectId(null)
    setFreshTerminalConversationId(crypto.randomUUID())
    setAgentsOpen(false)
    setSkillsOpen(false)
    setProcessOpen(false)
    setMcpOpen(false)
    setDashboardsOpen(false)
  }

  // Reopen a stored conversation — switch the view to match its mode. The
  // pending project is only for uncreated conversations; clear it (App reads the
  // stored conversation's own project).
  function handleSelectConversation(id: string, mode: Mode) {
    if (!activeConversationId) {
      appRef.current?.prepareComposerTransition("populated")
      closeFreshTerminalSessions(freshTerminalConversationId)
    }
    setView(MODE_TO_VIEW[mode])
    setActiveConversationId(id)
    setPendingProjectId(null)
    setAgentsOpen(false)
    setSkillsOpen(false)
    setProcessOpen(false)
    setMcpOpen(false)
    setDashboardsOpen(false)
  }

  // Start a fresh conversation, optionally in a project (its directory is
  // auto-adopted for workspace views).
  function handleNewConversation(projectId: string | null = null) {
    if (!activeConversationId) {
      closeFreshTerminalSessions(freshTerminalConversationId)
    } else {
      appRef.current?.prepareComposerTransition("empty")
    }
    setActiveConversationId(null)
    setPendingProjectId(projectId)
    setFreshTerminalConversationId(crypto.randomUUID())
    setAgentsOpen(false)
    setSkillsOpen(false)
    setProcessOpen(false)
    setMcpOpen(false)
    setDashboardsOpen(false)
  }

  // A session was deleted from the sidebar. If it was the active one, drop back
  // to a fresh (uncreated) conversation; refresh the list either way.
  function handleConversationDeleted(id: string) {
    if (id === activeConversationId) setActiveConversationId(null)
    refreshConversations()
  }

  function dismissStartupGuide(dontShowAgain: boolean) {
    setStartupGuideOpen(false)
    if (!dontShowAgain) return
    void window.cowork.settings
      .setOnboarding({ hideStartupGuide: true })
      .catch((err) => {
        console.warn("[settings] failed to save onboarding settings:", err)
      })
  }

  return (
    <SidebarProvider className="relative">
      {/* Top drag bar (replaces the OS title bar). Keep the open activity panel
          outside the drag surface so its tab strip remains interactive. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-11">
        <div
          className="pointer-events-auto absolute inset-y-0 left-0 [-webkit-app-region:drag]"
          style={{ right: activityOpen ? activityPanelWidth : 0 }}
        />
        <SidebarToggle fullscreen={fullscreen} isMac={isMac} />
        <HeaderThemeToggle rightOffset={themeRightOffset} />
        {terminalAvailable &&
          !(
            agentsOpen ||
            skillsOpen ||
            processOpen ||
            mcpOpen ||
            dashboardsOpen
          ) && (
            <TerminalToggle
              open={terminalOpen}
              onToggle={toggleTerminal}
              rightOffset={terminalRightOffset}
            />
          )}
        {!(
          agentsOpen ||
          skillsOpen ||
          processOpen ||
          mcpOpen ||
          dashboardsOpen
        ) && (
          <ActivityToggle
            open={activityOpen}
            onToggle={() => setActivity(!activityOpen)}
            reserveWindowControls={reserveWindowControls}
          />
        )}
      </div>
      <AppSidebar
        view={view}
        onViewChange={handleViewChange}
        activeConversationId={activeConversationId}
        onSelectConversation={handleSelectConversation}
        onNewConversation={handleNewConversation}
        onConversationDeleted={handleConversationDeleted}
        onSettingsClick={() => openSettings()}
        onSkillsClick={() => {
          setSkillsOpen(true)
          setAgentsOpen(false)
          setProcessOpen(false)
          setMcpOpen(false)
          setDashboardsOpen(false)
        }}
        onAgentsClick={() => {
          setAgentsOpen(true)
          setSkillsOpen(false)
          setProcessOpen(false)
          setMcpOpen(false)
          setDashboardsOpen(false)
        }}
        onProcessClick={() => {
          setProcessOpen(true)
          setAgentsOpen(false)
          setSkillsOpen(false)
          setMcpOpen(false)
          setDashboardsOpen(false)
        }}
        onMcpClick={() => {
          setMcpOpen(true)
          setProcessOpen(false)
          setAgentsOpen(false)
          setSkillsOpen(false)
          setDashboardsOpen(false)
        }}
        onDashboardsClick={() => {
          setDashboardsOpen(true)
          setMcpOpen(false)
          setProcessOpen(false)
          setAgentsOpen(false)
          setSkillsOpen(false)
        }}
        refreshKey={refreshKey}
        runningConvos={runningConvos}
        waitingConvos={waitingConvos}
      />
      {/* Center region: App and the Agents/Skills/Processes panels share this
          flex slot, sitting between the sidebar gap and the activity-panel gap.
          App stays mounted (hidden, not unmounted) when a panel is open so
          streaming/turn state survives. */}
      <div className="relative flex h-svh min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1 overflow-hidden",
            (agentsOpen ||
              skillsOpen ||
              processOpen ||
              mcpOpen ||
              dashboardsOpen) &&
              "hidden"
          )}
        >
          <App
            ref={appRef}
            view={view}
            conversationId={activeConversationId}
            pendingProjectId={pendingProjectId}
            onConversationCreated={(id) => {
              const pendingId = freshTerminalConversationId
              void window.cowork.terminal.adoptConversation(pendingId, id)
              setAdoptedTerminalConversation({ from: pendingId, to: id })
              setActiveConversationId(id)
              setTerminalOpenByConversation((state) => {
                if (!(pendingId in state)) return state
                const next = { ...state, [id]: state[pendingId] }
                delete next[pendingId]
                return next
              })
              setFreshTerminalConversationId(crypto.randomUUID())
              refreshConversations()
            }}
            onConversationChanged={refreshConversations}
            onOpenSettings={openSettings}
            settingsOpen={settingsOpen}
            rightPanelOpen={activityOpen}
            onWorkspaceChange={setWorkspacePath}
            onReviewFiles={openFiles}
            onOpenHtml={openHtmlInBrowser}
            onRanInBackground={() => openSidebarTab("info")}
            onRunningConvosChange={setRunningConvos}
            onWaitingConvosChange={setWaitingConvos}
          />
        </div>
        {agentsOpen && <AgentsScreen onClose={() => setAgentsOpen(false)} />}
        {skillsOpen && <SkillsScreen onClose={() => setSkillsOpen(false)} />}
        {processOpen && <ProcessScreen onClose={() => setProcessOpen(false)} />}
        {mcpOpen && <McpScreen onClose={() => setMcpOpen(false)} />}
        {dashboardsOpen && (
          <DashboardsScreen onClose={() => setDashboardsOpen(false)} />
        )}
        <TerminalDrawer
          open={terminalAvailable && terminalOpen}
          conversationId={terminalConversationId}
          workspace={workspacePath}
          replaceSessionsOnWorkspaceChange={activeConversationId === null}
          adoptedConversation={adoptedTerminalConversation}
          onAdoptionApplied={() => setAdoptedTerminalConversation(null)}
          onOpenChange={setTerminalOpenForActive}
          onAddSelectionToMessage={(text) =>
            appRef.current?.appendTerminalSelection(text)
          }
        />
      </div>
      <ActivityPanel
        conversationId={activeConversationId}
        open={activityOpen}
        tabs={sidebarTabState.tabs}
        activeTabId={sidebarTabState.activeTabId}
        reserveWindowControls={reserveWindowControls}
        browserObscured={
          settingsOpen || startupGuideOpen || viewingTask !== null
        }
        workspace={workspacePath}
        onAddFileSelection={(selection) =>
          appRef.current?.appendFileSelection(selection)
        }
        onOpenChange={setActivity}
        onActiveTabChange={(id) =>
          setSidebarTabState((state) => ({ ...state, activeTabId: id }))
        }
        onOpenTab={openSidebarTab}
        onCloseTab={closeSidebarTab}
        onOpenTask={setViewingTask}
        historyExpanded={historyExpanded}
        onHistoryExpandedChange={setHistoryExpanded}
        onRanInBackground={() => openSidebarTab("info")}
        onBrowserPoppedOutChange={handleBrowserPoppedOutChange}
        onWidthChange={setActivityPanelWidth}
      />
      <TaskCompletionToasts
        conversationId={activeConversationId}
        onReveal={revealHistory}
      />
      <Toaster />
      <StartupGuideDialog
        agentName={window.cowork.system().mainAgentName}
        open={startupGuideOpen}
        onDismiss={dismissStartupGuide}
      />
      <TaskTranscriptSheet
        task={viewingTask}
        open={viewingTask !== null}
        onOpenChange={(open) => {
          if (!open) setViewingTask(null)
        }}
      />
      <SettingsScreen
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open)
          // Re-read notification settings when the sheet closes so a change to
          // the toggles takes effect immediately (the renderer caches them).
          if (!open) refreshNotificationSettings()
        }}
        initialTab={settingsTab}
      />
    </SidebarProvider>
  )
}

// Apply the effective brand theme (persisted override > env presets > defaults)
// BEFORE the first render, so there's no flash of the default green. The main
// process resolves the precedence and returns the recolored token declarations
// (or null when nothing overrides globals.css); applyThemeCss (shared with the
// Settings → Appearance live preview) writes them into <style id="brand-theme">.
function applyBrandTheme() {
  applyThemeCss(window.cowork.system().theme)
}
applyBrandTheme()

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  </React.StrictMode>
)

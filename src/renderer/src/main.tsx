import React, { useEffect, useState } from "react"
import ReactDOM from "react-dom/client"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar, MODE_TO_VIEW, type View } from "@/components/sidebar"
import { SidebarToggle } from "@/components/sidebar-toggle"
import {
  ActivityPanel,
  ActivityToggle,
  SidebarModeToggle,
  readActivityOpen,
  writeActivityOpen,
  readSidebarMode,
  writeSidebarMode,
  type SidebarMode,
} from "@/components/activity-panel"
import { SettingsScreen } from "@/components/settings-screen"
import { SkillsScreen } from "@/components/skills-screen"
import { AgentsScreen } from "@/components/agents-screen"
import { ProcessScreen } from "@/components/process-screen"
import { TaskTranscriptSheet } from "@/components/task-transcript-sheet"
import { TaskCompletionToasts } from "@/components/task-completion-toasts"
import { Toaster } from "@/components/ui/sonner"
import type { Mode, Task } from "@/types"
import type { ChangedFile } from "@/lib/timeline"
import { maybeNotify, refreshNotificationSettings } from "@/lib/notify"
import { applyThemeCss } from "@/lib/theme"
import { cn } from "@/lib/utils"
import App from "./App"

// Tracks window fullscreen state so the sidebar toggle can reposition (the
// macOS traffic lights disappear in fullscreen, freeing the left edge).
function Shell() {
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
  // Which tab Settings opens on. First launch (no provider configured) opens
  // straight to Providers so the user can set one up.
  const [settingsTab, setSettingsTab] = useState("backend")
  // Whether the right-hand Workspace Activity panel is open. Controlled here so
  // the toggle can live in the drag bar (macOS swallows clicks on floating
  // elements that merely overlap it) and "Run in background" can reveal it when
  // a task starts. Seeded from — and persisted back to — the panel's cookie.
  const [activityOpen, setActivityOpen] = useState(readActivityOpen)
  const setActivity = (open: boolean) => {
    setActivityOpen(open)
    writeActivityOpen(open)
  }
  // Which content the right panel shows: "info" (Workspace Activity), "browser"
  // (the agent's live browser), or "changes" (the changed-file review). Global
  // (one choice for the whole app), persisted to a cookie like the open state.
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(readSidebarMode)
  const changeSidebarMode = (mode: SidebarMode) => {
    setSidebarMode(mode)
    writeSidebarMode(mode)
    setActivity(true)
  }
  // The active conversation's workspace root, reported up from App. Needed by the
  // sidebar's Changes review (git diffs + file:// previews) and browser opens.
  const [workspacePath, setWorkspacePath] = useState("")
  // Files under review in the sidebar's Changes mode, set when a transcript turn's
  // "Review all" / "+N more" is clicked.
  const [reviewFiles, setReviewFiles] = useState<ChangedFile[]>([])
  // Open the Changes review for a turn's files: stash them, switch the panel to
  // Changes mode, and open it.
  const openChangesReview = (files: ChangedFile[]) => {
    setReviewFiles(files)
    setSidebarMode("changes")
    writeSidebarMode("changes")
    setActivity(true)
  }
  // Open a workspace-relative html file in the sidebar agent browser: dock the
  // browser, switch the panel to Browser mode, and navigate to its file:// URL.
  const openHtmlInBrowser = (relPath: string) => {
    if (!workspacePath) return
    window.cowork.setBrowserSurface("sidebar")
    setSidebarMode("browser")
    writeSidebarMode("browser")
    setActivity(true)
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
    setActivity(true)
    setHistoryExpanded(true)
  }
  // Popping the browser out to its own window empties the panel's browser slot,
  // so collapse the panel to give the chat the space back; docking it back re-
  // opens it. Choosing Info or Changes from the mode dropdown re-opens on its own
  // (changeSidebarMode forces it open), which is the "unless they pick info/
  // changes" case.
  const handleBrowserPoppedOutChange = (poppedOut: boolean) => {
    setActivity(!poppedOut)
  }

  useEffect(() => {
    window.cowork.isFullScreen().then(setFullscreen)
    return window.cowork.onFullScreenChange(setFullscreen)
  }, [])

  // Brand the window title from the customizable system name (NEXT_system_name),
  // overriding the static "Cowork" baked into index.html.
  useEffect(() => {
    document.title = window.cowork.system().displayName
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

  // The agent navigated (with reveal-on-use) or a handoff needs the browser: open
  // the right panel in Browser mode. The sidebar equivalent of the separate
  // window revealing itself.
  useEffect(() => {
    return window.cowork.onBrowserRequestOpen(() => {
      setSidebarMode("browser")
      writeSidebarMode("browser")
      setActivity(true)
    })
  }, [])

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
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  // Switching views starts a fresh conversation for that view (the sidebar
  // shows prior ones to reopen).
  function handleViewChange(next: View) {
    setView(next)
    setActiveConversationId(null)
    setPendingProjectId(null)
    setAgentsOpen(false)
    setSkillsOpen(false)
    setProcessOpen(false)
  }

  // Reopen a stored conversation — switch the view to match its mode. The
  // pending project is only for uncreated conversations; clear it (App reads the
  // stored conversation's own project).
  function handleSelectConversation(id: string, mode: Mode) {
    setView(MODE_TO_VIEW[mode])
    setActiveConversationId(id)
    setPendingProjectId(null)
    setAgentsOpen(false)
    setSkillsOpen(false)
    setProcessOpen(false)
  }

  // Start a fresh conversation, optionally in a project (its directory is
  // auto-adopted for workspace views).
  function handleNewConversation(projectId: string | null = null) {
    setActiveConversationId(null)
    setPendingProjectId(projectId)
    setAgentsOpen(false)
    setSkillsOpen(false)
    setProcessOpen(false)
  }

  // A session was deleted from the sidebar. If it was the active one, drop back
  // to a fresh (uncreated) conversation; refresh the list either way.
  function handleConversationDeleted(id: string) {
    if (id === activeConversationId) setActiveConversationId(null)
    refreshConversations()
  }

  return (
    <SidebarProvider className="relative">
      {/* Top drag bar (replaces the OS title bar). The toggle is a no-drag
          child of this region so macOS lets its click through. */}
      <div className="absolute inset-x-0 top-0 z-20 h-11 [-webkit-app-region:drag]">
        <SidebarToggle fullscreen={fullscreen} />
        {/* The Info/Browser/Changes mode dropdown and the right-panel toggle are
            conversation-specific, so hide them while a full-screen overlay
            (Agents / Skills / Processes) is open. The theme toggle stays (it
            lives inside SidebarModeToggle and is useful everywhere). */}
        <SidebarModeToggle
          mode={sidebarMode}
          onModeChange={changeSidebarMode}
          showModeSelect={!(agentsOpen || skillsOpen || processOpen)}
        />
        {!(agentsOpen || skillsOpen || processOpen) && (
          <ActivityToggle
            open={activityOpen}
            onToggle={() => setActivity(!activityOpen)}
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
        }}
        onAgentsClick={() => {
          setAgentsOpen(true)
          setSkillsOpen(false)
          setProcessOpen(false)
        }}
        onProcessClick={() => {
          setProcessOpen(true)
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
      <div className="relative flex min-h-0 w-full flex-1">
        <div
          className={cn(
            "flex min-h-0 flex-1",
            (agentsOpen || skillsOpen || processOpen) && "hidden"
          )}
        >
          <App
            view={view}
            conversationId={activeConversationId}
            pendingProjectId={pendingProjectId}
            onConversationCreated={(id) => {
              setActiveConversationId(id)
              refreshConversations()
            }}
            onConversationChanged={refreshConversations}
            onOpenSettings={openSettings}
            settingsOpen={settingsOpen}
            rightPanelOpen={activityOpen}
            onWorkspaceChange={setWorkspacePath}
            onReviewChanges={openChangesReview}
            onOpenHtml={openHtmlInBrowser}
            onRanInBackground={() => setActivity(true)}
            onRunningConvosChange={setRunningConvos}
            onWaitingConvosChange={setWaitingConvos}
          />
        </div>
        {agentsOpen && <AgentsScreen onClose={() => setAgentsOpen(false)} />}
        {skillsOpen && <SkillsScreen onClose={() => setSkillsOpen(false)} />}
        {processOpen && <ProcessScreen onClose={() => setProcessOpen(false)} />}
      </div>
      <ActivityPanel
        conversationId={activeConversationId}
        open={activityOpen}
        mode={sidebarMode}
        browserObscured={settingsOpen || viewingTask !== null}
        workspace={workspacePath}
        changedFiles={reviewFiles}
        onOpenHtml={openHtmlInBrowser}
        onOpenChange={setActivity}
        onOpenTask={setViewingTask}
        historyExpanded={historyExpanded}
        onHistoryExpandedChange={setHistoryExpanded}
        onRanInBackground={() => setActivity(true)}
        onBrowserPoppedOutChange={handleBrowserPoppedOutChange}
      />
      <TaskCompletionToasts
        conversationId={activeConversationId}
        onReveal={revealHistory}
      />
      <Toaster />
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

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
  readActivityOpen,
  writeActivityOpen,
} from "@/components/activity-panel"
import { SettingsSheet } from "@/components/settings-sheet"
import { TaskTranscriptSheet } from "@/components/task-transcript-sheet"
import { TaskCompletionToasts } from "@/components/task-completion-toasts"
import { Toaster } from "@/components/ui/sonner"
import type { Mode, Task } from "@/types"
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
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  // Bumped whenever conversations change so the sidebar list refetches.
  const [refreshKey, setRefreshKey] = useState(0)
  const refreshConversations = () => setRefreshKey((k) => k + 1)
  // Whether the Settings sheet is open (opened from the sidebar gear).
  const [settingsOpen, setSettingsOpen] = useState(false)
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

  useEffect(() => {
    window.cowork.isFullScreen().then(setFullscreen)
    return window.cowork.onFullScreenChange(setFullscreen)
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
  }

  // Switching views starts a fresh conversation for that view (the sidebar
  // shows prior ones to reopen).
  function handleViewChange(next: View) {
    setView(next)
    setActiveConversationId(null)
  }

  // Reopen a stored conversation — switch the view to match its mode.
  function handleSelectConversation(id: string, mode: Mode) {
    setView(MODE_TO_VIEW[mode])
    setActiveConversationId(id)
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
        <ActivityToggle open={activityOpen} onToggle={() => setActivity(!activityOpen)} />
      </div>
      <AppSidebar
        view={view}
        onViewChange={handleViewChange}
        activeConversationId={activeConversationId}
        onSelectConversation={handleSelectConversation}
        onNewConversation={() => setActiveConversationId(null)}
        onConversationDeleted={handleConversationDeleted}
        onSettingsClick={() => openSettings()}
        refreshKey={refreshKey}
      />
      <App
        view={view}
        conversationId={activeConversationId}
        onConversationCreated={(id) => {
          setActiveConversationId(id)
          refreshConversations()
        }}
        onConversationChanged={refreshConversations}
        onOpenSettings={openSettings}
        settingsOpen={settingsOpen}
        onRanInBackground={() => setActivity(true)}
      />
      <ActivityPanel
        conversationId={activeConversationId}
        open={activityOpen}
        onOpenChange={setActivity}
        onOpenTask={setViewingTask}
        historyExpanded={historyExpanded}
        onHistoryExpandedChange={setHistoryExpanded}
        onRanInBackground={() => setActivity(true)}
      />
      <TaskCompletionToasts conversationId={activeConversationId} onReveal={revealHistory} />
      <Toaster />
      <TaskTranscriptSheet
        task={viewingTask}
        open={viewingTask !== null}
        onOpenChange={(open) => {
          if (!open) setViewingTask(null)
        }}
      />
      <SettingsSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initialTab={settingsTab}
      />
    </SidebarProvider>
  )
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  </React.StrictMode>
)

import React, { useEffect, useState } from "react"
import ReactDOM from "react-dom/client"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar, MODE_TO_VIEW, type View } from "@/components/sidebar"
import { SidebarToggle } from "@/components/sidebar-toggle"
import { SettingsSheet } from "@/components/settings-sheet"
import type { Mode } from "@/types"
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

  useEffect(() => {
    window.cowork.isFullScreen().then(setFullscreen)
    return window.cowork.onFullScreenChange(setFullscreen)
  }, [])

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
      </div>
      <AppSidebar
        view={view}
        onViewChange={handleViewChange}
        activeConversationId={activeConversationId}
        onSelectConversation={handleSelectConversation}
        onNewConversation={() => setActiveConversationId(null)}
        onConversationDeleted={handleConversationDeleted}
        onSettingsClick={() => setSettingsOpen(true)}
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
      />
      <SettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />
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

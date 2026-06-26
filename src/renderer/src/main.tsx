import React, { useEffect, useState } from "react"
import ReactDOM from "react-dom/client"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar, type View } from "@/components/sidebar"
import { SidebarToggle } from "@/components/sidebar-toggle"
import App from "./App"

// Tracks window fullscreen state so the sidebar toggle can reposition (the
// macOS traffic lights disappear in fullscreen, freeing the left edge).
function Shell() {
  const [fullscreen, setFullscreen] = useState(false)
  // The active view, switched from the sidebar button group. North Star and
  // Interactive share the workspace-backed panel; Chat has its own.
  const [view, setView] = useState<View>("North Star")

  useEffect(() => {
    window.cowork.isFullScreen().then(setFullscreen)
    return window.cowork.onFullScreenChange(setFullscreen)
  }, [])

  return (
    <SidebarProvider className="relative">
      {/* Top drag bar (replaces the OS title bar). The toggle is a no-drag
          child of this region so macOS lets its click through. */}
      <div className="absolute inset-x-0 top-0 z-20 h-11 [-webkit-app-region:drag]">
        <SidebarToggle fullscreen={fullscreen} />
      </div>
      <AppSidebar view={view} onViewChange={setView} />
      <App view={view} />
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

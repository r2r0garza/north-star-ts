import React, { useEffect, useState } from "react"
import ReactDOM from "react-dom/client"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/sidebar"
import { SidebarToggle } from "@/components/sidebar-toggle"
import App from "./App"

// Tracks window fullscreen state so the sidebar toggle can reposition (the
// macOS traffic lights disappear in fullscreen, freeing the left edge).
function Shell() {
  const [fullscreen, setFullscreen] = useState(false)

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
      <AppSidebar />
      <App />
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

import { PanelLeft } from "lucide-react"
import { useSidebar } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

// Sidebar collapse/expand button. Rendered as a no-drag child of the top drag
// bar (see Shell) so macOS lets the click through — a floating element merely
// overlapping a drag region gets its clicks swallowed by the OS.
//
// When not fullscreen it sits to the right of the macOS traffic lights; in
// fullscreen (no traffic lights) it shifts to the left edge. The position is
// the same whether the sidebar is open or collapsed, so it reads as part of the
// sidebar when open and over the main content when collapsed.
export function SidebarToggle({
  fullscreen,
  isMac,
}: {
  fullscreen: boolean
  isMac: boolean
}) {
  const { toggleSidebar, state } = useSidebar()
  return (
    <button
      type="button"
      onClick={toggleSidebar}
      aria-label={state === "expanded" ? "Collapse sidebar" : "Expand sidebar"}
      title={state === "expanded" ? "Collapse sidebar" : "Expand sidebar"}
      className={cn(
        "absolute top-2.5 z-10 [-webkit-app-region:no-drag]",
        "flex size-7 items-center justify-center rounded-md",
        "text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        !isMac || fullscreen ? "left-4" : "left-20"
      )}
    >
      <PanelLeft className="size-4.5" />
    </button>
  )
}

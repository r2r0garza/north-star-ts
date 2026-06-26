import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
} from "@/components/ui/sidebar"

export function AppSidebar() {
  return (
    <Sidebar>
      {/* Top padding clears the macOS traffic lights / sidebar toggle. Window
          dragging is handled by the top bar in Shell, not here — a drag region
          on the header would swallow the toggle button's clicks. */}
      <SidebarHeader className="h-12" />
      <SidebarContent>
        <SidebarGroup />
        <SidebarGroup />
      </SidebarContent>
      <SidebarFooter />
    </Sidebar>
  )
}

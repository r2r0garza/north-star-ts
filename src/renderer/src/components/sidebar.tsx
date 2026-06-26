import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
} from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"

export const VIEWS = ["Chat", "Interactive", "North Star"] as const
export type View = (typeof VIEWS)[number]

export function AppSidebar({
  view,
  onViewChange,
}: {
  view: View
  onViewChange: (view: View) => void
}) {
  return (
    <Sidebar>
      {/* Top padding clears the macOS traffic lights / sidebar toggle. Window
          dragging is handled by the top bar in Shell, not here — a drag region
          on the header would swallow the toggle button's clicks. */}
      <SidebarHeader className="h-12" />
      {/* View switcher — Chat / Interactive / North Star. */}
      <div className="px-2 pb-2">
        <ButtonGroup className="w-full">
          {VIEWS.map((v) => (
            <Button
              key={v}
              type="button"
              size="sm"
              variant={view === v ? "default" : "outline"}
              onClick={() => onViewChange(v)}
              className="flex-1"
            >
              {v}
            </Button>
          ))}
        </ButtonGroup>
      </div>
      <SidebarContent>
        <SidebarGroup />
        <SidebarGroup />
      </SidebarContent>
      <SidebarFooter />
    </Sidebar>
  )
}

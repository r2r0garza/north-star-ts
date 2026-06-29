import * as React from "react"
import { PanelRight } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
} from "@/components/ui/sidebar"
import { TasksSection } from "@/components/tasks-section"
import type { Task } from "@/types"

// The right-hand Workspace Activity panel. Deliberately SELF-CONTAINED rather
// than a second shadcn <Sidebar>: that component shares one SidebarContext (a
// single open state, Cmd+B, and the `sidebar_state` cookie) across every
// instance, so a right Sidebar would collapse in lockstep with the left one.
// This panel keeps its own collapse state (controlled by the Shell), shortcut
// (Cmd/Ctrl+J), and cookie, and only reuses the left sidebar's visual
// primitives (which are plain styled divs). It answers "what's happening / what
// needs my attention" for the active session — this PR fills in the Tasks
// section; future sections (Indexing, Todos, Approvals, Workspace status) slot
// in as more <ActivitySection>s.

const ACTIVITY_COOKIE_NAME = "activity_state"
const ACTIVITY_COOKIE_MAX_AGE = 60 * 60 * 24 * 7
const ACTIVITY_KEYBOARD_SHORTCUT = "j"
const ACTIVITY_WIDTH = "18rem"

// Read the persisted open state from the cookie (defaults to closed — the panel
// is opt-in so it doesn't crowd the chat by default). Exported so the Shell can
// seed its initial state from the same cookie.
export function readActivityOpen(): boolean {
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${ACTIVITY_COOKIE_NAME}=`))
  return match?.split("=")[1] === "true"
}

// Persist the open state to the cookie (mirrors the left sidebar's cookie write).
export function writeActivityOpen(open: boolean): void {
  document.cookie = `${ACTIVITY_COOKIE_NAME}=${open}; path=/; max-age=${ACTIVITY_COOKIE_MAX_AGE}`
}

// The collapse/expand button. Like SidebarToggle, it MUST be rendered as a
// no-drag child of the top drag bar (in the Shell): a floating element merely
// overlapping the drag region gets its clicks swallowed by macOS. Pinned to the
// right edge.
export function ActivityToggle({
  open,
  onToggle,
}: {
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={open ? "Collapse activity panel" : "Expand activity panel"}
      title={open ? "Collapse activity panel" : "Expand activity panel"}
      className={cn(
        "absolute top-2.5 right-4 z-10 [-webkit-app-region:no-drag]",
        "flex size-7 items-center justify-center rounded-md",
        "text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      )}
    >
      <PanelRight className="size-4.5" />
    </button>
  )
}

// A titled section inside the panel. Reuses the sidebar group primitives for
// visual parity with the left sidebar. Extensible: drop in more sections later.
export function ActivitySection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{title}</SidebarGroupLabel>
      <SidebarGroupContent>{children}</SidebarGroupContent>
    </SidebarGroup>
  )
}

export function ActivityPanel({
  conversationId,
  open,
  onOpenChange,
  onOpenTask,
}: {
  conversationId: string | null
  // Controlled open state (the Shell owns it so the toggle can live in the drag
  // bar and "Run in background" can force the panel open).
  open: boolean
  onOpenChange: (open: boolean) => void
  // Open a task's read-only transcript (the Shell hosts the viewer).
  onOpenTask: (task: Task) => void
}) {
  // Cmd/Ctrl+J toggles the panel (the left sidebar owns Cmd/Ctrl+B).
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === ACTIVITY_KEYBOARD_SHORTCUT &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        onOpenChange(!open)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [open, onOpenChange])

  return (
    // Layout gap that the main content flexes against (width animates to 0 when
    // collapsed), mirroring the left sidebar's gap+container split.
    <div
      data-state={open ? "expanded" : "collapsed"}
      className={cn(
        "relative hidden h-svh shrink-0 bg-transparent transition-[width] duration-200 ease-linear md:block",
        open ? "w-(--activity-width)" : "w-0"
      )}
      style={{ "--activity-width": ACTIVITY_WIDTH } as React.CSSProperties}
    >
      <div
        className={cn(
          "fixed inset-y-0 right-0 z-0 flex h-svh w-(--activity-width) flex-col border-l bg-sidebar text-sidebar-foreground transition-[right] duration-200 ease-linear",
          open ? "right-0" : "right-[calc(var(--activity-width)*-1)]"
        )}
        style={{ "--activity-width": ACTIVITY_WIDTH } as React.CSSProperties}
      >
        {/* Clears the top drag bar / toggle row. */}
        <SidebarHeader className="h-12 justify-center px-4">
          <span className="text-xs font-medium text-sidebar-foreground/70">
            Workspace Activity
          </span>
        </SidebarHeader>
        <SidebarContent>
          <ActivitySection title="Tasks">
            <TasksSection conversationId={conversationId} onOpenTask={onOpenTask} />
          </ActivitySection>
        </SidebarContent>
      </div>
    </div>
  )
}

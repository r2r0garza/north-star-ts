import * as React from "react"
import {
  PanelRight,
  ChevronRight,
  RotateCw,
  ExternalLink,
  SquareDashedMousePointer,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
} from "@/components/ui/sidebar"
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TasksSection } from "@/components/tasks-section"
import { TasksHistorySection } from "@/components/tasks-history-section"
import { TodosSection } from "@/components/todos-section"
import { IndexingSection } from "@/components/indexing-section"
import { ChangesPanel } from "@/components/changes-panel"
import type { ChangedFile } from "@/lib/timeline"
import type { Task } from "@/types"

// The right-hand panel. It has TWO modes, chosen from a dropdown in the drag bar
// (see SidebarModeToggle): "info" shows Workspace Activity (Tasks / Indexing /
// Todos / History); "browser" shows the agent's live browser for the active
// conversation, embedded as a native WebContentsView positioned to the panel's
// slot (see BrowserSlot + the main-process SidebarBrowserHost).
//
// Deliberately SELF-CONTAINED rather than a second shadcn <Sidebar>: that
// component shares one SidebarContext (a single open state, Cmd+B, and the
// `sidebar_state` cookie) across every instance, so a right Sidebar would
// collapse in lockstep with the left one. This panel keeps its own collapse
// state (controlled by the Shell), shortcut (Cmd/Ctrl+J), and cookie, and only
// reuses the left sidebar's visual primitives (which are plain styled divs).

export type SidebarMode = "info" | "browser" | "changes"

const ACTIVITY_COOKIE_NAME = "activity_state"
const MODE_COOKIE_NAME = "sidebar_mode"
const BROWSER_WIDTH_COOKIE_NAME = "sidebar_browser_width"
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7
const ACTIVITY_KEYBOARD_SHORTCUT = "j"
// Info mode is a fixed narrow rail; browser mode is wider and resizable.
const INFO_WIDTH = "18rem"
const BROWSER_MIN_WIDTH = 360
// Leave room for the chat column when the panel is dragged wide.
const BROWSER_RIGHT_MARGIN = 320

function readCookie(name: string): string | undefined {
  return document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${name}=`))
    ?.split("=")[1]
}

function writeCookie(name: string, value: string): void {
  document.cookie = `${name}=${value}; path=/; max-age=${COOKIE_MAX_AGE}`
}

// Read the persisted open state from the cookie (defaults to closed — the panel
// is opt-in so it doesn't crowd the chat by default). Exported so the Shell can
// seed its initial state from the same cookie.
export function readActivityOpen(): boolean {
  return readCookie(ACTIVITY_COOKIE_NAME) === "true"
}

// Persist the open state to the cookie (mirrors the left sidebar's cookie write).
export function writeActivityOpen(open: boolean): void {
  writeCookie(ACTIVITY_COOKIE_NAME, String(open))
}

// Read/persist the panel mode (info vs browser). Global (one choice for the whole
// app), mirroring the open-state cookie.
export function readSidebarMode(): SidebarMode {
  return readCookie(MODE_COOKIE_NAME) === "browser" ? "browser" : "info"
}
export function writeSidebarMode(mode: SidebarMode): void {
  writeCookie(MODE_COOKIE_NAME, mode)
}

function readBrowserWidth(): number {
  const raw = Number(readCookie(BROWSER_WIDTH_COOKIE_NAME))
  if (Number.isFinite(raw) && raw >= BROWSER_MIN_WIDTH) return raw
  // Default ~40% of the window, clamped so it never eats the whole chat column.
  return clampBrowserWidth(Math.round(window.innerWidth * 0.4))
}

function clampBrowserWidth(width: number): number {
  const max = Math.max(BROWSER_MIN_WIDTH, window.innerWidth - BROWSER_RIGHT_MARGIN)
  return Math.min(Math.max(width, BROWSER_MIN_WIDTH), max)
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

// The mode dropdown — an Info/Browser selector styled like the model picker,
// living in the drag bar next to ActivityToggle. Selecting a mode also opens the
// panel (the Shell wires that). Must be a no-drag child of the drag region.
export function SidebarModeToggle({
  mode,
  onModeChange,
}: {
  mode: SidebarMode
  onModeChange: (mode: SidebarMode) => void
}) {
  return (
    <div className="absolute top-2 right-14 z-10 [-webkit-app-region:no-drag]">
      <Select value={mode} onValueChange={(v) => onModeChange(v as SidebarMode)}>
        <SelectTrigger size="sm" className="h-7">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value="info">Info</SelectItem>
          <SelectItem value="browser">Browser</SelectItem>
          <SelectItem value="changes">Changes</SelectItem>
        </SelectContent>
      </Select>
    </div>
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

// The empty <div> that reserves on-screen space for the native browser view.
// While `active`, it continuously reports its rectangle to the main process so
// the WebContentsView tracks it (mount, resize, window resize, and through the
// panel's open/close animation). When inactive it reports null, hiding the view
// so it never lingers over the DOM (panel closed, not in browser mode, obscured
// by a modal, or popped out to the separate window).
function BrowserSlot({ active }: { active: boolean }) {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!active) {
      window.cowork.reportBrowserBounds(null)
      return
    }
    const report = () => {
      const el = ref.current
      if (!el) return
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) {
        window.cowork.reportBrowserBounds(null)
        return
      }
      window.cowork.reportBrowserBounds({
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height,
      })
    }
    report()
    const observer = new ResizeObserver(report)
    if (ref.current) observer.observe(ref.current)
    window.addEventListener("resize", report)
    // Re-report through the 200ms open/close width animation (getBoundingClientRect
    // changes each frame while the panel slides), then stop.
    const interval = window.setInterval(report, 30)
    const stop = window.setTimeout(() => window.clearInterval(interval), 400)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", report)
      window.clearInterval(interval)
      window.clearTimeout(stop)
      window.cowork.reportBrowserBounds(null)
    }
  }, [active])
  return <div ref={ref} className="min-h-0 flex-1" />
}

// The browser mode's chrome + slot. Minimal React chrome (URL bar + reload + pick
// + pop-out) over the native view slot. Drives the active tab through the same
// IPC the separate window's chrome uses.
function BrowserPanel({
  embedded,
}: {
  // Whether the native view should be embedded here (panel open + not obscured +
  // surface is "sidebar"). Gates BrowserSlot's bounds reporting.
  embedded: boolean
}) {
  const [url, setUrl] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [picking, setPicking] = React.useState(false)
  // Whether the view is currently popped out to the separate window. Local —
  // resets to docked on app start (matching the manager's default surface).
  const [poppedOut, setPoppedOut] = React.useState(false)
  // The URL currently being edited (null = mirror the live tab's URL).
  const [draft, setDraft] = React.useState<string | null>(null)

  // Track the active tab's URL/loading from the pushed tab list.
  React.useEffect(() => {
    return window.cowork.onBrowserTabs((tabs) => {
      const tab = tabs.find((t) => t.active)
      setUrl(tab?.url ?? "")
      setLoading(tab?.loading ?? false)
    })
  }, [])

  // Keep the Pick toggle in sync with the true pick-mode state (auto-off after a
  // pick, or a failure).
  React.useEffect(() => {
    return window.cowork.onBrowserPickMode(setPicking)
  }, [])

  const submitUrl = (e: React.FormEvent) => {
    e.preventDefault()
    const value = (draft ?? url).trim()
    if (value) window.cowork.browserNavigate(value)
    setDraft(null)
  }

  const togglePop = () => {
    const next = !poppedOut
    setPoppedOut(next)
    window.cowork.setBrowserSurface(next ? "window" : "sidebar")
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col pl-1">
      {/* Chrome: URL bar + reload + pick + pop-out. */}
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <button
          type="button"
          onClick={() => window.cowork.browserReload()}
          aria-label="Reload"
          title="Reload"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <RotateCw className={cn("size-4", loading && "animate-spin")} />
        </button>
        <form onSubmit={submitUrl} className="min-w-0 flex-1">
          <input
            type="text"
            value={draft ?? url}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setDraft(null)}
            placeholder="Enter a URL"
            spellCheck={false}
            className="w-full rounded-md border border-input bg-transparent px-2 py-1 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </form>
        <button
          type="button"
          onClick={() => window.cowork.browserSetPickMode(!picking)}
          aria-label="Pick element"
          title="Pick element"
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground",
            picking
              ? "bg-accent text-foreground"
              : "text-muted-foreground"
          )}
        >
          <SquareDashedMousePointer className="size-4" />
        </button>
        <button
          type="button"
          onClick={togglePop}
          aria-label={poppedOut ? "Dock browser" : "Pop out browser"}
          title={poppedOut ? "Dock browser" : "Pop out to a window"}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground",
            poppedOut ? "bg-accent text-foreground" : "text-muted-foreground"
          )}
        >
          <ExternalLink className="size-4" />
        </button>
      </div>
      {poppedOut ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
          <p className="text-xs text-muted-foreground">
            The browser is open in a separate window.
          </p>
          <button
            type="button"
            onClick={togglePop}
            className="rounded-md border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-accent"
          >
            Dock it back here
          </button>
        </div>
      ) : (
        <BrowserSlot active={embedded} />
      )}
    </div>
  )
}

export function ActivityPanel({
  conversationId,
  open,
  mode,
  browserObscured,
  workspace,
  changedFiles,
  onOpenHtml,
  onOpenChange,
  onOpenTask,
  historyExpanded,
  onHistoryExpandedChange,
  onRanInBackground,
}: {
  conversationId: string | null
  // Controlled open state (the Shell owns it so the toggle can live in the drag
  // bar and "Run in background" can force the panel open).
  open: boolean
  // Which content the panel shows (owned by the Shell so the drag-bar dropdown
  // and the agent's request-open can drive it).
  mode: SidebarMode
  // True while a DOM overlay (Settings / task transcript) is open. The native
  // browser view paints over the DOM, so it must hide while obscured.
  browserObscured: boolean
  // Active conversation's workspace root (for the Changes review's git diffs +
  // file:// previews). Empty in Chat mode / no workspace.
  workspace: string
  // Files under review in Changes mode (set by "Review all" in the transcript).
  changedFiles: ChangedFile[]
  // Open an html changed-file in the sidebar agent browser (from Changes mode).
  onOpenHtml: (relPath: string) => void
  onOpenChange: (open: boolean) => void
  // Open a task's read-only transcript (the Shell hosts the viewer).
  onOpenTask: (task: Task) => void
  // Controlled expand state for the History section (collapsed by default). The
  // Shell owns it so the completion toast's "View history" action can force it
  // open along with the panel.
  historyExpanded: boolean
  onHistoryExpandedChange: (open: boolean) => void
  // Called after the Todos panel hands its list off to the background, so the
  // Shell can keep the panel open and surface the new task.
  onRanInBackground?: () => void
}) {
  const [browserWidth, setBrowserWidth] = React.useState(readBrowserWidth)

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

  // Drag the panel's left edge to resize (browser mode only). newWidth grows as
  // the cursor moves left, since the panel is pinned to the right edge.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const onMove = (ev: MouseEvent) => {
      setBrowserWidth(clampBrowserWidth(window.innerWidth - ev.clientX))
    }
    const onUp = () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
      document.body.style.userSelect = ""
      // Persist the final width (reading it off state via the functional setter).
      setBrowserWidth((w) => {
        writeCookie(BROWSER_WIDTH_COOKIE_NAME, String(w))
        return w
      })
    }
    document.body.style.userSelect = "none"
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }

  // Browser and Changes are the wide, resizable modes; Info stays a narrow rail.
  const wideMode = mode === "browser" || mode === "changes"
  const width = wideMode ? `${browserWidth}px` : INFO_WIDTH
  // The native view is embedded here only when the panel is genuinely visible in
  // browser mode and nothing is drawing over it.
  const embedded = open && mode === "browser" && !browserObscured

  return (
    // Layout gap that the main content flexes against (width animates to 0 when
    // collapsed), mirroring the left sidebar's gap+container split.
    <div
      data-state={open ? "expanded" : "collapsed"}
      className={cn(
        "relative hidden h-svh shrink-0 bg-transparent transition-[width] duration-200 ease-linear md:block",
        open ? "w-(--activity-width)" : "w-0"
      )}
      style={{ "--activity-width": width } as React.CSSProperties}
    >
      <div
        className={cn(
          "fixed inset-y-0 right-0 z-0 flex h-svh w-(--activity-width) flex-col border-l bg-sidebar text-sidebar-foreground transition-[right] duration-200 ease-linear",
          open ? "right-0" : "right-[calc(var(--activity-width)*-1)]"
        )}
        style={{ "--activity-width": width } as React.CSSProperties}
      >
        {wideMode && (
          // Resize handle in a left gutter (the pl-1 in BrowserPanel/ChangesPanel
          // keeps content clear of it — in browser mode a DOM element under the
          // native view can't receive clicks). Only meaningful in the wide modes.
          <div
            onMouseDown={startResize}
            className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-border"
          />
        )}
        {/* Clears the top drag bar / toggle row. */}
        <SidebarHeader className="h-12 justify-center px-4">
          <span className="text-xs font-medium text-sidebar-foreground/70">
            {mode === "browser"
              ? "Browser"
              : mode === "changes"
                ? "Changes"
                : "Workspace Activity"}
          </span>
        </SidebarHeader>
        {mode === "browser" ? (
          <div className="min-h-0 flex-1">
            <BrowserPanel embedded={embedded} />
          </div>
        ) : mode === "changes" ? (
          <div className="min-h-0 flex-1">
            <ChangesPanel
              files={changedFiles}
              workspace={workspace}
              onOpenHtml={onOpenHtml}
            />
          </div>
        ) : (
          <SidebarContent>
            <ActivitySection title="Tasks">
              <TasksSection
                conversationId={conversationId}
                onOpenTask={onOpenTask}
              />
            </ActivitySection>
            {/* Indexing: the background workspace index build for this session's
                workspace, with pause/resume/cancel/clear (plan 008). */}
            <ActivitySection title="Indexing">
              <IndexingSection conversationId={conversationId} />
            </ActivitySection>
            {/* Todos: the agent's task list for this conversation, with a handoff
                to run the whole list in the background (plan 016). */}
            <ActivitySection title="Todos">
              <TodosSection
                conversationId={conversationId}
                onRanInBackground={onRanInBackground}
              />
            </ActivitySection>
            {/* History: terminal tasks for this conversation. Collapsed by default
                so it doesn't crowd the situational Tasks view above. */}
            <Collapsible
              open={historyExpanded}
              onOpenChange={onHistoryExpandedChange}
            >
              <SidebarGroup>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="group/history flex w-full items-center gap-1"
                  >
                    <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]/history:rotate-90" />
                    <SidebarGroupLabel className="cursor-pointer">
                      History
                    </SidebarGroupLabel>
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarGroupContent>
                    <TasksHistorySection
                      conversationId={conversationId}
                      onOpenTask={onOpenTask}
                    />
                  </SidebarGroupContent>
                </CollapsibleContent>
              </SidebarGroup>
            </Collapsible>
          </SidebarContent>
        )}
      </div>
    </div>
  )
}

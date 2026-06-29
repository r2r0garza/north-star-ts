import * as React from "react"
import { CheckCircle2, CircleAlert, Ban } from "lucide-react"
import { cn, formatRelativeTime } from "@/lib/utils"
import type { Task, TaskStatus } from "@/types"

// Terminal statuses — the opposite of tasks-section.tsx's ACTIONABLE. These are
// the tasks the live Tasks section hides; History is where they live on.
const TERMINAL: TaskStatus[] = ["completed", "failed", "cancelled"]

// Cap the recent list so a long-lived conversation's history can't grow the
// panel without bound. When more exist we say so rather than truncating silently.
const CAP = 25

// Icon + tint per terminal status, for the compact row marker.
const STATUS_ICON: Record<
  string,
  { Icon: typeof CheckCircle2; className: string; label: string }
> = {
  completed: { Icon: CheckCircle2, className: "text-primary", label: "Completed" },
  failed: { Icon: CircleAlert, className: "text-destructive", label: "Failed" },
  cancelled: { Icon: Ban, className: "text-muted-foreground", label: "Cancelled" },
}

// The History section of the Workspace Activity panel. Mirrors tasks-section's
// load + live-tail refetch pattern, but read-only and compact: terminal tasks
// for the active SOURCE conversation, newest first, each row opening the same
// read-only transcript viewer the live chat uses. No Resume/Cancel/gate UI.
export function TasksHistorySection({
  conversationId,
  onOpenTask,
}: {
  conversationId: string | null
  onOpenTask: (task: Task) => void
}) {
  const [tasks, setTasks] = React.useState<Task[]>([])
  // Whether more terminal tasks exist than the cap we display.
  const [truncated, setTruncated] = React.useState(false)

  const refetch = React.useCallback(async () => {
    if (!conversationId) {
      setTasks([])
      setTruncated(false)
      return
    }
    const rows = await window.cowork.db.tasks.list({ sourceConversationId: conversationId })
    // Rows arrive ORDER BY created_at DESC; filter to terminal then cap.
    const terminal = rows.filter((t) => TERMINAL.includes(t.status))
    setTruncated(terminal.length > CAP)
    setTasks(terminal.slice(0, CAP))
  }, [conversationId])
  const refetchRef = React.useRef(refetch)
  refetchRef.current = refetch

  React.useEffect(() => {
    void refetchRef.current()
  }, [conversationId])

  // Live tail: refetch when a task reaches (or moves between) terminal states.
  // Token deltas are ignored.
  React.useEffect(() => {
    if (!conversationId) return
    const unsubscribe = window.cowork.tasks.onEvent((payload) => {
      const t = payload.event.type
      if (t === "task_completed" || t === "task_failed" || t === "status_change") {
        void refetchRef.current()
      }
    })
    return unsubscribe
  }, [conversationId])

  if (!conversationId) {
    return <p className="px-2 py-1.5 text-xs text-muted-foreground">No session selected.</p>
  }
  if (tasks.length === 0) {
    return <p className="px-2 py-1.5 text-xs text-muted-foreground">No past tasks.</p>
  }

  return (
    <div className="flex flex-col gap-1">
      {tasks.map((task) => {
        const meta = STATUS_ICON[task.status] ?? {
          Icon: CheckCircle2,
          className: "text-muted-foreground",
          label: task.status,
        }
        const Icon = meta.Icon
        return (
          <button
            key={task.id}
            type="button"
            onClick={() => onOpenTask(task)}
            title="Open task transcript"
            className="flex w-full items-center gap-2 rounded-md p-1.5 text-left hover:bg-accent"
          >
            <Icon className={cn("size-3.5 shrink-0", meta.className)} />
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {task.title ?? "Untitled task"}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatRelativeTime(task.updatedAt)}
            </span>
          </button>
        )
      })}
      {truncated && (
        <p className="px-1.5 pt-1 text-xs text-muted-foreground">Showing last {CAP}</p>
      )}
    </div>
  )
}

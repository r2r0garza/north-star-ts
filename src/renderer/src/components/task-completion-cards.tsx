import * as React from "react"
import { CheckCircle2, CircleAlert, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { Task, TaskStatus } from "@/types"

// Terminal statuses worth acknowledging back in the live chat.
const TERMINAL: TaskStatus[] = ["completed", "failed"]

// Lightweight completion notices for background tasks finished in THIS source
// conversation. Derived from the tasks table (not persisted as chat messages —
// so they never pollute the model's context), shown just above the composer.
// Each card summarizes the outcome and links to the full task transcript. The
// user can dismiss a card; dismissals are session-local (a ref), so they don't
// reappear until the app restarts.
export function TaskCompletionCards({
  conversationId,
  onOpenTask,
}: {
  conversationId: string | null
  onOpenTask: (task: Task) => void
}) {
  const [done, setDone] = React.useState<Task[]>([])
  // Task ids the user dismissed this session — kept out of the list.
  const dismissed = React.useRef<Set<string>>(new Set())

  const refetch = React.useCallback(async () => {
    if (!conversationId) {
      setDone([])
      return
    }
    const rows = await window.cowork.db.tasks.list({ sourceConversationId: conversationId })
    setDone(
      rows.filter((t) => TERMINAL.includes(t.status) && !dismissed.current.has(t.id))
    )
  }, [conversationId])
  const refetchRef = React.useRef(refetch)
  refetchRef.current = refetch

  React.useEffect(() => {
    void refetchRef.current()
  }, [conversationId])

  // Refresh when a task reaches a terminal state (status_change/completed/failed).
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

  function dismiss(id: string) {
    dismissed.current.add(id)
    setDone((prev) => prev.filter((t) => t.id !== id))
  }

  if (done.length === 0) return null

  return (
    <div className="mb-3 flex flex-col gap-2">
      {done.map((task) => {
        const failed = task.status === "failed"
        const summary =
          failed
            ? task.error ?? "Task failed."
            : typeof task.result === "string"
              ? task.result
              : "Task completed."
        return (
          <div
            key={task.id}
            className={cn(
              "flex items-start gap-2 rounded-lg border p-3 text-sm",
              failed
                ? "border-destructive/40 bg-destructive/5"
                : "border-border bg-muted/40"
            )}
          >
            {failed ? (
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            ) : (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
            )}
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {failed ? "Background task failed" : "Background task completed"}
                {task.title ? ` — ${task.title}` : ""}
              </div>
              <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-muted-foreground">
                {summary}
              </p>
              <div className="mt-2">
                <Button size="xs" variant="outline" onClick={() => onOpenTask(task)}>
                  View task transcript
                </Button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => dismiss(task.id)}
              title="Dismiss"
              aria-label="Dismiss"
              className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

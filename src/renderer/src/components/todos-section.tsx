import * as React from "react"
import { Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { Todo, TodoStatus, TaskEventPayload } from "@/types"

// Compact status marker per todo status — mirrors the model-facing markers in
// todo-prompt.ts so the panel reads the same way the agent's list does.
const MARKERS: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
  cancelled: "[~]",
}
const STATUS_CLASS: Record<TodoStatus, string> = {
  pending: "text-muted-foreground",
  in_progress: "text-primary",
  completed: "text-muted-foreground line-through",
  cancelled: "text-muted-foreground line-through opacity-60",
}

// Items that still represent work to do (mirrors actionableTodos server-side).
function actionable(todos: Todo[]): Todo[] {
  return todos.filter((t) => t.status === "pending" || t.status === "in_progress")
}

// The Todos section of the Workspace Activity panel. Renders the active
// conversation's task list (built by the agent via todo_write) and offers a
// "Run all in background" handoff that dispatches the list to a durable
// background task (plan 016). Read-only otherwise — editing happens through the
// agent, not here.
export function TodosSection({
  conversationId,
  onRanInBackground,
}: {
  conversationId: string | null
  // Called after a successful handoff so the Shell can reveal the Tasks view.
  onRanInBackground?: () => void
}) {
  const [todos, setTodos] = React.useState<Todo[]>([])
  const [dispatching, setDispatching] = React.useState(false)

  const refetch = React.useCallback(async () => {
    if (!conversationId) {
      setTodos([])
      return
    }
    setTodos(await window.cowork.db.todos.list(conversationId))
  }, [conversationId])
  const refetchRef = React.useRef(refetch)
  refetchRef.current = refetch

  React.useEffect(() => {
    void refetchRef.current()
  }, [conversationId])

  // The agent writes todos and dispatches tasks as side effects of a turn, with
  // no dedicated todo event. Refetch on the task event tail (cheap, debounced by
  // React) so the list reflects todo_write writes and seeding promptly. Token
  // deltas are ignored.
  React.useEffect(() => {
    if (!conversationId) return
    const unsubscribe = window.cowork.tasks.onEvent((payload) => {
      if ((payload.event as TaskEventPayload).type === "token") return
      void refetchRef.current()
    })
    return unsubscribe
  }, [conversationId])

  async function runAll() {
    if (!conversationId || dispatching) return
    setDispatching(true)
    try {
      const task = await window.cowork.tasks.startTodos(conversationId)
      if (task) onRanInBackground?.()
    } finally {
      setDispatching(false)
    }
  }

  if (!conversationId) {
    return <p className="px-2 py-1.5 text-xs text-muted-foreground">No session selected.</p>
  }
  if (todos.length === 0) {
    return <p className="px-2 py-1.5 text-xs text-muted-foreground">No tasks yet.</p>
  }

  const remaining = actionable(todos).length

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1">
        {todos.map((t) => (
          <li key={t.itemId} className="flex gap-1.5 text-xs">
            <span className="select-none font-mono text-muted-foreground">
              {MARKERS[t.status] ?? "[?]"}
            </span>
            <span className={cn("min-w-0 flex-1", STATUS_CLASS[t.status])}>{t.content}</span>
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        disabled={remaining === 0 || dispatching}
        onClick={() => void runAll()}
        title={
          remaining === 0
            ? "No pending tasks to run"
            : "Run the remaining tasks in a background task"
        }
      >
        <Play className="size-3.5" />
        Run all in background
      </Button>
    </div>
  )
}

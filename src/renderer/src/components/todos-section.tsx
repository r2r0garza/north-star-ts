import * as React from "react"
import { Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { Todo, TodoStatus, TaskStatus, TaskEventPayload } from "@/types"

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
  return todos.filter(
    (t) => t.status === "pending" || t.status === "in_progress"
  )
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
  // Whether a still-running todo_run task already owns this conversation's list.
  // Drives the button so the user can't hand the same list off twice.
  const [activeTodoRun, setActiveTodoRun] = React.useState(false)
  const displayedConversationRef = React.useRef<string | null>(conversationId)
  const activeTodoRunTaskRef = React.useRef<string | null>(null)

  const refetch = React.useCallback(async () => {
    if (!conversationId) {
      displayedConversationRef.current = null
      activeTodoRunTaskRef.current = null
      setTodos([])
      setActiveTodoRun(false)
      return
    }
    // Prefer a todo_run task's FORK todos so the panel shows the background
    // worker's [ ]→[>]→[x] progress (and the final list once it completes).
    // After a 016 handoff the source conversation's own todos are a frozen
    // snapshot; the worker marks items completed in its forked conversation.
    // listTasks orders created_at DESC, so the first todo_run match is the
    // latest. No status filter on selection — a completed task must still show
    // its final fork list. Fall back to this conversation's todos when none.
    const tasks = await window.cowork.db.tasks.list({
      sourceConversationId: conversationId,
    })
    const todoRun = tasks.find(
      (t) =>
        typeof t.input === "object" &&
        t.input !== null &&
        (t.input as { kind?: unknown }).kind === "todo_run"
    )
    const LIVE = new Set<TaskStatus>([
      "queued",
      "running",
      "waiting_for_approval",
      "interrupted",
    ])
    setActiveTodoRun(!!todoRun && LIVE.has(todoRun.status))
    activeTodoRunTaskRef.current = todoRun?.id ?? null
    const readFrom = todoRun ? todoRun.conversationId : conversationId
    displayedConversationRef.current = readFrom
    setTodos(await window.cowork.db.todos.list(readFrom))
  }, [conversationId])
  const refetchRef = React.useRef(refetch)
  refetchRef.current = refetch

  React.useEffect(() => {
    displayedConversationRef.current = conversationId
    void refetchRef.current()
  }, [conversationId])

  // Todo writes publish committed snapshots from the DB boundary. Apply matching
  // snapshots directly; task events remain responsible for lifecycle changes
  // such as selecting a todo_run worker conversation or clearing that state.
  React.useEffect(() => {
    if (!conversationId) return
    const unsubscribe = window.cowork.db.todos.onChange((payload) => {
      if (payload.conversationId === displayedConversationRef.current) {
        setTodos(payload.todos)
      }
    })
    return unsubscribe
  }, [conversationId])

  // Lifecycle changes for the selected todo_run can change which conversation's
  // todos should be displayed and whether the handoff button is disabled.
  React.useEffect(() => {
    if (!conversationId) return
    const unsubscribe = window.cowork.tasks.onEvent((payload) => {
      if ((payload.event as TaskEventPayload).type === "token") return
      const activeTaskId = activeTodoRunTaskRef.current
      if (!activeTaskId || payload.taskId !== activeTaskId) return
      void refetchRef.current()
    })
    return unsubscribe
  }, [conversationId])

  async function runAll() {
    if (!conversationId || dispatching) return
    setDispatching(true)
    try {
      const task = await window.cowork.tasks.startTodos(conversationId)
      if (task) {
        activeTodoRunTaskRef.current = task.id
        displayedConversationRef.current = task.conversationId
        setActiveTodoRun(true)
        setTodos(await window.cowork.db.todos.list(task.conversationId))
        onRanInBackground?.()
      }
    } finally {
      setDispatching(false)
    }
  }

  if (!conversationId) {
    return (
      <p className="px-2 py-1.5 text-xs text-muted-foreground">
        No session selected.
      </p>
    )
  }
  if (todos.length === 0) {
    return (
      <p className="px-2 py-1.5 text-xs text-muted-foreground">No tasks yet.</p>
    )
  }

  const remaining = actionable(todos).length

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1">
        {todos.map((t) => (
          <li key={t.itemId} className="flex gap-1.5 text-xs">
            <span className="font-mono text-muted-foreground select-none">
              {MARKERS[t.status] ?? "[?]"}
            </span>
            <span className={cn("min-w-0 flex-1", STATUS_CLASS[t.status])}>
              {t.content}
            </span>
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        disabled={remaining === 0 || dispatching || activeTodoRun}
        onClick={() => void runAll()}
        title={
          activeTodoRun
            ? "Already running in the background"
            : remaining === 0
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

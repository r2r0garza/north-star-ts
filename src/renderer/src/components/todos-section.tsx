import * as React from "react"
import { Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TodoTraceList } from "@/components/todo-trace-list"
import { useConversationTodos } from "@/hooks/use-conversation-todos"
import type { Todo } from "@/types"

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
  isAutoMode,
}: {
  conversationId: string | null
  // Called after a successful handoff so the Shell can reveal the Tasks view.
  onRanInBackground?: () => void
  // Read at click time: a handoff from an Auto-mode conversation runs in Auto.
  isAutoMode?: (conversationId: string) => boolean
}) {
  const [dispatching, setDispatching] = React.useState(false)
  const { todos, activeTodoRun, refresh } = useConversationTodos(conversationId)

  async function runAll() {
    if (!conversationId || dispatching) return
    setDispatching(true)
    try {
      const task = await window.cowork.tasks.startTodos(conversationId, {
        autoMode: isAutoMode?.(conversationId) ?? false,
      })
      if (task) {
        await refresh()
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
      <TodoTraceList todos={todos} className="text-xs" />
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

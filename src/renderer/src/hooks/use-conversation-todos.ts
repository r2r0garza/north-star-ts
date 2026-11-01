import * as React from "react"
import type { Todo, TaskStatus, TaskEventPayload } from "@/types"

// The todo list to display for a conversation, kept live: a still-relevant
// todo_run worker's list when one exists, otherwise the conversation's own.
export function useConversationTodos(conversationId: string | null) {
  const [todos, setTodos] = React.useState<Todo[]>([])
  // Whether a still-running todo_run task already owns this conversation's list.
  // Drives the button so the user can't hand the same list off twice.
  const [activeTodoRun, setActiveTodoRun] = React.useState(false)
  const displayedConversationRef = React.useRef<string | null>(conversationId)
  const refreshRef = React.useRef(0)
  const snapshotRevisionRef = React.useRef(0)
  const conversationRef = React.useRef(conversationId)
  conversationRef.current = conversationId

  const refetch = React.useCallback(async () => {
    const refresh = ++refreshRef.current
    const isCurrent = () =>
      refresh === refreshRef.current &&
      conversationId === conversationRef.current
    if (!conversationId) {
      displayedConversationRef.current = null
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
    if (!isCurrent()) return
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
    const readFrom = todoRun ? todoRun.conversationId : conversationId
    displayedConversationRef.current = readFrom
    const revision = snapshotRevisionRef.current
    const snapshot = await window.cowork.db.todos.list(readFrom)
    if (isCurrent() && revision === snapshotRevisionRef.current) {
      setTodos(snapshot)
    }
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
        snapshotRevisionRef.current++
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
      const event = payload.event as TaskEventPayload
      if (
        event.type !== "status_change" &&
        event.type !== "task_completed" &&
        event.type !== "task_failed"
      )
        return
      void refetchRef.current()
    })
    return unsubscribe
  }, [conversationId])

  const refresh = React.useCallback(() => refetchRef.current(), [])
  return { todos, activeTodoRun, refresh }
}

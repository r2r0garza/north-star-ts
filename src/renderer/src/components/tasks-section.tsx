import * as React from "react"
import { Play, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { ApprovalCard } from "@/components/tool-group"
import { QuestionPanel } from "@/components/question-panel"
import { cn } from "@/lib/utils"
import type { Task, TaskStatus, TaskEventPayload, Question, QuestionAnswer } from "@/types"

// The statuses the panel surfaces: the actionable ones. Terminal states
// (completed/failed/cancelled) are intentionally hidden — this panel is about
// "what's happening / what needs attention", not history.
const ACTIONABLE: TaskStatus[] = [
  "queued",
  "running",
  "waiting_for_approval",
  "interrupted",
]

// A short human label + dot color per status, for the row badge.
const STATUS_META: Record<string, { label: string; dot: string }> = {
  queued: { label: "Queued", dot: "bg-muted-foreground/50" },
  running: { label: "Running", dot: "bg-primary" },
  waiting_for_approval: { label: "Waiting for approval", dot: "bg-amber-500" },
  interrupted: { label: "Interrupted", dot: "bg-amber-500" },
}

// The pending gate a waiting task is blocked on — an approval prompt or an
// ask_user_question — reconstructed from the task's event stream.
type PendingGate =
  | { kind: "approval"; requestId: string; tool: string; summary: string; reason: string }
  | { kind: "question"; requestId: string; questions: Question[] }

// Derive a task's current pending gate from its events (newest wins). Used both
// for the live tail and to recover a gate after the panel remounts (replayed
// from db.taskEvents.list). A status_change away from waiting_for_approval
// clears it (the gate was resolved).
function latestGate(events: TaskEventPayload[]): PendingGate | null {
  let gate: PendingGate | null = null
  for (const ev of events) {
    if (ev.type === "approval") {
      gate = { kind: "approval", requestId: ev.requestId, tool: ev.tool, summary: ev.summary, reason: ev.reason }
    } else if (ev.type === "question") {
      gate = { kind: "question", requestId: ev.requestId, questions: ev.questions }
    } else if (ev.type === "status_change" && ev.to === "running") {
      // Resolved (markRunning) — the gate is no longer pending.
      gate = null
    }
  }
  return gate
}

function TaskRow({
  task,
  gate,
  onResume,
  onCancel,
  onOpen,
  onApprove,
  onDeny,
  onAnswer,
}: {
  task: Task
  gate: PendingGate | null
  onResume: () => void
  onCancel: () => void
  onOpen: () => void
  onApprove: (requestId: string, remember?: "workspace") => void
  onDeny: (requestId: string) => void
  onAnswer: (requestId: string, answers: QuestionAnswer[]) => void
}) {
  const meta = STATUS_META[task.status] ?? { label: task.status, dot: "bg-muted-foreground/50" }
  const isRunning = task.status === "running"
  const isInterrupted = task.status === "interrupted"
  const isWaiting = task.status === "waiting_for_approval"

  return (
    <div className="flex flex-col gap-2 rounded-md border bg-card p-2.5">
      <div className="flex items-start gap-2">
        {/* Clicking the title/body opens the task's read-only transcript. */}
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 text-left"
          title="Open task transcript"
        >
          <div className="truncate text-sm text-foreground hover:underline">
            {task.title ?? "Untitled task"}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            {isRunning ? (
              <Spinner className="size-3" />
            ) : (
              <span className={cn("size-1.5 rounded-full", meta.dot)} />
            )}
            <span>{meta.label}</span>
          </div>
        </button>
        <div className="flex shrink-0 gap-1">
          {isInterrupted && (
            <Button size="sm" variant="outline" onClick={onResume} title="Resume task">
              <Play className="size-3.5" />
              Resume
            </Button>
          )}
          {!isInterrupted && (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={onCancel}
              title="Cancel task"
              aria-label="Cancel task"
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* A paused task surfaces its gate inline so the user can resolve it
          without leaving the panel. Reuses the same cards the live chat uses. */}
      {isWaiting && gate?.kind === "approval" && (
        <ApprovalCard
          approval={{
            requestId: gate.requestId,
            summary: gate.summary,
            reason: gate.reason,
            status: "pending",
          }}
          onApproval={(requestId, decision, remember) =>
            decision === "approved" ? onApprove(requestId, remember) : onDeny(requestId)
          }
        />
      )}
      {isWaiting && gate?.kind === "question" && (
        <QuestionPanel
          questions={gate.questions}
          onSubmit={(answers) => onAnswer(gate.requestId, answers)}
        />
      )}
      {isWaiting && !gate && (
        <p className="text-xs text-muted-foreground">Waiting for input…</p>
      )}
    </div>
  )
}

// The Tasks section of the Workspace Activity panel. Loads the active
// conversation's actionable tasks (by SOURCE conversation — each task runs in
// its own hidden transcript), keeps them fresh via the runner's live event tail,
// and surfaces approval/question gates inline so a paused background task can be
// resolved without the live chat.
export function TasksSection({
  conversationId,
  onOpenTask,
}: {
  conversationId: string | null
  // Open a task's read-only transcript (handled by the panel/Shell).
  onOpenTask: (task: Task) => void
}) {
  const [tasks, setTasks] = React.useState<Task[]>([])
  // Pending gate per task id, derived from the event stream.
  const [gates, setGates] = React.useState<Record<string, PendingGate | null>>({})

  const refetch = React.useCallback(async () => {
    if (!conversationId) {
      setTasks([])
      return
    }
    const rows = await window.cowork.db.tasks.list({ sourceConversationId: conversationId })
    const actionable = rows.filter((t) => ACTIONABLE.includes(t.status))
    setTasks(actionable)
    // Recover any pending gate for waiting tasks by replaying their events —
    // so a gate survives a panel remount or a fresh open of the conversation.
    const waiting = actionable.filter((t) => t.status === "waiting_for_approval")
    const recovered = await Promise.all(
      waiting.map(async (t) => {
        const events = await window.cowork.db.taskEvents.list(t.id)
        return [t.id, latestGate(events.map((e) => e.payload as TaskEventPayload))] as const
      })
    )
    setGates((prev) => {
      const next = { ...prev }
      for (const [id, gate] of recovered) next[id] = gate
      return next
    })
  }, [conversationId])
  const refetchRef = React.useRef(refetch)
  refetchRef.current = refetch

  React.useEffect(() => {
    let cancelled = false
    setGates({})
    if (!conversationId) {
      setTasks([])
      return
    }
    void refetchRef.current()
    return () => {
      cancelled = true
      void cancelled
    }
  }, [conversationId])

  // Live tail: update the pending-gate map from approval/question/status events,
  // and refetch the list on any lifecycle change. Token deltas are ignored.
  React.useEffect(() => {
    if (!conversationId) return
    const unsubscribe = window.cowork.tasks.onEvent((payload) => {
      const { taskId, event } = payload
      if (event.type === "approval") {
        setGates((g) => ({
          ...g,
          [taskId]: { kind: "approval", requestId: event.requestId, tool: event.tool, summary: event.summary, reason: event.reason },
        }))
      } else if (event.type === "question") {
        setGates((g) => ({
          ...g,
          [taskId]: { kind: "question", requestId: event.requestId, questions: event.questions },
        }))
      } else if (event.type === "status_change" && event.to === "running") {
        setGates((g) => ({ ...g, [taskId]: null }))
      }
      if (event.type === "token") return
      void refetchRef.current()
    })
    return unsubscribe
  }, [conversationId])

  async function resume(id: string) {
    await window.cowork.tasks.resume(id)
    await refetch()
  }
  async function cancel(id: string) {
    await window.cowork.tasks.cancel(id)
    await refetch()
  }
  function approve(taskId: string, requestId: string, remember?: "workspace") {
    void window.cowork.tasks.approve({ taskId, requestId, remember })
    setGates((g) => ({ ...g, [taskId]: null }))
  }
  function deny(taskId: string, requestId: string) {
    void window.cowork.tasks.deny({ taskId, requestId })
    setGates((g) => ({ ...g, [taskId]: null }))
  }
  function answer(taskId: string, requestId: string, answers: QuestionAnswer[]) {
    void window.cowork.tasks.answer({ taskId, requestId, answers })
    setGates((g) => ({ ...g, [taskId]: null }))
  }

  if (!conversationId) {
    return <p className="px-2 py-1.5 text-xs text-muted-foreground">No session selected.</p>
  }
  if (tasks.length === 0) {
    return <p className="px-2 py-1.5 text-xs text-muted-foreground">No active tasks.</p>
  }

  return (
    <div className="flex flex-col gap-2">
      {tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          gate={gates[task.id] ?? null}
          onResume={() => void resume(task.id)}
          onCancel={() => void cancel(task.id)}
          onOpen={() => onOpenTask(task)}
          onApprove={(requestId, remember) => approve(task.id, requestId, remember)}
          onDeny={(requestId) => deny(task.id, requestId)}
          onAnswer={(requestId, answers) => answer(task.id, requestId, answers)}
        />
      ))}
    </div>
  )
}

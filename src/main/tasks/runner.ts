import { runAgentLoop, type ChatEvent, type ChatResult } from "../agent"
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
} from "../db/repositories/tasks"
import { appendEvent } from "../db/repositories/task-events"
import { appendMessage, listMessages } from "../db/repositories/messages"
import { getConversation } from "../db/repositories/conversations"
import { getWorkspace } from "../db/repositories/workspaces"
import type { Task, TaskStatus } from "../db/types"

// Runner-emitted lifecycle events, appended to task_events alongside the agent's
// ChatEvents so a (re)attaching renderer can reconstruct a task's progress from
// the durable log. These are NOT part of the live `chat` path's ChatEvent union
// — they describe the task wrapper, not the agent turn.
export type RunnerLifecycleEvent =
  | { type: "status_change"; from: TaskStatus; to: TaskStatus }
  | { type: "task_completed"; result?: string }
  | { type: "task_failed"; error: string }

// The full vocabulary written to task_events / streamed on the live tail: the
// agent's own streaming events plus the runner's lifecycle events. Reusing the
// ChatEvent shapes verbatim is what lets the renderer replay a task's transcript
// with the same code it uses for a live `chat:event` stream.
export type TaskEventPayload = ChatEvent | RunnerLifecycleEvent

// A live-tail subscriber. `eventId` is the task_events row id (0 for ephemeral
// token deltas, which are streamed live but never persisted) so a renderer can
// `afterId`-dedupe persisted events against a replay from db:taskEvents:list.
export type TaskEventListener = (
  taskId: string,
  event: TaskEventPayload,
  eventId: number
) => void

// What a registered task kind is allowed to do. Auto-resume is a per-kind
// capability, deliberately NOT a global switch: a background job (e.g. 008's
// workspace indexer) can opt into resuming itself on startup, while user-driven
// coding tasks stay manual-resume-only until we have stronger workspace
// validation and resume semantics.
interface TaskKindCapability {
  autoResume: boolean
}

// The default kind for a durable agent turn enqueued from the UI: manual resume
// only. Future kinds (indexing, maintenance) register here with autoResume:true.
const DEFAULT_KIND = "agent_chat"
const TASK_KINDS: Record<string, TaskKindCapability> = {
  agent_chat: { autoResume: false },
}

// A task's input blob carries its kind and the user message to run. Stored as
// JSON on tasks.input by enqueue; read back on resume.
interface TaskInput {
  kind: string
  message: string
}

function kindOf(task: Task): string {
  const input = task.input as Partial<TaskInput> | null
  return input?.kind ?? DEFAULT_KIND
}

function capabilityOf(kind: string): TaskKindCapability {
  return TASK_KINDS[kind] ?? { autoResume: false }
}

// A single-process durable task runner over the existing task tables. It makes
// agent work queued (FIFO under a concurrency cap), background (runs with no
// renderer attached; progress persisted to task_events), and crash-resumable
// (an interrupted task survives an app restart). It wraps runAgentLoop — a
// "live turn" (runChat) and a "task" share that core loop but own their own
// AbortController, so the two lifecycles stay independent.
export class TaskRunner {
  // Pending task ids in FIFO order.
  private queue: string[] = []
  // In-flight tasks → their AbortController (task-keyed, unlike runChat's
  // conversation-keyed map). cancel/stop abort these.
  private running = new Map<string, AbortController>()
  private readonly concurrency: number
  private listeners = new Set<TaskEventListener>()
  // The pump sleeps on this resolver when idle (a wakeable queue, not a busy
  // poll). enqueue/resume/completion call wakeup() to re-pump.
  private wake: (() => void) | null = null
  // Set when wakeup() fires with no waiter parked, so the pump doesn't miss a
  // wake that lands between draining the queue and parking (lost-wakeup guard).
  private wakeQueued = false
  private stopped = false
  private pumping = false

  constructor(opts: { concurrency?: number } = {}) {
    this.concurrency = opts.concurrency ?? 2
  }

  // Reconcile orphaned tasks from a previous run, seed the queue with anything
  // already `queued`, and start the pump. Call once in app.whenReady (after the
  // DB handlers are registered — the runner reads the DB synchronously).
  start(): void {
    this.reconcile()
    this.seed()
    void this.pump()
  }

  // Enqueue a new durable agent turn. Persists the user message immediately so
  // the loop (and any later resume) replays it from the transcript — runOne
  // calls runAgentLoop with no fresh userMessage, making a first run and a
  // resume the exact same code path.
  enqueue(input: {
    conversationId: string
    message: string
    kind?: string
    title?: string | null
  }): Task {
    const kind = input.kind ?? DEFAULT_KIND
    const taskInput: TaskInput = { kind, message: input.message }
    const task = createTask({
      conversationId: input.conversationId,
      title: input.title ?? null,
      status: "queued",
      input: taskInput,
    })
    appendMessage({
      conversationId: input.conversationId,
      role: "user",
      content: input.message,
    })
    this.queue.push(task.id)
    this.wakeup()
    return task
  }

  // Manually resume an interrupted task (user-driven). No-op if the task is
  // missing or not in the `interrupted` state.
  resume(taskId: string): void {
    const task = getTask(taskId)
    if (!task || task.status !== "interrupted") return
    updateTask(taskId, { status: "queued" })
    this.emit(taskId, { type: "status_change", from: task.status, to: "queued" })
    if (!this.queue.includes(taskId)) this.queue.push(taskId)
    this.wakeup()
  }

  // Cancel a task. A running task is aborted (its 005 process-group kill tears
  // down any in-flight shell) and runOne maps the resulting {stopped:true} to a
  // `cancelled` status. A still-pending task is marked cancelled directly.
  cancel(taskId: string): void {
    this.queue = this.queue.filter((id) => id !== taskId)
    const controller = this.running.get(taskId)
    if (controller) {
      controller.abort()
      return
    }
    const task = getTask(taskId)
    if (task && (task.status === "queued" || task.status === "interrupted")) {
      updateTask(taskId, { status: "cancelled" })
      this.emit(taskId, { type: "status_change", from: task.status, to: "cancelled" })
    }
  }

  // Subscribe to the live event tail (all tasks). Returns an unsubscribe fn.
  subscribe(listener: TaskEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // Abort all in-flight tasks and stop the pump. Called on app will-quit; the
  // final statuses are left for the next boot's reconcile (which marks any task
  // still `running` as `interrupted`), since teardown may not finish before the
  // process exits.
  async stop(): Promise<void> {
    this.stopped = true
    for (const controller of this.running.values()) controller.abort()
    this.wakeup()
  }

  // On startup, any task left `running`/`waiting_for_approval` means the process
  // died mid-flight. Mark it `interrupted`; kinds that opt into auto-resume go
  // straight back to `queued` (seed picks them up), everything else waits for an
  // explicit user resume.
  private reconcile(): void {
    const orphaned = [
      ...listTasks({ status: "running" }),
      ...listTasks({ status: "waiting_for_approval" }),
    ]
    for (const task of orphaned) {
      const next: TaskStatus = capabilityOf(kindOf(task)).autoResume
        ? "queued"
        : "interrupted"
      updateTask(task.id, { status: next })
      this.emit(task.id, { type: "status_change", from: task.status, to: next })
    }
  }

  // Seed the queue from any `queued` tasks. listTasks orders created_at DESC, so
  // reverse for FIFO (oldest first).
  private seed(): void {
    for (const task of listTasks({ status: "queued" }).reverse()) {
      if (!this.queue.includes(task.id)) this.queue.push(task.id)
    }
  }

  // The pump: launch as many tasks as the concurrency cap allows, then sleep
  // until woken. Runs once (guarded by `pumping`); runOne re-wakes it on
  // completion so freed slots refill.
  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (!this.stopped) {
        while (this.running.size < this.concurrency) {
          const taskId = this.takeNext()
          if (!taskId) break
          void this.runOne(taskId)
        }
        if (this.stopped) break
        if (this.wakeQueued) {
          this.wakeQueued = false
          continue
        }
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
      }
    } finally {
      this.pumping = false
    }
  }

  // Wake the pump, or remember the wake if it isn't parked yet (so a wake that
  // lands between draining the queue and parking isn't lost).
  private wakeup(): void {
    if (this.wake) {
      const resolve = this.wake
      this.wake = null
      resolve()
    } else {
      this.wakeQueued = true
    }
  }

  // Pull the next runnable task id from the queue, skipping any whose
  // conversation already has a running task. Per-conversation serialization
  // keeps message seq ordering sane (two tasks on the same conversation would
  // otherwise interleave appendMessage writes). Prunes vanished tasks.
  private takeNext(): string | undefined {
    const busy = new Set<string>()
    for (const id of this.running.keys()) {
      const task = getTask(id)
      if (task) busy.add(task.conversationId)
    }
    for (let i = 0; i < this.queue.length; i++) {
      const task = getTask(this.queue[i])
      if (!task) {
        this.queue.splice(i, 1)
        i--
        continue
      }
      if (busy.has(task.conversationId)) continue
      this.queue.splice(i, 1)
      return task.id
    }
    return undefined
  }

  // Run one task to completion: repair any dangling tool-call tail, resolve the
  // workspace, drive runAgentLoop, and settle the final status. No retry in this
  // cut — a transient failure ends `failed` (retry is plan 011).
  private async runOne(taskId: string): Promise<void> {
    const task = getTask(taskId)
    if (!task) return
    const abort = new AbortController()
    this.running.set(taskId, abort)
    try {
      this.repairDanglingToolCalls(task.conversationId)
      const workspace = this.resolveWorkspace(task.conversationId)

      updateTask(taskId, { status: "running" })
      this.emit(taskId, { type: "status_change", from: task.status, to: "running" })

      const result: ChatResult = await runAgentLoop({
        conversationId: task.conversationId,
        workspace,
        onEvent: (event) => this.emit(taskId, event),
        abort,
      })

      if (result.stopped) {
        updateTask(taskId, { status: "cancelled" })
        this.emit(taskId, { type: "status_change", from: "running", to: "cancelled" })
      } else if (result.error) {
        updateTask(taskId, { status: "failed", error: result.error })
        this.emit(taskId, { type: "task_failed", error: result.error })
        this.emit(taskId, { type: "status_change", from: "running", to: "failed" })
      } else {
        updateTask(taskId, { status: "completed", result: result.content ?? null })
        this.emit(taskId, { type: "task_completed", result: result.content })
        this.emit(taskId, { type: "status_change", from: "running", to: "completed" })
      }
    } catch (err) {
      // runAgentLoop swallows its own errors into {error}, so reaching here is an
      // unexpected throw (e.g. a repository call). Record it as a failure.
      const message = err instanceof Error ? err.message : String(err)
      updateTask(taskId, { status: "failed", error: message })
      this.emit(taskId, { type: "task_failed", error: message })
    } finally {
      this.running.delete(taskId)
      this.wakeup()
    }
  }

  // Resolve the absolute workspace directory for a conversation (or undefined for
  // a Chat-mode conversation with no workspace). The renderer can't supply this
  // for a background task, so the runner derives it: conversation → workspaceId →
  // workspace.path.
  private resolveWorkspace(conversationId: string): string | undefined {
    const conversation = getConversation(conversationId)
    if (!conversation?.workspaceId) return undefined
    return getWorkspace(conversation.workspaceId)?.path
  }

  // Before resuming an interrupted task, repair a dangling assistant tool-call
  // tail: if the last assistant turn requested tool calls but the app died
  // before every result was persisted, the rebuilt context would be invalid (the
  // model API requires a `tool` message for each tool_call_id). Append a
  // synthetic result for each unanswered call so the next request is well-formed.
  private repairDanglingToolCalls(conversationId: string): void {
    const messages = listMessages(conversationId)
    let lastIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant" && messages[i].toolCalls?.length) {
        lastIdx = i
        break
      }
    }
    if (lastIdx === -1) return
    const toolCalls = messages[lastIdx].toolCalls ?? []
    const answered = new Set(
      messages
        .slice(lastIdx + 1)
        .filter((m) => m.role === "tool" && m.toolCallId)
        .map((m) => m.toolCallId as string)
    )
    for (const call of toolCalls) {
      if (answered.has(call.id)) continue
      appendMessage({
        conversationId,
        role: "tool",
        content: "Interrupted before completion; result unknown.",
        toolCallId: call.id,
        toolName: call.name,
      })
    }
  }

  // Persist an event to the durable log and forward it to live subscribers.
  // Token deltas are ephemeral live-stream pieces — the durable transcript lives
  // in `messages` (runAgentLoop persists each assistant/tool message), so
  // persisting every token would bloat task_events for no recovery benefit. The
  // live tail still forwards tokens so a renderer attached mid-run sees them
  // stream, exactly like the live `chat` path.
  private emit(taskId: string, event: TaskEventPayload): void {
    let eventId = 0
    if (event.type !== "token") {
      eventId = appendEvent({ taskId, type: event.type, payload: event }).id
    }
    for (const listener of this.listeners) {
      try {
        listener(taskId, event, eventId)
      } catch (err) {
        console.error("Task event listener failed:", err)
      }
    }
  }
}

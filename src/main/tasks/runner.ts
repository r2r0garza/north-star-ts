import { runAgentLoop, SHUTDOWN_ABORT_REASON, type ChatEvent, type ChatResult } from "../agent"
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
} from "../db/repositories/tasks"
import { appendEvent } from "../db/repositories/task-events"
import {
  createApproval,
  listApprovals,
  resolveApproval as resolveApprovalRecord,
} from "../db/repositories/approvals"
import { appendMessage } from "../db/repositories/messages"
import { getConversation, createConversation } from "../db/repositories/conversations"
import { getWorkspace } from "../db/repositories/workspaces"
import { replaceTodos } from "../db/repositories/todos"
import type { Task, TaskStatus, TodoStatus } from "../db/types"

// Runner-emitted lifecycle events, appended to task_events alongside the agent's
// ChatEvents so a (re)attaching renderer can reconstruct a task's progress from
// the durable log. These are NOT part of the live `chat` path's ChatEvent union
// — they describe the task wrapper, not the agent turn.
export type RunnerLifecycleEvent =
  | { type: "status_change"; from: TaskStatus; to: TaskStatus }
  | { type: "task_completed"; result?: string }
  | { type: "task_failed"; error: string }
  // A transient failure is being retried: `n` is the attempt just completed (1 =
  // the first run failed), `reason` is the error message. The task stays
  // logically running (DB row unchanged) while it backs off, so no status_change
  // accompanies this — it's a progress note in the durable log (plan 011).
  | { type: "attempt"; n: number; reason: string }

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
export interface TaskKindCapability {
  autoResume: boolean
}

// The default kind for a durable agent turn enqueued from the UI: manual resume
// only. Background producers (indexing, maintenance) opt their kind into
// auto-resume via registerKind() at app init.
const DEFAULT_KIND = "agent_chat"

// A task's input blob carries its kind and the user message to run. Stored as
// JSON on tasks.input by enqueue; read back on resume.
interface TaskInput {
  kind: string
  message: string
  // Optional snapshot of a todo list to seed into the forked worker conversation
  // (plan 016, todo_run). enqueue forks a fresh conversation with an empty todos
  // table, so a handed-off list must be carried here and seeded — not a column
  // (per the 015 producer contract: per-kind config rides in the input blob).
  seedTodos?: Array<{ itemId: string; content: string; status: TodoStatus }>
}

function kindOf(task: Task): string {
  const input = task.input as Partial<TaskInput> | null
  return input?.kind ?? DEFAULT_KIND
}

// Retry-with-backoff tuning for transient failures (plan 011). MAX_ATTEMPTS is
// the total number of runs (1 initial + 2 retries); delay grows exponentially,
// capped at MAX_DELAY_MS.
interface BackoffConfig {
  baseMs: number
  maxMs: number
  maxAttempts: number
}
const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 1000,
  maxMs: 30_000,
  maxAttempts: 3,
}

// Capped exponential backoff with full jitter: a random delay in
// [0, min(maxMs, baseMs * 2^(attempt-1))]. Full jitter (vs a fixed schedule)
// avoids a thundering herd when sibling tasks back off together. Math.random is
// fine here — this is the Electron main process, not the workflow sandbox.
function backoffDelay(attempt: number, cfg: BackoffConfig): number {
  const ceiling = Math.min(cfg.maxMs, cfg.baseMs * 2 ** (attempt - 1))
  return Math.floor(Math.random() * ceiling)
}

// A single-process durable task runner over the existing task tables. It makes
// agent work queued (FIFO under a concurrency cap), background (runs with no
// renderer attached; progress persisted to task_events), and crash-resumable
// (an interrupted task survives an app restart). It wraps runAgentLoop — a
// "live turn" (runChat) and a "task" share that core loop but own their own
// AbortController, so the two lifecycles stay independent.
//
// PRODUCER CONTRACT: every task producer — the "Run in background" button, and
// future ones (workspace indexing, re-index, North Star subtasks, scheduled
// maintenance, artifact generation) — creates work ONLY through enqueue()
// (in-process) or the task:start IPC (over IPC). A producer must NEVER write the
// tasks/messages tables or call runAgentLoop directly. enqueue is the single
// seam; everything downstream — approvals, retry, crash recovery, cancellation,
// history — is shared by construction, so behavior is identical no matter who
// enqueued the task. A producer needing richer per-kind config passes it inside
// the task input blob (extend TaskInput per-kind) rather than adding columns,
// and registers its kind's capabilities via registerKind() at app init.
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
  // Per-task count of failed attempts so far (transient-retry budget). Survives
  // between a failed run and its backoff re-run; deleted on any terminal settle.
  private attempts = new Map<string, number>()
  // Pending backoff timers so cancel()/stop() can clear a task mid-sleep. A task
  // here is NOT in `running` (its slot is freed) but its DB row stays `running`.
  private backoffTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly backoff: BackoffConfig
  // Per-kind capability registry — the source of truth for capabilityOf().
  // agent_chat is pre-registered (manual-resume-only); producers opt their kind
  // into auto-resume via registerKind() at app init, before start() runs
  // reconcile/seed. Unknown kinds fall back to { autoResume: false }.
  private readonly kinds = new Map<string, TaskKindCapability>([
    [DEFAULT_KIND, { autoResume: false }],
  ])

  constructor(opts: { concurrency?: number; backoff?: Partial<BackoffConfig> } = {}) {
    this.concurrency = opts.concurrency ?? 2
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff }
  }

  // Reconcile orphaned tasks from a previous run, seed the queue with anything
  // already `queued`, and start the pump. Call once in app.whenReady (after the
  // DB handlers are registered — the runner reads the DB synchronously).
  start(): void {
    this.reconcile()
    this.seed()
    void this.pump()
  }

  // Register a task kind's capabilities (e.g. a background producer opting into
  // auto-resume on restart). Call once at app init, BEFORE start() — start()
  // runs reconcile(), which consults the registry to decide whether an orphaned
  // task of this kind re-queues (autoResume) or waits for a manual resume.
  // Re-registering a kind overwrites its capability.
  registerKind(kind: string, capability: TaskKindCapability): void {
    this.kinds.set(kind, capability)
  }

  // The capabilities of a task kind, from the registry. An unregistered kind
  // gets the conservative default: manual resume only.
  private capabilityOf(kind: string): TaskKindCapability {
    return this.kinds.get(kind) ?? { autoResume: false }
  }

  // Enqueue a new durable agent turn. The task runs in its OWN forked
  // conversation — a private worker transcript — so its model/tool messages
  // never interleave with the live chat the user started it from (which caused
  // races, mixed context, and duplicate answers when both wrote to one log). The
  // fork copies the source's mode, workspace, and LLM selection so the task runs
  // with the same context; `sourceConversationId` links it back so the Workspace
  // Activity panel can list it under the originating conversation. A headless
  // producer whose source conversation doesn't exist passes null, which createTask
  // treats as self-sourced (the task's own worker conversation). The user
  // message is persisted into the PRIVATE transcript, so runOne calls
  // runAgentLoop with no fresh userMessage — a first run and a resume are the
  // exact same code path.
  enqueue(input: {
    conversationId: string
    message: string
    kind?: string
    title?: string | null
    seedTodos?: TaskInput["seedTodos"]
  }): Task {
    const kind = input.kind ?? DEFAULT_KIND
    const taskInput: TaskInput = { kind, message: input.message, seedTodos: input.seedTodos }

    // Fork a private conversation from the source, inheriting its execution
    // context (mode → tools/prompt, workspace, provider/model selection).
    const source = getConversation(input.conversationId)
    const taskConversation = createConversation({
      mode: source?.mode ?? "interactive",
      workspaceId: source?.workspaceId ?? null,
      accountId: source?.accountId ?? null,
      modelId: source?.modelId ?? null,
      title: input.title ?? input.message.slice(0, 60),
    })

    // Seed a handed-off todo list into the fresh worker conversation (plan 016).
    // The fork starts with an empty todos table; replaceTodos writes the snapshot
    // so buildTodoListPrompt re-injects it and the background agent works the list.
    if (input.seedTodos && input.seedTodos.length > 0) {
      replaceTodos(
        taskConversation.id,
        input.seedTodos.map((t) => ({ id: t.itemId, content: t.content, status: t.status }))
      )
    }

    const task = createTask({
      conversationId: taskConversation.id,
      // Link back to the source only when it actually exists — source_conversation_id
      // has a FK (ON DELETE SET NULL), so a headless producer with no live source
      // (or a since-deleted one) records null rather than violating the constraint.
      sourceConversationId: source ? input.conversationId : null,
      title: input.title ?? null,
      status: "queued",
      input: taskInput,
    })
    appendMessage({
      conversationId: taskConversation.id,
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
    // A manual resume restarts the retry budget — the prior attempt counter (if
    // any survived) is stale; a fresh user-driven run gets the full allowance.
    this.attempts.delete(taskId)
    updateTask(taskId, { status: "queued" })
    this.emit(taskId, { type: "status_change", from: task.status, to: "queued" })
    if (!this.queue.includes(taskId)) this.queue.push(taskId)
    this.wakeup()
  }

  // Cancel a task. A running task is aborted (its 005 process-group kill tears
  // down any in-flight shell) and runOne maps the resulting {stopped:true} to a
  // `cancelled` status. A still-pending task is marked cancelled directly.
  cancel(taskId: string): void {
    // Backing off between retries: the task is sleeping on a timer, not in the
    // queue or the running map. Clear the timer and settle it cancelled. Its DB
    // row reads `running` during backoff, so map from there.
    const timer = this.backoffTimers.get(taskId)
    if (timer) {
      clearTimeout(timer)
      this.backoffTimers.delete(taskId)
      this.attempts.delete(taskId)
      this.queue = this.queue.filter((id) => id !== taskId)
      const task = getTask(taskId)
      if (task) {
        updateTask(taskId, { status: "cancelled" })
        this.emit(taskId, { type: "status_change", from: task.status, to: "cancelled" })
      }
      return
    }
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

  // Flip a paused task back to `running` after its approval/question gate was
  // resolved (the actual gate promise is resolved by resolveApproval/
  // resolveQuestion in the agent module — this just reflects the status). No-op
  // unless the task is currently waiting, so a stale call can't disturb a task
  // that already moved on. The loop was never suspended at the runner level (the
  // agent gate held it), so there's nothing to re-pump.
  markRunning(taskId: string): void {
    const task = getTask(taskId)
    if (!task || task.status !== "waiting_for_approval") return
    updateTask(taskId, { status: "running" })
    this.emit(taskId, { type: "status_change", from: "waiting_for_approval", to: "running" })
  }

  // Record the user's decision on a gate (durable approvals table) and flip the
  // task back to `running`. Called by the task:approve/deny IPC handlers after
  // they resolve the agent's in-memory gate. The `requestId` selects the exact
  // pending row to resolve, so a stale decision can't settle a request the task
  // re-created on resume.
  recordApprovalDecision(
    taskId: string,
    requestId: string,
    status: "approved" | "denied"
  ): void {
    this.settleApprovals(taskId, status, undefined, requestId)
    this.markRunning(taskId)
  }

  // Resolve still-`pending` approval rows for a task. With `requestId`, only the
  // row carrying that process-unique token is settled (the precise user
  // decision); without it, every pending row for the task is swept (crash/cancel
  // cleanup). `decision` is the structured blob recorded alongside the status.
  private settleApprovals(
    taskId: string,
    status: "approved" | "denied",
    decision?: unknown,
    requestId?: string
  ): void {
    for (const approval of listApprovals({ taskId, status: "pending" })) {
      if (requestId !== undefined) {
        const req = approval.request as { requestId?: string } | null
        if (req?.requestId !== requestId) continue
      }
      resolveApprovalRecord(approval.id, { status, decision })
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
    // Clear any pending backoff timers so they don't fire into a stopped pump
    // (or after the process is quitting). Their DB rows stay `running` and the
    // next boot's reconcile maps them to `interrupted`, same as in-flight tasks.
    for (const timer of this.backoffTimers.values()) clearTimeout(timer)
    this.backoffTimers.clear()
    // Abort with the shutdown reason so a task parked on an approval/question
    // gate is NOT resolved as denied/cancelled — leaving it unresolved keeps the
    // task `waiting_for_approval`, which the next boot's reconcile maps to
    // `interrupted` for a clean re-prompt on resume (plan 012). A plain abort()
    // here used to fabricate an "ERROR[denied]" tool result that wedged resume.
    for (const controller of this.running.values()) controller.abort(SHUTDOWN_ABORT_REASON)
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
      // A task killed mid-wait left a `pending` approval row whose in-memory gate
      // is gone. Resolve it `denied` (superseded) so it doesn't linger; on resume
      // the loop re-enters the gate and creates a fresh request (re-prompt, plan
      // 012). The agent never replays a decision the user made while quit.
      if (task.status === "waiting_for_approval") {
        this.settleApprovals(task.id, "denied", { superseded: "restart" })
      }
      const next: TaskStatus = this.capabilityOf(kindOf(task)).autoResume
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
    // A backing-off task isn't in `running` (its slot is freed) but it's still
    // logically in-flight on its conversation. Treat its conversation as busy too
    // so a same-conversation sibling can't start and interleave message writes
    // while it sleeps between retries.
    for (const id of this.backoffTimers.keys()) {
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

  // Run one task to completion: resolve the workspace, drive runAgentLoop (which
  // repairs any dangling tool-call tail from a crashed turn before rebuilding
  // context), and settle the final status. A transient failure is retried with
  // backoff (settleError); a deterministic one fails fast.
  private async runOne(taskId: string): Promise<void> {
    const task = getTask(taskId)
    if (!task) return
    const abort = new AbortController()
    this.running.set(taskId, abort)
    try {
      const workspace = this.resolveWorkspace(task.conversationId)

      updateTask(taskId, { status: "running" })
      this.emit(taskId, { type: "status_change", from: task.status, to: "running" })

      const result: ChatResult = await runAgentLoop({
        conversationId: task.conversationId,
        workspace,
        // A background task can itself hand off more work (e.g. a todo_run task
        // spawning another). Bind to this same runner so it goes through the one
        // enqueue seam — the producer contract holds recursively.
        enqueueTask: (input) => this.enqueue(input),
        onEvent: (event) => {
          // A gate is blocking the loop: surface it as waiting_for_approval so
          // the panel can prompt. The agent's gate promise stays parked until
          // the user answers via task:approve/deny/answer, which calls
          // markRunning to flip the status back. The task stays in `running`
          // (the loop hasn't returned), so the concurrency slot is still held —
          // intended: a paused task shouldn't free a slot mid-turn.
          if (event.type === "approval" || event.type === "question") {
            // Dual-write the approval gate to the durable `approvals` table so a
            // request blocked across an app restart is recoverable. Only
            // `approval` gets a row (questions are out of scope, plan 012); the
            // request blob mirrors the event so reconcile/resolve can match it by
            // its process-unique requestId.
            if (event.type === "approval") {
              createApproval({
                taskId,
                request: {
                  tool: event.tool,
                  summary: event.summary,
                  reason: event.reason,
                  requestId: event.requestId,
                  toolCallId: event.id,
                },
              })
            }
            updateTask(taskId, { status: "waiting_for_approval" })
            this.emit(taskId, {
              type: "status_change",
              from: "running",
              to: "waiting_for_approval",
            })
          }
          this.emit(taskId, event)
        },
        abort,
      })

      if (result.stopped) {
        this.attempts.delete(taskId)
        // A turn stopped while parked on a gate leaves a `pending` approval row;
        // sweep it so it doesn't outlive the cancelled task (no-op if the user
        // already approved/denied it).
        this.settleApprovals(taskId, "denied", { superseded: "interrupted" })
        updateTask(taskId, { status: "cancelled" })
        this.emit(taskId, { type: "status_change", from: "running", to: "cancelled" })
      } else if (result.error) {
        this.settleError(taskId, result.error, result.retryable === true)
      } else {
        this.attempts.delete(taskId)
        updateTask(taskId, { status: "completed", result: result.content ?? null })
        this.emit(taskId, { type: "task_completed", result: result.content })
        this.emit(taskId, { type: "status_change", from: "running", to: "completed" })
      }
    } catch (err) {
      // runAgentLoop swallows its own errors into {error}, so reaching here is an
      // unexpected throw (e.g. a repository call) — not a provider-transient error,
      // so it fails fast with no retry.
      const message = err instanceof Error ? err.message : String(err)
      this.attempts.delete(taskId)
      this.settleApprovals(taskId, "denied", { superseded: "interrupted" })
      updateTask(taskId, { status: "failed", error: message })
      this.emit(taskId, { type: "task_failed", error: message })
    } finally {
      this.running.delete(taskId)
      this.wakeup()
    }
  }

  // Settle a failed run: retry transient failures with backoff (up to
  // maxAttempts), fail fast otherwise. On a retry we record an `attempt` event,
  // leave the DB row `running` (so a crash mid-backoff reconciles to
  // `interrupted`), and arm a timer that re-queues the task once the slot is
  // freed by runOne's finally. On exhaustion (or a deterministic error) we mark
  // the task `failed` and clear the attempt counter.
  private settleError(taskId: string, error: string, retryable: boolean): void {
    const n = (this.attempts.get(taskId) ?? 0) + 1
    if (retryable && n < this.backoff.maxAttempts) {
      this.attempts.set(taskId, n)
      this.emit(taskId, { type: "attempt", n, reason: error })
      const timer = setTimeout(() => {
        this.backoffTimers.delete(taskId)
        if (this.stopped || !getTask(taskId)) {
          this.attempts.delete(taskId)
          return
        }
        if (!this.queue.includes(taskId)) this.queue.push(taskId)
        this.wakeup()
      }, backoffDelay(n, this.backoff))
      this.backoffTimers.set(taskId, timer)
      return
    }
    this.attempts.delete(taskId)
    updateTask(taskId, { status: "failed", error })
    this.emit(taskId, { type: "task_failed", error })
    this.emit(taskId, { type: "status_change", from: "running", to: "failed" })
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

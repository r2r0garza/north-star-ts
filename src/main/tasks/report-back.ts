import { runCompletionReport, type ChatEvent } from "../agent"

export type CompletionReportEvent =
  | { type: "started" }
  | { type: "event"; event: ChatEvent }
import { getTask, listTasks } from "../db/repositories/tasks"
import { getConversation } from "../db/repositories/conversations"
import { appendEvent, listEvents } from "../db/repositories/task-events"
import { getMaxMessageSeq } from "../db/repositories/messages"
import { completionReportInstruction, requiresHandoff } from "./handoff"
import type { TaskRunner } from "./runner"

export class TaskReportBack {
  private pending = new Set<string>()
  private stopped = false

  constructor(
    private readonly runner: TaskRunner,
    private readonly onReported: (conversationId: string) => void,
    private readonly onStream?: (
      conversationId: string,
      event: CompletionReportEvent
    ) => void
  ) {}

  start(): void {
    this.runner.subscribe((taskId, event) => {
      if (event.type === "task_completed" || event.type === "task_failed")
        this.enqueue(taskId)
    })
    for (const task of listTasks()) {
      if (task.status === "completed" || task.status === "failed")
        this.enqueue(task.id)
    }
  }

  stop(): void {
    this.stopped = true
  }

  private enqueue(taskId: string): void {
    if (this.stopped || this.pending.has(taskId)) return
    const task = getTask(taskId)
    if (
      !task ||
      !requiresHandoff(task) ||
      !task.sourceConversationId ||
      task.sourceConversationId === task.conversationId
    )
      return
    // Nested workers report to their parent worker, not to an unattended chat.
    if (listTasks({ conversationId: task.sourceConversationId }).length > 0)
      return
    const completion = listEvents(taskId).findLast(
      (event) => event.type === "task_completed" || event.type === "task_failed"
    )
    if (
      !completion ||
      listEvents(taskId).some(
        (event) =>
          event.type === "completion_reported" &&
          (event.payload as { completionEventId?: number })
            ?.completionEventId === completion.id
      )
    )
      return
    this.pending.add(taskId)
    void this.report(taskId, completion.id)
      .catch((error) => {
        console.error("Background task report-back failed:", error)
      })
      .finally(() => this.pending.delete(taskId))
  }

  private async report(
    taskId: string,
    completionEventId: number
  ): Promise<void> {
    const task = getTask(taskId)
    if (
      this.stopped ||
      !task?.sourceConversationId ||
      !getConversation(task.sourceConversationId)
    )
      return
    const conversationId = task.sourceConversationId
    const before = getMaxMessageSeq(conversationId)
    let started = false
    try {
      const result = await runCompletionReport(
        conversationId,
        completionReportInstruction(task),
        `The background task “${task.title ?? "Untitled task"}” ${task.status === "failed" ? "failed" : "finished"}, but I couldn't generate its completion report. Its result is available in task history; I haven't confirmed that the assignment was fulfilled.`,
        (event) => this.onStream?.(conversationId, { type: "event", event }),
        () => {
          started = true
          this.onStream?.(conversationId, { type: "started" })
        }
      )
      if (this.stopped || !getTask(taskId) || !getConversation(conversationId))
        return
      if (result.stopped && getMaxMessageSeq(conversationId) === before) return
      appendEvent({
        taskId,
        type: "completion_reported",
        payload: { completionEventId },
      })
    } finally {
      if (started) this.onReported(conversationId)
    }
    if (!started) this.onReported(conversationId)
  }
}

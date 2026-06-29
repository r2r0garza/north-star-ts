import { ipcMain, type WebContents } from "electron"
import type { TaskRunner, TaskEventPayload } from "../tasks/runner"
import { resolveApproval, resolveQuestion } from "../agent"
import type { QuestionAnswer } from "../agent/tools/types"

// Registers the durable task-runner control channels and the live event tail.
// The CRUD over the task tables already lives on the `db:tasks:*` / `db:taskEvents:*`
// channels (see db-handlers.ts) — these add the *control verbs* (start/resume/
// cancel) plus a live tail that mirrors `chat:event` for live token/tool streaming
// of a running task. Call after the runner is constructed in app.whenReady.
export function registerTaskHandlers(runner: TaskRunner): void {
  // Start a new durable agent turn. Resolves with the created task row so the
  // renderer can track it.
  ipcMain.handle(
    "task:start",
    (_e, input: { conversationId: string; message: string; kind?: string; title?: string | null }) =>
      runner.enqueue(input)
  )
  // Resume an interrupted task (user-driven manual resume).
  ipcMain.handle("task:resume", (_e, taskId: string) => runner.resume(taskId))
  // Cancel a task (running → aborted → cancelled; pending → cancelled directly).
  ipcMain.handle("task:cancel", (_e, taskId: string) => runner.cancel(taskId))

  // Resolve a gate a paused background task is blocked on. The agent loop's gate
  // is keyed by a process-unique `requestId` (carried in the approval/question
  // event the panel received), so these reuse the same resolvers the live chat
  // path uses (resolveApproval/resolveQuestion). For approvals, the runner also
  // records the decision in the durable `approvals` table and flips the task's
  // status back to running (recordApprovalDecision); questions have no durable
  // row, so they just markRunning.
  ipcMain.handle(
    "task:approve",
    (_e, payload: { taskId: string; requestId: string; remember?: "workspace" }) => {
      resolveApproval(payload.requestId, "approved", payload.remember)
      runner.recordApprovalDecision(payload.taskId, payload.requestId, "approved")
    }
  )
  ipcMain.handle(
    "task:deny",
    (_e, payload: { taskId: string; requestId: string }) => {
      resolveApproval(payload.requestId, "denied")
      runner.recordApprovalDecision(payload.taskId, payload.requestId, "denied")
    }
  )
  ipcMain.handle(
    "task:answer",
    (_e, payload: { taskId: string; requestId: string; answers: QuestionAnswer[] }) => {
      resolveQuestion(payload.requestId, payload.answers)
      runner.markRunning(payload.taskId)
    }
  )

  // Live event tail. A renderer calls "task:subscribe" once; from then on it
  // receives every task's events on the "task:event" channel until its
  // webContents is destroyed. The renderer replays history first via
  // db:taskEvents:list, then dedupes the live tail by the row id we forward.
  const subscriptions = new Map<WebContents, () => void>()
  ipcMain.handle("task:subscribe", (event) => {
    const sender = event.sender
    if (subscriptions.has(sender)) return
    const unsubscribe = runner.subscribe(
      (taskId: string, ev: TaskEventPayload, eventId: number) => {
        if (!sender.isDestroyed()) {
          sender.send("task:event", { taskId, event: ev, id: eventId })
        }
      }
    )
    subscriptions.set(sender, unsubscribe)
    sender.once("destroyed", () => {
      unsubscribe()
      subscriptions.delete(sender)
    })
  })
  ipcMain.handle("task:unsubscribe", (event) => {
    const unsubscribe = subscriptions.get(event.sender)
    if (unsubscribe) {
      unsubscribe()
      subscriptions.delete(event.sender)
    }
  })
}

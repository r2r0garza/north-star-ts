import { ipcMain, type WebContents } from "electron"
import type { TaskRunner, TaskEventPayload } from "../tasks/runner"

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

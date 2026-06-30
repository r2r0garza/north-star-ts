import { ipcMain } from "electron"
import {
  conversations,
  messages,
  workspaces,
  tasks,
  taskEvents,
  checkpoints,
  approvals,
  todos,
} from "../db/repositories"
import type { Mode, TaskStatus, ApprovalStatus } from "../db/types"

// Registers every `db:` IPC channel. Call after app.whenReady() so the DB
// connection (which reads app.getPath("userData")) opens lazily on first use.
// All handlers are synchronous repository calls; SQLite access stays in main.
export function registerDbHandlers(): void {
  // Conversations
  ipcMain.handle(
    "db:conversations:create",
    (_e, input: { mode: Mode; workspaceId?: string | null; title?: string | null }) =>
      conversations.createConversation(input)
  )
  ipcMain.handle("db:conversations:list", (_e, opts?: { mode?: Mode }) =>
    conversations.listConversations(opts)
  )
  ipcMain.handle("db:conversations:get", (_e, id: string) =>
    conversations.getConversation(id) ?? null
  )
  ipcMain.handle(
    "db:conversations:update",
    (_e, id: string, patch: { title?: string | null; workspaceId?: string | null }) =>
      conversations.updateConversation(id, patch)
  )
  ipcMain.handle("db:conversations:delete", (_e, id: string) =>
    conversations.deleteConversation(id)
  )

  // Messages (read-only from the renderer; writes happen inside runChat)
  ipcMain.handle("db:messages:list", (_e, conversationId: string) =>
    messages.listMessages(conversationId)
  )

  // Todos (read-only from the renderer; writes happen via the todo_write tool).
  // The Todos panel reads the active conversation's list to render it and offer
  // the "Run all in background" handoff (plan 016).
  ipcMain.handle("db:todos:list", (_e, conversationId: string) =>
    todos.listTodos(conversationId)
  )

  // Workspaces
  ipcMain.handle("db:workspaces:list", () => workspaces.listWorkspaces())
  ipcMain.handle("db:workspaces:upsert", (_e, path: string, name?: string) =>
    workspaces.upsertWorkspace(path, name)
  )
  ipcMain.handle("db:workspaces:update", (_e, id: string, patch: { name?: string }) =>
    workspaces.updateWorkspace(id, patch)
  )
  ipcMain.handle("db:workspaces:delete", (_e, id: string) =>
    workspaces.deleteWorkspace(id)
  )

  // Tasks (storage-only)
  ipcMain.handle(
    "db:tasks:create",
    (_e, input: { conversationId: string; title?: string | null; status?: TaskStatus; input?: unknown }) =>
      tasks.createTask(input)
  )
  ipcMain.handle(
    "db:tasks:list",
    (_e, opts?: { conversationId?: string; sourceConversationId?: string; status?: TaskStatus }) =>
      tasks.listTasks(opts)
  )
  ipcMain.handle("db:tasks:get", (_e, id: string) => tasks.getTask(id) ?? null)
  ipcMain.handle(
    "db:tasks:update",
    (_e, id: string, patch: { title?: string | null; status?: TaskStatus; result?: unknown; error?: string | null }) =>
      tasks.updateTask(id, patch)
  )
  ipcMain.handle("db:tasks:delete", (_e, id: string) => tasks.deleteTask(id))

  // Task events (storage-only, append-only)
  ipcMain.handle(
    "db:taskEvents:append",
    (_e, input: { taskId: string; type: string; payload?: unknown }) =>
      taskEvents.appendEvent(input)
  )
  ipcMain.handle(
    "db:taskEvents:list",
    (_e, taskId: string, opts?: { afterId?: number; limit?: number }) =>
      taskEvents.listEvents(taskId, opts)
  )

  // Checkpoints (storage-only)
  ipcMain.handle(
    "db:checkpoints:create",
    (_e, input: { taskId: string; label?: string | null; state: unknown }) =>
      checkpoints.createCheckpoint(input)
  )
  ipcMain.handle("db:checkpoints:list", (_e, taskId: string) =>
    checkpoints.listCheckpoints(taskId)
  )
  ipcMain.handle("db:checkpoints:get", (_e, id: string) =>
    checkpoints.getCheckpoint(id) ?? null
  )
  ipcMain.handle("db:checkpoints:delete", (_e, id: string) =>
    checkpoints.deleteCheckpoint(id)
  )

  // Approvals (storage-only)
  ipcMain.handle(
    "db:approvals:create",
    (_e, input: { taskId: string; request?: unknown }) =>
      approvals.createApproval(input)
  )
  ipcMain.handle("db:approvals:list", (_e, opts?: { taskId?: string; status?: ApprovalStatus }) =>
    approvals.listApprovals(opts)
  )
  ipcMain.handle(
    "db:approvals:resolve",
    (_e, id: string, decision: { status: "approved" | "denied"; decision?: unknown }) =>
      approvals.resolveApproval(id, decision)
  )
}

import { ipcMain } from "electron"
import {
  conversations,
  messages,
  workspaces,
  projects,
  tasks,
  taskEvents,
  checkpoints,
  approvals,
  todos,
} from "../db/repositories"
import type {
  Conversation,
  Mode,
  TaskStatus,
  ApprovalStatus,
} from "../db/types"
import type { IndexService } from "../index/service"
import type { TaskRunner } from "../tasks/runner"
import { getIndexing } from "../settings/service"
import { getRunByWorkspace } from "../db/repositories/index-runs"

// Kick off auto-indexing when a conversation gains a workspace in an indexable
// mode (plan 008). Gated by the global auto-index setting and the per-workspace
// enable flag; North Star indexes at high priority (prefer index before deep
// execution), Interactive at low (background). ensureRunning is idempotent, so
// re-firing on every create/update is safe. Failures never block the DB call.
function maybeAutoIndex(
  conversation: Conversation,
  service?: IndexService
): void {
  if (!service || !conversation.workspaceId) return
  if (conversation.mode !== "interactive" && conversation.mode !== "north_star")
    return
  if (!getIndexing().autoIndexNewWorkspaces) return
  const run = getRunByWorkspace(conversation.workspaceId)
  if (run && !run.enabled) return
  try {
    service.ensureRunning(
      conversation.workspaceId,
      conversation.mode === "north_star" ? "high" : "low"
    )
  } catch (err) {
    console.error("auto-index trigger failed:", err)
  }
}

// Registers every `db:` IPC channel. Call after app.whenReady() so the DB
// connection (which reads app.getPath("userData")) opens lazily on first use.
// All handlers are synchronous repository calls; SQLite access stays in main.
// `indexService` (plan 008) is optional so tests/headless callers can omit it.
// `runner` (plan 022) is optional for the same reason: when present, a session
// delete routes through it so the tasks it sourced are cancelled and their worker
// conversations cleaned up (no orphans); when absent, delete is the raw DB call.
export function registerDbHandlers(
  indexService?: IndexService,
  runner?: TaskRunner,
  // Close a conversation's browser tab when it's deleted (plan: tabbed browser).
  // A thin callback rather than the BrowserManager type, to keep this module
  // decoupled from the browser layer. Optional for tests/headless.
  closeBrowserTab?: (conversationId: string) => void
): void {
  // Conversations
  ipcMain.handle(
    "db:conversations:create",
    (
      _e,
      input: {
        mode: Mode
        workspaceId?: string | null
        projectId?: string | null
        title?: string | null
        accountId?: string | null
        modelId?: string | null
        agentName?: string | null
      }
    ) => {
      const conversation = conversations.createConversation(input)
      maybeAutoIndex(conversation, indexService)
      return conversation
    }
  )
  ipcMain.handle("db:conversations:list", (_e, opts?: { mode?: Mode }) =>
    conversations.listConversations(opts)
  )
  ipcMain.handle(
    "db:conversations:get",
    (_e, id: string) => conversations.getConversation(id) ?? null
  )
  ipcMain.handle(
    "db:conversations:update",
    (
      _e,
      id: string,
      patch: {
        title?: string | null
        workspaceId?: string | null
        projectId?: string | null
        accountId?: string | null
        modelId?: string | null
        agentName?: string | null
      }
    ) => {
      const conversation = conversations.updateConversation(id, patch)
      maybeAutoIndex(conversation, indexService)
      return conversation
    }
  )
  ipcMain.handle("db:conversations:delete", (_e, id: string) => {
    // Close the conversation's browser tab (if any) so a deleted conversation
    // doesn't leave an orphaned tab/renderer behind.
    closeBrowserTab?.(id)
    return runner
      ? runner.deleteSourceConversation(id)
      : conversations.deleteConversation(id)
  })

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
  ipcMain.handle(
    "db:workspaces:update",
    (_e, id: string, patch: { name?: string }) =>
      workspaces.updateWorkspace(id, patch)
  )
  ipcMain.handle("db:workspaces:delete", (_e, id: string) =>
    workspaces.deleteWorkspace(id)
  )

  // Projects — a grouping of conversations with an optional default directory
  // (workspace_id). Thin repository wrappers, like the other DB channels.
  ipcMain.handle(
    "db:projects:create",
    (_e, input: { name: string; workspaceId?: string | null }) =>
      projects.createProject(input)
  )
  ipcMain.handle("db:projects:list", () => projects.listProjects())
  ipcMain.handle(
    "db:projects:get",
    (_e, id: string) => projects.getProject(id) ?? null
  )
  ipcMain.handle(
    "db:projects:update",
    (_e, id: string, patch: { name?: string; workspaceId?: string | null }) =>
      projects.updateProject(id, patch)
  )
  ipcMain.handle("db:projects:delete", (_e, id: string) =>
    projects.deleteProject(id)
  )

  // Tasks (storage-only)
  ipcMain.handle(
    "db:tasks:create",
    (
      _e,
      input: {
        conversationId: string
        title?: string | null
        status?: TaskStatus
        input?: unknown
      }
    ) => tasks.createTask(input)
  )
  ipcMain.handle(
    "db:tasks:list",
    (
      _e,
      opts?: {
        conversationId?: string
        sourceConversationId?: string
        status?: TaskStatus
      }
    ) => tasks.listTasks(opts)
  )
  ipcMain.handle("db:tasks:get", (_e, id: string) => tasks.getTask(id) ?? null)
  ipcMain.handle(
    "db:tasks:update",
    (
      _e,
      id: string,
      patch: {
        title?: string | null
        status?: TaskStatus
        result?: unknown
        error?: string | null
      }
    ) => tasks.updateTask(id, patch)
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
  ipcMain.handle(
    "db:checkpoints:get",
    (_e, id: string) => checkpoints.getCheckpoint(id) ?? null
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
  ipcMain.handle(
    "db:approvals:list",
    (_e, opts?: { taskId?: string; status?: ApprovalStatus }) =>
      approvals.listApprovals(opts)
  )
  ipcMain.handle(
    "db:approvals:resolve",
    (
      _e,
      id: string,
      decision: { status: "approved" | "denied"; decision?: unknown }
    ) => approvals.resolveApproval(id, decision)
  )
}

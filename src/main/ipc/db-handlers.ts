import { ipcMain, type WebContents } from "electron"
import type { WorkflowDefinition } from "../../shared/workflows"
import { serializeWorkflowExport } from "../workflow-export"
import {
  conversations,
  messages,
  workspaces,
  projects,
  workflows,
  tasks,
  taskEvents,
  checkpoints,
  approvals,
  todos,
  dashboards,
} from "../db/repositories"
import type {
  GeneratedFilesRule,
  WorktreeSetup,
  Conversation,
  Mode,
  TaskStatus,
  ApprovalStatus,
  WorkspaceChecks,
} from "../db/types"
import type { IndexService } from "../index/service"
import type { TaskRunner } from "../tasks/runner"
import { autoIndexWorkspace } from "../index/auto-index"
import { deleteConversationWithArtifacts } from "../conversations/lifecycle"

// Kick off auto-indexing when a conversation gains a workspace in an indexable
// mode (plan 008). Gated by the global auto-index setting and the per-workspace
// enable flag; North Star indexes at high priority (prefer index before deep
// execution), Interactive at low (background). ensureRunning is idempotent, so
// re-firing on every create/update is safe. Failures never block the DB call.
function maybeAutoIndex(
  conversation: Conversation,
  service?: IndexService,
  watcher?: { start: (workspaceId: string) => Promise<void> }
): void {
  if (!service || !conversation.workspaceId) return
  if (conversation.mode !== "interactive" && conversation.mode !== "north_star")
    return
  autoIndexWorkspace(
    conversation.workspaceId,
    conversation.mode === "north_star" ? "high" : "low",
    service,
    watcher
  )
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
  closeBrowserTab?: (conversationId: string) => void,
  indexWatcher?: {
    start: (workspaceId: string) => Promise<void>
    stop: (workspaceId: string) => Promise<void>
  }
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
      maybeAutoIndex(conversation, indexService, indexWatcher)
      return conversation
    }
  )
  ipcMain.handle("db:conversations:list", (_e, opts?: { mode?: Mode }) =>
    conversations.listConversations(opts)
  )
  ipcMain.handle(
    "db:conversations:search",
    (_e, query: unknown, opts?: { limit?: unknown }) =>
      conversations.searchConversations(String(query ?? ""), {
        limit: typeof opts?.limit === "number" ? opts.limit : undefined,
      })
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
      maybeAutoIndex(conversation, indexService, indexWatcher)
      return conversation
    }
  )
  // Pin/unpin: a dedicated channel (not the generic update) so it can leave
  // updated_at untouched — the update path always bumps recency, which would
  // break "unpin returns to natural position."
  ipcMain.handle(
    "db:conversations:setPinned",
    (_e, id: string, pinned: boolean) =>
      conversations.setConversationPinned(id, pinned)
  )
  ipcMain.handle("db:conversations:delete", (_e, id: string) => {
    // Close the conversation's browser tab (if any) so a deleted conversation
    // doesn't leave an orphaned tab/renderer behind.
    closeBrowserTab?.(id)
    return runner
      ? runner.deleteSourceConversation(id)
      : deleteConversationWithArtifacts(id)
  })
  const conversationSubscriptions = new Map<
    WebContents,
    { unsubscribe: () => void; onDestroyed: () => void }
  >()
  const unsubscribeConversations = (sender: WebContents) => {
    const subscription = conversationSubscriptions.get(sender)
    if (!subscription) return
    subscription.unsubscribe()
    sender.removeListener("destroyed", subscription.onDestroyed)
    conversationSubscriptions.delete(sender)
  }
  ipcMain.handle("db:conversations:subscribe", (event) => {
    const sender = event.sender
    if (conversationSubscriptions.has(sender)) return
    const stop = conversations.subscribeConversationChanges((payload) => {
      if (!sender.isDestroyed()) {
        sender.send("db:conversations:change", payload)
      }
    })
    const onDestroyed = () => unsubscribeConversations(sender)
    conversationSubscriptions.set(sender, { unsubscribe: stop, onDestroyed })
    sender.once("destroyed", onDestroyed)
  })
  ipcMain.handle("db:conversations:unsubscribe", (event) => {
    unsubscribeConversations(event.sender)
  })

  // Messages (read-only from the renderer; writes happen inside runChat)
  ipcMain.handle("db:messages:list", (_e, conversationId: string) =>
    messages
      .listMessages(conversationId)
      .map(({ nativeAssistant: _native, ...message }) => message)
  )

  // Todos (read-only from the renderer; writes happen via the todo_write tool).
  // The Todos panel reads the active conversation's list to render it and offer
  // the "Run all in background" handoff (plan 016).
  ipcMain.handle("db:todos:list", (_e, conversationId: string) =>
    todos.listTodos(conversationId)
  )
  const todoSubscriptions = new Map<
    WebContents,
    { unsubscribe: () => void; onDestroyed: () => void }
  >()
  const unsubscribeTodos = (sender: WebContents) => {
    const subscription = todoSubscriptions.get(sender)
    if (!subscription) return
    subscription.unsubscribe()
    sender.removeListener("destroyed", subscription.onDestroyed)
    todoSubscriptions.delete(sender)
  }
  ipcMain.handle("db:todos:subscribe", (event) => {
    const sender = event.sender
    if (todoSubscriptions.has(sender)) return
    const stop = todos.subscribeTodoChanges((payload) => {
      if (!sender.isDestroyed()) {
        sender.send("db:todos:change", payload)
      }
    })
    const onDestroyed = () => unsubscribeTodos(sender)
    todoSubscriptions.set(sender, { unsubscribe: stop, onDestroyed })
    sender.once("destroyed", onDestroyed)
  })
  ipcMain.handle("db:todos:unsubscribe", (event) => {
    unsubscribeTodos(event.sender)
  })

  // Workspaces
  ipcMain.handle("db:workspaces:list", () => workspaces.listWorkspaces())
  ipcMain.handle("db:workspaces:upsert", (_e, path: string, name?: string) =>
    workspaces.upsertWorkspace(path, name)
  )
  ipcMain.handle(
    "db:workspaces:update",
    (
      _e,
      id: string,
      patch: {
        name?: string
        generatedFiles?: GeneratedFilesRule[]
        worktreeSetup?: WorktreeSetup
        commandChecks?: WorkspaceChecks
      }
    ) => workspaces.updateWorkspace(id, patch)
  )
  ipcMain.handle("db:workspaces:delete", async (_e, id: string) => {
    await indexWatcher?.stop(id)
    workspaces.deleteWorkspace(id)
  })

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
  ipcMain.handle("db:projects:reorder", (_e, ids: string[]) =>
    projects.reorderProjects(ids)
  )

  ipcMain.on("db:workflows:flush", (event, workflow: WorkflowDefinition) => {
    try {
      workflows.updateWorkflow(workflow)
      event.returnValue = { ok: true }
    } catch {
      event.returnValue = { ok: false }
    }
  })
  ipcMain.handle("db:workflows:delete", (_e, id: string) =>
    workflows.deleteWorkflow(id)
  )
  ipcMain.handle("db:workflows:import", (_e, data: unknown) => workflows.importWorkflow(data))
  ipcMain.handle("db:workflows:export", (_e, workflow: WorkflowDefinition) => {
    const { dialog, BrowserWindow } = require("electron") as typeof import("electron")
    const { writeFile } = require("node:fs/promises") as typeof import("node:fs/promises")
    const safeName = workflow.name.replace(/[\\/:*?\"<>|]/g, "-").trim() || "workflow"
    return (async () => {
      const win = BrowserWindow.getFocusedWindow()
    const options = { defaultPath: `${safeName}.json`, filters: [{ name: "JSON", extensions: ["json"] }] }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { canceled: true }
      await writeFile(result.filePath, serializeWorkflowExport(workflow), "utf8")
      return { canceled: false }
    })()
  })
  ipcMain.handle("db:workflows:create", () => workflows.createWorkflow())
  ipcMain.handle("db:workflows:list", () => workflows.listWorkflows())
  ipcMain.handle("db:workflows:update", (_e, workflow: WorkflowDefinition) =>
    workflows.updateWorkflow(workflow)
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

  // Live dashboards (plan 033). Structured CRUD the dashboards view + the
  // dashboard_write agent tool share. A dashboard is a top-level object (not
  // conversation-scoped); widgets + their cached data hang off it.
  ipcMain.handle(
    "db:dashboards:create",
    (
      _e,
      input: { name: string; description?: string | null; layout?: unknown }
    ) => dashboards.createDashboard(input)
  )
  ipcMain.handle("db:dashboards:list", () => dashboards.listDashboards())
  ipcMain.handle(
    "db:dashboards:get",
    (_e, id: string) => dashboards.getDashboard(id) ?? null
  )
  ipcMain.handle(
    "db:dashboards:graph",
    (_e, id: string) => dashboards.getDashboardGraph(id) ?? null
  )
  ipcMain.handle(
    "db:dashboards:update",
    (
      _e,
      id: string,
      patch: {
        name?: string
        description?: string | null
        layout?: unknown
        pinned?: boolean
      }
    ) => dashboards.updateDashboard(id, patch)
  )
  ipcMain.handle("db:dashboards:delete", (_e, id: string) =>
    dashboards.deleteDashboard(id)
  )

  ipcMain.handle("db:dashboards:widgets:list", (_e, dashboardId: string) =>
    dashboards.listWidgets(dashboardId)
  )
  ipcMain.handle(
    "db:dashboards:widgets:create",
    (
      _e,
      input: {
        dashboardId: string
        title: string
        type: unknown
        config?: unknown
        recipe?: unknown
        pos?: unknown
        position?: number
      }
    ) => dashboards.createWidget(input)
  )
  ipcMain.handle(
    "db:dashboards:widgets:update",
    (
      _e,
      id: string,
      patch: {
        title?: string
        type?: unknown
        config?: unknown
        recipe?: unknown
        pos?: unknown
        position?: number
      }
    ) => dashboards.updateWidget(id, patch)
  )
  ipcMain.handle("db:dashboards:widgets:delete", (_e, id: string) =>
    dashboards.deleteWidget(id)
  )

  ipcMain.handle(
    "db:dashboards:data:get",
    (_e, widgetId: string) => dashboards.getWidgetData(widgetId) ?? null
  )
  ipcMain.handle(
    "db:dashboards:data:upsert",
    (
      _e,
      input: {
        widgetId: string
        data?: unknown
        status?: unknown
        error?: string | null
      }
    ) => dashboards.upsertWidgetData(input)
  )
}

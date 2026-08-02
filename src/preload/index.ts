import { contextBridge, ipcRenderer } from "electron"
import type { IpcRendererEvent } from "electron"
// Type-only imports — erased at build time, so better-sqlite3 is never pulled
// into the preload bundle. The renderer gets exact DB row types via these.
import type {
  Approval,
  ApprovalStatus,
  Conversation,
  Message,
  Mode,
  Task,
  TaskCheckpoint,
  TaskEvent,
  TaskStatus,
  Todo,
  Workspace,
} from "../main/db/types"
import type { ActionKind } from "../main/agent/approval/types"
import type { PickedElement } from "../main/browser/types"
import type { GitDiffResult } from "../main/git/diff"
import type { Question, QuestionAnswer } from "../main/agent/tools/types"
import type {
  ExecutionSettings,
  PermissionSettings,
  LlmSettings,
  IndexingSettings,
  SkillSourcesSettings,
  BrowserSettings,
  IdeSettings,
} from "../main/settings/service"
import type { SkillSourceRow } from "../main/agent/skills/types"
import type { RuntimeStatus } from "../main/agent/env/runtime-check"
import type { CreateAccountInput } from "../main/db/repositories/provider-accounts"
import type { AddModelInput } from "../main/db/repositories/models"
import type {
  AccountView,
  AccountWithModels,
} from "../main/ipc/provider-handlers"
import type { ModelEntry, IndexPriority } from "../main/db/types"
import type { IndexStatus } from "../main/ipc/index-handlers"

// Streaming events emitted during a chat turn (mirrors ChatEvent in the agent).
export type ChatEvent =
  | { type: "token"; delta: string }
  | {
      type: "tool"
      phase: "start"
      id: string
      name: string
      arguments: string
    }
  | { type: "tool"; phase: "done"; id: string; name: string; result: string }
  | {
      type: "approval"
      id: string
      requestId: string
      tool: string
      summary: string
      reason: string
      // The action kind being approved (e.g. "delegate"). The renderer hides the
      // "always allow" affordance for delegate approvals. Optional for back-compat.
      kind?: ActionKind
    }
  | {
      type: "question"
      id: string
      requestId: string
      questions: Question[]
    }

// Runner lifecycle events appended to task_events alongside ChatEvents (mirrors
// RunnerLifecycleEvent in the task runner).
export type RunnerLifecycleEvent =
  | { type: "status_change"; from: TaskStatus; to: TaskStatus }
  | { type: "task_completed"; result?: string }
  | { type: "task_failed"; error: string }
  | { type: "attempt"; n: number; reason: string }
  // Deterministic indexing progress (plan 008): scanned/total for the strip.
  | {
      type: "index_progress"
      stage: string
      filesScanned: number
      filesTotal: number
    }

// The full event vocabulary a task emits, live or replayed from task_events.
export type TaskEventPayload = ChatEvent | RunnerLifecycleEvent

// A live task event, as forwarded over the "task:event" channel. `id` is the
// task_events row id (0 for ephemeral token deltas, which aren't persisted), so
// the renderer can dedupe the live tail against a db.taskEvents.list replay.
export type TaskLiveEvent = {
  taskId: string
  event: TaskEventPayload
  id: number
}

// A skill as surfaced to the composer's slash menu — just what the picker needs
// to display and match on. The full body stays in the main process (read_skill).
export type SkillSummary = {
  name: string
  description: string
}

// The typed API exposed to the renderer as `window.cowork`.
// This is the ONLY surface the UI can use to reach the main process.
const api = {
  // Runs a chat turn. `onEvent` receives streamed tokens and tool activity;
  // the returned promise resolves with the final result. The event listener is
  // attached only for the duration of the turn and removed when it settles.
  chat: (
    req: {
      conversationId: string
      message: string
      workspace?: string
      attachments?: string[]
    },
    onEvent?: (event: ChatEvent) => void
  ) => {
    // The "chat:event" channel is shared by every in-flight turn, so filter to
    // this turn's conversation — otherwise a concurrent turn's tokens would
    // stream into this one's bubble.
    const listener = (
      _e: IpcRendererEvent,
      payload: { conversationId: string; event: ChatEvent }
    ) => {
      if (payload.conversationId === req.conversationId)
        onEvent?.(payload.event)
    }
    ipcRenderer.on("chat:event", listener)
    const done = () => ipcRenderer.removeListener("chat:event", listener)
    return (
      ipcRenderer.invoke("chat", req) as Promise<{
        content?: string
        error?: string
        stopped?: boolean
      }>
    ).finally(done)
  },
  // Cancel the in-flight turn for a conversation (the Stop button). The chat()
  // promise above then resolves with `{ stopped: true }`.
  chatStop: (conversationId: string) =>
    ipcRenderer.invoke("chat:stop", conversationId) as Promise<void>,
  // Resolve an in-flight approval request (from an "approval" ChatEvent). The
  // agent loop is paused until this is called. `requestId` is the token from the
  // event. `remember: "workspace"` persists an allowlist rule so the same action
  // is auto-approved next time.
  chatApprove: (payload: {
    requestId: string
    decision: "approved" | "denied"
    remember?: "workspace"
  }) => ipcRenderer.invoke("chat:approve", payload) as Promise<void>,
  // Answer an in-flight ask_user_question (from a "question" ChatEvent). The
  // agent loop is paused until this is called. `answers` is parallel to the
  // event's `questions` array.
  chatAnswer: (payload: { requestId: string; answers: QuestionAnswer[] }) =>
    ipcRenderer.invoke("chat:answer", payload) as Promise<void>,

  // Durable task runner control. Unlike chat() (a live, foreground turn tied to
  // the calling renderer), a task runs in the background in the main process,
  // persists its progress to task_events, and survives the renderer detaching or
  // the app restarting. Replay a task's history with db.taskEvents.list, then
  // subscribe to the live tail with tasks.onEvent.
  tasks: {
    // Start a new durable agent turn. Resolves with the created task row.
    start: (input: {
      conversationId: string
      message: string
      kind?: string
      title?: string | null
    }) => ipcRenderer.invoke("task:start", input) as Promise<Task>,
    // Hand the conversation's current todo list off to a background task (the
    // "Run all in background" button, plan 016). Snapshots the list server-side
    // and enqueues a `todo_run` task. Resolves null when there's nothing to run.
    startTodos: (conversationId: string) =>
      ipcRenderer.invoke(
        "task:start-todos",
        conversationId
      ) as Promise<Task | null>,
    // Manually resume an interrupted task (e.g. one reconciled after a crash).
    resume: (taskId: string) =>
      ipcRenderer.invoke("task:resume", taskId) as Promise<void>,
    // Cancel a task: a running one is aborted (its in-flight shell is killed),
    // a pending one is marked cancelled. Never retries.
    cancel: (taskId: string) =>
      ipcRenderer.invoke("task:cancel", taskId) as Promise<void>,
    // Pause a task (plan 008): a running one aborts to `paused` (a durable resume
    // state keeping partial progress); resume() with the same id continues it.
    pause: (taskId: string) =>
      ipcRenderer.invoke("task:pause", taskId) as Promise<void>,
    // Resolve a gate a paused (waiting_for_approval) task is blocked on. The
    // requestId comes from the task's approval/question event. approve/deny gate
    // a tool action; answer responds to an ask_user_question.
    approve: (payload: {
      taskId: string
      requestId: string
      remember?: "workspace"
    }) => ipcRenderer.invoke("task:approve", payload) as Promise<void>,
    deny: (payload: { taskId: string; requestId: string }) =>
      ipcRenderer.invoke("task:deny", payload) as Promise<void>,
    answer: (payload: {
      taskId: string
      requestId: string
      answers: QuestionAnswer[]
    }) => ipcRenderer.invoke("task:answer", payload) as Promise<void>,
    // Subscribe to the live event tail for ALL tasks. Returns an unsubscribe fn.
    // The callback fires for every running task's tokens, tool activity, and
    // status changes; filter by `taskId` in the handler.
    onEvent: (cb: (event: TaskLiveEvent) => void) => {
      const listener = (_e: IpcRendererEvent, payload: TaskLiveEvent) =>
        cb(payload)
      ipcRenderer.on("task:event", listener)
      void ipcRenderer.invoke("task:subscribe")
      return () => {
        ipcRenderer.removeListener("task:event", listener)
        void ipcRenderer.invoke("task:unsubscribe")
      }
    },
  },
  pickWorkspace: () =>
    ipcRenderer.invoke("pick-workspace") as Promise<{
      path?: string
      canceled?: boolean
    }>,
  // Native multi-file picker for Chat attachments.
  pickFiles: () =>
    ipcRenderer.invoke("pick-files") as Promise<{
      paths?: string[]
      canceled?: boolean
    }>,
  // List available skills (name + description) for the composer's slash menu.
  // Pass the active workspace so project-level skills are included.
  skills: {
    list: (workspace?: string) =>
      ipcRenderer.invoke("skills:list", workspace) as Promise<SkillSummary[]>,
    // Enumerate the skill-source folders (built-in + custom) with per-source
    // skill counts, for Settings → Capabilities. Pass the workspace to include
    // the workspace-scoped sources.
    sources: (workspace?: string) =>
      ipcRenderer.invoke("skills:sources", workspace) as Promise<
        SkillSourceRow[]
      >,
  },
  // List workspace files for the composer's `@`-mention menu, filtered by the
  // typed query (server-side). Returns workspace-relative POSIX paths, capped.
  // Resolves [] when there's no workspace (Chat mode).
  files: {
    list: (workspace: string, query: string) =>
      ipcRenderer.invoke("files:list", workspace, query) as Promise<string[]>,
  },
  // Read the current git branch for a workspace folder. Resolves with the
  // branch name, a short detached-HEAD SHA, or null when not a git repo.
  git: {
    branch: (path: string) =>
      ipcRenderer.invoke("git:branch", path) as Promise<string | null>,
    // Working-tree diff for one workspace-relative file (backs the changed-file
    // pills). Null when not a git repo; { diff: "" } when tracked but unchanged.
    diff: (workspace: string, relPath: string) =>
      ipcRenderer.invoke("git:diff", workspace, relPath) as Promise<GitDiffResult | null>,
  },
  // Open a workspace file in the OS default app for its type (the user's IDE, if
  // that's the default). Resolves with "" on success or an error string.
  openInEditor: (workspace: string, relPath: string) =>
    ipcRenderer.invoke("open-in-editor", workspace, relPath) as Promise<string>,
  // Whether the window is currently fullscreen (macOS traffic lights hidden).
  isFullScreen: () => ipcRenderer.invoke("is-fullscreen") as Promise<boolean>,
  // Subscribe to fullscreen changes. Returns an unsubscribe function.
  onFullScreenChange: (cb: (value: boolean) => void) => {
    const listener = (_e: IpcRendererEvent, value: boolean) => cb(value)
    ipcRenderer.on("window:fullscreen", listener)
    return () => {
      ipcRenderer.removeListener("window:fullscreen", listener)
    }
  },
  // Subscribe to elements the user picks in the agent browser (pick mode). The
  // renderer surfaces the payload as a pending composer chip. Returns an
  // unsubscribe function.
  onBrowserElementPicked: (cb: (element: PickedElement) => void) => {
    const listener = (_e: IpcRendererEvent, element: PickedElement) =>
      cb(element)
    ipcRenderer.on("browser:element-picked", listener)
    return () => {
      ipcRenderer.removeListener("browser:element-picked", listener)
    }
  },
  // Tell main which conversation the user is now viewing, so the agent browser
  // shows that conversation's tab. Null = a fresh/uncreated conversation.
  setActiveConversation: (conversationId: string | null) => {
    void ipcRenderer.invoke("browser:set-active-conversation", conversationId)
  },
  // Subscribe to a request (from clicking a tab in the agent browser) to switch
  // the app to a conversation. Returns an unsubscribe function.
  onActivateConversation: (cb: (conversationId: string) => void) => {
    const listener = (_e: IpcRendererEvent, id: string) => cb(id)
    ipcRenderer.on("browser:activate-conversation", listener)
    return () => {
      ipcRenderer.removeListener("browser:activate-conversation", listener)
    }
  },
  // Report the right-panel Browser slot's on-screen rectangle so the embedded
  // agent-browser view is laid out to match. Null hides the embed (panel closed /
  // not in Browser mode / obscured by a modal).
  reportBrowserBounds: (
    bounds: { x: number; y: number; width: number; height: number } | null
  ) => {
    void ipcRenderer.invoke("browser:report-bounds", bounds)
  },
  // Choose where the agent browser displays: "sidebar" (embedded in the app
  // panel) or "window" (the separate pop-out window).
  setBrowserSurface: (surface: "window" | "sidebar") => {
    void ipcRenderer.invoke("browser:set-surface", surface)
  },
  // Drive the active tab from the sidebar browser chrome (URL bar / reload /
  // pick). These reuse the same handlers the separate window's chrome uses.
  browserNavigate: (url: string) => {
    void ipcRenderer.invoke("browser:navigate", url)
  },
  browserReload: () => {
    void ipcRenderer.invoke("browser:reload")
  },
  browserSetPickMode: (active: boolean) => {
    void ipcRenderer.invoke("browser:set-pick-mode", active)
  },
  // Subscribe to a request to open the right panel in Browser mode (the sidebar
  // equivalent of the agent browser window revealing itself). Returns unsubscribe.
  onBrowserRequestOpen: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on("browser:request-open", listener)
    return () => {
      ipcRenderer.removeListener("browser:request-open", listener)
    }
  },
  // Subscribe to the active tab's pick-mode state (so the panel's "Pick" toggle
  // reflects the true state — auto-off after a pick, etc.). Returns unsubscribe.
  onBrowserPickMode: (cb: (active: boolean) => void) => {
    const listener = (_e: IpcRendererEvent, active: boolean) => cb(active)
    ipcRenderer.on("browser:pick-mode", listener)
    return () => {
      ipcRenderer.removeListener("browser:pick-mode", listener)
    }
  },
  // Subscribe to the tab list (used by the sidebar chrome to show the active
  // tab's URL/title/loading). Returns unsubscribe.
  onBrowserTabs: (
    cb: (
      tabs: Array<{
        id: string
        title: string
        url: string
        loading: boolean
        active: boolean
      }>
    ) => void
  ) => {
    const listener = (
      _e: IpcRendererEvent,
      tabs: Array<{
        id: string
        title: string
        url: string
        loading: boolean
        active: boolean
      }>
    ) => cb(tabs)
    ipcRenderer.on("browser:tabs", listener)
    return () => {
      ipcRenderer.removeListener("browser:tabs", listener)
    }
  },

  // Durable local state (SQLite, owned by the main process). Thin invoke
  // wrappers — the renderer only displays state and sends actions; it never
  // touches the database directly.
  db: {
    conversations: {
      create: (input: {
        mode: Mode
        workspaceId?: string | null
        title?: string | null
        accountId?: string | null
        modelId?: string | null
      }) =>
        ipcRenderer.invoke(
          "db:conversations:create",
          input
        ) as Promise<Conversation>,
      list: (opts?: { mode?: Mode }) =>
        ipcRenderer.invoke("db:conversations:list", opts) as Promise<
          Conversation[]
        >,
      get: (id: string) =>
        ipcRenderer.invoke(
          "db:conversations:get",
          id
        ) as Promise<Conversation | null>,
      update: (
        id: string,
        patch: {
          title?: string | null
          workspaceId?: string | null
          accountId?: string | null
          modelId?: string | null
        }
      ) =>
        ipcRenderer.invoke(
          "db:conversations:update",
          id,
          patch
        ) as Promise<Conversation>,
      delete: (id: string) =>
        ipcRenderer.invoke("db:conversations:delete", id) as Promise<void>,
    },
    messages: {
      list: (conversationId: string) =>
        ipcRenderer.invoke("db:messages:list", conversationId) as Promise<
          Message[]
        >,
    },
    todos: {
      // Read the conversation's task list (rendered by the Todos panel). Writes
      // happen via the agent's todo_write tool, not the renderer.
      list: (conversationId: string) =>
        ipcRenderer.invoke("db:todos:list", conversationId) as Promise<Todo[]>,
    },
    workspaces: {
      list: () =>
        ipcRenderer.invoke("db:workspaces:list") as Promise<Workspace[]>,
      upsert: (path: string, name?: string) =>
        ipcRenderer.invoke(
          "db:workspaces:upsert",
          path,
          name
        ) as Promise<Workspace>,
      update: (id: string, patch: { name?: string }) =>
        ipcRenderer.invoke(
          "db:workspaces:update",
          id,
          patch
        ) as Promise<Workspace>,
      delete: (id: string) =>
        ipcRenderer.invoke("db:workspaces:delete", id) as Promise<void>,
    },
    tasks: {
      create: (input: {
        conversationId: string
        title?: string | null
        status?: TaskStatus
        input?: unknown
      }) => ipcRenderer.invoke("db:tasks:create", input) as Promise<Task>,
      list: (opts?: {
        conversationId?: string
        sourceConversationId?: string
        status?: TaskStatus
      }) => ipcRenderer.invoke("db:tasks:list", opts) as Promise<Task[]>,
      get: (id: string) =>
        ipcRenderer.invoke("db:tasks:get", id) as Promise<Task | null>,
      update: (
        id: string,
        patch: {
          title?: string | null
          status?: TaskStatus
          result?: unknown
          error?: string | null
        }
      ) => ipcRenderer.invoke("db:tasks:update", id, patch) as Promise<Task>,
      delete: (id: string) =>
        ipcRenderer.invoke("db:tasks:delete", id) as Promise<void>,
    },
    taskEvents: {
      append: (input: { taskId: string; type: string; payload?: unknown }) =>
        ipcRenderer.invoke("db:taskEvents:append", input) as Promise<TaskEvent>,
      list: (taskId: string, opts?: { afterId?: number; limit?: number }) =>
        ipcRenderer.invoke("db:taskEvents:list", taskId, opts) as Promise<
          TaskEvent[]
        >,
    },
    checkpoints: {
      create: (input: {
        taskId: string
        label?: string | null
        state: unknown
      }) =>
        ipcRenderer.invoke(
          "db:checkpoints:create",
          input
        ) as Promise<TaskCheckpoint>,
      list: (taskId: string) =>
        ipcRenderer.invoke("db:checkpoints:list", taskId) as Promise<
          TaskCheckpoint[]
        >,
      get: (id: string) =>
        ipcRenderer.invoke(
          "db:checkpoints:get",
          id
        ) as Promise<TaskCheckpoint | null>,
      delete: (id: string) =>
        ipcRenderer.invoke("db:checkpoints:delete", id) as Promise<void>,
    },
    approvals: {
      create: (input: { taskId: string; request?: unknown }) =>
        ipcRenderer.invoke("db:approvals:create", input) as Promise<Approval>,
      list: (opts?: { taskId?: string; status?: ApprovalStatus }) =>
        ipcRenderer.invoke("db:approvals:list", opts) as Promise<Approval[]>,
      resolve: (
        id: string,
        decision: { status: "approved" | "denied"; decision?: unknown }
      ) =>
        ipcRenderer.invoke(
          "db:approvals:resolve",
          id,
          decision
        ) as Promise<Approval>,
    },
  },

  // Persisted settings (execution backend + approval policy). Mirrors the
  // `settings:` IPC channels; all reads/writes go through the main-process
  // settings service so its cache and the DB stay coherent.
  settings: {
    getExecution: () =>
      ipcRenderer.invoke("settings:getExecution") as Promise<ExecutionSettings>,
    setExecution: (next: ExecutionSettings) =>
      ipcRenderer.invoke(
        "settings:setExecution",
        next
      ) as Promise<ExecutionSettings>,
    getPermissions: () =>
      ipcRenderer.invoke(
        "settings:getPermissions"
      ) as Promise<PermissionSettings>,
    setPermissions: (next: PermissionSettings) =>
      ipcRenderer.invoke(
        "settings:setPermissions",
        next
      ) as Promise<PermissionSettings>,
    getIndexing: () =>
      ipcRenderer.invoke("settings:getIndexing") as Promise<IndexingSettings>,
    setIndexing: (next: IndexingSettings) =>
      ipcRenderer.invoke(
        "settings:setIndexing",
        next
      ) as Promise<IndexingSettings>,
    getSkillSources: () =>
      ipcRenderer.invoke(
        "settings:getSkillSources"
      ) as Promise<SkillSourcesSettings>,
    setSkillSources: (next: SkillSourcesSettings) =>
      ipcRenderer.invoke(
        "settings:setSkillSources",
        next
      ) as Promise<SkillSourcesSettings>,
    getBrowser: () =>
      ipcRenderer.invoke("settings:getBrowser") as Promise<BrowserSettings>,
    setBrowser: (next: BrowserSettings) =>
      ipcRenderer.invoke(
        "settings:setBrowser",
        next
      ) as Promise<BrowserSettings>,
    getIde: () =>
      ipcRenderer.invoke("settings:getIde") as Promise<IdeSettings>,
    setIde: (next: IdeSettings) =>
      ipcRenderer.invoke("settings:setIde", next) as Promise<IdeSettings>,
    // The selectable IDEs (id + label) for the Settings dropdown. Static list;
    // mirrored from the main-process IDE registry so the renderer needs no import.
    ideOptions: () =>
      ipcRenderer.invoke("settings:getIdeOptions") as Promise<
        Array<{ id: string; label: string }>
      >,
    checkRuntimes: (recheck?: boolean) =>
      ipcRenderer.invoke("settings:checkRuntimes", recheck) as Promise<{
        docker: RuntimeStatus
        podman: RuntimeStatus
      }>,
  },

  // Workspace indexing (plan 008). Pause/resume/cancel reuse tasks.* (an index
  // run IS a durable task); these are the index-specific verbs. Live progress
  // arrives on tasks.onEvent as `index_progress` events.
  index: {
    // One-shot status snapshot for the strip's first paint / reattach.
    status: (workspaceId: string) =>
      ipcRenderer.invoke("index:status", workspaceId) as Promise<IndexStatus>,
    // (Re)start indexing for a workspace — Start after cancel/clear, or Rebuild
    // after completion. Idempotent (no-op if a build is already live).
    start: (payload: { workspaceId: string; priority?: IndexPriority }) =>
      ipcRenderer.invoke("index:start", payload) as Promise<void>,
    // Drop all index rows for a workspace and reset its run (cancels any live task).
    clear: (workspaceId: string) =>
      ipcRenderer.invoke("index:clear", workspaceId) as Promise<void>,
    // Enable/disable indexing for one workspace (disable cancels a live run;
    // enable kicks a fresh run).
    setEnabled: (payload: {
      workspaceId: string
      enabled: boolean
      priority?: IndexPriority
    }) => ipcRenderer.invoke("index:setEnabled", payload) as Promise<void>,
  },

  // LLM provider accounts, their models, API keys, and the active selection.
  // The renderer never receives a plaintext key — only `hasKey`/`maskedKey`.
  // All secret handling stays in the main process.
  providers: {
    // Whether secure (keychain) key storage is usable on this machine.
    secureStorageAvailable: () =>
      ipcRenderer.invoke(
        "providers:secureStorageAvailable"
      ) as Promise<boolean>,
    list: () => ipcRenderer.invoke("providers:list") as Promise<AccountView[]>,
    create: (input: CreateAccountInput) =>
      ipcRenderer.invoke("providers:create", input) as Promise<AccountView>,
    update: (
      id: string,
      patch: { displayName?: string; baseUrl?: string | null }
    ) =>
      ipcRenderer.invoke("providers:update", id, patch) as Promise<AccountView>,
    delete: (id: string) =>
      ipcRenderer.invoke("providers:delete", id) as Promise<void>,
    // Store an API key (encrypted in main). Resolves { ok } / { ok:false, error }.
    setKey: (id: string, key: string) =>
      ipcRenderer.invoke("providers:setKey", id, key) as Promise<{
        ok: boolean
        error?: string
      }>,
    clearKey: (id: string) =>
      ipcRenderer.invoke("providers:clearKey", id) as Promise<void>,
    getMaskedKey: (id: string) =>
      ipcRenderer.invoke("providers:getMaskedKey", id) as Promise<
        string | null
      >,
    // Every account paired with its models — for the composer's grouped picker.
    listWithModels: () =>
      ipcRenderer.invoke("providers:listWithModels") as Promise<
        AccountWithModels[]
      >,
    // The DEFAULT provider/model for new conversations (per-conversation overrides
    // are stored on the conversation row via db.conversations.update).
    getDefault: () =>
      ipcRenderer.invoke("providers:getDefault") as Promise<LlmSettings>,
    setDefault: (next: LlmSettings) =>
      ipcRenderer.invoke("providers:setDefault", next) as Promise<LlmSettings>,
    hasActive: () =>
      ipcRenderer.invoke("providers:hasActive") as Promise<boolean>,
  },

  // Models belonging to a provider account.
  models: {
    list: (accountId: string) =>
      ipcRenderer.invoke("models:list", accountId) as Promise<ModelEntry[]>,
    add: (input: AddModelInput) =>
      ipcRenderer.invoke("models:add", input) as Promise<ModelEntry>,
    update: (
      id: string,
      patch: { modelId?: string; modelName?: string | null }
    ) => ipcRenderer.invoke("models:update", id, patch) as Promise<ModelEntry>,
    delete: (id: string) =>
      ipcRenderer.invoke("models:delete", id) as Promise<void>,
    // Fetch the gateway catalog and merge it in. { ok } / { ok:false, error }.
    importFromGateway: (accountId: string) =>
      ipcRenderer.invoke("models:importFromGateway", accountId) as Promise<{
        ok: boolean
        error?: string
      }>,
  },
}

contextBridge.exposeInMainWorld("cowork", api)

export type CoworkApi = typeof api

// Re-export DB row types so the renderer can import them from the preload
// surface without reaching into the main process directly.
export type {
  Approval,
  ApprovalStatus,
  Conversation,
  Message,
  Mode,
  Task,
  TaskCheckpoint,
  TaskEvent,
  TaskStatus,
  Todo,
  TodoStatus,
  Workspace,
} from "../main/db/types"
// Re-export the ask_user_question types so the renderer can type the panel.
export type {
  Question,
  QuestionOption,
  QuestionAnswer,
} from "../main/agent/tools/types"
// Re-export settings types so the renderer can type the Settings pane.
export type {
  ExecutionSettings,
  PermissionSettings,
  LlmSettings,
  IndexingSettings,
  SkillSourcesSettings,
  BrowserSettings,
  BrowserReveal,
  IdeSettings,
  Backend,
  FilePermission,
  ApprovalCategory,
} from "../main/settings/service"
export type {
  SkillSourceRow,
  SkillSourceKind,
} from "../main/agent/skills/types"
export type { RuntimeStatus, Runtime } from "../main/agent/env/runtime-check"
// LLM provider/model types for the Providers & Models tabs and the composer.
export type {
  Provider,
  ModelOrigin,
  ProviderAccount,
  ModelEntry,
} from "../main/db/types"
export type {
  AccountView,
  AccountWithModels,
} from "../main/ipc/provider-handlers"
// Workspace indexing types (plan 008) for the status strip + settings tab.
export type { IndexPriority, IndexStage } from "../main/db/types"
export type { IndexStatus } from "../main/ipc/index-handlers"
export type { PickedElement } from "../main/browser/types"
export type { GitDiffResult } from "../main/git/diff"

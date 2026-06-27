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
  Workspace,
} from "../main/db/types"
import type { Question, QuestionAnswer } from "../main/agent/tools/types"

// Streaming events emitted during a chat turn (mirrors ChatEvent in the agent).
export type ChatEvent =
  | { type: "token"; delta: string }
  | { type: "tool"; phase: "start"; id: string; name: string; arguments: string }
  | { type: "tool"; phase: "done"; id: string; name: string; result: string }
  | {
      type: "approval"
      id: string
      requestId: string
      tool: string
      summary: string
      reason: string
    }
  | {
      type: "question"
      id: string
      requestId: string
      questions: Question[]
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
    const listener = (_e: IpcRendererEvent, event: ChatEvent) => onEvent?.(event)
    ipcRenderer.on("chat:event", listener)
    const done = () => ipcRenderer.removeListener("chat:event", listener)
    return (ipcRenderer.invoke("chat", req) as Promise<{
      content?: string
      error?: string
      stopped?: boolean
    }>).finally(done)
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

  // Durable local state (SQLite, owned by the main process). Thin invoke
  // wrappers — the renderer only displays state and sends actions; it never
  // touches the database directly.
  db: {
    conversations: {
      create: (input: { mode: Mode; workspaceId?: string | null; title?: string | null }) =>
        ipcRenderer.invoke("db:conversations:create", input) as Promise<Conversation>,
      list: (opts?: { mode?: Mode }) =>
        ipcRenderer.invoke("db:conversations:list", opts) as Promise<Conversation[]>,
      get: (id: string) =>
        ipcRenderer.invoke("db:conversations:get", id) as Promise<Conversation | null>,
      update: (id: string, patch: { title?: string | null; workspaceId?: string | null }) =>
        ipcRenderer.invoke("db:conversations:update", id, patch) as Promise<Conversation>,
      delete: (id: string) =>
        ipcRenderer.invoke("db:conversations:delete", id) as Promise<void>,
    },
    messages: {
      list: (conversationId: string) =>
        ipcRenderer.invoke("db:messages:list", conversationId) as Promise<Message[]>,
    },
    workspaces: {
      list: () => ipcRenderer.invoke("db:workspaces:list") as Promise<Workspace[]>,
      upsert: (path: string, name?: string) =>
        ipcRenderer.invoke("db:workspaces:upsert", path, name) as Promise<Workspace>,
      update: (id: string, patch: { name?: string }) =>
        ipcRenderer.invoke("db:workspaces:update", id, patch) as Promise<Workspace>,
      delete: (id: string) =>
        ipcRenderer.invoke("db:workspaces:delete", id) as Promise<void>,
    },
    tasks: {
      create: (input: { conversationId: string; title?: string | null; status?: TaskStatus; input?: unknown }) =>
        ipcRenderer.invoke("db:tasks:create", input) as Promise<Task>,
      list: (opts?: { conversationId?: string; status?: TaskStatus }) =>
        ipcRenderer.invoke("db:tasks:list", opts) as Promise<Task[]>,
      get: (id: string) => ipcRenderer.invoke("db:tasks:get", id) as Promise<Task | null>,
      update: (id: string, patch: { title?: string | null; status?: TaskStatus; result?: unknown; error?: string | null }) =>
        ipcRenderer.invoke("db:tasks:update", id, patch) as Promise<Task>,
      delete: (id: string) => ipcRenderer.invoke("db:tasks:delete", id) as Promise<void>,
    },
    taskEvents: {
      append: (input: { taskId: string; type: string; payload?: unknown }) =>
        ipcRenderer.invoke("db:taskEvents:append", input) as Promise<TaskEvent>,
      list: (taskId: string, opts?: { afterId?: number; limit?: number }) =>
        ipcRenderer.invoke("db:taskEvents:list", taskId, opts) as Promise<TaskEvent[]>,
    },
    checkpoints: {
      create: (input: { taskId: string; label?: string | null; state: unknown }) =>
        ipcRenderer.invoke("db:checkpoints:create", input) as Promise<TaskCheckpoint>,
      list: (taskId: string) =>
        ipcRenderer.invoke("db:checkpoints:list", taskId) as Promise<TaskCheckpoint[]>,
      get: (id: string) =>
        ipcRenderer.invoke("db:checkpoints:get", id) as Promise<TaskCheckpoint | null>,
      delete: (id: string) =>
        ipcRenderer.invoke("db:checkpoints:delete", id) as Promise<void>,
    },
    approvals: {
      create: (input: { taskId: string; request?: unknown }) =>
        ipcRenderer.invoke("db:approvals:create", input) as Promise<Approval>,
      list: (opts?: { taskId?: string; status?: ApprovalStatus }) =>
        ipcRenderer.invoke("db:approvals:list", opts) as Promise<Approval[]>,
      resolve: (id: string, decision: { status: "approved" | "denied"; decision?: unknown }) =>
        ipcRenderer.invoke("db:approvals:resolve", id, decision) as Promise<Approval>,
    },
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
  Workspace,
} from "../main/db/types"
// Re-export the ask_user_question types so the renderer can type the panel.
export type { Question, QuestionOption, QuestionAnswer } from "../main/agent/tools/types"

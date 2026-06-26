// Row types and enum unions for the SQLite layer. These mirror the schema in
// `schema.ts` and are the shape repositories return (camelCase, JSON parsed).
// Preload imports these with `import type` so the renderer gets exact types
// without pulling better-sqlite3 into the preload bundle.

// A conversation's view/mode. One per view: Chat / Interactive / North Star.
export type Mode = "chat" | "interactive" | "north_star"

// Roles persisted in the messages table. `system` is allowed by the schema but
// never persisted — the system prompt is rebuilt per turn (skills are dynamic).
export type MessageRole = "system" | "user" | "assistant" | "tool"

// Durable task lifecycle. Storage-only this phase (no runner yet).
export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled"

export type ApprovalStatus = "pending" | "approved" | "denied"

// A single tool call requested by the assistant, stored as JSON on the message
// row. Mirrors the OpenAI-compatible tool_call shape Portkey expects.
export interface ToolCallRecord {
  id: string
  name: string
  arguments: string
}

export interface Workspace {
  id: string
  path: string
  name: string | null
  createdAt: number
  updatedAt: number
}

export interface Conversation {
  id: string
  mode: Mode
  title: string | null
  workspaceId: string | null
  createdAt: number
  updatedAt: number
}

export interface Message {
  id: string
  conversationId: string
  seq: number
  role: MessageRole
  content: string | null
  toolCalls: ToolCallRecord[] | null
  toolCallId: string | null
  toolName: string | null
  tokenEstimate: number | null
  createdAt: number
}

export interface Task {
  id: string
  conversationId: string
  title: string | null
  status: TaskStatus
  input: unknown
  result: unknown
  error: string | null
  createdAt: number
  updatedAt: number
}

export interface TaskEvent {
  id: number
  taskId: string
  type: string
  payload: unknown
  createdAt: number
}

export interface TaskCheckpoint {
  id: string
  taskId: string
  label: string | null
  state: unknown
  createdAt: number
}

export interface Approval {
  id: string
  taskId: string
  status: ApprovalStatus
  request: unknown
  decision: unknown
  requestedAt: number
  resolvedAt: number | null
}

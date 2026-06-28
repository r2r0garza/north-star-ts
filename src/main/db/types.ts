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

// The agent's per-conversation task list (the `todo_write` tool). Distinct from
// TaskStatus — these are a planning scratchpad, not durable runner lifecycle.
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

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
  // Per-conversation LLM selection (SCHEMA_V6). Null = use the default from the
  // settings `llm` blob. `accountId` is a provider_accounts.id; `modelId` is the
  // model's gateway id string (not the models.id row id).
  accountId: string | null
  modelId: string | null
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

// One item in a conversation's task list. `itemId` is the model-chosen id
// (unique within a conversation); `seq` is list order = priority.
export interface Todo {
  conversationId: string
  itemId: string
  seq: number
  content: string
  status: TodoStatus
  createdAt: number
  updatedAt: number
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

// The scope an "always allow" decision applies to. PR2 exposes only `once`
// (not persisted) and `workspace`; the rest are reserved so the model can grow
// without a schema change.
export type AllowlistScope =
  | "once"
  | "conversation"
  | "workspace"
  | "agent"
  | "global"

// A remembered "always allow" rule, backing the approval pipeline. Generic over
// tool/kind so one table serves every gated tool. `identity` is the exact
// normalized action identity — matching is conservative equality.
export interface ActionAllowlistRule {
  id: string
  tool: string
  kind: string
  identity: string
  scope: AllowlistScope
  workspacePath: string | null
  conversationId: string | null
  agentId: string | null
  createdAt: number
  lastUsedAt: number | null
}

// The LLM providers a user can configure. `portkey` and `openai_compatible`
// (an endpoint that routes through the Portkey connector, e.g. LM Studio) are
// wired in V1; the rest are reserved so the UI can list them as "coming soon"
// without a schema change.
export type Provider =
  | "portkey"
  | "openai_compatible"
  | "openai"
  | "anthropic"
  | "google"
  | "azure_openai"

// Where a model row came from: hand-typed by the user, imported from the
// gateway's /models catalog, or auto-seeded on account creation. Drives the UI
// badge and the gateway-import merge (re-import refreshes `gateway` rows; it
// never deletes `manual`/`seeded` ones).
export type ModelOrigin = "manual" | "gateway" | "seeded"

// A configured connection to an LLM provider. The API key is NEVER held here in
// plaintext — `hasKey` reflects whether ciphertext is stored (the row's actual
// `encrypted_key` BLOB stays in the main process and never crosses IPC).
export interface ProviderAccount {
  id: string
  provider: Provider
  displayName: string
  baseUrl: string | null
  hasKey: boolean
  createdAt: number
  lastUsedAt: number | null
}

// One model id belonging to a provider account. `modelName` is an optional
// custom display label; callers fall back to `modelId` when it's null.
export interface ModelEntry {
  id: string
  accountId: string
  modelId: string
  modelName: string | null
  origin: ModelOrigin
  createdAt: number
  updatedAt: number
}

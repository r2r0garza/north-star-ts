// Row types and enum unions for the SQLite layer. These mirror the schema in
// `schema.ts` and are the shape repositories return (camelCase, JSON parsed).
// Preload imports these with `import type` so the renderer gets exact types
// without pulling better-sqlite3 into the preload bundle.

import type { WorkspaceChecks } from "../../shared/workspace-checks"

// A conversation's view/mode. One per view: Chat / Interactive / North Star.
export type Mode = "chat" | "interactive" | "north_star"

// Roles persisted in the messages table. The main system prompt is rebuilt per
// turn; `system` rows are also used as an internal storage role for durable runtime
// context. Providers receive that context through a lower-trust transport role.
export type MessageRole = "system" | "user" | "assistant" | "tool"

// Durable task lifecycle. `paused` is a deliberate durable state (plan 008): a
// paused task survives restart and resumes from its own progress cursor, unlike
// `cancelled` (terminal) or `interrupted` (orphaned by a crash).
export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled"
  | "paused"

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

// Files a repository generates rather than writes by hand (a code index, a
// lockfile, codegen output), and the command that rebuilds them. When a
// Mission Control merge conflicts only on such files, the merge queue runs the
// command instead of asking the integrator to merge them by hand.
export interface GeneratedFilesRule {
  // Repository-relative globs, e.g. ".code-index/**" or "**/package-lock.json".
  paths: string[]
  // Run from the repository root with a shell; it rewrites the files.
  command: string
}

// How a Mission Control worktree of this workspace gets a working
// environment: a fresh worktree has only tracked files, so ignored ones
// (.venv, node_modules) are missing and agents went looking for a test runner.
export interface WorktreeSetup {
  // Workspace-relative paths symlinked from the main checkout, e.g. ".venv".
  linkPaths: string[]
  // Run in order in each new worktree, e.g. an install step per project root
  // (plan 106.11). A failed step stops the ones after it.
  steps: WorktreeSetupStep[]
}

export interface WorktreeSetupStep {
  // Stable, so workspace analysis findings can refer to the step.
  id: string
  label: string
  // One command, run with a shell.
  command: string
  // Workspace-relative directory to run in; "" is the workspace root.
  cwd: string
  // Who wrote it: the user, or an applied workspace-analysis finding.
  source: "user" | "analysis"
  findingKey?: string
  // "python-shared-venv": a built-in step (plan 106.11). The worktree gets a
  // thin venv of its own that reuses the main checkout's installed packages
  // and puts the worktree's own source first, so there's nothing to download
  // and imports get the story's code, not the main checkout's. `command` is
  // then only a description.
  kind?: "command" | "python-shared-venv"
  // For python-shared-venv: the venv directory (relative to cwd), the full
  // setup to run when the main checkout has no usable venv, and the install
  // to run on top when the worktree's dependencies differ from the main
  // checkout's (a merged story added one).
  venv?: string
  fallback?: Array<{ label: string; command: string }>
  refresh?: Array<{ label: string; command: string }>
}

export interface Workspace {
  id: string
  path: string
  name: string | null
  generatedFiles: GeneratedFilesRule[]
  worktreeSetup: WorktreeSetup
  // What each named check runs here (plan 104): command phases name a check,
  // so one process works across workspaces. No defaults.
  commandChecks: WorkspaceChecks
  createdAt: number
  updatedAt: number
}

// A user-created grouping of conversations (SCHEMA_V12). `workspaceId` is the
// project's optional default directory (a workspaces.id): with one, the project
// backs Chat/Interactive/North Star and its fresh workspace-view conversations
// auto-adopt the directory; without one, the project is Chat-only. Null = no
// default directory. ON DELETE SET NULL, so clearing the workspace just drops it.
export interface Project {
  id: string
  name: string
  workspaceId: string | null
  position: number
  createdAt: number
  updatedAt: number
}

export interface Conversation {
  id: string
  mode: Mode
  title: string | null
  workspaceId: string | null
  // The directory the conversation works in when it isn't its workspace's own
  // folder: a Mission Control user story's git worktree of that workspace.
  // Null = the workspace's path. Resolve with workingDirectoryOf.
  workingDirectory?: string | null
  // The project this conversation belongs to (SCHEMA_V12), or null for the "No
  // Project" bucket. ON DELETE SET NULL — deleting a project keeps its
  // conversations, moving them to "No Project".
  projectId: string | null
  // Per-conversation LLM selection (SCHEMA_V6). Null = use the default from the
  // settings `llm` blob. `accountId` is a provider_accounts.id; `modelId` is the
  // model's gateway id string (not the models.id row id).
  accountId: string | null
  modelId: string | null
  // Reasoning effort picked in the composer for this conversation's model.
  // Null = the provider adapter's default.
  effort?: import("../../shared/reasoning-effort").ReasoningEffort | null
  // The custom agent selected for this conversation (SCHEMA_V13), by name — the
  // on-disk identifier of a `<name>.agent.md` definition. Null = the built-in
  // main agent (default behavior). Re-resolved from disk per turn.
  agentName: string | null
  // Whether this conversation is pinned to the top of its sidebar group
  // (SCHEMA_V14). Pinning does NOT touch updated_at, so unpinning restores the
  // conversation's natural recency position.
  pinned: boolean
  createdAt: number
  updatedAt: number
}

export interface ConversationSearchResult {
  conversationId: string
  mode: Mode
  title: string | null
  projectId: string | null
  projectName: string | null
  updatedAt: number
  matchKind: "title" | "content" | "title_and_content"
  snippet: string | null
  targetMessageId: string | null
  rank: number
}

export interface Message {
  artifact?: import("../../shared/conversation-artifacts").ArtifactReference
  media?: import("../../shared/tool-media").ToolMediaReference[]
  nativeAssistant?: import("../agent/providers/native-carrier").NativeAssistantCarrier
  // Assistant reasoning for the transcript UI; context assembly ignores it.
  reasoning?: string
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

export type ToolCallLifecycleState =
  | "prepared"
  | "waiting_for_approval"
  | "started"
  | "settled_success"
  | "settled_error"
  | "not_started"
  | "unknown"

export interface ToolCallLifecycle {
  id: string
  conversationId: string
  assistantMessageId: string | null
  logicalRoundId: string
  toolCallId: string
  toolName: string
  arguments: string
  invocationId: string
  identity: string
  state: ToolCallLifecycleState
  result: string | null
  error: string | null
  preparedAt: number
  waitingAt: number | null
  startedAt: number | null
  settledAt: number | null
  updatedAt: number
}

// The rolling conversation summary (SCHEMA_V10, plan 019). One row per
// conversation — a compact digest of the turns scrolling out of the
// ContextBuilder's recent-message window. `coversThrough` is the highest
// messages.seq folded in (the incremental-regeneration cursor and the
// debounce baseline); `messageCount` is how many turns are folded so far;
// `tokenEstimate` is the digest's cost via the shared TokenCounter.
export interface ConversationSummary {
  conversationId: string
  summary: string
  coversThrough: number
  messageCount: number
  tokenEstimate: number | null
  updatedAt: number
}

export interface Task {
  id: string
  // The task's PRIVATE worker transcript — a forked conversation the runner
  // writes model/tool messages to, isolated from any live chat.
  conversationId: string
  // The live conversation the task was started from (where it shows in the
  // Workspace Activity panel). Null if that conversation was later deleted.
  sourceConversationId: string | null
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

export type SubagentArtifactStatus =
  | "active"
  | "resolved"
  | "quarantined_cleanup_required"

export interface SubagentArtifact {
  id: string
  repositoryId: string
  sessionId: string
  assignmentId: string
  backend: string
  branch: string
  worktreePath: string
  markerPath: string
  status: SubagentArtifactStatus
  detail: unknown
  createdAt: number
  updatedAt: number
  resolvedAt: number | null
}

export interface TaskCheckpoint {
  id: string
  taskId: string
  label: string | null
  state: unknown
  createdAt: number
}

export type FailureStage =
  | "agent_setup"
  | "model_request"
  | "tool_dispatch"
  | "tool_execution"
  | "result_persistence"
  | "output_validation"
  | "decomposition"
  | "reviewer"
  | "subprocess"
  // A deterministic command phase's execution (plan 104).
  | "command"
  | "scheduler"

export interface FailureContext {
  code: string
  stage: FailureStage
  message: string
  retryable: boolean
  attempt: number | null
  maxAttempts: number | null
  runId: string | null
  phaseRunId: string | null
  phaseId: string | null
  taskId: string | null
  workerTaskId: string | null
  agentName: string | null
  toolCallId?: string | null
  cause?: string | null
  occurredAt: number
}

// The workspace index (plan 008). Deterministic, incremental, resumable.

// The stage a run has reached. Stages enrich cumulatively; `symbols`/`embeddings`
// are schema-reserved (user story 1 builds file_map + metadata).
export type IndexStage = "file_map" | "metadata" | "symbols" | "embeddings"

// Indexing priority: North Star = high (prefer index before deep execution),
// Interactive = low (background, yields between batches).
export type IndexPriority = "low" | "high"

// One row per workspace: links to the driving 009 task, holds resumable progress
// (cursor + scanned/total counts) and the per-workspace enable toggle. Run
// lifecycle (queued/running/paused/…) lives on the task, not duplicated here.
export interface IndexRun {
  id: string
  workspaceId: string
  taskId: string | null
  enabled: boolean
  stage: IndexStage
  priority: IndexPriority
  cursor: string | null
  filesScanned: number
  filesTotal: number
  error: string | null
  createdAt: number
  updatedAt: number
}

// Stage 1: one row per tracked file. `hash` drives incremental skip; `size`/
// `mtime` are the fast-path check before hashing. `indexedStage` is the highest
// stage completed for this file.
export interface IndexFile {
  id: string
  workspaceId: string
  path: string
  ext: string | null
  size: number
  mtime: number
  hash: string
  indexedStage: IndexStage
  updatedAt: number
}

// Stage 2: parsed metadata for a key doc (package.json, tsconfig, readme, git…).
// `value` is a parsed JSON blob.
export interface IndexMetadata {
  id: string
  workspaceId: string
  kind: string
  path: string | null
  value: unknown
  updatedAt: number
}

// Stage 3: a symbol/import extracted from a file (unpopulated in user story 1).
export interface IndexSymbol {
  id: string
  workspaceId: string
  fileId: string
  name: string
  kind: string
  line: number | null
  detail: unknown
  updatedAt: number
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
  | "claude_code"
  | "codex_cli"
  | "codex_subscription"
  | "claude_subscription"
  | "anthropic"
  | "google"
  | "azure_openai"

// Which OpenAI wire API an account speaks. `completions` is /chat/completions
// (the universal path used by every provider today); `responses` is reserved for
// a future OpenAI Responses (/responses) adapter. Persisted on the account so the
// provider layer can branch without a per-request probe.
export type ApiMode = "completions" | "responses" | "codex_responses"

// Where a model row came from: hand-typed by the user, imported from the
// gateway's /models catalog, or auto-seeded on account creation. Drives the UI
// badge and the gateway-import merge (re-import refreshes `gateway` rows; it
// never deletes `manual`/`seeded` ones).
export type ModelOrigin = "manual" | "gateway" | "seeded"

export type ExternalAgentModelSourceKind =
  | "github"
  | "copilot"
  | "cursor"
  | "claude"
  | "codex"

// A configured connection to an LLM provider. The API key is NEVER held here in
// plaintext — `hasKey` reflects whether ciphertext is stored (the row's actual
// `encrypted_key` BLOB stays in the main process and never crosses IPC).
export interface ProviderAccount {
  id: string
  provider: Provider
  displayName: string
  baseUrl: string | null
  hasKey: boolean
  enabled: boolean
  // User-authored display order (SCHEMA_V30), shared by Settings and pickers.
  position: number
  // The OpenAI wire API this account speaks. Defaults to "completions"; only
  // consulted for openai/openai_compatible accounts (portkey ignores it).
  apiMode: ApiMode
  // Whether the endpoint accepts image content parts (SCHEMA_V68). Off for
  // text-only bridges (e.g. Copilot Bridge stringifies them as base64 text);
  // the agent then withholds tool images and steers to text alternatives.
  acceptsImages: boolean
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
  favorite: boolean
  createdAt: number
  updatedAt: number
}

export interface ExternalAgentModelMapping {
  sourceKind: ExternalAgentModelSourceKind
  sourceModel: string
  normalizedSourceModel: string
  destinationAccountId: string
  destinationModelId: string
  createdAt: number
  updatedAt: number
}

export type ModelRequestRetryBudgetStatus =
  | "in_progress"
  | "completed"
  | "exhausted"
export type ModelRequestRetryBudgetSource = "automatic" | "user_retry"

export interface ModelRequestRetryBudget {
  id: string
  conversationId: string
  logicalRoundId: string
  parentBudgetId: string | null
  retrySequence: number
  source: ModelRequestRetryBudgetSource
  status: ModelRequestRetryBudgetStatus
  attemptsConsumed: number
  maxAttempts: number
  firstAttemptAt: number
  deadlineAt: number
  lastError: string | null
  completedAt: number | null
  exhaustedAt: number | null
  createdAt: number
  updatedAt: number
}

// External agent CLI continuity (SCHEMA_V29). The provider owns its native
// transcript; North Star stores only the stable reference needed to resume.
export interface CliSession {
  conversationId: string
  provider: "claude_code" | "codex_cli"
  sessionId: string
  createdAt: number
  updatedAt: number
}

// ── MCP servers (file-based, like agents/skills) ────────────────────────────
// Which transport an MCP server speaks. `stdio` spawns a child process and talks
// over its stdin/stdout; `http` connects to a Streamable HTTP endpoint (and may
// require OAuth). Inferred from which fields the mcp.json entry carries (command
// → stdio, url → http), validated in the loader.
export type McpTransport = "stdio" | "http"

// One MCP server DEFINITION as parsed from an mcp.json file. This is the
// shareable, git-committable part — it carries NO per-machine state (no enabled
// flag, no OAuth tokens): those live in the DB side-store keyed by `name`. The
// file format mirrors the ecosystem standard:
//   { "mcpServers": { "<name>": { command, args, env } | { url, headers } } }
export interface McpServerDef {
  // Stable slug used in the agent-facing tool prefix mcp__<name>__<tool> and as
  // the side-store key. From the object key in mcp.json. Validated [a-z0-9-]+.
  name: string
  transport: McpTransport
  // stdio transport:
  command: string | null
  args: string[]
  env: Record<string, string>
  // http transport:
  url: string | null
  headers: Record<string, string>
}

// A server definition joined with its per-machine side-store state and its
// source file. This is the shape the UI and the manager consume.
export interface McpServer extends McpServerDef {
  // Absolute path to the mcp.json file this server was defined in (for edit/
  // reveal and source-kind classification).
  path: string
  // The source dir this file was discovered under, for diagnostics.
  source: string
  // Whether this server is active. A newly-discovered server defaults ON; the
  // side-store records only an explicit OFF (or an OAuth token set). See
  // db/repositories/mcp-state.ts.
  enabled: boolean
  // Whether a completed OAuth token set is stored for this (http) server. Reduced
  // from the encrypted side-store BLOB so ciphertext never crosses IPC.
  hasOauth: boolean
}

// --- Live dashboards (plan 033) -------------------------------------------

// A widget's render kind. Bare TEXT in the DB, coerced in the repo layer.
export type DashboardWidgetType = "chart" | "stat" | "table"

// The cache row's freshness. 'ok' = last fetch succeeded; 'error' = the recipe
// run failed (see `error`); 'stale' = never fetched / needs a refresh.
export type DashboardWidgetDataStatus = "ok" | "error" | "stale"

// A saved dashboard — a top-level object (NOT conversation-scoped), so it
// persists like a process definition. `layout` is a JSON blob for grid config
// (column count / breakpoints) parsed by the renderer.
export interface Dashboard {
  id: string
  name: string
  description: string | null
  layout: unknown | null
  pinned: boolean
  createdAt: number
  updatedAt: number
}

// One widget on a dashboard. `config` is the render config (chart kind, data
// keys, recharts options); `recipe` describes HOW to (re)fetch the data (a
// command / URL / normalize hint — re-runnable replay is plan 033.3); `pos` is
// the grid geometry {x,y,w,h}. All three are JSON blobs parsed by consumers.
export interface DashboardWidget {
  id: string
  dashboardId: string
  title: string
  type: DashboardWidgetType
  config: unknown | null
  recipe: unknown | null
  pos: unknown | null
  position: number
}

// A widget's data-fetch recipe (stored inside the opaque `recipe` JSON blob).
// The deterministic refresh executor (plan 033.3) re-runs it with no LLM: run
// `command` in `cwd` (captured at author time), OR fetch `url`; the output MUST
// be a JSON array of flat objects (the row shape the view renders). `note` is a
// freeform authoring hint. All fields optional — validated at refresh time.
export interface DashboardRecipe {
  command?: string
  url?: string
  cwd?: string
  workspace?: string
  note?: string
}

// The cached data a widget renders — the run/cache side of the definition/run
// split. One row per widget (PK = widgetId), replaced on each refresh.
export interface DashboardWidgetData {
  widgetId: string
  data: unknown | null
  status: DashboardWidgetDataStatus
  error: string | null
  fetchedAt: number
}

// The whole dashboard in one shape — the view loads it in a single call (repo
// getDashboardGraph assembles it from the widget + cache list queries).
export interface DashboardGraph {
  dashboard: Dashboard
  widgets: DashboardWidget[]
  data: DashboardWidgetData[]
}

export type PhaseRunStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped"

export type {
  WorkspaceCheck,
  WorkspaceChecks,
} from "../../shared/workspace-checks"

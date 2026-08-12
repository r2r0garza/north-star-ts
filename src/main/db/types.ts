// Row types and enum unions for the SQLite layer. These mirror the schema in
// `schema.ts` and are the shape repositories return (camelCase, JSON parsed).
// Preload imports these with `import type` so the renderer gets exact types
// without pulling better-sqlite3 into the preload bundle.

// A conversation's view/mode. One per view: Chat / Interactive / North Star.
export type Mode = "chat" | "interactive" | "north_star"

// Roles persisted in the messages table. `system` is allowed by the schema but
// never persisted — the system prompt is rebuilt per turn (skills are dynamic).
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

export interface Workspace {
  id: string
  path: string
  name: string | null
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
  createdAt: number
  updatedAt: number
}

export interface Conversation {
  id: string
  mode: Mode
  title: string | null
  workspaceId: string | null
  // The project this conversation belongs to (SCHEMA_V12), or null for the "No
  // Project" bucket. ON DELETE SET NULL — deleting a project keeps its
  // conversations, moving them to "No Project".
  projectId: string | null
  // Per-conversation LLM selection (SCHEMA_V6). Null = use the default from the
  // settings `llm` blob. `accountId` is a provider_accounts.id; `modelId` is the
  // model's gateway id string (not the models.id row id).
  accountId: string | null
  modelId: string | null
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

export interface TaskCheckpoint {
  id: string
  taskId: string
  label: string | null
  state: unknown
  createdAt: number
}

// The workspace index (plan 008). Deterministic, incremental, resumable.

// The stage a run has reached. Stages enrich cumulatively; `symbols`/`embeddings`
// are schema-reserved (slice 1 builds file_map + metadata).
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

// Stage 3: a symbol/import extracted from a file (unpopulated in slice 1).
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
  | "anthropic"
  | "google"
  | "azure_openai"

// Which OpenAI wire API an account speaks. `completions` is /chat/completions
// (the universal path used by every provider today); `responses` is reserved for
// a future OpenAI Responses (/responses) adapter. Persisted on the account so the
// provider layer can branch without a per-request probe.
export type ApiMode = "completions" | "responses"

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
  // The OpenAI wire API this account speaks. Defaults to "completions"; only
  // consulted for openai/openai_compatible accounts (portkey ignores it).
  apiMode: ApiMode
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

// ── Process engine (plan 025) ───────────────────────────────────────────────
// A user-authored agentic DAG. Definitions (the reusable template) are split
// from runs (one per execution). See schema.ts SCHEMA_V15.

// How a phase binds to its agent pool: 'single' runs its one agent directly;
// 'dispatch' routes each (sub-)task to the best-fit agent in the pool (025.3).
export type PhaseRouting = "single" | "dispatch"

// Per-phase human-in-the-loop policy: 'auto' releases dependents on completion;
// 'approve' inserts a durable approval gate before dependents dispatch.
export type PhaseGatePolicy = "auto" | "approve"

// A dependency edge fires either when the whole upstream phase completes
// ('on_complete') or per completed fan-out sub-task ('on_each_subtask', 025.2).
export type EdgeTrigger = "on_complete" | "on_each_subtask"

// The orchestrator run's lifecycle. Mirrors the tasks table's states (the run is
// backed by a process_run task) plus the DAG-specific waiting_for_approval.
export type ProcessRunStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"

// A single phase's execution state within a run. 'pending' = not yet dispatchable
// / awaiting dependencies; 'ready' is transient; 'skipped' reserved for denied-gate
// dependents (025+).
export type PhaseRunStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped"

export interface ProcessDefinition {
  id: string
  name: string
  description: string | null
  // Per-process autonomy toggle for cross-phase flag-back (plan 031.2). When true
  // (default), an agent's flag_for_rework needs human confirmation before the
  // send-back; when false, the engine routes the flag autonomously.
  requireFlagApproval: boolean
  createdAt: number
  updatedAt: number
}

export interface ProcessPhase {
  id: string
  processId: string
  key: string
  name: string
  routing: PhaseRouting
  gatePolicy: PhaseGatePolicy
  fanOut: boolean
  // The cap on "Request changes" rework rounds for a gated phase (plan 029).
  // 0 = unlimited (default). Only meaningful when gatePolicy === "approve".
  maxReworkRounds: number
  // When set, the phase's kickoff steers its agent to write artifacts under a
  // `.<key>/` folder at the workspace root — a predictable location (plan 030).
  dotFolder: boolean
  // Per-phase VALIDATOR (plan 031.1): when true, a second agent reviews the
  // phase's output after its worker completes and either approves it or sends it
  // back with feedback (reusing the 029 rework channel), bounded; on exhaustion
  // the phase escalates to a human gate.
  validator: boolean
  // The per-phase cap on validator review rounds. 0 = use the engine default
  // (DEFAULT_VALIDATOR_ITERATIONS); a positive value overrides. Never unlimited —
  // the DAG has no cycle guard, so a bound is mandatory.
  validatorMaxIterations: number
  // The dedicated reviewer agent name. Null falls back to the phase's own
  // resolved agent (pool[0]).
  validatorAgent: string | null
  position: number
}

// tools/skills are tri-state JSON overrides: null = use the agent's own
// definition; [] = none; [list] = exactly these (matches .agent.md frontmatter).
export interface ProcessPhaseAgent {
  id: string
  phaseId: string
  agentName: string
  skills: string[] | null
  tools: string[] | null
  position: number
}

export interface ProcessEdge {
  id: string
  processId: string
  fromPhaseId: string
  toPhaseId: string
  trigger: EdgeTrigger
}

export interface ProcessRun {
  id: string
  processId: string | null
  sourceConversationId: string | null
  // The run's working directory (plan 026): a workspaces.id, resolved to a path
  // for every phase worker. A run started from the Process screen has no source
  // conversation to inherit a workspace from, so it carries its own. Null = the
  // run resolves its workspace from the source conversation (or none).
  workspaceId: string | null
  // The process_run task that drives this run (holds the runner slot, anchors
  // approval gates + checkpoints). SET NULL if the task is deleted.
  taskId: string | null
  objective: string | null
  // Short, LLM-generated display title summarizing the objective (like a
  // conversation's title). Null for pre-existing runs and until generation lands
  // — the renderer falls back to an objective slice.
  title: string | null
  status: ProcessRunStatus
  startedAt: number | null
  finishedAt: number | null
  createdAt: number
}

export interface ProcessPhaseRun {
  id: string
  runId: string
  phaseId: string
  parentId: string | null
  status: PhaseRunStatus
  taskId: string | null
  agentName: string | null
  // Optional display title (plan 026 pass 1). For a fan-out / on_each_subtask
  // CHILD, a short label derived from its sub-task briefing (e.g. "counter
  // component"); null for an ordinary top-level phase run (the monitor falls back
  // to the phase name).
  title: string | null
  iteration: number
  error: string | null
  startedAt: number | null
  finishedAt: number | null
  // The "Request changes" feedback note injected into this phase-run's re-run
  // kickoff (plan 029). Null for a first/normal run; set when a gate is sent
  // back. reworkRound is the bound counter (how many times sent back).
  reworkNote: string | null
  reworkRound: number
  // The validator's own round counter (plan 031.1): how many times the reviewer
  // has sent this phase-run back. Kept SEPARATE from reworkRound (which drives the
  // 029 count-based gate re-detection and must not be perturbed). Default 0.
  validatorRound: number
  // First-class on_each_subtask lineage (plan 031.2): the source fan-out CHILD
  // this consumer instance consumes. Null for ordinary runs and fan-out children;
  // set for on_each_subtask consumer instances. Lets flag-back reset only the
  // instance tied to a reworked source sub-task (per-child, not the whole batch).
  sourceChildRunId: string | null
}

// A cross-phase rework flag (plan 031.2): a phase-worker found a defect an earlier
// phase owns and flagged it back. Lifecycle: pending → applied | dismissed.
export type ProcessFlagStatus = "pending" | "applied" | "dismissed"

export interface ProcessFlag {
  id: string
  runId: string
  // The phase-run whose worker raised the flag. Nullable (SET NULL) because a
  // per-child send-back deletes the flagging on_each_subtask instance so it can
  // re-trigger fresh; the flag row survives (as a durable audit record) with this
  // reference cleared. Always set at creation; null only after the instance is gone.
  flaggingPhaseRunId: string | null
  // The upstream phase the flag targets.
  targetPhaseId: string
  // The specific fan-out sub-task (child run) targeted, when resolved — from the
  // flagging instance's sourceChildRunId, or a key#N index. Null = the whole phase.
  targetChildRunId: string | null
  reason: string
  status: ProcessFlagStatus
  createdAt: number
}

// The whole authored graph in one shape — the scheduler and the monitor both
// consume it (repo getProcessGraph assembles it from three list queries).
export interface ProcessGraph {
  definition: ProcessDefinition
  phases: ProcessPhase[]
  agents: ProcessPhaseAgent[]
  edges: ProcessEdge[]
}

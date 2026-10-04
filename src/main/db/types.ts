// Row types and enum unions for the SQLite layer. These mirror the schema in
// `schema.ts` and are the shape repositories return (camelCase, JSON parsed).
// Preload imports these with `import type` so the renderer gets exact types
// without pulling better-sqlite3 into the preload bundle.

import type {
  FollowupTarget,
  PlanChange,
  ProposalFollowup,
  ProposalKind,
  ProposalStatus,
} from "../../shared/mission-control/plan-changes"
import type { UserStoryNarrative } from "../../shared/mission-control/story"
import type { OverlapPolicy } from "../../shared/mission-control/waves"
import type { AppLaunch } from "../../shared/mission-control/app-launch"
export type {
  AppLaunch,
  AppService,
  AppServiceReady,
} from "../../shared/mission-control/app-launch"

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

// A workspace's Mission Control settings (plan 109.01). `checksDir` is the
// workspace-relative directory QA seats write acceptance checks under, one
// subdirectory per user story. It's tracked in git, so checks are committed
// on the user story branch and merge with the code.
export interface WorkspaceMissionControlSettings {
  checksDir: string
}

export interface Workspace {
  id: string
  path: string
  name: string | null
  generatedFiles: GeneratedFilesRule[]
  worktreeSetup: WorktreeSetup
  // How the app is started for Mission Control seats (plan 109.03).
  appLaunch: AppLaunch
  missionControl: WorkspaceMissionControlSettings
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

export type PhaseCompletionContract =
  | { policy: "legacy" }
  | { policy: "validated"; version: 1; requiredArtifacts: string[] }

export interface PhaseOutcome {
  version: 1
  attemptId: string
  status: "completed" | "blocked" | "failed"
  output: string
  evidence: string
  reason?: string
  nextAction?: string
}

export interface PhaseCompletionReceipt {
  outcome: PhaseOutcome
  checkedArtifacts: string[]
  // Null until all configured checks pass.
  checkedAt: number | null
}

export type ProcessRuntimeSlot =
  | "worker"
  | "decomposer"
  | "router"
  | "validator"

export interface ProcessRuntimeSelection {
  accountId?: string | null
  modelId?: string | null
  // Portable exports may name a provider instead of a local account id. The local
  // runtime resolver ignores it until an import remaps it to an account.
  provider?: Provider | null
}

export type ProcessRuntimeConfig = Partial<
  Record<ProcessRuntimeSlot, ProcessRuntimeSelection>
>

export const RIG_DECISION_RIGHTS = [
  "assign_user_story",
  "revise_plan",
  "accept_proof",
  "merge",
  "escalate_to_user",
  "approve_followup",
] as const

export type RigDecisionRight = (typeof RIG_DECISION_RIGHTS)[number]

export interface Rig {
  id: string
  name: string
  description: string | null
  cultureMd: string
  createdAt: number
  updatedAt: number
}

export interface RigPod {
  id: string
  rigId: string
  key: string
  name: string
  missionStatement: string
  cultureMd: string
  leadSeatId: string | null
  position: number
}

export interface RigSeat {
  id: string
  podId: string
  key: string
  role: string
  charter: string
  agentRefId: string | null
  agentLabel: string | null
  skills: string[] | null
  tools: string[] | null
  mcpServers: string[] | null
  decisionRights: RigDecisionRight[]
  runtimeConfig: ProcessRuntimeConfig | null
  position: number
}

export interface RigOversight {
  id: string
  rigId: string
  overseerPodId: string
  overseenPodId: string
}

export interface RigGraph {
  rig: Rig
  pods: RigPod[]
  seats: RigSeat[]
  oversight: RigOversight[]
}

export interface RigDiagnostic {
  severity: "warning" | "error"
  code: string
  message: string
  entityId?: string
}

export type FeatureStatus =
  | "draft"
  | "active"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed"
export type MilestoneStatus =
  | "planned"
  | "active"
  | "integrating"
  | "review"
  | "completed"
  | "cancelled"
  | "failed"
export type UserStoryStatus =
  | "draft"
  | "ready"
  | "blocked"
  | "running"
  | "proving"
  | "integrating"
  | "done"
  | "failed"
  | "cancelled"

export interface UserStorySpec {
  // "As a …, I want …, so that …" — optional; null for technical work.
  story: UserStoryNarrative | null
  goal: string
  acceptance: string[]
  outOfScope: string[]
  touchHints: string[]
  notes: string
  // Runs after every other user story in its milestone, including ones added
  // later (an integration proof, docs). Nothing may depend on it.
  runsLast: boolean
}

// How the Navigator drives a feature (plan 106.6): manual shows "next up"
// only; copilot directs the lead seat, which acts through map tools; autopilot
// dispatches mechanical steps itself and hands judgment to the lead.
export type DriveMode = "manual" | "copilot" | "autopilot"

export interface FeatureDrive {
  // Apply the feature planning proposal without waiting for the user.
  autoApplyPlan: boolean
  // User stories whose touch hints overlap: "wait" runs them one at a time;
  // "parallel" runs them together and lets the merge queue handle collisions.
  overlapPolicy: OverlapPolicy
  // Wall-clock time spent driving (copilot/autopilot while active). Accrued in
  // small increments, so time the app was closed or asleep is never counted.
  activeMs: number
  accountedAt: number | null
  // Why the feature is paused, when it is.
  pauseReason: string | null
  // "setup": a story couldn't start until the workspace is set up for it.
  pausedBy: "user" | "budget" | "health" | "setup" | null
  // Health detectors the user muted for this feature (plan 106.8).
  healthMuted: string[]
}

export interface Feature {
  id: string
  key: string
  name: string
  intent: string
  definitionOfDone: string
  rigId: string | null
  rigSnapshot: RigGraph | null
  workspaceId: string | null
  projectId: string | null
  defaultPodKey: string | null
  playbookId: string | null
  driveMode: DriveMode
  budgets: Record<string, unknown>
  // Navigator drive bookkeeping (plan 106.6).
  drive: FeatureDrive
  status: FeatureStatus
  taskId: string | null
  createdAt: number
  updatedAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface Milestone {
  id: string
  featureId: string
  key: string
  name: string
  outcome: string
  definitionOfDone: string
  playbookId: string | null
  mergePolicy: MilestoneMergePolicy
  integrationBranch: string | null
  // Integration (plan 106.5): the user's branch and commit at milestone start,
  // and the repository the integration branch lives in.
  baseRef: string | null
  baseOid: string | null
  repoRoot: string | null
  landing: MilestoneLanding | null
  // The lead's judgment that the milestone meets its definition of done (106.6).
  dodReview: MilestoneDodReview | null
  status: MilestoneStatus
  position: number
  startedAt: number | null
  finishedAt: number | null
}

export type MergePolicyMode = "manual" | "local_merge" | "open_pr"

export interface MilestoneDodReview {
  by: string
  summary: string
  at: number
}

export interface MilestoneMergePolicy {
  mode: MergePolicyMode
}

// How a milestone's integration branch reached the base branch (plan 106.5).
export interface MilestoneLanding {
  mode: MergePolicyMode
  // "user" = an explicit approval or "mark merged"; "detected" = Milestone
  // Control saw the integration head become reachable from the base branch.
  // "navigator": the Navigator completed a milestone with nothing to land after
  // the lead's definition-of-done review (plan 106.6).
  completedBy: "user" | "detected" | "navigator"
  at: number
  base: string
  baseOid: string | null
  head: string
  mergeCommit?: string
  fastForward?: boolean
  prUrl?: string
}

export type MergeQueueStatus =
  | "queued"
  | "merging"
  | "merged"
  | "conflict"
  | "resolving"
  | "cancelled"

export interface MergeQueueEntry {
  id: string
  milestoneId: string
  userStoryId: string
  playbookRunId: string | null
  status: MergeQueueStatus
  attempt: number
  userStoryHead: string | null
  conflictFiles: string[]
  mergeCommit: string | null
  touchedFiles: string[]
  // Touched files no touch hint covers: the drift signal for 106.8.
  outsideHints: string[]
  note: string | null
  escalated: boolean
  resolutionRunId: string | null
  resolutionWorktree: string | null
  resolutionStartOid: string | null
  resolutionAttempts: number
  proofAcceptedAt: number
  createdAt: number
  updatedAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface UserStory {
  id: string
  milestoneId: string
  key: string
  title: string
  spec: UserStorySpec
  proof: unknown | null
  podKey: string | null
  playbookId: string | null
  status: UserStoryStatus
  processRunId: string | null
  branch: string | null
  // The current attempt's worktree and the integration commit it started from.
  worktreePath: string | null
  baseOid: string | null
  attempts: number
  origin: "user" | "agent"
  position: number
  startedAt: number | null
  finishedAt: number | null
}

export interface UserStoryEdge {
  id: string
  milestoneId: string
  fromUserStoryId: string
  toUserStoryId: string
}

export interface WorkRevision {
  id: string
  featureId: string
  targetKind: "feature" | "milestone" | "user_story" | "edge"
  targetId: string
  actor: string
  change: { op: string; before?: unknown; after?: unknown }
  reason: string | null
  createdAt: number
}

export interface FeatureGraph {
  feature: Feature
  milestones: Milestone[]
  userStories: UserStory[]
  edges: UserStoryEdge[]
  revisions: WorkRevision[]
  rigDrifted: boolean
}

export type PlaybookAltitude = "user_story" | "milestone" | "feature"
export type PlaybookHookName =
  | "run"
  | "before_user_stories"
  | "after_each_user_story"
  | "after_all_user_stories"
  | "plan"
  | "between_milestones"
  | "on_complete"

export interface Playbook {
  id: string
  name: string
  altitude: PlaybookAltitude
  description: string | null
  createdAt: number
  updatedAt: number
}

export interface PlaybookHook {
  id: string
  playbookId: string
  hook: PlaybookHookName
  processId: string
  // False for a Process imported as a playbook (plan 106.9): the definition
  // stays the user's, so deleting the playbook leaves it in place.
  ownsProcess: boolean
}

export interface PlaybookWithHooks extends Playbook {
  hooks: PlaybookHook[]
}

export type PlaybookRunStatus = "running" | "completed" | "failed" | "cancelled"

export interface PlaybookRun {
  id: string
  playbookId: string | null
  hook: PlaybookHookName
  featureId: string
  milestoneId: string | null
  userStoryId: string | null
  processRunId: string | null
  status: PlaybookRunStatus
  proof: UserStoryProof | null
  proofRevisions: number
  outcomeReason: string | null
  // Set when the run works in its own worktree rather than the workspace.
  worktreePath: string | null
  createdAt: number
  finishedAt: number | null
}

export interface MissionControlRunLink {
  featureId: string
  milestoneId: string | null
  userStoryId: string | null
  playbookRunId: string
  hook: PlaybookHookName
}

// One resolved seat, frozen at run start. Workers read only this snapshot, never
// the live rig, so rig edits mid-run cannot change who does the work.
export interface SeatBinding {
  address: string
  role: string
  seatId: string
  podKey: string
  podName: string
  agentName: string
  agentLabel: string
  charter: string
  podMission: string
  podCulture: string
  decisionRights: RigDecisionRight[]
  skills: string[] | null
  tools: string[] | null
  mcpServers: string[] | null
  runtime: ProcessRuntimeSelection | null
}

export interface SeatBindingsSnapshot {
  version: 1
  rigName: string
  rigCulture: string
  podKey: string
  // Role → candidate seat addresses, in routing order.
  roles: Record<string, string[]>
  seats: Record<string, SeatBinding>
  // Static Refocus intent chain (feature → milestone → user story).
  intentChain: string
}

export type ProofCriterionStatus = "met" | "not_met" | "not_verifiable"

// How a proof criterion was verified (plan 109.05). Proofs recorded before
// it have none, shown as "unspecified".
export type ProofVerificationMethod =
  | "qa_check"
  | "app_exercised"
  | "builder_tests"
  | "command"
  | "code_read"

// A QA check a criterion cites, as the harness recorded it in the test step.
export interface ProofCheckResult {
  checkId: string
  status: "passed" | "flaky" | "failed" | "not_run"
  attempts: number
}

export interface UserStoryProofCriterion {
  id: string
  status: ProofCriterionStatus
  evidence: string
  method?: ProofVerificationMethod
  checks?: ProofCheckResult[]
  artifacts?: string[]
  reason?: string
}

export interface UserStoryProof {
  version: 1
  criteria: UserStoryProofCriterion[]
  verdict: "accepted" | "rejected"
  verifiedBy:
    | { kind: "seat"; address: string }
    | { kind: "command"; phaseKey: string }
  builderAddresses: string[]
  processRunId: string
  acceptedAt: number | null
  warnings?: string[]
}

export interface ProcessRuntimeSnapshotSelection {
  accountId: string | null
  modelId: string | null
  source:
    | "phase_agent"
    | "seat"
    | "phase"
    | "run"
    | "source_conversation"
    | "default"
}

export type ProcessRuntimeSnapshot = Partial<
  Record<ProcessRuntimeSlot, ProcessRuntimeSnapshotSelection>
>

export interface ProcessPhase {
  // Omitted only in pre-contract in-memory callers; persisted rows are explicit.
  completionContract?: PhaseCompletionContract
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
  // SUB-PROCESS phase (plan 038.1): when set, this phase runs ANOTHER process
  // definition as a nested run instead of an agent worker/fan-out. Mutually
  // exclusive with fan_out (and the agent pool is unused) — validated in the repo.
  // Null = an ordinary agent phase.
  subprocessId: string | null
  // Mission Control proof step (plan 106.3): only this phase's worker is offered
  // record_proof, and only inside a user story run. Ignored by legacy Processes.
  proofStep?: boolean
  // Mission Control (plan 106.4): how long a seat-role step's conversation
  // lives. `step`: a new worker for this step (106.3). `user_story`: one session per
  // seat for this user story (or hook) run, shared by the seat's steps and mail,
  // closed when the run ends. `feature`: the seat's long-lived session,
  // carried across user stories. Ignored for agent-name phases and legacy Processes.
  // Stored in process_phases.context_mode.
  contextScope?: PhaseContextScope
  runtimeConfig?: ProcessRuntimeConfig | null
  position: number
}

export type PhaseContextScope = "step" | "user_story" | "feature"

// tools/skills are tri-state JSON overrides: null = use the agent's own
// definition; [] = none; [list] = exactly these (matches .agent.md frontmatter).
// Exactly one of agentName / seatRole is set (repo-validated). A seat-role row
// (plan 106.3) binds at run start against the feature's rig snapshot.
export interface ProcessPhaseAgent {
  id: string
  phaseId: string
  agentName: string | null
  seatRole?: string | null
  skills: string[] | null
  tools: string[] | null
  runtimeConfig?: ProcessRuntimeConfig | null
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
  // Null/absent marks pre-contract runs: permanently legacy on resume.
  completionContracts?: Record<string, PhaseCompletionContract> | null
  id: string
  processId: string | null
  sourceConversationId: string | null
  // The run's working directory (plan 026): a workspaces.id, resolved to a path
  // for every phase worker. A run started from the Process screen has no source
  // conversation to inherit a workspace from, so it carries its own. Null = the
  // run resolves its workspace from the source conversation (or none).
  workspaceId: string | null
  // Where the run's workers actually work when it isn't the workspace's own
  // folder: a Mission Control user story's git worktree of `workspaceId`. The
  // worktree is never a workspace of its own. Null = the workspace's path.
  workingDirectory?: string | null
  // The process_run task that drives this run (holds the runner slot, anchors
  // approval gates + checkpoints). SET NULL if the task is deleted.
  taskId: string | null
  objective: string | null
  // Short, LLM-generated display title summarizing the objective (like a
  // conversation's title). Null for pre-existing runs and until generation lands
  // — the renderer falls back to an objective user story.
  title: string | null
  // A NESTED run's caller (plan 038.1): the sub-process phase-run that started
  // this run. Null for a top-level run. Lets the monitor nest the child run under
  // the phase and crash-resume re-attach (find-by-parent) instead of restarting.
  parentPhaseRunId: string | null
  runtimeConfig?: ProcessRuntimeConfig | null
  // Mission Control runs only (plan 106.3): the immutable seat bindings resolved
  // at run start, and the container this run executes for. Null for Processes.
  seatBindings?: SeatBindingsSnapshot | null
  missionControl?: MissionControlRunLink | null
  status: ProcessRunStatus
  startedAt: number | null
  finishedAt: number | null
  createdAt: number
}

export interface ProcessPhaseRun {
  completionReceipt?: PhaseCompletionReceipt | null
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
  failure: FailureContext | null
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
  // Frozen output captured when this phase-run successfully completes. Downstream
  // phases consume this rather than the mutable worker conversation transcript.
  resultContent: string | null
  // When the validator review of the worker's output started; null when no
  // review is in flight. The phase stays `running` meanwhile.
  reviewStartedAt: number | null
  // Stable identity of the current completed worker output reviewed by a
  // validator. Cleared on reset/rework and stamped after each successful worker
  // completion so stale reviewer results cannot settle a replacement output.
  outputIdentity: string | null
  // First-class on_each_subtask lineage (plan 031.2): the source fan-out CHILD
  // this consumer instance consumes. Null for ordinary runs and fan-out children;
  // set for on_each_subtask consumer instances. Lets flag-back reset only the
  // instance tied to a reworked source sub-task (per-child, not the whole batch).
  sourceChildRunId: string | null
  // The seat that ran this phase-run's worker (plan 106.3). Null outside
  // Mission Control and for agent-name-bound phases.
  seatAddress?: string | null
  runtimeSnapshot?: ProcessRuntimeSnapshot | null
  // QA acceptance checks on a Mission Control QA step (plan 109.02): the
  // freeze taken when the checks step completes, drift found when the test
  // step starts, and the results `run_checks` recorded. Written only by the
  // harness, never from model arguments.
  qaChecks?: PhaseRunQaChecks | null
}

// A content snapshot of the checks directory: workspace-relative path → file
// hash (a git blob id in a repository). `hash` covers the sorted paths and
// file hashes together.
export interface ChecksSnapshot {
  checksDir: string
  hash: string
  files: Record<string, string>
}

export interface ChecksFreeze extends ChecksSnapshot {
  frozenAt: number
  // Why QA re-froze the checks in the test step (refreeze_checks).
  reason?: string
}

export interface ChecksChange {
  path: string
  change: "added" | "modified" | "deleted"
  // A page object, fixture, or helper other stories' checks may use, as
  // opposed to this story's own specs and manifest.
  shared: boolean
  // Line counts from git, when both versions are known.
  added?: number
  removed?: number
}

export interface CheckResult {
  checkId: string
  criterionId: string
  storyRef: string
  // 1, or 2 for the single retry of a failing check.
  attempt: number
  passed: boolean
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  outputTail: string
  ranAt: number
  // A Playwright check (plan 109.06): which Playwright and browser ran it,
  // its tests, and the traces and screenshots of failures (evidence files).
  playwright?: {
    source: "workspace" | "bundled"
    version: string
    browser: "workspace" | "chrome" | "installed" | "missing"
    tests: Array<{
      title: string
      file: string
      status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted"
      durationMs: number
      error?: string
    }>
    artifacts: string[]
  }
  // Why the check couldn't run at all for a reason outside the app (no
  // browser installed yet). Counts as not passed.
  notVerifiable?: string
  // The check never reached the app (connection refused, no baseURL): a
  // setup problem, not evidence about the criterion (plan 109.07). Counts as
  // not passed.
  unreachable?: string
}

export interface PhaseRunQaChecks {
  freeze?: ChecksFreeze
  // Set when the test step starts and the checks differ from the freeze.
  // The proof can't be accepted until QA re-freezes them.
  drift?: {
    changed: ChecksChange[]
    detectedAt: number
    resolvedAt: number | null
  }
  // Files outside the checks and scratch directories that QA's checks step
  // changed (shell writes bypass the write scope).
  outsideWrites?: string[]
  results?: CheckResult[]
}

export interface ProcessPhaseAttempt {
  id: string
  runId: string
  phaseRunId: string
  phaseId: string
  taskId: string | null
  workerTaskId: string | null
  agentName: string | null
  stage: FailureStage
  status: "failed"
  attempt: number | null
  maxAttempts: number | null
  error: string
  failure: FailureContext
  createdAt: number
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

// ── Mission Control seat sessions and Comms (plan 106.4) ────────────────────

export type SeatSessionStatus = "idle" | "busy" | "rotated" | "closed"

// feature: the seat's long-lived session. user story: one session for one
// playbook run (a user story attempt or a hook run), closed when the run ends.
export type SeatSessionScope = "feature" | "user_story"

export interface SeatSession {
  id: string
  featureId: string
  seatAddress: string
  scope: SeatSessionScope
  // The playbook run a user story session belongs to (null for feature scope).
  playbookRunId: string | null
  generation: number
  conversationId: string | null
  status: SeatSessionStatus
  handoffSummary: string | null
  rotationReason: string | null
  failureCount: number
  createdAt: number
  lastActivityAt: number | null
  rotatedAt: number | null
}

export type SeatThreadAnchorKind = "user_story" | "milestone" | "proposal"

export interface SeatThread {
  id: string
  featureId: string
  anchorKind: SeatThreadAnchorKind | null
  anchorId: string | null
  subject: string
  createdAt: number
}

export type SeatMessageKind =
  | "message"
  | "direction"
  | "steer"
  | "escalation"
  | "alert"

export type SeatMessageStatus =
  | "queued"
  | "delivered"
  | "replied"
  | "acknowledged"
  | "expired"
  | "refused"

export interface SeatMessage {
  id: string
  threadId: string
  featureId: string
  fromAddress: string
  toAddress: string
  inReplyTo: string | null
  hop: number
  body: string
  kind: SeatMessageKind
  status: SeatMessageStatus
  expectsReply: boolean
  needsDecision: RigDecisionRight | null
  refusalReason: string | null
  // Delivered as an answer-only wake of a finished fresh worker.
  answerOnly: boolean
  wakeTaskId: string | null
  // Where the tagged turn landed, for "open in seat transcript".
  deliveredConversationId: string | null
  deliveredMessageId: string | null
  createdAt: number
  deliveredAt: number | null
}

// ── Mission Control Navigator (plan 106.6) ─────────────────────────────────

export interface PlanProposal {
  id: string
  featureId: string
  // The milestone the change set was made against (the active one), if any.
  milestoneId: string | null
  kind: ProposalKind
  changes: PlanChange[]
  // Seat address (or "navigator@rig") that proposed it.
  proposer: string
  reason: string
  // Set for kind "followup" (plan 106.7); its changes stay empty until applied.
  followup: ProposalFollowup | null
  status: ProposalStatus
  resolvedBy: string | null
  resolutionNote: string | null
  createdAt: number
  resolvedAt: number | null
  // Pending proposals only, computed on read: changes that no longer apply to
  // the plan as it is now, by index.
  problems?: Array<{ index: number; error: string }>
  // Pending follow-ups only, computed on read: where applying lands it unless
  // the user picks another place.
  defaultTarget?: FollowupTarget
}

// Seat memory (plan 106.7): a short lesson attached to a seat of a rig, injected
// into every later turn in that seat once active. Never written by a tool:
// lessons are extracted after seat turns, reviewed by the user, shared only by
// the user (a copy that keeps its lineage), and retracted with every copy.
export type SeatMemoryKind = "lesson" | "convention" | "pitfall"
export type SeatMemoryStatus = "pending_review" | "active" | "retracted"
// learned: extracted from a seat turn; shared: copied from another seat's
// lesson (derivedFrom); imported: arrived with a rig template.
export type SeatMemorySource = "learned" | "shared" | "imported"

export interface SeatMemory {
  id: string
  rigId: string
  seatAddress: string
  content: string
  kind: SeatMemoryKind
  status: SeatMemoryStatus
  source: SeatMemorySource
  originFeatureId: string | null
  originConversationId: string | null
  originSessionId: string | null
  originUserStoryId: string | null
  originMessageId: string | null
  derivedFrom: string | null
  useCount: number
  lastUsedAt: number | null
  createdAt: number
  reviewedAt: number | null
  retractedAt: number | null
  retractReason: string | null
  // Computed on read for the Memory tab.
  exposureCount?: number
  originLabel?: string | null
}

export interface SeatMemoryExposure {
  memoryId: string
  conversationId: string
  featureId: string | null
  seatAddress: string
  injectedAt: number
}

// What retracting a lesson did: every copy it retracted, and the live seat
// sessions that had been shown one and were told to disregard it.
export interface SeatMemoryRetraction {
  retracted: SeatMemory[]
  exposedConversations: number
  notified: Array<{ featureId: string; address: string }>
}

export interface NavigatorTickAction {
  kind:
    | "start_user_story"
    | "retry_user_story"
    | "run_hook"
    | "apply_plan"
    | "advance_milestone"
    | "complete_milestone"
    | "complete_feature"
    | "kick_merges"
    | "auto_pause"
    | "direction"
    | "notify"
  target: string | null
  ok: boolean
  detail: string
}

export interface NavigatorTick {
  id: string
  featureId: string
  positionHash: string
  // One line: where the feature is and what is next.
  summary: string
  actions: NavigatorTickAction[]
  decisionKeys: string[]
  // Compact state for "what changed" in the next direction.
  state: NavigatorTickState
  createdAt: number
}

export interface NavigatorTickState {
  milestoneId?: string | null
  milestoneStatus?: string | null
  // user story key → status, for the active milestone.
  userStories?: Record<string, string>
}

// ── Mission Control health (plan 106.8) ────────────────────────────────────

// Progress moves the map; ceremony is ritual around the work; neutral events
// are recorded for context (a run started, the drive resumed) but weigh nothing.
export type McEventClass = "progress" | "ceremony" | "neutral"

export interface McEvent {
  id: string
  featureId: string
  milestoneId: string | null
  userStoryId: string | null
  seatAddress: string | null
  class: McEventClass
  type: string
  weight: number
  // The row this event was derived from (message, revision, proof, merge
  // entry…); unique per type, so a replayed write records nothing twice.
  refId: string | null
  detail: Record<string, unknown> | null
  createdAt: number
}

export type HealthSeverity = "info" | "warn" | "critical"

export type HealthSignalStatus = "open" | "acknowledged" | "resolved" | "muted"

export type HealthAnchorKind =
  | "feature"
  | "milestone"
  | "user_story"
  | "seat"
  | "thread"

// One concrete thing a signal rests on, for the evidence drill-down.
export interface HealthEvidence {
  kind: "event" | "message" | "proof" | "file" | "failure"
  label: string
  at: number | null
  refId?: string
  // Where the user can open it.
  link?: { kind: "user_story" | "milestone" | "thread"; id: string }
}

export interface HealthSignal {
  id: string
  featureId: string
  detector: string
  anchorKind: HealthAnchorKind
  anchorId: string
  anchorLabel: string
  severity: HealthSeverity
  status: HealthSignalStatus
  summary: string
  evidence: HealthEvidence[]
  fireCount: number
  firstSeenAt: number
  lastSeenAt: number
  // When the warn-level alert went out (user + context-bearing seat).
  alertedAt: number | null
  alertedTo: string | null
  // When the critical response ran (auto-pause).
  criticalAt: number | null
  acknowledgedAt: number | null
  resolvedAt: number | null
  // Refocus requests this signal made, where they went, and how many times
  // the drift continued after one was delivered.
  refocusCount: number
  lastRefocusAt: number | null
  refocusConversations: string[]
  ignoredCount: number
}

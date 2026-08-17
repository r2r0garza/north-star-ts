// Re-export the persisted DB row types from the preload surface so renderer
// code can import them from a stable `@/types` path.
export type {
  Approval,
  ApprovalStatus,
  Conversation,
  Message,
  Mode,
  Project,
  Task,
  TaskCheckpoint,
  TaskEvent,
  TaskStatus,
  Todo,
  TodoStatus,
  Workspace,
} from "../../preload/index"

// Durable task runner event types, surfaced for the Workspace Activity panel's
// live tail subscription (window.cowork.tasks.onEvent).
export type { TaskEventPayload, TaskLiveEvent } from "../../preload/index"

// ask_user_question types, surfaced for the QuestionPanel.
export type {
  Question,
  QuestionOption,
  QuestionAnswer,
} from "../../preload/index"

// Picked-element type (agent browser pick mode), surfaced for the composer chip.
export type { PickedElement } from "../../preload/index"

// Git diff result (changed-file pills + sidebar Changes review).
export type { GitDiffResult } from "../../preload/index"

// Skill types: summary for the composer's slash menu; metadata + catalog entry
// for the Skills view (browse + edit SKILL.md).
export type {
  SkillSummary,
  SkillSourceRow,
  SkillSourceKind,
  SkillMetadata,
  SkillCatalogEntry,
  SkillFolder,
  SkillTree,
} from "../../preload/index"

// Custom agent summary for the composer's agent picker; source rows for the
// Settings → Capabilities "Agent folders" table.
export type {
  AgentSummary,
  AgentSourceRow,
  AgentSourceKind,
  AgentDefinition,
  AgentFolder,
  AgentTree,
  AgentFields,
} from "../../preload/index"

// Settings types, surfaced for the Settings pane.
export type {
  ExecutionSettings,
  PermissionSettings,
  LlmSettings,
  IndexingSettings,
  SkillSourcesSettings,
  AgentSourcesSettings,
  BrowserSettings,
  BrowserReveal,
  IdeSettings,
  NotificationSettings,
  Backend,
  FilePermission,
  ApprovalCategory,
  RuntimeStatus,
  Runtime,
} from "../../preload/index"

// Workspace indexing types (plan 008), surfaced for the status strip + settings.
export type {
  IndexStatus,
  IndexPriority,
  IndexStage,
} from "../../preload/index"

// LLM provider/model types, surfaced for the Providers/Models tabs + composer.
export type {
  Provider,
  ModelOrigin,
  ProviderAccount,
  ModelEntry,
  AccountView,
  AccountWithModels,
} from "../../preload/index"

// Process engine types (plans 025/026), surfaced for the Process screen — the
// DAG builder + live run monitor.
export type {
  ProcessDefinition,
  ProcessPhase,
  ProcessPhaseAgent,
  ProcessEdge,
  ProcessRun,
  ProcessPhaseRun,
  ProcessGraph,
  ProcessRunStatus,
  PhaseRunStatus,
  PhaseRouting,
  PhaseGatePolicy,
  EdgeTrigger,
} from "../../preload/index"

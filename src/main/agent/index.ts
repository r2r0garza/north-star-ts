import {
  openSteering,
  consumeSteering,
  setSteeringWake,
  steeringState,
  validateSteeringWith,
} from "./steering"
import type { SteeringState } from "../../shared/steering"
import { nativeAssistant } from "./providers/native-carrier"
import { randomUUID } from "crypto"
import {
  acceptsToolActivity,
  executionArguments,
  withToolActivity,
} from "../../shared/tool-activity"
import { readFile, stat } from "fs/promises"
import { basename, dirname, isAbsolute } from "path"
import { SHUTDOWN_ABORT_REASON, stopNote } from "./abort"
import { askUser } from "./questions/broker"
import {
  toolDefinitions,
  browserToolDefinitions,
  webSearchDefinition,
  webFetchDefinition,
  runTool,
  getToolEffects,
  getToolExecutionPolicy,
  todoWriteTool,
  askUserQuestionTool,
  runTodosInBackgroundTool,
  indexQueryTool,
  writePlanTool,
  readPlanTool,
  presentPlanTool,
  spawnSubagentsTool,
} from "./tools"
import { terminateOwnedCommandSessions } from "./tools/command_session_tools"
import { terminateOwnedTestSessions } from "./tools/test_diagnostics_tools"
import type { BrowserHandle } from "../browser/manager"
import { TOOL_EFFECTS, type ToolImage } from "./tools/types"
import { readFileTool } from "./tools/read_file_tool"
import { CHAT_SHELL_TOOL_NAMES, chatShellContext } from "./tools/chat_shell"
import { toolError } from "./tools/output"
import type { ToolContext } from "./tools/types"
import {
  FILE_CHANGE_KINDS,
  KIND_WIDE_IDENTITY,
  allowsKindWide,
  type ApprovalRemember,
} from "../../shared/approval-scope"
import {
  readDocumentTool,
  supportedDocumentKind,
} from "./tools/document_extraction_tool"
import { accumulateToolCalls, extractTextToolCalls } from "./tool-stream"
import { runToolCallBatches, ToolLifecycleError } from "./tool-batch-scheduler"
import {
  listTodos,
  replaceTodos,
  isTodoListFinished,
} from "../db/repositories/todos"
import { createTask, updateTask } from "../db/repositories/tasks"
import { todoSeed, finishedTodoTitle } from "../tasks/todo-run"
import { buildTodoListPrompt, todoListInHistory } from "./todo-prompt"
import { loadSkills } from "./skills/loader"
import { buildSkillsPrompt } from "./skills/prompt"
import { createReadSkillTool } from "./skills/tool"
import { forcedSkillNames } from "./skills/forced"
import { skillSources } from "./skills/sources"
import { registerSkillResourceRootInMap } from "./tools/skill_resources"
import { recordMemoryTurn } from "./memory/service"
import { loadAgent, loadAgents } from "./agents/loader"
import { agentSources } from "./agents/sources"
import type { AgentDefinition } from "./agents/types"
import { MAX_AGENT_DEPTH } from "./agents/types"
import {
  agentToolAllowlist,
  agentToolsIncludeCategory,
  isUniversalTool,
} from "./agents/tool-categories"
import { buildSubagentsPrompt } from "./agents/prompt"
import {
  agentCapabilityPolicy,
  agentCapabilitySummary,
  externalAgentToolFilter,
  resolvePolicyChildren,
  resolvePolicyMcpServers,
  resolvePolicySkills,
} from "./agents/capability-policy"
import { getMcpManager, parsePrefixedName, enabledServerNames } from "./mcp"
import type { McpToolDefinition } from "./mcp"
import { spawnSubagentTool } from "./tools/spawn_subagent"
import type { SpawnSubagentsInput, SubagentResult } from "./subagents/contracts"
import {
  composeSubagentInstructions,
  ephemeralProfilePrompt,
} from "./subagents/profiles"
import { loadSpawnableAgent, loadSpawnableAgents } from "./subagents/sources"
import { resolveSkillResourcePath } from "./tools/skill_resources"
import { repositoryDelegationLeases } from "./subagents/repository-lease"
import {
  collectWriterHandback,
  createWriterWorktree,
  mergeability,
  preflightWriterRepository,
  removeWriterWorktree,
  stageIntegrationBranch,
  type WriterWorktree,
} from "./subagents/worktrees"
import { containerNameForConversation } from "./env/container"
import { dashboardWriteTool } from "./tools/dashboard_write"
import { presentChartTool } from "./tools/present_chart"
import { presentTableTool } from "./tools/present_table"
import type { ArtifactPresentation } from "../../shared/conversation-artifacts"
import { dashboardReadTool } from "./tools/dashboard_read"
import { loadSystemPrompt } from "./system-prompt"
import { logSystemPrompt } from "./prompt-log"
import { buildIndexSummary } from "../index/summary"
import { takeConversationNotes } from "../db/repositories/conversation-notes"
import { indexedWorkspaceFor } from "../index/indexed-workspace"
import {
  contextBuilder,
  SECTION_PRIORITY,
  type ContextSection,
} from "./context/context-builder"
import { renderContextEnvelope } from "../../shared/context-provenance"
import {
  taskStateSection,
  approvalsSection,
  summarySection,
  environmentSection,
  browserStateSection,
} from "./context/sections"
import { repairDanglingToolCalls } from "./repair"
import { replayToolCallArguments } from "./tool-call-arguments"
import { offeredToolNames, unavailableToolResult } from "./tool-availability"
import { createEnvironment } from "./env"
import { LocalEnvironment } from "./env/local"
import { CHAT_VENV_PROMPT, resolveChatVenvOverlay } from "../python/chat-venv"
import type { Environment } from "./env/types"
import * as settingsService from "../settings/service"
import { selectionAcceptsImages } from "./providers/image-input"
import {
  resolveLlm,
  createCompletion,
  isTransientError,
  NoActiveProviderError,
  type LlmSelection,
} from "./providers"
import { ContextOverflowError } from "./providers/anthropic"
import { contextWindowFor, isContextOverflow } from "./providers/context-limits"
import {
  buildWorkLedger,
  clearOldToolResults,
  clipToolResults,
  latestRound,
  compactionTiers,
  compactionWatermarks,
  continuationMessage,
  pinnedInstructions,
} from "./context/compaction"
import {
  createCompletionRoundWithRetry,
  ModelRequestRetryExhaustedError,
  ModelResponseValidationError,
  StreamStalledError,
  streamUsageRequested,
  withStreamUsage,
  type CompletionRound,
  type ModelResponseAttemptDiagnostics,
} from "./model-request-retry"
import {
  measureRequest,
  measureResponse,
  REQUEST_SIZE_ESTIMATOR,
  type RequestSize,
} from "./context/request-size"
import {
  contextUsageLog,
  type ContextUsageEntry,
  type ContextUsageOutcome,
} from "./context/usage-log"
import { generateTitle } from "./title"
export { generateTitle } from "./title"
import { sanitizeFailureContext } from "../tasks/failure-sanitizer"
import { replayToolMedia } from "../media/tool-media"
import {
  appendMessage,
  listMessages,
  listMessagesAfterSeq,
  getMaxMessageSeq,
  getMessage,
} from "../db/repositories/messages"
import {
  findPriorToolCallLifecycleByInvocation,
  getToolCallLifecycle,
  markToolCallNotStarted,
  markToolCallSettled,
  markToolCallStarted,
  markToolCallUnknown,
  markToolCallWaitingForApproval,
  normalizeToolActionIdentity,
  normalizeToolCallIdentity,
  recordToolCallIntents,
  updateToolCallOperationIdentity,
} from "../db/repositories/tool-call-lifecycle"
import {
  completeBudget as completeModelRequestRetryBudget,
  exhaustBudget as exhaustModelRequestRetryBudget,
} from "../db/repositories/model-request-retry-budgets"
import {
  commandCompletionInbox,
  type CommandCompletionEvent,
  type CommandCompletionOwner,
} from "./command-completion-inbox"
import {
  getConversation,
  createConversation,
  updateConversation,
  setConversationTitleIfUntitled,
} from "../db/repositories/conversations"
import { actionAllowlist } from "../db/repositories"
import { getWorkspace, workingDirectoryOf } from "../db/repositories/workspaces"
import { getProject } from "../db/repositories/projects"
import { getAccount } from "../db/repositories/provider-accounts"
import {
  createSubagentArtifact,
  listSubagentArtifacts,
  settleSubagentArtifact,
} from "../db/repositories/subagent-artifacts"
import type { Conversation } from "../db/types"
import type { FailureContext, FailureStage } from "../db/types"
import { runClaudeConversation, runCodexConversation } from "./cli"
import {
  conversationTurnPending,
  serializeConversationTurn,
} from "./conversation-turns"
import { bashBlockCommand, type BashBlockRequest } from "./bash-block"
import type { ToolCallRecord } from "../db/types"
import { normalizeClaudeModel } from "./cli/claude"
import { makePolicyEngine } from "./approval/engine"
import { PlanModeClassifier } from "./approval/plan-mode-classifier"
import type {
  ActionKind,
  Gate,
  GateOutcome,
  ToolAction,
} from "./approval/types"
import type { Ask, AskResult, EnqueueTask, Question } from "./tools/types"
import { SubagentApprovalCoordinator } from "./subagents/approval-coordinator"
import { SubagentAutoModeRelay } from "./subagents/auto-mode"

// The single approval policy, shared across turns. Built by the shared factory
// (approval/engine.ts) so the deterministic dashboard-refresh executor (033.3)
// authorizes headless side effects through the exact same engine + classifiers.
const policy = makePolicyEngine()

// Decision for one pending approval, set by resolveApproval and awaited inside
// the gate. `remember` persists an allowlist rule when the human chose "always".
interface PendingApproval {
  resolve: (decision: "approved" | "denied") => void
  action: ToolAction
  workspacePath?: string
  conversationId?: string
  explicit?: boolean
}
const pendingApprovals = new Map<string, PendingApproval>()

// One AbortController per in-flight turn, keyed by conversation. The renderer's
// Stop button calls stopChat(conversationId), which aborts the controller: that
// cancels the in-flight Portkey stream (signal passed to every create() call),
// unblocks any pending approval gate, and breaks the agentic loop. A turn owns
// at most one controller; runChat clears it in `finally`.
const abortControllers = new Map<string, AbortController>()

// One auto-mode setter per in-flight LIVE turn, keyed by conversation. The
// renderer's mode dropdown calls setAutoModeForConversation(id, true) when the
// user flips to Auto mid-turn; that reaches the running loop's `setAutoMode`
// closure (the same one present_plan uses), so the gate — which reads the live
// `autoMode` var — honors it on the next gated action. Only live turns register
// here (the durable runner and subagent spawns have no renderer to toggle from).
// A turn owns at most one entry; runChat clears it in `finally`.
const autoModeSetters = new Map<string, (on: boolean) => void>()

// Reason passed to controller.abort() when the app is shutting down (will-quit),
// as opposed to a user Stop/cancel. A user abort resolves a pending gate as
// "denied" so the loop unwinds cleanly; a shutdown must instead leave the gate
// UNRESOLVED — no tool result is persisted, so the task stays
// `waiting_for_approval` and the next boot reconciles it to `interrupted` and
// re-prompts on resume (plan 012). Fabricating a denial here was the bug that
// persisted a fake "ERROR[denied]" result and wedged resume.
// Defined in the leaf `./abort` module (no heavy imports) and re-exported here for
// back-compat; import from `./abort` directly to avoid the agent-barrel cycle.
export { SHUTDOWN_ABORT_REASON }

// Max output tokens per model turn. The agent emits tool calls whose arguments
// can be large (e.g. write_file_tool inlines a whole file as a JSON blob), so a
// low cap truncates the response mid-tool-call — the streamed arguments arrive as
// invalid JSON. 1024 was far too low for a file-writing agent; 8192 covers normal
// writes. A turn that still hits the ceiling is detected via finish_reason below
// and surfaced as a clean, retryable error rather than a cryptic JSON parse throw.
const MAX_OUTPUT_TOKENS = 8192
// Reasoning models (e.g. DeepSeek via OpenRouter) count hidden reasoning against
// the cap, so a long investigation can spend all 8192 tokens before emitting any
// text or tool call. Such a round is re-issued at the next step up instead of
// failing the turn; the base cap stays low so ordinary turns aren't affected.
const OUTPUT_TOKEN_STEPS = [MAX_OUTPUT_TOKENS, 16_384, 32_768] as const
// How many times a round whose stream hung is re-issued before the turn fails.
const MAX_STREAM_STALLS = 2

export function nextOutputTokenCap(current: number): number | null {
  return OUTPUT_TOKEN_STEPS.find((step) => step > current) ?? null
}

// Forces a work-state summary of everything persisted so far (plan 118 tier
// 2). Registered once by the main process with SummaryService.compactNow, so
// every runAgentLoop caller gets it without importing the app entry.
type TurnCompactor = (
  conversationId: string,
  signal: AbortSignal
) => Promise<boolean>
let turnCompactor: TurnCompactor | null = null
export function registerTurnCompactor(fn: TurnCompactor | null): void {
  turnCompactor = fn
}

// A provider that rejects the raised cap (the model's own output ceiling is
// lower) — keep the original output-limit failure rather than this error.
function rejectsOutputCap(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /max_(completion_)?tokens|max.{0,20}output.{0,20}tokens|maximum.{0,40}tokens/i.test(
    message
  )
}
// A non-retryable context-overflow failure naming the sizes involved. Its 4xx
// status keeps the task and workflow runners from retrying it.
function overflowFailure(
  estimated: number | null,
  window: number | null,
  cause?: unknown
): ContextOverflowError {
  const threshold = settingsService.getIndexing().turnCompactionTokenThreshold
  const k = (n: number) => `${Math.round(n / 1000)}k`
  return new ContextOverflowError(
    `The request exceeds the model's context window` +
      (estimated ? ` (~${k(estimated)} tokens estimated` : " (") +
      (window ? `, window ${k(window)}` : "") +
      `, compaction threshold ${threshold ? k(threshold) : "off"}) and compaction could not shrink it. ` +
      "Lower the turn compaction threshold in Settings or use a larger-context model.",
    400,
    { cause }
  )
}
const CHILD_APPROVAL_TIMEOUT_MS = 10 * 60_000

// Operating rules injected as a high-priority context section when a turn is in
// plan mode. Kept short and imperative.
const PLAN_MODE_PROMPT = `# Plan mode

You are in PLAN MODE. Investigate and design an approach, but do NOT modify the
workspace yet — writing files, editing files, running shell commands, and handing
work to the background are all disabled until the user approves your plan.

- Research freely with the read/search/browser tools to understand the task.
- Capture your plan with the write_plan tool (Markdown). Call it again to revise
  as you learn more — each call replaces the whole document.
- Use read_plan to read back what you've saved (the plan lives outside the
  workspace, so read_file_tool can't open it).
- When the plan is ready, call present_plan to show it to the user for approval.
- If the user requests changes, revise with write_plan and present_plan again.
- Once the user approves, plan mode ends and the full toolset returns — then
  implement the approved plan in this same turn.`

// Called from the renderer over IPC ("chat:stop") to cancel an in-flight turn.
// Idempotent and safe to call when nothing is running (no-op if no controller).
export function stopChat(conversationId: string): void {
  abortControllers.get(conversationId)?.abort()
}

// Called from the renderer over IPC ("chat:setAutoMode") when the user flips the
// mode dropdown while a turn is running. Flips the live turn's `autoMode` (via
// the registered closure, which also emits the auto_mode event to keep the UI in
// sync), and — when turning Auto ON — immediately approves any approval this
// conversation is currently blocked on, so the pending prompt clears instead of
// stranding the user (Auto means "stop asking me"). No-op if no live turn.
function approvePendingForConversation(conversationId: string): void {
  for (const [requestId, pending] of pendingApprovals) {
    if (pending.conversationId === conversationId) {
      resolveApproval(requestId, "approved")
    }
  }
}

export function setAutoModeForConversation(
  conversationId: string,
  on: boolean
): void {
  const setter = autoModeSetters.get(conversationId)
  if (!setter) return
  setter(on)
  if (!on) return
  // Auto-approve whatever this conversation is blocked on right now. Sequential
  // gating means at most one pending approval per conversation, but resolve all
  // matching just in case. No `remember` — Auto is a run stance, not a rule.
  approvePendingForConversation(conversationId)
}

// Called from the renderer over IPC ("chat:approve") to resolve a request the
// gate is blocked on. `requestId` is a process-unique token (not the model's
// tool-call id, which is only unique within a turn) so a decision can never
// resolve a different conversation's pending gate. On "approved" with a
// `remember` scope, the action is persisted to the allowlist so identical future
// actions skip the prompt — `"workspace"` for every conversation in this folder,
// `"conversation"` for just this session.
// `"kind"` remembers EVERY action of this kind for this conversation only
// (eligible kinds only — see allowsKindWide).
export function resolveApproval(
  requestId: string,
  decision: "approved" | "denied",
  remember?: ApprovalRemember
): void {
  const pending = pendingApprovals.get(requestId)
  if (!pending) return
  pendingApprovals.delete(requestId)
  if (
    decision === "approved" &&
    !pending.explicit &&
    remember === "workspace" &&
    pending.workspacePath
  ) {
    actionAllowlist.addRule({
      tool: pending.action.tool,
      kind: pending.action.kind,
      identity: pending.action.identity,
      scope: "workspace",
      workspacePath: pending.workspacePath,
      conversationId: pending.conversationId ?? null,
    })
  } else if (
    decision === "approved" &&
    !pending.explicit &&
    remember === "conversation" &&
    pending.conversationId
  ) {
    // Session scope: remember only for this conversation (matched by
    // conversation_id in the allowlist). Used for web_fetch's "approve for this
    // session" — a workspace-independent action, so it isn't workspace-scoped.
    actionAllowlist.addRule({
      tool: pending.action.tool,
      kind: pending.action.kind,
      identity: pending.action.identity,
      scope: "conversation",
      workspacePath: pending.workspacePath ?? null,
      conversationId: pending.conversationId,
    })
  } else if (
    decision === "approved" &&
    !pending.explicit &&
    (remember === "kind" || remember === "file_changes") &&
    pending.conversationId &&
    allowsKindWide(pending.action.kind)
  ) {
    // Kind-wide, this conversation only (for a background task: its private
    // worker conversation, i.e. this run). Matched by findMatch's wildcard path.
    // "file_changes" grants every eligible file kind at once.
    const kinds =
      remember === "file_changes" ? FILE_CHANGE_KINDS : [pending.action.kind]
    for (const kind of kinds) {
      actionAllowlist.addRule({
        tool: pending.action.tool,
        kind,
        identity: KIND_WIDE_IDENTITY,
        scope: "conversation",
        workspacePath: pending.workspacePath ?? null,
        conversationId: pending.conversationId,
      })
    }
  }
  pending.resolve(decision)
}

// Pending ask_user_question round trips live in the conversation-scoped broker
// (`./questions/broker`), shared with the CLI MCP bridge so both surfaces answer
// through the same `chat:answer` IPC. Re-exported here because the main-process
// IPC handler has always imported it from this module.
export { resolveQuestion } from "./questions/broker"

export interface ChatRequest {
  // The conversation this turn belongs to. Messages are persisted under it and
  // prior history is replayed into the prompt via the ContextBuilder.
  conversationId: string
  message: string
  bashBlock?: BashBlockRequest
  // The directory the agent's filesystem tools are confined to. Optional: the
  // Chat view runs without a workspace and relies on inlined attachments.
  workspace?: string
  // Absolute host paths explicitly attached by the user, readable on demand.
  attachments?: string[]
  // Skill names explicitly selected by the user through slash mentions.
  skills?: string[]
  // Start this turn in plan mode (interactive/north_star only). See
  // RunAgentLoopOptions.planMode.
  planMode?: boolean
  // Start this turn in auto mode (any mode, including chat). See
  // RunAgentLoopOptions.autoMode.
  autoMode?: boolean
}

export interface ChatResult {
  content?: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  error?: string
  failure?: FailureContext
  // Stable code for renderer actions that should not depend on parsing the
  // human-readable error text.
  errorCode?: "execution_backend_unavailable"
  // True when the turn was cancelled by the user's Stop button (a clean stop,
  // not an error). The stop note (see stopNote) is already persisted.
  stopped?: boolean
  // Only meaningful alongside `error`: true when the failure was a transient
  // infrastructure hiccup (gateway 5xx, network/timeout) worth a backoff retry.
  // Classified at the catch block where the raw error's status/code is still
  // available; the task runner reads it to decide retry vs fail-fast (plan 011).
  retryable?: boolean
}

// Persist a failure that happens after the user message has been appended but
// before (or during) the model loop. The renderer reconciles the live buffer from
// stored messages when a turn settles, so returning an unpersisted early error
// makes the assistant bubble disappear and looks like the agent did nothing.
function failTurn(
  conversationId: string,
  message: string,
  retryable = false,
  errorCode?: ChatResult["errorCode"],
  failure?: FailureContext
): ChatResult {
  try {
    appendMessage({
      conversationId,
      role: "assistant",
      content: `⚠️ The turn ended early: ${message}`,
    })
  } catch {
    console.error("Unable to persist agent failure", {
      conversationId,
      stage: "result_persistence",
    })
    failure ??= agentFailure({
      code: "failure_persistence_failed",
      stage: "result_persistence",
      message: "Unable to persist agent failure",
    })
  }
  return {
    error: message,
    retryable,
    ...(errorCode ? { errorCode } : {}),
    ...(failure ? { failure } : {}),
  }
}

function agentFailure(input: {
  code: string
  stage: FailureStage
  message: string
  retryable?: boolean
  taskId?: string
  cause?: string | null
  toolCallId?: string
}): FailureContext {
  return sanitizeFailureContext({
    code: input.code,
    stage: input.stage,
    message: input.message,
    retryable: input.retryable === true,
    attempt: null,
    maxAttempts: null,
    runId: null,
    phaseRunId: null,
    phaseId: null,
    taskId: input.taskId ?? null,
    workerTaskId: input.taskId ?? null,
    agentName: null,
    toolCallId: input.toolCallId,
    cause: input.cause ?? null,
    occurredAt: Date.now(),
  })
}

function isToolErrorResult(result: string): boolean {
  return result.startsWith("ERROR[") || result.startsWith("Error running ")
}

function commandCompletionMessage(events: CommandCompletionEvent[]): string {
  return JSON.stringify(
    {
      type: "background_command_completions",
      completions: events.map((event) => ({
        eventId: event.id,
        sessionId: event.sessionId,
        runId: event.runId,
        command: event.command,
        cwd: event.cwd,
        createdAt: event.createdAt,
        status: event.status,
        exitCode: event.exitCode,
        signal: event.signal,
        durationMs: event.durationMs,
        cursor: event.cursor,
        nextCursor: event.nextCursor,
        totalBytes: event.totalBytes,
        droppedBytes: event.droppedBytes,
        omittedBytes: event.omittedBytes,
        modelTruncated: event.modelTruncated,
        truncated: event.truncated,
        cleanupError: event.cleanupError,
        output: event.output,
      })),
    },
    null,
    2
  )
}

function appendCommandCompletionEvents(input: {
  conversationId: string
  messages: any[]
  owner: CommandCompletionOwner
  events: CommandCompletionEvent[]
}): boolean {
  if (input.events.length === 0) return false
  const content =
    "Runtime event: background command completion(s).\n\n" +
    renderContextEnvelope(
      {
        trust: "untrusted_data",
        channel: "command",
        source: "background_command_completion",
      },
      commandCompletionMessage(input.events)
    )
  appendMessage({
    conversationId: input.conversationId,
    role: "system",
    content,
  })
  // Chat protocols have no standalone runtime-event role. Transport the safely
  // enveloped data as user-compatible input without storing it as human speech.
  input.messages.push({ role: "user", content })
  commandCompletionInbox.markConsumed(input.events.map((event) => event.id))
  return true
}

// DeepSeek's native tool-call markup (DSML, and its tool-call block tokens),
// which providers normally convert into structured tool calls. Seen as text
// only when conversion failed, e.g. a call cut off at the output cap.
const UNPARSED_TOOL_CALL =
  /<[｜|]\s*DSML\s*[｜|]\s*(?:invoke|function_calls|parameter)|<[｜|]tool[▁_ ]call/i

function validateModelRoundForLoop(input: {
  round: CompletionRound
  commandCompletionPending: boolean
  canRaiseOutputCap: boolean
}): void {
  if (input.round.refusal) return
  const structuredToolCalls = accumulateToolCalls(input.round.toolFragments)
  const recovered = extractTextToolCalls(input.round.text)
  const text = recovered.text.trim()
  const hasToolCalls =
    structuredToolCalls.length > 0 || recovered.toolCalls.length > 0
  // Cut off at the cap: ask the loop to re-issue the round with a higher cap.
  // Partial text isn't a usable answer either — it may be a tool call the
  // provider couldn't parse because it was truncated (nav-test-5: QA's final
  // "answer" was half a DSML exec_command, so the phase ended without a
  // proof). At the top step, fall through to the existing handling.
  if (
    input.round.finishReason === "length" &&
    input.canRaiseOutputCap &&
    !input.commandCompletionPending
  ) {
    throw new ModelResponseValidationError(
      "The model hit the output limit before finishing its response.",
      { retryable: false, outputLimit: true }
    )
  }
  // Tool-call markup that reached us as text (the provider didn't turn it into
  // a structured call) is a failed call, never a final answer.
  if (!hasToolCalls && UNPARSED_TOOL_CALL.test(input.round.text)) {
    const truncated = input.round.finishReason === "length"
    throw new ModelResponseValidationError(
      truncated
        ? "The model hit the output limit in the middle of a tool call."
        : "The model's tool call arrived as unparsed text instead of a tool call.",
      { retryable: !truncated }
    )
  }
  if (text || hasToolCalls || input.commandCompletionPending) return

  if (input.round.finishReason === "length") {
    throw new ModelResponseValidationError(
      "The model hit the output limit before returning a usable answer. Retry with a narrower request or a higher output cap.",
      { retryable: false }
    )
  }

  if (input.round.finishReason === "content_filter") {
    throw new ModelResponseValidationError(
      "The model response was blocked by a content filter before returning a usable answer.",
      { retryable: false }
    )
  }

  if (
    input.round.finishReason !== null &&
    input.round.finishReason !== "stop"
  ) {
    const finishReason = input.round.finishReason
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .slice(0, 80)
    throw new ModelResponseValidationError(
      `The model ended with unsupported finish reason "${finishReason}" before returning a usable answer.`,
      { retryable: false }
    )
  }

  throw new ModelResponseValidationError(
    "The model returned no usable answer. The turn ended before it could finish.",
    { retryable: true }
  )
}

function parseCommandSessionId(result: string): string | undefined {
  try {
    const parsed = JSON.parse(result) as { sessionId?: unknown }
    return typeof parsed.sessionId === "string" && parsed.sessionId
      ? parsed.sessionId
      : undefined
  } catch {
    return undefined
  }
}

function reconciledSideEffectingToolResult(input: {
  conversationId: string
  callId: string
  callName: string
  effects: ReturnType<typeof getToolEffects>
}): string | undefined {
  if (input.effects?.readOnly) return undefined
  const current = getToolCallLifecycle(input.conversationId, input.callId)
  if (!current) return undefined
  const prior = findPriorToolCallLifecycleByInvocation({
    conversationId: input.conversationId,
    invocationId: current.invocationId,
    excludeToolCallId: input.callId,
  })

  // An unresolved side effect still needs reconciliation across model rounds.
  // Check it before cached results so a later blocked retry cannot hide it.
  const unknown = prior.find(
    (row) => row.state === "unknown" || row.state === "started"
  )
  if (unknown) {
    return (
      `ERROR[tool_reconciliation_blocked]: an equivalent ${input.callName} ` +
      `invocation has an unknown outcome (${unknown.invocationId}). ` +
      "The operation was not retried to avoid duplicating side effects."
    )
  }

  // A later model request may intentionally repeat a command or edit the same
  // file. Only reuse a result within the original request, with identical tool
  // arguments: approval identities can omit payloads such as file contents.
  const callIdentity = normalizeToolCallIdentity({
    id: current.toolCallId,
    name: current.toolName,
    arguments: current.arguments,
  })
  const settled = prior.find(
    (row) =>
      (row.state === "settled_success" || row.state === "settled_error") &&
      row.logicalRoundId === current.logicalRoundId &&
      normalizeToolCallIdentity({
        id: row.toolCallId,
        name: row.toolName,
        arguments: row.arguments,
      }) === callIdentity
  )
  if (settled) {
    return (
      settled.result ??
      settled.error ??
      `ERROR[tool_reconciled]: equivalent ${input.callName} already settled.`
    )
  }

  return undefined
}

function reconcileSideEffectingToolAction(input: {
  conversationId: string
  callId: string
  callName: string
  action: ToolAction
  effects: ReturnType<typeof getToolEffects>
}): string | undefined {
  if (input.effects?.readOnly) return undefined
  const current = updateToolCallOperationIdentity({
    conversationId: input.conversationId,
    toolCallId: input.callId,
    identity: normalizeToolActionIdentity({
      kind: input.action.kind,
      identity: input.action.identity,
    }),
  })
  if (!current) return undefined
  return reconciledSideEffectingToolResult({
    conversationId: input.conversationId,
    callId: input.callId,
    callName: input.callName,
    effects: input.effects,
  })
}

// Streaming events emitted during a turn. `token` is a text delta to append to
// the assistant bubble; `tool` reports tool activity so the UI can show it. The
// tool-call `id` joins start↔done (and matches the persisted toolCallId), so the
// live markers render identically to the ones rebuilt from storage on reload.
export type ChatEvent =
  | { type: "command_output"; id: string; result: string }
  | { type: "steering_state"; state: SteeringState }
  | {
      type: "steering_delivered"
      id: string
      content: string
      createdAt: number
    }
  | { type: "token"; delta: string; attemptId?: string }
  // Model reasoning for the transcript, in the same attempt as its tokens: a
  // rolled-back attempt's reasoning is discarded with its text.
  | { type: "reasoning"; delta: string; attemptId?: string }
  | {
      type: "stream_attempt"
      phase: "start" | "commit" | "rollback"
      attemptId: string
      attempt?: number
      retrying?: boolean
    }
  | {
      type: "tool"
      phase: "start"
      id: string
      name: string
      arguments: string
    }
  | {
      type: "tool"
      phase: "done"
      id: string
      name: string
      result: string
      messageId?: string
      media?: import("../../shared/tool-media").ToolMediaReference[]
      artifact?: import("../../shared/conversation-artifacts").ArtifactReference
    }
  // The agent wants to perform a gated action and needs the human to decide.
  // `id` is the tool-call id so the renderer can attach the approval card to the
  // right tool marker; `requestId` is the process-unique token the renderer
  // echoes back to resolve this exact request. The turn pauses until then.
  | {
      type: "approval"
      id: string
      requestId: string
      tool: string
      summary: string
      reason: string
      // The action kind being approved. The renderer keys affordances off it —
      // e.g. a `delegate` approval (handing work to the background) omits the
      // "always allow in this workspace" button, since delegation is asked every
      // time. Optional so older persisted events without it still parse.
      kind?: ActionKind
      explicit?: boolean
      detail?: Record<string, unknown>
    }
  // The agent is asking the user clarifying questions (ask_user_question). `id`
  // is the tool-call id; `requestId` is the process-unique token the renderer
  // echoes back with the answers. The turn pauses until then.
  | {
      type: "question"
      id: string
      requestId: string
      questions: Question[]
    }
  // The backend changed the current turn's plan-mode state. The renderer uses
  // this confirmed event instead of optimistically clearing its toggle when the
  // approval answer is submitted.
  | { type: "plan_mode"; enabled: boolean }
  // The backend activated auto mode (present_plan approved with Auto mode).
  // The renderer uses this to switch its agentMode state to "auto".
  | { type: "auto_mode"; enabled: boolean }
  // The run is parked waiting for owned background command sessions to settle.
  // Stop remains available because this is still the same in-flight turn.
  | { type: "command_wait"; phase: "start" | "done"; sessionIds?: string[] }
  // The in-memory request was compacted mid-turn (plan 118). Tier 1 cleared
  // old tool results; tier 2 rebuilt it from a work-state summary.
  | { type: "context_compacted"; tier: 1 | 2; before: number; after: number }

type OnEvent = (event: ChatEvent) => void

// Options for the core agentic loop. The caller owns the AbortController and its
// registration/teardown, so the live `chat` path can key it by conversationId
// (see runChat) while the durable task runner keys it by taskId. runAgentLoop
// only reads `abort.signal`; it never registers or clears the controller.
export interface RunAgentLoopOptions {
  // The conversation this run belongs to. Messages are persisted under it and
  // prior history is replayed into the prompt via the ContextBuilder.
  conversationId: string
  // The directory the agent's filesystem tools are confined to. Optional: the
  // Chat view runs without a workspace and relies on inlined attachments.
  workspace?: string
  // Absolute host paths explicitly attached by the user, readable on demand.
  attachments?: string[]
  // Skill names explicitly selected by the user through slash mentions.
  skills?: string[]
  // A fresh user message to persist before the loop starts (a new turn). Omitted
  // when a durable task resumes — the loop continues from the already-persisted
  // transcript with no new user turn, since context is rebuilt from stored
  // messages each round.
  userMessage?: string
  // Validated user-clicked command; executed once before requesting a model reply.
  bashCommand?: string
  // Receives streamed tokens and tool activity. Defaults to a no-op so a
  // background task with no renderer attached still runs.
  onEvent?: OnEvent
  // The controller this run honors. Aborting it cancels the in-flight stream,
  // releases any pending approval/question gate, and unwinds the loop. The
  // caller registers and tears it down (this function never touches the
  // module-level abortControllers map).
  abort: AbortController
  // Hand work off to the durable task runner. Injected by the caller (runChat
  // and the runner's own runOne both bind it to the singleton's enqueue) rather
  // than imported — the agent module can't import the runner (the runner imports
  // it; that would be a cycle). Threaded into ToolContext so run_todos_in_background
  // can enqueue a `todo_run` task. Absent in contexts that can't delegate.
  enqueueTask?: EnqueueTask
  // Build the agent browser handle for this turn, bound to the turn's signal.
  // Injected by the caller (the main-process IPC handler owns the BrowserManager
  // singleton) rather than imported — same cycle-avoidance as enqueueTask. Absent
  // in contexts with no browser (e.g. the durable task runner, unit tests).
  provideBrowser?: (signal: AbortSignal) => BrowserHandle
  // The durable task this run belongs to, when driven by the runner's runOne.
  // Absent on the live `chat` path (which has no task). Used only to surface this
  // task's prior gate decisions in the approvals context section (plan 021) so a
  // resumed task doesn't re-request an already-decided action — advisory, never a
  // gate bypass.
  taskId?: string
  // Interactive chat (runChat) and the subagents it spawns, at any depth: put
  // the app's Python venv first on PATH for this turn's local commands, unless
  // the workspace has its own Python environment. Other background callers leaves it off, and so do subagents
  // spawned from them, since they inherit the parent's value.
  chatPythonVenv?: boolean
  // Start this turn in plan mode: the agent may read/search and write only its
  // plan file (write_plan), and must call present_plan for approval before it can
  // touch the workspace. Session-only (the renderer passes it per send; not
  // persisted). Ignored for chat mode. Flips off mid-turn when the user approves.
  planMode?: boolean
  // Start this turn in auto mode: ordinary require_approval gate decisions are
  // automatically approved so the agent acts without confirmation prompts.
  // Protected require_explicit_approval decisions are also approved: enabling
  // Auto mode is the user's run-level pre-approval.
  // Session-only. Honored in every mode including chat (chat's browser_navigate
  // is a require_approval action). Can also be activated mid-turn when the user
  // picks "Yes, approve and work in Auto mode" in the plan approval question.
  autoMode?: boolean
  // Whether this run may receive conversation delegation tools. `runChat` passes
  // the default-off user preference as a turn-start snapshot. Omitted means
  // enabled so independent callers preserve their semantics.
  conversationSubagentsEnabled?: boolean
  // Subagent-tree depth of this run: 0 for a top-level (user- or task-driven)
  // turn, incremented each time an agent spawns a child via spawn_subagent.
  // Bounds recursion (MAX_AGENT_DEPTH). Defaults to 0.
  agentDepth?: number
  // The chain of custom-agent names from the root of the subagent tree down to
  // (but not including) this run's own agent. Used to reject a spawn that would
  // re-enter an ancestor (cycle guard). Defaults to []. The spawn helper appends
  // the child's name when recursing.
  agentAncestors?: string[]
  // Explicit directory for DISCOVERING workspace-level custom agents, overriding
  // the derivation from the confinement workspace / conversation. Set by the
  // subagent spawn helper so a forked worker discovers agents from the same
  // directory as its parent (a Chat worker inherits neither a confinement
  // workspace nor the project link). Absent on top-level turns, which derive it.
  agentDir?: string
  completionInstruction?: string
  reportOnly?: boolean
  llmSelectionOverride?: LlmSelection
  agentNameOverride?: string | null
  // Additional caller-provided context, budgeted like other sections.
  extraContextSections?: ContextSection[]
  // Withhold the ask_user_question tool: this turn has NO interactive user to
  // answer a clarifying question, so offering the tool only lets the worker stall
  // until it's interrupted. Headless workers have no interactive event sink, unlike a durable task,
  // which surfaces the question in the activity panel. The worker proceeds on
  // reasonable assumptions instead (its kickoff frames the work as self-contained).
  suppressUserQuestions?: boolean
  unattended?: boolean
  // Child-run overrides used by conversation subagents. They are runtime-only:
  // ephemeral identities are never persisted as conversation agent names.
  agentOverride?: AgentDefinition | null
  childInstructionPrefix?: string
  allowedToolNames?: Set<string>
  // Offer only read-only tools (workflow step validation). CLI providers
  // cannot enforce this, so they refuse the turn instead.
  readOnlyTools?: boolean
  subagentRun?: boolean
  repositoryLeaseToken?: string
  beforeApproval?: (signal: AbortSignal) => Promise<() => void>
  onApprovalWaitingChange?: (waiting: boolean) => void
  registerAutoModeSetter?: (setter: (enabled: boolean) => void) => () => void
  receiveSteering?: boolean
  closeSteering?: () => void
}

// The on-disk directory associated with a conversation, used to discover
// workspace-level custom agents (<dir>/.github/agents, <dir>/.cowork/agents).
// Independent of the tool-confinement workspace: a Chat conversation runs with
// no confinement workspace but can still belong to a directory-backed project,
// and the user picks agents from that project's dirs. Resolution mirrors the
// renderer's `workspace` derivation: the conversation's own linked workspace
// first, then its project's default workspace. Returns undefined for a truly
// directory-less conversation (only user-level ~/.cowork/agents apply then).
function resolveConversationDir(
  conversation: Conversation | undefined
): string | undefined {
  if (!conversation) return undefined
  const own = workingDirectoryOf(conversation)
  if (own) return own
  if (conversation.projectId) {
    const project = getProject(conversation.projectId)
    if (project?.workspaceId) {
      const ws = getWorkspace(project.workspaceId)
      if (ws?.path) return ws.path
    }
  }
  return undefined
}

// The core agentic loop, shared by the live `chat` path (runChat) and the
// durable task runner. Runs the model→tools cycle for `conversationId`, confined
// to `workspace`, streaming through `onEvent` and persisting every turn (user,
// assistant, tool results) as it goes so the transcript is durable and
// resumable. Returns the final result object.
export async function runAgentLoop(
  opts: RunAgentLoopOptions
): Promise<ChatResult> {
  const {
    conversationId,
    workspace,
    attachments: initialAttachments,
    userMessage,
    abort,
    taskId,
    skills: selectedSkillNames,
  } = opts
  const attachments = [...(initialAttachments ?? [])]
  const onEvent: OnEvent = opts.onEvent ?? (() => {})
  const runId = randomUUID()
  const commandCompletionOwner: CommandCompletionOwner = {
    conversationId,
    workspace: workspace ?? "",
    runId,
  }

  // The workspace is optional. When provided it must be a real directory and
  // the agent's filesystem tools are confined to it; the Chat view sends no
  // workspace and relies on inlined attachments instead.
  const hasWorkspace = typeof workspace === "string" && workspace.length > 0
  if (hasWorkspace) {
    if (!isAbsolute(workspace!)) {
      const message = "A valid absolute workspace path is required."
      return {
        error: message,
        failure: agentFailure({
          code: "invalid_workspace",
          stage: "agent_setup",
          message,
          taskId,
        }),
      }
    }
    try {
      const info = await stat(workspace!)
      if (!info.isDirectory()) {
        const message = `Workspace is not a directory: ${workspace}`
        return {
          error: message,
          failure: agentFailure({
            code: "invalid_workspace",
            stage: "agent_setup",
            message,
            taskId,
          }),
        }
      }
    } catch {
      const message = `Workspace does not exist: ${workspace}`
      return {
        error: message,
        failure: agentFailure({
          code: "invalid_workspace",
          stage: "agent_setup",
          message,
          taskId,
        }),
      }
    }
  }

  // Load the conversation once, here: its `mode` selects the base system prompt,
  // gates the todo tool, names the selected custom agent, and is reused below for
  // the title check. Defaults to "chat" if missing.
  const conversation = getConversation(conversationId)

  // Autonomous CLI providers own their complete agent loop. Branch before
  // loading skills, tools, MCP, index context, approvals, or an Environment so
  // none of North Star's internal orchestration leaks into the external CLI.
  const defaultLlm = settingsService.getLlm()
  const effectiveAccountId =
    opts.llmSelectionOverride !== undefined
      ? (opts.llmSelectionOverride.accountId ?? defaultLlm.activeAccountId)
      : (conversation?.accountId ?? defaultLlm.activeAccountId)
  const effectiveAccount = effectiveAccountId
    ? getAccount(effectiveAccountId)
    : undefined
  if (
    effectiveAccount?.provider === "claude_code" ||
    effectiveAccount?.provider === "codex_cli"
  ) {
    if (attachments?.length)
      return { error: "Attachments are not supported by CLI providers." }
    if (opts.readOnlyTools)
      return { error: "Read-only turns are not supported by CLI providers." }
    if (opts.bashCommand)
      return { error: "Run code is unavailable for CLI providers." }
    if (!conversation) return { error: "Conversation not found." }
    if (!effectiveAccount.enabled) {
      const label =
        effectiveAccount.provider === "claude_code"
          ? "Claude Code"
          : "Codex CLI"
      return { error: `The selected ${label} provider is disabled.` }
    }
    // Built ONCE and shared by both runners. They previously took separate
    // object literals, and a bridge option added to one but not the other went
    // unnoticed (types can't catch it — every field here is optional).
    const cliTurn = {
      conversation,
      workspace,
      // Gates the MCP bridge's ask_user_question the same way it gates the
      // internal tool: a headless worker gets no question surface at all.
      suppressUserQuestions: opts.suppressUserQuestions,
      completionInstruction: opts.completionInstruction,
      reportOnly: opts.reportOnly,
      reportProvider: effectiveAccount.provider,
      // Lends the CLI North Star's browser over the bridge (plan 045).
      provideBrowser: opts.provideBrowser,
      // The CLI paths return before `agentDir` is resolved below, so scope their
      // memory the same way it would have been: confinement workspace, else the
      // conversation's own directory.
      memoryWorkspaceDir: hasWorkspace
        ? workspace
        : resolveConversationDir(conversation),
      userMessage,
      abort,
      onEvent,
    }
    const selection = opts.llmSelectionOverride ?? conversation
    const modelId =
      selection.modelId ??
      (selection.accountId === null ? defaultLlm.activeModelId : null)
    return effectiveAccount.provider === "claude_code"
      ? runClaudeConversation({
          ...cliTurn,
          model: normalizeClaudeModel(modelId),
        })
      : runCodexConversation({ ...cliTurn, model: modelId })
  }

  // The directory used to DISCOVER workspace-level agents (and the composer's
  // agent picker). This is intentionally NOT the tool-confinement `workspace`
  // (which Chat leaves undefined): a Chat conversation started inside a project
  // still has a directory — the project's — where <dir>/.github/agents and
  // <dir>/.cowork/agents live, and the user picked an agent from exactly that
  // list. So resolve the conversation's directory independently: the confinement
  // workspace if present, else the conversation's own linked workspace, else its
  // project's default workspace. Mirrors how the renderer derives its `workspace`
  // state (project dir → conversation workspace).
  const agentDir =
    opts.agentDir ??
    (hasWorkspace ? workspace : resolveConversationDir(conversation))

  // Resolve the selected custom "fleet" agent, if any. Its markdown body is
  // prepended to the mode prompt, and its frontmatter narrows the tools/skills
  // this turn is offered. Re-resolved from disk each turn (definitions are files,
  // not DB rows). Null (no selection, or the file vanished) → the built-in main
  // agent, exactly as before.
  const selectedAgentName =
    opts.agentNameOverride !== undefined
      ? opts.agentNameOverride
      : conversation?.agentName
  const agent =
    opts.agentOverride !== undefined
      ? opts.agentOverride
      : selectedAgentName
        ? await loadAgent(selectedAgentName, agentDir)
        : null
  const capabilityPolicy = agentCapabilityPolicy(agent)

  // Load skills (user → workspace, last-wins), then build the read_skill tool and
  // the Skills System prompt section. Only skill metadata enters the prompt;
  // bodies are fetched on demand via the tool. When a custom agent declares a
  // `skills` frontmatter, filter to its allowlist (tri-state: omitted → all;
  // [] → none; [list] → only those) before building the tool + prompt.
  const allSkills = await loadSkills(skillSources(agentDir))
  const skills = resolvePolicySkills(agent, allSkills, capabilityPolicy)
  const readSkillTool = createReadSkillTool(skills)
  const forcedSkills = forcedSkillNames(userMessage, selectedSkillNames)
  const availableSkillNames = new Set(skills.map((skill) => skill.name))
  const unknownSkill = forcedSkills.names.find(
    (name) => !availableSkillNames.has(name)
  )
  if (unknownSkill) {
    const available = [...availableSkillNames].join(", ") || "(none)"
    return {
      error: `No skill named "${unknownSkill}". Available skills: ${available}`,
    }
  }
  const skillResourceRoots: Record<string, string> = {}
  for (const name of forcedSkills.names) {
    const skill = skills.find((s) => s.name === name)
    if (skill) {
      registerSkillResourceRootInMap(skillResourceRoots, {
        name: skill.name,
        root: dirname(skill.path),
      })
    }
  }

  // Filesystem tools are confined to a workspace, so the full set is only
  // offered when one exists. A Chat session has no workspace; instead it offers
  // the read tools, scoped to the files the user attached (the attachment list
  // is the read allowlist — see read_file_tool's resolveReadable).
  const hasAttachments = !!attachments && attachments.length > 0

  // read_file_tool only handles UTF-8 text: on a PDF/DOCX/XLSX/PPTX/IPYNB/image
  // it fails with `binary` and points at read_document. So when an attachment is
  // one of those, read_document is offered alongside it — otherwise Chat hits a
  // dead end where the error names a tool that was never on the toolset. Both
  // resolve attachments through the same allowlist and read straight from the
  // host, so neither needs a workspace.
  const attachedDocuments = hasAttachments
    ? attachments!.filter((p) => supportedDocumentKind(p) !== null)
    : []
  const attachedTextFiles = hasAttachments
    ? attachments!.filter((p) => supportedDocumentKind(p) === null)
    : []

  // This conversation's LLM selection (provider account + model). Null fields
  // fall back to the global default inside resolveLlm, so a session that never
  // picked a model uses the default while one that did keeps its own.
  const llmSelection: LlmSelection = opts.llmSelectionOverride ?? {
    accountId: conversation?.accountId ?? null,
    modelId: conversation?.modelId ?? null,
  }

  // The todo tool is gated by mode, not workspace: chat is the tool-light mode
  // and doesn't get it; interactive/north_star do, with or without a workspace.
  const showTodos = conversation?.mode != null && conversation.mode !== "chat"

  // Plan mode (interactive/north_star only). MUTABLE: present_plan flips it off
  // mid-turn on approval, and the toolset + gate are re-evaluated each loop
  // iteration from this flag, so the same turn unlocks the filesystem tools once
  // the user approves. Ignored for chat (the tool-light mode).
  let planMode = !!opts.planMode && showTodos
  // Reads the live `planMode` closure var, so its verdict tracks a mid-turn
  // approval. Consulted before the shared PolicyEngine in the per-turn gate.
  const planModeClassifier = new PlanModeClassifier(() => planMode)

  // Auto mode: auto-approve human confirmations
  // (require_approval/require_explicit_approval → approved). Hard-blocks are
  // never bypassed. Enabling Auto mode is the user's run-level pre-approval, so
  // the user does not need to monitor an Auto-mode run for permission requests.
  // MUTABLE: present_plan can activate it mid-turn when the user picks "Yes,
  // approve and work in Auto mode".
  let autoMode = !!opts.autoMode
  const autoModeSubscribers = new Set<(enabled: boolean) => void>()
  // The turn-level auto-mode mutator: flips the live var and notifies the UI.
  // Shared by present_plan (via ctx.setAutoMode) and the mid-turn dropdown toggle
  // (via the autoModeSetters registry). The gate reads `autoMode` live, so both
  // paths take effect on the next gated action.
  const setAutoMode = (on: boolean) => {
    autoMode = on
    onEvent({ type: "auto_mode", enabled: on })
    for (const subscriber of autoModeSubscribers) subscriber(on)
  }
  const unregisterAutoModeSetter = opts.registerAutoModeSetter?.(setAutoMode)
  // Expose this turn's setter for the renderer's mid-turn Auto toggle, but only
  // for live turns (those with a renderer wired via provideBrowser). The durable
  // task runner and subagent spawns have no dropdown to toggle from, and keying
  // by conversation would let a background worker's entry clobber a live one.
  const isLiveTurn = !!opts.provideBrowser
  if (isLiveTurn) autoModeSetters.set(conversationId, setAutoMode)

  // Whether to surface the workspace index to the agent (plan 008/014): a
  // workspace-backed non-chat session with the "use index for context" setting on
  // and an index that actually exists (its own, or its main checkout's), so the
  // model is never offered a tool that can only answer "not indexed yet".
  // Gates BOTH the index_query_tool and the injected summary below.
  const indexWorkspacePath =
    showTodos &&
    conversation?.workspaceId &&
    settingsService.getIndexing().useIndexForContext
      ? getWorkspace(conversation.workspaceId)?.path
      : undefined
  const indexedWorkspace = indexWorkspacePath
    ? await indexedWorkspaceFor(indexWorkspacePath)
    : null
  const useIndex = !!indexedWorkspace

  // The agent browser is offered when the caller wired a provider (the live chat
  // path does; the durable task runner does not — a background task has no window
  // to drive). Bound to this turn's signal so Stop unwinds an in-flight browser op.
  const browser = opts.provideBrowser?.(abort.signal)

  // Custom-agent tool restriction. When the selected agent declares a `tools`
  // frontmatter, this is the set of internal tool names it may be offered (plus
  // the universal floor, handled in buildTools); null = no restriction (omitted
  // frontmatter → full mode-appropriate toolset). Computed once — it doesn't
  // change mid-turn like planMode does.
  const agentToolNames = capabilityPolicy ? null : agentToolAllowlist(agent)
  const externalToolAllowed = externalAgentToolFilter(
    capabilityPolicy,
    !!opts.suppressUserQuestions
  )

  // Subagent spawning. Live conversations and chat-originated background tasks
  // pass an explicit snapshot; independent callers omit
  // the flag and retain their authored delegation behavior. The remaining agent
  // policy and depth gates only narrow that capability further.
  const delegationEnabled = opts.conversationSubagentsEnabled !== false
  const canSpawn =
    delegationEnabled &&
    !opts.subagentRun &&
    !!agent &&
    (capabilityPolicy
      ? capabilityPolicy.children.kind !== "none"
      : agentToolsIncludeCategory(agent, "agent") &&
        agent.children !== undefined) &&
    (opts.agentDepth ?? 0) < MAX_AGENT_DEPTH
  let spawnableChildren: AgentDefinition[] = []
  if (canSpawn) {
    const loadable = await loadSpawnableAgents(agentDir)
    spawnableChildren = resolvePolicyChildren(
      agent!,
      loadable,
      capabilityPolicy
    )
  }
  const offerSpawn = canSpawn && spawnableChildren.length > 0
  // The built-in main agent always gets the batch tool. A custom parent gets it
  // only when its existing agent/children policy permits delegation.
  const offerSpawnBatch =
    delegationEnabled &&
    !opts.subagentRun &&
    (opts.agentDepth ?? 0) < MAX_AGENT_DEPTH &&
    (!agent || canSpawn)

  // MCP tools. Resolve which enabled servers this agent may use (its `mcpServers`
  // tri-state — omitted → all enabled; [] → none; [list] → only those), then ask
  // the pooled manager for their tool definitions, namespaced mcp__<server>__<tool>.
  // Governed separately from `agentToolNames` (which gates built-in categories);
  // an MCP-restricted agent still keeps its full built-in toolset and vice-versa.
  // Resilient: a server that fails to connect is skipped (logged), never aborting
  // the turn. Fetched ONCE here (a network round-trip can't run inside the sync
  // buildTools); inclusion is gated on !planMode there, so a plan approved
  // mid-turn regains MCP tools without a re-fetch.
  const mcpWorkspace = hasWorkspace ? workspace : undefined
  let mcpTools: McpToolDefinition[] = []
  {
    const enabledNames = await enabledServerNames(mcpWorkspace)
    const allowedNames = resolvePolicyMcpServers(
      agent,
      enabledNames,
      capabilityPolicy
    )
    if (allowedNames.length > 0) {
      mcpTools = await getMcpManager().listToolsFor(
        allowedNames,
        mcpWorkspace,
        (server, err) =>
          console.warn(
            `[mcp] server "${server}" unavailable this turn: ${err}`
          ),
        abort.signal
      )
    }
  }

  // Names of the filesystem-mutating workspace tools. In plan mode these are
  // dropped from the offered toolset (so the model can't call them) and also
  // hard-blocked at the gate (belt-and-suspenders); write_plan replaces them as
  // the only allowed write.
  const MUTATING_TOOL_NAMES = new Set([
    "write_file_tool",
    "edit_file_tool",
    "apply_patch_tool",
    "run_shell_tool",
    "exec_command",
    "write_stdin",
    "poll_command",
    "terminate_command",
  ])

  // Build the per-turn toolset from the CURRENT plan-mode flag. Recomputed each
  // loop iteration: when the user approves a plan mid-turn, planMode flips false
  // and the next model round-trip regains the full filesystem toolset.
  //
  // When a custom agent restricts tools (agentToolNames non-null), the offered
  // set is intersected against it AFTER the mode/plan gating — an agent can only
  // ever narrow, never widen (an agent granted `edit` in a bare Chat still gets
  // no filesystem tools; plan mode still drops mutating tools). Universal tools
  // (ask_user_question, read_skill, plan-mode handoff) bypass the allowlist.
  const applyAgentTools = <T extends { function: { name: string } }>(
    defs: T[]
  ): T[] => {
    if (opts.reportOnly) return []
    if (opts.unattended)
      defs = defs.filter(
        (d) =>
          ![
            "ask_user_question",
            "run_todos_in_background",
            "spawn_subagent",
            "spawn_subagents",
            "present_plan",
            "write_plan",
            "browser_handoff",
          ].includes(d.function.name)
      )
    const agentFiltered = externalToolAllowed
      ? defs.filter((d) => externalToolAllowed(d.function.name))
      : agentToolNames === null
        ? defs
        : defs.filter(
            (d) =>
              isUniversalTool(d.function.name) ||
              agentToolNames.has(d.function.name)
          )
    return agentFiltered.filter(
      (d) =>
        (!opts.allowedToolNames ||
          opts.allowedToolNames.has(d.function.name)) &&
        (!opts.readOnlyTools || isReadOnlyTool(d.function.name))
    )
  }
  const buildTools = () =>
    applyAgentTools([
      ...(hasWorkspace
        ? planMode
          ? toolDefinitions.filter(
              (d) => !MUTATING_TOOL_NAMES.has(d.function.name)
            )
          : toolDefinitions
        : [
            // Chat: read_file for attachments and skill:// resources, and the
            // command tools, which run in the conversation's scratch dir
            // (tools/chat_shell.ts).
            ...(attachments.length > 0 || skills.length > 0
              ? [readFileTool.definition]
              : []),
            ...(attachments.some((path) => supportedDocumentKind(path) !== null)
              ? [readDocumentTool.definition]
              : []),
            ...(planMode
              ? []
              : toolDefinitions.filter((d) =>
                  CHAT_SHELL_TOOL_NAMES.has(d.function.name)
                )),
          ]),
      ...(showTodos
        ? // run_todos_in_background delegates to a background writer, so it's
          // withheld in plan mode along with the direct FS tools.
          planMode
          ? [todoWriteTool.definition]
          : [todoWriteTool.definition, runTodosInBackgroundTool.definition]
        : []),
      ...(useIndex ? [indexQueryTool.definition] : []),
      ...(browser ? browserToolDefinitions : []),
      // Web tools are offered in every mode, independent of workspace/browser.
      // In plan mode, web_fetch remains behind its ordinary per-origin approval
      // gate; it researches external sources without mutating the workspace.
      webSearchDefinition,
      webFetchDefinition,
      // spawn_subagent: offered only when the agent+children gates pass and there
      // are children to spawn (offerSpawn). Withheld in plan mode like other
      // side-effecting tools. Not intersected away by the allowlist — offerSpawn
      // already required the `agent` category.
      ...(offerSpawn && !planMode ? [spawnSubagentTool.definition] : []),
      ...(offerSpawnBatch && !planMode ? [spawnSubagentsTool.definition] : []),
      // dashboard_write (plan 033.2): offered in interactive modes (like
      // todo_write), withheld in plan mode as a side-effecting save. Subject to
      // the agent tool allowlist via its `dashboard` category.
      ...(showTodos && !planMode ? [dashboardWriteTool.definition] : []),
      // Snapshots write conversation state, not workspace files. Native Chat
      // supports them too; read-only and custom-agent filters still apply.
      ...(!planMode
        ? [presentChartTool.definition, presentTableTool.definition]
        : []),
      // dashboard_read (plan 033.4): same modes as dashboard_write but kept in
      // plan mode — it only reads cached widget data. Subject to the allowlist
      // via the `dashboard` or `dashboard_read` category.
      ...(showTodos ? [dashboardReadTool.definition] : []),
      // Plan-mode tools: the only write (write_plan) + the approval handoff.
      ...(planMode
        ? [writePlanTool.definition, presentPlanTool.definition]
        : opts.subagentRun && opts.allowedToolNames?.has("write_plan")
          ? [writePlanTool.definition]
          : []),
      // read_plan: reads the conversation's own plan file (outside the workspace,
      // so read_file_tool can't). Offered whenever a plan CAN exist — both in
      // plan mode (re-read the draft) and after approval (consult it while
      // implementing). Withheld only where plans don't apply (Chat/subagents,
      // which have no conversationId path into a plan file anyway).
      ...(showTodos ? [readPlanTool.definition] : []),
      // ask_user_question is offered in every mode — clarification is universal —
      // EXCEPT a headless worker with no interactive user to answer.
      ...(opts.suppressUserQuestions ? [] : [askUserQuestionTool.definition]),
      readSkillTool.definition,
    ])
      .concat(
        // MCP tools bypass the built-in-category allowlist (applyAgentTools): MCP
        // access is governed by the agent's separate `mcpServers` field, already
        // resolved into `mcpTools`. Withheld in plan mode like spawn (a remote call
        // is a side effect); regained the moment a plan is approved.
        planMode ? [] : mcpTools
      )
      .map(withToolActivity)
  // The non-droppable base prompt (mode prompt). Everything else is a droppable
  // context SECTION handed to the ContextBuilder, which budgets + composes them
  // into the system block under one global budget with an explicit drop order
  // (plan 014). This replaces the previous pile of `systemPrompt +=` appends.
  //
  // A selected custom agent's markdown body is PREPENDED to the mode prompt (and
  // stays non-droppable): the agent's persona/instructions sit on top of ours so
  // they frame everything the model reads, without discarding the mode behavior.
  const modePrompt = await loadSystemPrompt(conversation?.mode)
  const baseSystemPrompt =
    (opts.childInstructionPrefix
      ? `${renderContextEnvelope(
          {
            trust: "approved_instruction",
            channel: "agent",
            source: "subagent_identity",
            persisted: true,
          },
          opts.childInstructionPrefix
        )}\n\n${modePrompt}`
      : agent
        ? `${renderContextEnvelope(
            {
              trust: "approved_instruction",
              channel: "agent",
              source: agent.name,
              persisted: true,
            },
            agent.body.trim()
          )}\n\n${modePrompt}`
        : modePrompt) +
    (opts.completionInstruction ? `\n\n${opts.completionInstruction}` : "")
  const sections: ContextSection[] = [...(opts.extraContextSections ?? [])]

  const chatVenvOverlay = opts.chatPythonVenv
    ? await resolveChatVenvOverlay(hasWorkspace ? workspace : undefined)
    : null
  if (chatVenvOverlay) {
    sections.push({
      name: "python_venv",
      priority: SECTION_PRIORITY.environment,
      content: CHAT_VENV_PROMPT,
      provenance: {
        trust: "system",
        channel: "runtime",
        source: "chat_python_venv",
      },
    })
  }

  // Environment orientation: date + model always, and (when a workspace exists)
  // platform + workspace path + a git block for a real repo. Assembled fresh each
  // turn from what's actually true — no git noise for a non-repo folder, no
  // workspace line in bare chat. Async (git shells out), so it's awaited here
  // before the synchronous ContextBuilder.build() below. Model label is resolved
  // best-effort from this conversation's selection (resolveLlm runs later).
  const envSection = await environmentSection({
    workspacePath: hasWorkspace ? workspace : undefined,
    llmSelection,
  })
  if (envSection) sections.push(envSection)

  // Agent-browser state: whenever the browser is wired this turn AND its tools
  // survived the agent allowlist, tell the model the authoritative current state
  // — the open page's URL, or that nothing is open. Always emitted (not gated on
  // a page being open): a page the user closed must produce an explicit "nothing
  // open", else the model reports the last page it remembers from the history as
  // if it were still open. state() is read-only and won't create a tab.
  if (
    browser &&
    buildTools().some((d) => d.function.name.startsWith("browser_"))
  ) {
    sections.push(browserStateSection(browser.state()))
  }

  if (agent && capabilityPolicy) {
    const capabilitySummary = agentCapabilitySummary(
      agent,
      capabilityPolicy,
      buildTools().map((d) => d.function.name)
    )
    if (capabilitySummary) {
      sections.push({
        name: "external_agent_capabilities",
        priority: SECTION_PRIORITY.skills,
        content: capabilitySummary,
        provenance: {
          trust: "system",
          channel: "runtime",
          source: "external_agent_capabilities",
        },
      })
    }
  }

  // Skills: the read_skill catalog. Kept longest under budget pressure (highest
  // priority) — dropping it would hide capabilities the agent is told it has.
  const skillsPrompt = buildSkillsPrompt(skills)
  if (skillsPrompt) {
    sections.push({
      name: "skills",
      priority: SECTION_PRIORITY.skills,
      content: skillsPrompt,
      provenance: {
        trust: "approved_instruction",
        channel: "skill",
        source: "skill_catalog",
        persisted: true,
      },
    })
  }
  const selectedSkills = skills.filter((s) =>
    forcedSkills.names.includes(s.name)
  )
  if (selectedSkills.length > 0) {
    sections.push({
      name: "selected_skills",
      priority: SECTION_PRIORITY.skills,
      content:
        "## User-selected skills\n" +
        "The user explicitly selected these skills with slash mentions. Treat them as activated for this turn; their bundled files are available as read-only skill resources:\n" +
        selectedSkills
          .map((s) => `- ${s.name}: skill://${s.name}/`)
          .join("\n") +
        "\nCall read_skill for full instructions if the selected skill instructions are not already in context.",
      provenance: {
        trust: "approved_instruction",
        channel: "skill",
        source: "selected_skills",
        persisted: true,
      },
    })
  }

  // Subagents: the catalog of child agents this agent may spawn (only present
  // when the spawn tool is offered). Same priority as skills — it advertises a
  // capability the agent is told it has, so it shouldn't be dropped while the
  // tool is on offer.
  if (offerSpawn) {
    const subagentsPrompt = buildSubagentsPrompt(spawnableChildren)
    if (subagentsPrompt) {
      sections.push({
        name: "subagents",
        priority: SECTION_PRIORITY.skills,
        content: subagentsPrompt,
        provenance: {
          trust: "approved_instruction",
          channel: "agent",
          source: "subagent_catalog",
          persisted: true,
        },
      })
    }
  }

  // Plan mode: the operating rules for a read-only planning turn. Highest
  // priority so it's never dropped while active. Note this reflects plan mode at
  // turn start; once the user approves mid-turn the tool result tells the model
  // to implement, and the withheld tools reappear.
  if (planMode) {
    sections.push({
      name: "plan_mode",
      priority: SECTION_PRIORITY.planMode,
      content: PLAN_MODE_PROMPT,
    })
  }

  // Rolling conversation summary (plan 019), read up front because its boundary
  // decides whether the todo list needs re-injecting (below).
  const summary = summarySection(conversationId)

  // Todo list: mode-gated, and injected only when the history being sent no
  // longer shows it — a summary replaced the todo_write calls, or the list was
  // seeded without one (a handed-off background task). Every successful
  // todo_write result carries the full list, so while one is still in history
  // the system-prompt copy would only repeat it, and each list change would
  // rewrite the prompt prefix: a full prompt-cache miss and dropped thinking on
  // the next turn.
  if (showTodos) {
    // On a genuine new user turn (not a durable-task resume, which passes no
    // userMessage), clear a FINISHED list so the next task plans from scratch.
    // Todos are scoped only by conversation, so without this a second task in the
    // same conversation would inherit the prior task's completed checkmarks. Only
    // clear when EVERY item is terminal (completed/cancelled) — an in-progress
    // multi-turn plan legitimately persists across turns and must survive.
    if (userMessage !== undefined) {
      const finished = listTodos(conversationId)
      if (isTodoListFinished(finished)) {
        // Record the finished list into History before clearing, so an inline
        // task (never handed to a background worker) leaves a visible record.
        // Self-sourced (source defaults to conversationId) + terminal status, so
        // the durable runner never queues it and the boot orphan-reaper leaves it
        // alone. The snapshot lives in `input`; the History viewer renders it as a
        // checklist (input.kind === "inline_todos").
        createTask({
          conversationId,
          status: "completed",
          title: finishedTodoTitle(finished),
          input: { kind: "inline_todos", todos: todoSeed(finished) },
        })
        replaceTodos(conversationId, [])
      }
    }
    const visible =
      summary?.replacesHistoryThrough === undefined
        ? listMessages(conversationId)
        : listMessagesAfterSeq(conversationId, summary.replacesHistoryThrough)
    const todoPrompt = todoListInHistory(visible)
      ? null
      : buildTodoListPrompt(listTodos(conversationId))
    if (todoPrompt) {
      sections.push({
        name: "todos",
        priority: SECTION_PRIORITY.todos,
        content: todoPrompt,
      })
    }
  }

  // Background task state: active durable tasks spawned from this session, so the
  // agent doesn't re-start work already running (plan 014).
  if (showTodos) {
    const taskSection = taskStateSection(conversationId)
    if (taskSection) sections.push(taskSection)
  }

  // Prior approvals (plan 021): durable "always allow" grants in scope + this
  // task's recent/pending gate decisions, so the agent doesn't re-ask for an
  // already-granted action or retry a denied one. Advisory only — the live gate
  // is still the authority. `workspace` is the path (matches allowlist scoping);
  // `taskId` is undefined on the live path, set by the runner. Returns null (no
  // block) for a bare turn with no grants and no task.
  if (showTodos) {
    const approvals = approvalsSection({
      conversationId,
      workspacePath: workspace,
      taskId,
    })
    if (approvals) sections.push(approvals)
  }

  // Rolling conversation summary (plan 019): a compact digest of earlier turns.
  // Generated out of band by the `summarize` task; its coverage boundary rides on
  // the section (`replacesHistoryThrough`) so the builder, which never drops it,
  // decides where verbatim history resumes.
  // Highest-priority section (last dropped). Conversation memory applies to
  // every mode, including Chat, independently of the available toolset.
  if (summary) sections.push(summary)

  // Workspace-index summary (plan 008): cheap structured orientation. Advisory,
  // most droppable. Gated by the "use index for context" setting + a workspace.
  if (indexedWorkspace) {
    // Summarize the main checkout when this workspace is an unindexed worktree.
    const indexSummary = buildIndexSummary(indexedWorkspace.workspace.id)
    if (indexSummary) {
      sections.push({
        name: "index",
        priority: SECTION_PRIORITY.index,
        content: indexSummary,
        provenance: {
          trust: "untrusted_data",
          channel: "file",
          source: "workspace_index_summary",
          persisted: true,
        },
      })
    }
  }

  // Before assembling context, repair any dangling tool-call tail from a turn
  // that was abandoned (the app quit, or a turn was left parked on an approval
  // gate, before its tool produced a result). Without this the rebuilt history
  // would carry an assistant tool_call with no matching `tool` message and the
  // next request would 400.
  //
  // The repair mode depends on the caller, distinguished by `userMessage`.
  // Durable-task resumes pass no userMessage ("carry on"), while live-chat turns
  // pass a fresh userMessage. Both modes now preserve the assistant tool-call
  // evidence and repair unanswered calls from durable lifecycle state; "rollback"
  // remains a compatibility spelling for task callers.
  repairDanglingToolCalls(
    conversationId,
    userMessage === undefined ? "rollback" : "synthesize"
  )

  // Persist this turn's user message before context is assembled (the
  // ContextBuilder replays from stored messages). A resuming durable task passes
  // no userMessage — the transcript already ends with the user turn — so we skip
  // the append and let the loop continue from stored history. List any attached
  // files by name (contents are NOT inlined: the model reads them on demand via
  // read_file_tool, scoped to this attachment list, which supports paging).
  let persistedUserContent: string | undefined
  let modelUserContent: string | undefined
  const turnUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  let hasTurnUsage = false
  // Visible prose this turn produced, kept outside the loop so the memory
  // recorder in `finally` can see it. The loop's own `text` is per-round and is
  // gone by the time an abort, a truncation, or a thrown error unwinds.
  let turnAssistantText = ""
  // A transient failure is re-run by the caller with the same user message.
  // Recording it would double the reference log and spend a second extraction
  // call on text the retry is about to record anyway.
  let turnWillRetry = false
  // Where this turn begins in the transcript.
  const turnStartSeq = getMaxMessageSeq(conversationId)
  if (userMessage !== undefined) {
    let userContent = userMessage || "What files are in the workspace?"
    let modelContent =
      forcedSkills.modelMessage !== undefined
        ? forcedSkills.modelMessage
        : userContent
    if (hasAttachments) {
      // Name the reader that actually works per file: read_file_tool is text-only,
      // so pointing it at an attached PDF/DOCX/etc. just burns a turn on a `binary`
      // error. Only non-empty groups are listed, so the all-text case (the common
      // one) still reads as a single list.
      const noteParts: string[] = []
      if (attachedTextFiles.length > 0) {
        noteParts.push(
          `read with read_file_tool: ${attachedTextFiles
            .map((p) => JSON.stringify(p))
            .join(", ")}`
        )
      }
      if (attachedDocuments.length > 0) {
        noteParts.push(
          `read with read_document: ${attachedDocuments
            .map((p) => JSON.stringify(p))
            .join(", ")}`
        )
      }
      const note = `Attached files (${noteParts.join("; ")})`
      userContent = userContent ? `${userContent}\n\n${note}` : note
      modelContent = modelContent ? `${modelContent}\n\n${note}` : note
    }
    persistedUserContent = userContent
    modelUserContent = modelContent
    // Persist the literal user text. A leading /skill command may be stripped
    // only in the in-memory model message below, after the history is rebuilt.
    appendMessage({ conversationId, role: "user", content: userContent })
  }

  // Assemble the prompt via the ContextBuilder: system prompt + the complete
  // stored transcript until summarization, or summary + complete uncovered tail
  // afterward. The array grows in-memory as the agent calls tools and we feed
  // results back; those turns are also persisted as they complete (below).
  // A text-only provider (account setting) gets no image parts: retained tool
  // images aren't replayed and tools fall back to text (no emitImage below).
  const acceptsImages = selectionAcceptsImages(llmSelection)
  const messages: any[] = contextBuilder.build(conversationId, {
    baseSystemPrompt,
    sections,
    tokenBudget:
      settingsService.getIndexing().summarizeTokenThreshold || undefined,
    images: acceptsImages,
  })
  if (
    modelUserContent !== undefined &&
    modelUserContent !== persistedUserContent
  ) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        messages[i] = { ...messages[i], content: modelUserContent }
        break
      }
    }
  }

  for (const name of forcedSkills.names) {
    const id = randomUUID()
    const args = JSON.stringify({ name })
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id,
          type: "function",
          function: {
            name: readSkillTool.definition.function.name,
            arguments: args,
          },
        },
      ],
    })
    const assistantMessage = appendMessage({
      conversationId,
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id,
          name: readSkillTool.definition.function.name,
          arguments: args,
        },
      ],
    })
    recordToolCallIntents({
      conversationId,
      assistantMessageId: assistantMessage.id,
      logicalRoundId: `forced-skill:${name}`,
      calls: [
        {
          id,
          name: readSkillTool.definition.function.name,
          arguments: args,
        },
      ],
    })
    markToolCallStarted({ conversationId, toolCallId: id })
    onEvent({
      type: "tool",
      phase: "start",
      id,
      name: readSkillTool.definition.function.name,
      arguments: args,
    })
    let result: string
    try {
      result = await readSkillTool.execute(
        { name },
        {
          workspace: workspace ?? "",
          attachments,
          conversationId,
          skillResourceRoots,
        }
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      markToolCallSettled({
        conversationId,
        toolCallId: id,
        state: "settled_error",
        error: message,
      })
      throw err
    }
    messages.push({ role: "tool", tool_call_id: id, content: result })
    appendMessage({
      conversationId,
      role: "tool",
      content: result,
      toolCallId: id,
      toolName: readSkillTool.definition.function.name,
    })
    markToolCallSettled({
      conversationId,
      toolCallId: id,
      state: isToolErrorResult(result) ? "settled_error" : "settled_success",
      result,
      error: isToolErrorResult(result) ? result : null,
    })
    onEvent({
      type: "tool",
      phase: "done",
      id,
      name: readSkillTool.definition.function.name,
      result,
    })
  }

  // Debug aid (settings.logSystemPrompt): dump the verbatim system block for this
  // turn to system-prompt-logs/. Best-effort and fire-and-forget — never blocks or
  // fails the turn. messages[0] is always the composed system message.
  if (settingsService.getIndexing().logSystemPrompt) {
    void logSystemPrompt(
      conversation?.mode ?? "chat",
      String(messages[0]?.content ?? "")
    )
  }

  // Build this turn's selected execution backend (host or container) up front.
  // Never silently substitute another backend: if the configured runtime is
  // unavailable, fail visibly so the user can start it or change the setting.
  // Chat sessions (no workspace) only use the local attachment path, so a plain
  // LocalEnvironment is enough there.
  // Resolve this conversation's LLM provider + model up front (its own selection,
  // or the default). A missing/incomplete provider config fails the turn cleanly
  // here (before any container spin-up) rather than mid-loop. The renderer gates
  // Send on hasActiveProvider, so this is the backstop for a stale selection.
  let llm: ReturnType<typeof resolveLlm>
  try {
    llm = resolveLlm(llmSelection)
  } catch (err) {
    if (err instanceof NoActiveProviderError) {
      return failTurn(conversationId, err.message)
    }
    throw err
  }

  let env: Environment
  // Whether this turn runs in an isolated container — gates the sandbox
  // auto-approve downgrade in the approval policy below.
  let sandboxed = false
  let localProfile: settingsService.LocalRuntimeProfile = "host-access"
  if (hasWorkspace) {
    try {
      const envConfig = settingsService.getExecutionConfig()
      sandboxed = envConfig.kind === "container"
      localProfile =
        envConfig.kind === "local"
          ? (envConfig.profile ?? "host-access")
          : "host-access"
      env = await createEnvironment(
        workspace!,
        conversationId,
        envConfig,
        chatVenvOverlay ?? undefined
      )
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return failTurn(
        conversationId,
        `Execution backend unavailable: ${detail}`,
        false,
        "execution_backend_unavailable"
      )
    }
  } else {
    env = new LocalEnvironment("", "host-access", {
      envOverlay: chatVenvOverlay ?? undefined,
    })
  }

  try {
    // Tracks whether any earlier turn already streamed visible text. The model
    // may emit a preamble ("Let me check…"), call a tool, then continue in a
    // new turn — we insert a paragraph break before the later turn's first
    // token so the two pieces don't run together in the bubble.
    let streamedText = false

    // Per-round context usage log (plan 108). Measurement only: it never
    // changes the request and never fails the turn.
    let modelRound = 0
    let compactionNote: ContextUsageEntry["compaction"] | null = null
    const logContextUsage = (input: {
      requestSize: RequestSize | null
      roundId: string
      attempt: number
      outcome: ContextUsageOutcome
      diagnostics: ModelResponseAttemptDiagnostics | null
      responseEstimate: number | null
      finishReason: string | null
    }) => {
      const size = input.requestSize
      if (!size) return
      try {
        const reported = input.diagnostics?.usage?.promptTokens ?? null
        void contextUsageLog.append({
          at: new Date().toISOString(),
          conversationId,
          taskId: taskId ?? null,
          agentDepth: opts.agentDepth ?? 0,
          turnStartSeq,
          round: modelRound,
          roundId: input.roundId,
          attempt: input.attempt,
          provider: llm.provider ?? null,
          accountId: llm.accountId,
          model: llm.model,
          mode: conversation?.mode ?? "chat",
          seat: null,
          request: {
            reported,
            cached: input.diagnostics?.usage?.cachedTokens ?? null,
            cacheWrite: input.diagnostics?.usage?.cacheWriteTokens ?? null,
            estimated: size.total,
            estimator: REQUEST_SIZE_ESTIMATOR,
            ratio:
              reported !== null && size.total > 0
                ? Math.round((reported / size.total) * 1000) / 1000
                : null,
            usageRequested: streamUsageRequested(llm),
            byRole: size.byRole,
            toolDefs: size.toolDefs,
            messageCount: size.messageCount,
            largest: size.largestMessage,
          },
          response: {
            reported: input.diagnostics?.usage?.completionTokens ?? null,
            estimated: input.responseEstimate,
            finishReason: input.finishReason,
          },
          outcome: input.outcome,
          ...(compactionNote ? { compaction: compactionNote } : {}),
        })
        compactionNote = null
      } catch (error) {
        console.warn("[ctx] context usage logging failed:", error)
      }
    }
    const executeCalls = async (
      toolCalls: ToolCallRecord[],
      text: string,
      logicalRoundId: string,
      offeredNames: Set<string>,
      carrier?: CompletionRound["nativeAssistant"],
      reasoning?: string
    ) => {
      // Record the assistant turn (text + the tool calls it requested) so the
      // follow-up request has the full context — both in-memory and persisted.
      messages.push({
        role: "assistant",
        content: text || null,
        [nativeAssistant]: carrier,
        tool_calls: toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: {
            name: c.name,
            arguments: replayToolCallArguments(c.arguments),
          },
        })),
      })
      const assistantMessage = appendMessage({
        conversationId,
        role: "assistant",
        content: text || null,
        nativeAssistant: carrier,
        reasoning,
        toolCalls: toolCalls.map((c) => ({
          id: c.id,
          name: c.name,
          arguments: c.arguments,
        })),
      })
      recordToolCallIntents({
        conversationId,
        assistantMessageId: assistantMessage.id,
        logicalRoundId,
        calls: toolCalls,
      })
      completeModelRequestRetryBudget({ conversationId, logicalRoundId })
      const effectsForCall = (name: string) => {
        if (name === readSkillTool.definition.function.name) {
          return TOOL_EFFECTS.readOnlySequential
        }
        return (
          mcpTools.find((tool) => tool.function.name === name)?.effects ??
          getToolEffects(name)
        )
      }

      // Execute requested tool calls in maximal consecutive batches. Only
      // workspace-confined read-only tools marked parallel-safe can overlap; all
      // mutations, browser actions, questions, approvals, shell calls,
      // delegation, web/MCP, and unannotated calls remain one-call barriers.
      const toolResults = await runToolCallBatches(toolCalls, {
        // Durable lifecycle evidence is keyed by call ID and written as soon as
        // each call settles. Repair can reconstruct an interrupted transcript
        // from it; ordered message projection need not wait to make results safe.
        onSettled: (settled) => {
          const { call } = settled
          // A cancelled approval wait has not authorized any backend work.
          if (
            settled.outcome === "unknown" &&
            getToolCallLifecycle(conversationId, call.id)?.state ===
              "waiting_for_approval"
          ) {
            settled.outcome = "not_started"
            settled.result =
              "Interrupted before tool execution started; re-request approval if still needed."
            settled.error = false
          }
          const { result, error, outcome } = settled
          if (outcome === "unknown") {
            markToolCallUnknown({
              conversationId,
              toolCallId: call.id,
              error: result,
            })
          } else if (outcome === "not_started") {
            markToolCallNotStarted({
              conversationId,
              toolCallId: call.id,
              result,
            })
          } else {
            const lifecycle = markToolCallSettled({
              images: settled.images,
              presentationArtifact: settled.presentationArtifact,
              conversationId,
              toolCallId: call.id,
              state:
                error || isToolErrorResult(result)
                  ? "settled_error"
                  : "settled_success",
              result,
              error: error || isToolErrorResult(result) ? result : null,
            })
            if (lifecycle?.result != null) settled.result = lifecycle.result
          }
        },
        onBatchSettled: (results) => {
          for (const { call, result } of results) {
            const storedResult = appendMessage({
              conversationId,
              role: "tool",
              content: result,
              toolCallId: call.id,
              toolName: call.name,
            })
            if (storedResult.media?.length || storedResult.artifact)
              onEvent({
                type: "tool",
                phase: "done",
                id: call.id,
                name: call.name,
                result,
                messageId: storedResult.id,
                media: storedResult.media,
                artifact: storedResult.artifact,
              })
            if (call.name === "exec_command") {
              const sessionId = parseCommandSessionId(result)
              if (sessionId) {
                commandCompletionInbox.markInitialResultPersisted(
                  commandCompletionOwner,
                  sessionId
                )
              }
            }
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: result,
            })
          }
        },
        policyFor: (call) => getToolExecutionPolicy(call.name),
        effectsFor: effectsForCall,
        onStart: (call) => {
          onEvent({
            type: "tool",
            phase: "start",
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          })
        },
        onDone: (call, result) =>
          onEvent({
            type: "tool",
            phase: "done",
            id: call.id,
            name: call.name,
            result,
          }),
        signal: abort.signal,
        execute: async (call, _index, callSignal) => {
          if (
            opts.unattended &&
            [
              "ask_user_question",
              "run_todos_in_background",
              "spawn_subagent",
              "spawn_subagents",
              "present_plan",
              "write_plan",
              "browser_handoff",
            ].includes(call.name)
          )
            return {
              result:
                "This tool is unavailable in an unattended workflow. Complete the current step directly or report the blocker.",
            }
          if (opts.reportOnly)
            return { result: "Tools are disabled for this report-only turn." }
          const persistLifecycle = <T>(action: () => T): T => {
            try {
              return action()
            } catch (error) {
              throw new ToolLifecycleError("result_persistence", call.id, error)
            }
          }
          persistLifecycle(() =>
            markToolCallStarted({ conversationId, toolCallId: call.id })
          )
          const callImages: ToolImage[] = []
          let presentationArtifact: ArtifactPresentation | undefined
          let acceptingImages = true
          const unavailable = unavailableToolResult(call.name, offeredNames)
          if (unavailable) return { result: unavailable }
          const reconciled = reconciledSideEffectingToolResult({
            conversationId,
            callId: call.id,
            callName: call.name,
            effects: effectsForCall(call.name),
          })
          if (
            reconciled !== undefined &&
            !["present_chart", "present_table"].includes(call.name)
          )
            return { result: reconciled }
          // The model's streamed tool-call arguments are occasionally malformed JSON
          // even when the turn wasn't length-truncated (a mid-stream glitch, or an
          // unescaped character in a large blob — e.g. a big write_file_tool payload).
          // (Concatenated JSON from providers that omit the streaming `index` is now
          // reassembled correctly upstream by accumulateToolCalls; this catch remains
          // as defense-in-depth for genuinely malformed/truncated arguments.)
          // A raw JSON.parse throw here would abort the whole turn as an opaque
          // "turn ended early: Unterminated string in JSON …". Instead, feed the tool
          // call a structured error result (with its tool_call_id, so the transcript
          // stays well-formed) and continue — the agent sees an actionable failure and
          // can retry the call with valid arguments (or chunk a large write).
          let args: Record<string, unknown>
          try {
            args = JSON.parse(call.arguments || "{}")
            const definition = buildTools().find(
              (tool) => tool.function.name === call.name
            )
            if (
              definition &&
              acceptsToolActivity(definition) &&
              args &&
              typeof args === "object" &&
              !Array.isArray(args)
            ) {
              args = executionArguments(args)
            }
          } catch {
            const errResult =
              "ERROR[bad_tool_arguments]: your tool-call arguments were not valid " +
              "JSON (often an unescaped character or an over-large value). Retry this " +
              "call with well-formed JSON; if a value is large, write it in smaller chunks."
            return { result: errResult }
          }
          // The approval gate for this tool call. `allow` and `hard_block` resolve
          // synchronously; approval decisions emit an event and block until the
          // renderer calls resolveApproval over IPC. The event carries the tool-
          // call `id` (so the renderer attaches the card to the right marker) and
          // a process-unique `requestId` keying the pending map — the renderer
          // echoes the latter back, so a decision can't resolve another turn's gate.
          let gatedResult: string | undefined
          const gate: Gate = async (action): Promise<GateOutcome> => {
            callSignal.throwIfAborted()
            const reconciled = reconcileSideEffectingToolAction({
              conversationId,
              callId: call.id,
              callName: call.name,
              action,
              effects: effectsForCall(call.name),
            })
            if (reconciled !== undefined) {
              gatedResult = reconciled
              return Promise.resolve("blocked")
            }
            // Plan mode hard-blocks workspace mutations regardless of the offered
            // toolset (belt-and-suspenders: the mutating tools are already withheld
            // from buildTools()). Reads the LIVE flag, so once a plan is approved
            // this stops blocking and the same turn can implement.
            const decision =
              planModeClassifier.classify(action) ??
              policy.decide(action, {
                workspacePath: workspace,
                conversationId,
                sandboxed,
                localProfile,
              })
            if (decision.level === "allow") return Promise.resolve("approved")
            if (decision.level === "hard_block") {
              gatedResult = `ERROR[blocked]: ${decision.reason}`
              return Promise.resolve("blocked")
            }
            const explicit = decision.level === "require_explicit_approval"
            // Plan mode retains explicit research approvals even if a stale or
            // mid-turn mode flag also says Auto. present_plan disables plan mode
            // before enabling Auto for implementation.
            if (autoMode && !planMode) return Promise.resolve("approved")
            const releaseApproval = opts.beforeApproval
              ? await opts.beforeApproval(callSignal)
              : undefined
            opts.onApprovalWaitingChange?.(true)
            const requestId = randomUUID()
            persistLifecycle(() =>
              markToolCallWaitingForApproval({
                conversationId,
                toolCallId: call.id,
              })
            )
            const approval = new Promise<GateOutcome>((resolve) => {
              const approvalTimeout = opts.subagentRun
                ? setTimeout(() => {
                    if (!pendingApprovals.delete(requestId)) return
                    gatedResult =
                      "ERROR[approval_timeout]: Child approval timed out."
                    resolve("denied")
                  }, CHILD_APPROVAL_TIMEOUT_MS)
                : undefined
              const resolvePending: PendingApproval["resolve"] = (outcome) => {
                if (approvalTimeout) clearTimeout(approvalTimeout)
                resolve(outcome)
              }
              pendingApprovals.set(requestId, {
                resolve: resolvePending,
                action,
                workspacePath: workspace,
                conversationId,
                explicit,
              })
              // If the turn is stopped while waiting on this approval, release the
              // gate (as a denial) so the loop can unwind instead of hanging — the
              // pre-PR2 "renderer disconnect hangs the gate" gap, closed by Stop.
              // EXCEPTION: an app-shutdown abort leaves the gate unresolved on
              // purpose — persisting a denial result here would record a decision
              // the user never made and wedge resume (plan 012). The process is
              // exiting anyway; the task stays waiting_for_approval and reconciles
              // to interrupted on next boot.
              callSignal.addEventListener(
                "abort",
                () => {
                  if (callSignal.reason === SHUTDOWN_ABORT_REASON) return
                  if (pendingApprovals.delete(requestId))
                    resolvePending("denied")
                },
                { once: true }
              )
            })
            // Register before announcing the request. Event handlers may enable
            // Auto synchronously; they must be able to resolve this exact gate.
            onEvent({
              type: "approval",
              id: call.id,
              requestId,
              tool: action.tool,
              summary: action.summary,
              reason: decision.reason,
              kind: action.kind,
              explicit,
              detail: action.detail,
            })
            return approval
              .then((outcome) => {
                callSignal.throwIfAborted()
                if (outcome === "approved") {
                  persistLifecycle(() =>
                    markToolCallStarted({ conversationId, toolCallId: call.id })
                  )
                }
                return outcome
              })
              .finally(() => {
                opts.onApprovalWaitingChange?.(false)
                releaseApproval?.()
              })
          }
          // The clarification prompt for ask_user_question. Emits a `question`
          // event and blocks until the renderer answers (chat:answer → resolveQuestion)
          // or the turn is stopped (resolves "cancelled" so the loop unwinds).
          const ask: Ask = (questions): Promise<AskResult> => {
            callSignal.throwIfAborted()
            return askUser({
              conversationId,
              toolCallId: call.id,
              questions,
              emit: onEvent,
              signal: callSignal,
            })
          }
          // read_skill ignores these fields. With a workspace, file tools confine
          // to it; without one, read_file_tool reads only the attached files.
          const leaseBlocker = hasWorkspace
            ? await repositoryDelegationLeases.blocker(
                workspace!,
                opts.repositoryLeaseToken
              )
            : undefined
          if (
            leaseBlocker &&
            effectsForCall(call.name)?.readOnly === false &&
            call.name !== "spawn_subagents"
          ) {
            return {
              result: `ERROR[repository_busy]: ${leaseBlocker.label}`,
            }
          }
          const ctx = {
            workspace: workspace ?? "",
            attachments,
            conversationId,
            invocationId: getToolCallLifecycle(conversationId, call.id)
              ?.invocationId,
            gate,
            ask,
            env,
            signal: callSignal,
            enqueueTask: opts.enqueueTask
              ? (
                  input: Parameters<NonNullable<typeof opts.enqueueTask>>[0]
                ) => {
                  callSignal.throwIfAborted()
                  return opts.enqueueTask!(
                    input,
                    opts.conversationSubagentsEnabled
                  )
                }
              : undefined,
            browser,
            emitImage: acceptsImages
              ? (image: ToolImage) => {
                  if (
                    acceptingImages &&
                    !callSignal.aborted &&
                    callImages.length <= 3
                  )
                    callImages.push({ ...image })
                }
              : undefined,
            emitCommandOutput: (result: string) => {
              onEvent({ type: "command_output", id: call.id, result })
            },
            emitArtifact: (snapshot: ArtifactPresentation) => {
              callSignal.throwIfAborted()
              if (
                !["present_chart", "present_table"].includes(call.name) ||
                presentationArtifact
              )
                throw new Error("Invalid chart emission")
              presentationArtifact = snapshot
            },
            skillResourceRoots,
            // present_plan calls this on approval; the selected backend is already
            // running, so the next loop iteration can safely unlock mutations.
            setPlanMode: (on: boolean) => {
              callSignal.throwIfAborted()
              planMode = on
              onEvent({ type: "plan_mode", enabled: on })
            },
            // present_plan calls this when the user picks "approve and Auto mode".
            // Shared with the mid-turn dropdown toggle (autoModeSetters registry).
            setAutoMode: (on: boolean) => {
              callSignal.throwIfAborted()
              setAutoMode(on)
            },
            isAutoMode: () => autoMode && !planMode,
            // Subagent spawning: wired only when the running agent may spawn, so
            // the tool reports "unavailable" otherwise (it's also not offered).
            // agentChildren is the authorization whitelist; depth/ancestors bound
            // recursion. The child's name is appended to the ancestor chain here.
            spawnSubagents: offerSpawnBatch
              ? (input: SpawnSubagentsInput) =>
                  spawnSubagentBatch({
                    input,
                    parentConversation: conversation,
                    parentWorkspace: hasWorkspace ? workspace : undefined,
                    agentDir,
                    parentAgent: agent,
                    parentToolNames: new Set(
                      buildTools().map((d) => d.function.name)
                    ),
                    skillResourceRoots,
                    parentSignal: callSignal,
                    parentChatPythonVenv: opts.chatPythonVenv,
                    parentAutoMode: autoMode,
                    subscribeParentAutoMode: (subscriber) => {
                      autoModeSubscribers.add(subscriber)
                      return () => autoModeSubscribers.delete(subscriber)
                    },
                    parentOnEvent: onEvent,
                    parentToolCallId: call.id,
                    depth: (opts.agentDepth ?? 0) + 1,
                    ancestors: [
                      ...(opts.agentAncestors ?? []),
                      ...(agent ? [agent.name] : []),
                    ],
                  })
              : undefined,
            planMode,
            writeSubagentsEnabled: hasWorkspace,
            repositoryLeaseToken: opts.repositoryLeaseToken,
            spawnSubagent: offerSpawn
              ? (input: { agentName: string; prompt: string }) =>
                  spawnSubagent({
                    agentName: input.agentName,
                    prompt: input.prompt,
                    parentWorkspace: hasWorkspace ? workspace : undefined,
                    // Children discover agents from the same directory as this run
                    // (Chat's project dir, not the confinement workspace).
                    agentDir,
                    parentConversation: conversation,
                    parentSignal: callSignal,
                    parentChatPythonVenv: opts.chatPythonVenv,
                    depth: (opts.agentDepth ?? 0) + 1,
                    ancestors: [
                      ...(opts.agentAncestors ?? []),
                      ...(agent ? [agent.name] : []),
                    ],
                  })
              : undefined,
            agentChildren: agent?.children,
            agentDepth: opts.agentDepth ?? 0,
            agentAncestors: opts.agentAncestors ?? [],
            commandCompletions: commandCompletionInbox,
            commandCompletionOwner,
          }
          // MCP tool calls (mcp__<server>__<tool>) route to the connection pool via
          // the manager, not the static tool registry. Gate first: calling a
          // third-party server is a side effect (kind "mcp"), so it prompts unless
          // auto mode, exactly like web_fetch. The identity is the prefixed name so an
          // "always allow" rule is scoped to that specific server tool.
          const mcpCall = parsePrefixedName(call.name)
          let result: string
          try {
            if (mcpCall) {
              const outcome = await gate({
                tool: call.name,
                kind: "mcp",
                summary: `Call ${mcpCall.serverName} · ${mcpCall.toolName}`,
                identity: call.name,
                detail: { server: mcpCall.serverName, tool: mcpCall.toolName },
              })
              result =
                outcome === "approved"
                  ? renderContextEnvelope(
                      {
                        trust: "untrusted_data",
                        channel: "mcp",
                        source: call.name,
                      },
                      await getMcpManager().callTool(
                        call.name,
                        args,
                        mcpWorkspace,
                        callSignal
                      )
                    )
                  : `ERROR[mcp]: the user ${
                      outcome === "blocked" ? "blocked" : "declined"
                    } the call to ${mcpCall.serverName} · ${mcpCall.toolName}.`
            } else {
              result =
                call.name === readSkillTool.definition.function.name
                  ? await readSkillTool.execute(args, ctx)
                  : !hasWorkspace && CHAT_SHELL_TOOL_NAMES.has(call.name)
                    ? await runChatShellTool(call.name, args, ctx)
                    : await runTool(call.name, args, ctx)
            }
            // Keep the actual gate result, including recovered successes and the
            // reason for a block, instead of a tool's generic blocked message.
            return {
              result: gatedResult ?? result,
              images: callImages,
              presentationArtifact,
            }
          } finally {
            acceptingImages = false
          }
        },
      })
      if (
        !abort.signal.aborted &&
        toolResults.some((result) => result.outcome === "unknown")
      ) {
        return false
      }
      const storedResults = listMessages(conversationId).filter(
        (message) =>
          message.role === "tool" &&
          toolCalls.some((call) => call.id === message.toolCallId)
      )
      messages.push(...replayToolMedia(storedResults))
      appendCommandCompletionEvents({
        conversationId,
        messages,
        owner: commandCompletionOwner,
        events: commandCompletionInbox.drain(commandCompletionOwner),
      })
      return true
    }
    if (opts.bashCommand) {
      const offered = offeredToolNames(buildTools())
      if (planMode || !offered.has("exec_command")) {
        return failTurn(
          conversationId,
          "Run code is unavailable in this agent or mode."
        )
      }
      const settled = await executeCalls(
        [
          {
            id: randomUUID(),
            name: "exec_command",
            arguments: JSON.stringify({
              command: opts.bashCommand,
              background: true,
            }),
          },
        ],
        "",
        `user-command:${runId}`,
        offered
      )
      if (!settled)
        return failTurn(
          conversationId,
          "A tool outcome is unknown. Reconcile its effects before continuing."
        )
      // A click authorizes only this script, not model-selected follow-up actions.
      opts.allowedToolNames = new Set(["wait_for_events"])
    }

    // Agentic loop: call the model, run any tools it asks for, repeat until the
    // model returns a turn with no tool calls (the final answer). No round-trip
    // cap — like Claude Code, we let the model run until it's done; multi-step
    // tasks (and the todo list that tracks them) need more than a handful of
    // steps. A turn ends only on a tool-free reply or a thrown error (caught
    // below and surfaced/persisted).
    if (opts.receiveSteering)
      validateSteeringWith(conversationId, (input) => {
        const selected = forcedSkillNames(input.message, input.skills)
        const unknown = selected.names.find(
          (name) => !availableSkillNames.has(name)
        )
        if (unknown)
          throw new Error(
            `No skill named "${unknown}" is available to this agent.`
          )
      })
    const deliverSteering = () =>
      opts.receiveSteering &&
      consumeSteering(conversationId, (message) => {
        for (const path of message.attachments)
          if (!attachments.includes(path)) attachments.push(path)
        const selected = forcedSkillNames(message.message, message.skills)
        for (const name of selected.names) {
          const skill = skills.find((item) => item.name === name)
          if (!skill)
            throw new Error(
              `No skill named "${name}" is available to this agent.`
            )
          registerSkillResourceRootInMap(skillResourceRoots, {
            name,
            root: dirname(skill.path),
          })
        }
        let content = message.message
        if (message.attachments.length)
          content += `\n\nAttached files: ${message.attachments.map((path) => `${JSON.stringify(path)} (read with ${supportedDocumentKind(path) ? "read_document" : "read_file_tool"})`).join(", ")}`
        const stored = appendMessage({ conversationId, role: "user", content })
        messages.push({
          role: "user",
          content:
            (selected.modelMessage ?? message.message) +
            content.slice(message.message.length) +
            (selected.names.length
              ? `\n\nUser-selected skills: ${selected.names.join(", ")}. Call read_skill for their full instructions before proceeding.`
              : ""),
        })
        persistedUserContent = [persistedUserContent, content]
          .filter(Boolean)
          .join("\n\n")
        onEvent({
          type: "steering_delivered",
          id: message.id,
          content,
          createdAt: stored.createdAt,
        })
      })
    // In-turn compaction (plan 118), at the round boundary: every result of
    // the previous round is persisted and no tool call is in flight. Changes
    // only the in-memory request. `force` (an overflow) skips the watermark.
    let compactFailedAt = 0
    // The last round's provider-reported input size and our estimate of it.
    let lastReported: { reported: number; estimate: number } | null = null
    const compactionMarks = () =>
      compactionWatermarks(
        settingsService.getIndexing().turnCompactionTokenThreshold,
        llm.provider
          ? contextWindowFor(llm.provider, llm.accountId, llm.model)
          : null
      )
    const compactRequest = async (
      tools: unknown[],
      force: boolean
    ): Promise<{ before: number; after: number } | null> => {
      const marks = compactionMarks()
      const tiers = compactionTiers(llm.provider)
      if (!marks || !(tiers.clear || tiers.rebuild)) return null
      const measured = measureRequest(messages, tools).total
      // Server-side clearing shrinks what the provider sees, not our estimate:
      // judge by the last reported size plus what was added since.
      const before =
        tiers.serverClear && !force
          ? lastReported
            ? lastReported.reported + (measured - lastReported.estimate)
            : 0
          : measured
      if (!force && before <= marks.high) return null
      let total = before
      if (tiers.clear) {
        // An overflow means the real limit is below the watermark: halve.
        const result = clearOldToolResults(messages, {
          total,
          target: force
            ? Math.min(marks.low, Math.floor(total / 2))
            : marks.low,
        })
        if (result.cleared > 0) {
          messages.splice(0, messages.length, ...result.messages)
          total = measureRequest(messages, tools).total
          compactionNote = {
            tier: 1,
            before,
            after: total,
            clearedResults: result.cleared,
          }
          onEvent({ type: "context_compacted", tier: 1, before, after: total })
          if (total <= marks.high || force) return { before, after: total }
        }
      }
      // Nothing to fold yet (a fresh first round): summarizing can't shrink it.
      if (
        !tiers.rebuild ||
        !turnCompactor ||
        !messages.some((m) => m?.role === "assistant")
      )
        return { before, after: total }
      // After a failed summary, wait for meaningful growth before retrying.
      if (!force && compactFailedAt && total < compactFailedAt * 1.25)
        return { before, after: total }
      if (!(await turnCompactor(conversationId, abort.signal))) {
        compactFailedAt = total
        return { before, after: total }
      }
      compactFailedAt = 0
      const turnMessages = listMessagesAfterSeq(conversationId, turnStartSeq)
      const earlierUser = listMessages(conversationId).filter(
        (m) => m.role === "user" && m.seq <= turnStartSeq
      )
      // A resumed or workflow turn's request was persisted before it began;
      // an unattended step also keeps its original step prompt.
      const opening = [
        ...(opts.unattended && earlierUser[0] ? [earlierUser[0]] : []),
        ...(userMessage === undefined && earlierUser.length
          ? [earlierUser[earlierUser.length - 1]]
          : []),
      ]
      const continuation = continuationMessage(
        pinnedInstructions(turnMessages, opening),
        buildWorkLedger(
          turnMessages,
          showTodos ? listTodos(conversationId) : []
        )
      )
      const pinned = measureRequest([continuation]).total
      if (pinned > marks.high)
        throw new ContextOverflowError(
          `This turn's instructions and work ledger alone (~${Math.round(pinned / 1000)}k tokens) exceed the compaction threshold (${Math.round(marks.high / 1000)}k). Raise the turn compaction threshold in Settings or use a larger-context model.`
        )
      // Refresh the summary and todo sections; everything else is unchanged.
      const freshSections = sections.filter(
        (section) => section.name !== "summary" && section.name !== "todos"
      )
      const todoPrompt = showTodos
        ? buildTodoListPrompt(listTodos(conversationId))
        : null
      if (todoPrompt)
        freshSections.push({
          name: "todos",
          priority: SECTION_PRIORITY.todos,
          content: todoPrompt,
        })
      const summary = summarySection(conversationId)
      if (summary) freshSections.push(summary)
      const rebuilt = [
        ...contextBuilder.build(conversationId, {
          baseSystemPrompt,
          sections: freshSections,
          tokenBudget:
            settingsService.getIndexing().summarizeTokenThreshold || undefined,
          images: acceptsImages,
        }),
        continuation,
      ]
      // The results the model asked for last round, shortened if needed.
      const round = latestRound(messages)
      const roundBudget =
        marks.high -
        measureRequest(rebuilt, tools).total -
        (round.length ? measureRequest(round.slice(0, 1)).total : 0)
      messages.splice(
        0,
        messages.length,
        ...rebuilt,
        ...clipToolResults(round, roundBudget)
      )
      const after = measureRequest(messages, tools).total
      compactionNote = {
        tier: 2,
        before,
        after,
        clearedResults: compactionNote?.clearedResults ?? 0,
        summaryCoversThrough: summary?.replacesHistoryThrough ?? null,
        pinnedTokens: pinned,
      }
      lastReported = null
      onEvent({ type: "context_compacted", tier: 2, before, after })
      return { before, after }
    }
    while (true) {
      // Stop pressed during the previous step's tool execution: break before
      // starting another model round-trip. (An abort mid-stream is caught by the
      // signal on create() below and handled in `catch`.)
      if (abort.signal.aborted) {
        appendMessage({
          conversationId,
          role: "assistant",
          content: stopNote(abort.signal),
        })
        return { stopped: true }
      }

      deliverSteering()
      // Notes that arrived mid-turn join before the next model round.
      for (const note of takeConversationNotes(conversationId)) {
        const content = `${note.source === "user" ? "Note from the user while you work" : "Note while you work"}:\n\n${note.body}`
        appendMessage({ conversationId, role: "user", content })
        messages.push({ role: "user", content })
      }
      // Recompute the toolset from the live plan-mode flag: an approval during
      // the previous iteration's present_plan call flips planMode off, so this
      // round-trip regains the full filesystem toolset.
      const tools = buildTools()
      const offeredNames = offeredToolNames(tools)
      const baseRoundId = `after-seq:${getMaxMessageSeq(conversationId)}`
      let logicalRoundId = baseRoundId
      let outputCap: number = MAX_OUTPUT_TOKENS
      // Each re-issue (a higher cap, a hung stream) gets a fresh logical id,
      // so its own transient-retry budget.
      let stalls = 0
      const roundId = () =>
        [
          baseRoundId,
          ...(outputCap > MAX_OUTPUT_TOKENS ? [`cap-${outputCap}`] : []),
          ...(stalls ? [`stall-${stalls}`] : []),
          ...(overflowCompacted ? ["compacted"] : []),
        ].join(":")
      // The current attempt's connection, so a hung one can be closed without
      // stopping the turn.
      const current: { abort: AbortController | null } = { abort: null }
      modelRound += 1
      await compactRequest(tools, false)
      let requestSize: RequestSize | null = null
      try {
        requestSize = measureRequest(messages, tools)
      } catch (error) {
        console.warn("[ctx] request measurement failed:", error)
      }
      // Never send a request known to exceed the model's window.
      const contextWindow = llm.provider
        ? contextWindowFor(llm.provider, llm.accountId, llm.model)
        : null
      if (requestSize && contextWindow && requestSize.total > contextWindow)
        throw overflowFailure(requestSize.total, contextWindow)
      let overflowCompacted = false
      // Only the Anthropic adapter takes the server-side clearing thresholds.
      const clearMarks = compactionTiers(llm.provider).serverClear
        ? compactionMarks()
        : null
      // The transport attempt in flight, and whether its line is written: a
      // rolled-back attempt logs itself; one that throws without a rollback
      // (an abort) is logged by the catch below.
      let attempt = 0
      let attemptLogged = false
      const logFailedAttempt = (error: unknown, retrying: boolean) => {
        attemptLogged = true
        logContextUsage({
          requestSize,
          roundId: logicalRoundId,
          attempt,
          outcome: abort.signal.aborted
            ? "aborted"
            : error instanceof StreamStalledError
              ? "stalled"
              : error instanceof ModelResponseValidationError &&
                  error.outputLimit
                ? "truncated"
                : retrying
                  ? "retry"
                  : "error",
          diagnostics:
            error instanceof ModelResponseValidationError
              ? (error.diagnostics ?? null)
              : null,
          responseEstimate: null,
          finishReason:
            error instanceof ModelResponseValidationError
              ? (error.diagnostics?.finishReason ?? null)
              : null,
        })
      }
      let round: CompletionRound
      for (;;) {
        const nextCap = nextOutputTokenCap(outputCap)
        try {
          round = await createCompletionRoundWithRetry({
            conversationId,
            logicalRoundId,
            signal: abort.signal,
            isTransientError,
            validateRound: (round) =>
              validateModelRoundForLoop({
                round,
                commandCompletionPending: commandCompletionInbox.hasPending(
                  commandCompletionOwner
                ),
                canRaiseOutputCap: nextCap !== null,
              }),
            requestIdentity: {
              accountId: llm.accountId,
              modelId: llm.model,
              apiMode: llm.apiMode,
            },
            recoverVisibleText: (rawText) => extractTextToolCalls(rawText).text,
            onAttemptEvent: (() => {
              let attemptText = ""
              let withheldText = false
              let visibleText = false
              return (event) => {
                if (event.type === "start") {
                  attempt = event.attempt
                  attemptLogged = false
                  attemptText = ""
                  withheldText = false
                  visibleText = false
                  onEvent({
                    type: "stream_attempt",
                    phase: "start",
                    attemptId: event.attemptId,
                    attempt: event.attempt,
                  })
                  return
                }
                if (event.type === "reasoning") {
                  onEvent({
                    type: "reasoning",
                    delta: event.delta,
                    attemptId: event.attemptId,
                  })
                  return
                }
                if (event.type === "text") {
                  attemptText += event.delta
                  const trimmed = attemptText.trimStart()
                  const mayBeTextToolCall =
                    !streamedText &&
                    ("[TOOL_CALL:".startsWith(trimmed) ||
                      trimmed.startsWith("[TOOL_CALL:"))
                  if (mayBeTextToolCall) {
                    withheldText = true
                    return
                  }
                  const visiblePiece = withheldText ? attemptText : event.delta
                  withheldText = false
                  if (!visibleText && streamedText) {
                    onEvent({
                      type: "token",
                      delta: "\n\n",
                      attemptId: event.attemptId,
                    })
                  }
                  visibleText = true
                  onEvent({
                    type: "token",
                    delta: visiblePiece,
                    attemptId: event.attemptId,
                  })
                  return
                }
                if (event.type === "commit") {
                  const recovered = extractTextToolCalls(attemptText)
                  if (
                    withheldText &&
                    recovered.toolCalls.length === 0 &&
                    recovered.text
                  ) {
                    if (streamedText) {
                      onEvent({
                        type: "token",
                        delta: "\n\n",
                        attemptId: event.attemptId,
                      })
                    }
                    onEvent({
                      type: "token",
                      delta: recovered.text,
                      attemptId: event.attemptId,
                    })
                    visibleText = true
                  }
                  streamedText ||= visibleText
                  onEvent({
                    type: "stream_attempt",
                    phase: "commit",
                    attemptId: event.attemptId,
                  })
                  return
                }
                logFailedAttempt(event.error, event.retrying)
                onEvent({
                  type: "stream_attempt",
                  phase: "rollback",
                  attemptId: event.attemptId,
                  retrying: event.retrying,
                })
              }
            })(),
            request: () => {
              const controller = new AbortController()
              if (abort.signal.aborted) controller.abort(abort.signal.reason)
              else
                abort.signal.addEventListener(
                  "abort",
                  () => controller.abort(abort.signal.reason),
                  { once: true }
                )
              current.abort = controller
              return withStreamUsage(llm, (streamOptions) =>
                createCompletion(
                  llm.client,
                  llm.model,
                  outputCap,
                  {
                    messages,
                    tools,
                    stream: true,
                    ...(streamOptions ? { stream_options: streamOptions } : {}),
                    // The composer's pick; only these adapters offer one.
                    ...(conversation?.effort &&
                    (llm.provider === "anthropic" ||
                      llm.provider === "codex_subscription")
                      ? { reasoning_effort: conversation.effort }
                      : {}),
                    ...(clearMarks
                      ? {
                          context_clearing: {
                            trigger: clearMarks.high,
                            clearAtLeast: clearMarks.high - clearMarks.low,
                          },
                        }
                      : {}),
                  },
                  [
                    undefined,
                    // The attempt's abort signal (chained to the turn's). On the
                    // OpenAI-backed path the SDK forwards it to fetch. On the
                    // Portkey path, breaking the iterator cancels the body.
                    { signal: controller.signal },
                  ],
                  llm.apiMode
                )
              )
            },
          })
          break
        } catch (error) {
          if (!attemptLogged) logFailedAttempt(error, false)
          if (error instanceof StreamStalledError && !abort.signal.aborted) {
            // Close the hung connection, then re-issue the round.
            current.abort?.abort(error)
            if (stalls < MAX_STREAM_STALLS) {
              stalls += 1
              logicalRoundId = roundId()
              continue
            }
          }
          const truncated =
            error instanceof ModelResponseValidationError && error.outputLimit
          if (truncated && nextCap !== null && !abort.signal.aborted) {
            // A fresh logical round id gives the re-issued round its own
            // transient-retry budget; the truncated one's budget is spent.
            outputCap = nextCap
            logicalRoundId = roundId()
            continue
          }
          // An overflow is never resent unchanged: compact once and retry
          // only if the request actually shrank.
          if (isContextOverflow(error) && !abort.signal.aborted) {
            const compacted = overflowCompacted
              ? null
              : await compactRequest(tools, true)
            overflowCompacted = true
            if (compacted && compacted.after < compacted.before) {
              requestSize = measureRequest(messages, tools)
              logicalRoundId = roundId()
              continue
            }
            throw overflowFailure(
              requestSize?.total ?? null,
              contextWindow,
              error
            )
          }
          if (outputCap > MAX_OUTPUT_TOKENS && rejectsOutputCap(error))
            throw new ModelResponseValidationError(
              "The model hit the output limit before returning a usable answer, and the provider rejected a higher output cap.",
              { retryable: false }
            )
          throw error
        }
      }

      // Reassemble the streamed turn only after the request has completed. Each
      // failed transport/stream attempt buffers and discards its partial text and
      // tool fragments, so a retry cannot execute an abandoned partial tool call
      // or duplicate partial prose in the live UI.
      const usage = round.diagnostics.usage
      // The provider cleared old tool results itself; show and log it like
      // our own tier 1.
      const serverCleared = usage?.contextCleared
      if (serverCleared && usage?.promptTokens !== undefined) {
        const before = usage.promptTokens + serverCleared.inputTokens
        compactionNote = {
          tier: 1,
          before,
          after: usage.promptTokens,
          clearedResults: serverCleared.toolUses,
          server: true,
        }
        onEvent({
          type: "context_compacted",
          tier: 1,
          before,
          after: usage.promptTokens,
        })
      }
      logContextUsage({
        requestSize,
        roundId: logicalRoundId,
        attempt,
        outcome: abort.signal.aborted
          ? "aborted"
          : round.finishReason === "length"
            ? "truncated"
            : "ok",
        diagnostics: round.diagnostics,
        responseEstimate: measureResponse(
          round.text,
          round.toolFragments.map((fragment) => ({
            name: fragment.function?.name ?? "",
            arguments: fragment.function?.arguments ?? "",
          }))
        ),
        finishReason: round.finishReason,
      })
      if (usage?.promptTokens && requestSize)
        lastReported = {
          reported: usage.promptTokens,
          estimate: requestSize.total,
        }
      if (usage) {
        hasTurnUsage = true
        turnUsage.promptTokens += usage.promptTokens ?? 0
        turnUsage.completionTokens += usage.completionTokens ?? 0
        turnUsage.totalTokens +=
          usage.totalTokens ??
          (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)
      }
      let text = round.text
      if (text) {
        turnAssistantText = turnAssistantText
          ? `${turnAssistantText}\n\n${text}`
          : text
      }
      const finishReason = round.finishReason

      // Stopped mid-stream (we broke out above): persist whatever text streamed
      // so far plus the stop note, and end the turn. Don't act on a partial
      // tool-call fragment.
      if (abort.signal.aborted) {
        appendMessage({
          conversationId,
          role: "assistant",
          content: text
            ? `${text}\n\n${stopNote(abort.signal)}`
            : stopNote(abort.signal),
          reasoning: round.reasoning,
        })
        return { stopped: true }
      }

      if (round.refusal) {
        appendMessage({
          conversationId,
          role: "assistant",
          content: text,
          nativeAssistant: round.nativeAssistant,
          reasoning: round.reasoning,
        })
        completeModelRequestRetryBudget({ conversationId, logicalRoundId })
        return { content: text, ...(hasTurnUsage ? { usage: turnUsage } : {}) }
      }

      const structuredToolCalls = accumulateToolCalls(round.toolFragments)
      const recovered = extractTextToolCalls(text)
      text = recovered.text
      const toolCalls = [...structuredToolCalls, ...recovered.toolCalls]
      // Text was already forwarded incrementally by onAttemptEvent. Tool-call
      // fragments remain buffered until this validated round reaches this point.

      // The turn hit the output-token ceiling. If it was cut off mid tool-call,
      // the accumulated arguments are partial/invalid JSON — parsing them below
      // throws a cryptic SyntaxError that surfaces as an opaque "turn ended early"
      // (the bug a large write_file_tool blob triggered). Fail cleanly and
      // retryably instead, with a message the agent/user can act on. A truncated
      // text-only answer falls through: its partial text is still usable.
      if (finishReason === "length" && toolCalls.length > 0) {
        const note =
          "The model's response was truncated before the tool call completed " +
          "(hit the output token limit). Retry with a smaller write, a chunked " +
          "file write, or a higher output cap."
        appendMessage({
          conversationId,
          role: "assistant",
          content: `⚠️ ${note}`,
        })
        exhaustModelRequestRetryBudget({
          conversationId,
          logicalRoundId,
          error: note,
        })
        return { error: note, retryable: false }
      }

      if (toolCalls.length === 0) {
        if (opts.receiveSteering) {
          if (
            steeringState(conversationId).messages.some(
              (message) => message.status === "queued"
            )
          ) {
            appendMessage({
              conversationId,
              role: "assistant",
              content: text,
              nativeAssistant: round.nativeAssistant,
              reasoning: round.reasoning,
            })
            messages.push({
              role: "assistant",
              content: text || null,
              [nativeAssistant]: round.nativeAssistant,
            })
            completeModelRequestRetryBudget({ conversationId, logicalRoundId })
            deliverSteering()
            continue
          }
        }
        if (commandCompletionInbox.hasPending(commandCompletionOwner)) {
          if (text.trim()) {
            appendMessage({
              conversationId,
              role: "assistant",
              content: text,
              nativeAssistant: round.nativeAssistant,
              reasoning: round.reasoning,
            })
          }
          completeModelRequestRetryBudget({ conversationId, logicalRoundId })
          onEvent({ type: "command_wait", phase: "start" })
          const waitAbort = new AbortController()
          const releaseWake = opts.receiveSteering
            ? setSteeringWake(conversationId, () => waitAbort.abort())
            : undefined
          try {
            await commandCompletionInbox.waitForEvent(commandCompletionOwner, {
              signal: AbortSignal.any([abort.signal, waitAbort.signal]),
            })
          } finally {
            releaseWake?.()
          }
          onEvent({ type: "command_wait", phase: "done" })
          if (abort.signal.aborted) {
            appendMessage({
              conversationId,
              role: "assistant",
              content: stopNote(abort.signal),
            })
            return { stopped: true }
          }
          appendCommandCompletionEvents({
            conversationId,
            messages,
            owner: commandCompletionOwner,
            events: commandCompletionInbox.drain(commandCompletionOwner),
          })
          continue
        }
        // No tool calls — this is the final answer. Persist it so the next turn
        // (and a reopened conversation) has the full transcript.
        appendMessage({
          conversationId,
          role: "assistant",
          content: text,
          nativeAssistant: round.nativeAssistant,
          reasoning: round.reasoning,
        })
        completeModelRequestRetryBudget({ conversationId, logicalRoundId })
        return {
          content: text,
          ...(hasTurnUsage ? { usage: turnUsage } : {}),
        }
      }

      if (
        !(await executeCalls(
          toolCalls,
          text,
          logicalRoundId,
          offeredNames,
          round.nativeAssistant,
          round.reasoning
        ))
      ) {
        return failTurn(
          conversationId,
          "A tool outcome is unknown. Reconcile its effects before continuing."
        )
      }
    }
  } catch (error) {
    // A user Stop aborts the in-flight stream, which surfaces here as an abort
    // error. That's a clean stop, not a failure: persist a neutral note (so the
    // transcript shows where it stopped) and return without an error banner.
    if (abort.signal.aborted && !(error instanceof ToolLifecycleError)) {
      appendMessage({
        conversationId,
        role: "assistant",
        content: stopNote(abort.signal),
      })
      return { stopped: true }
    }
    if (error instanceof ModelRequestRetryExhaustedError) {
      console.error("Model request retry budget exhausted:", error)
      turnWillRetry = error.retryable
      const failure = taskId
        ? agentFailure({
            code: "model_request_retry_exhausted",
            stage: "model_request",
            message: error.message,
            retryable: error.retryable,
            taskId,
            cause: error.name,
          })
        : undefined
      return failTurn(
        conversationId,
        error.message,
        error.retryable,
        undefined,
        failure
      )
    }
    console.error(
      "Agent loop failed:",
      error instanceof ToolLifecycleError
        ? { stage: error.stage, toolCallId: error.toolCallId }
        : error
    )
    const message = error instanceof Error ? error.message : "Request failed"
    const retryable =
      !(error instanceof ToolLifecycleError) && isTransientError(error)
    turnWillRetry = retryable
    const failure =
      error instanceof ToolLifecycleError || taskId
        ? agentFailure({
            toolCallId:
              error instanceof ToolLifecycleError
                ? error.toolCallId
                : undefined,
            code:
              error instanceof ToolLifecycleError
                ? "tool_lifecycle_failed"
                : retryable
                  ? "transient_model_request_failed"
                  : "model_request_failed",
            stage:
              error instanceof ToolLifecycleError
                ? error.stage
                : "model_request",
            message,
            retryable,
            taskId,
            cause: error instanceof Error ? error.name : null,
          })
        : undefined
    return failTurn(conversationId, message, retryable, undefined, failure)
  } finally {
    opts.closeSteering?.()
    // Record the turn for automatic memory on EVERY terminal path, not only the
    // clean final-answer one. Turns that end in a user stop, an output-cap
    // truncation, or a thrown model error still carry durable user-stated facts,
    // and previously contributed nothing at all — not even a reference log.
    // A resume passes no persistedUserContent. It is still recorded: the service
    // logs the turn to reference/ and skips extraction when there is no new user
    // message, so a durable task no longer runs for hours leaving no trace.
    if (!turnWillRetry && (opts.agentDepth ?? 0) === 0) {
      void recordMemoryTurn({
        conversationId,
        userText: persistedUserContent,
        assistantText: turnAssistantText,
        workspaceDir: agentDir,
      }).catch((err) => console.warn("[memory] turn record failed:", err))
    }
    if (abort.signal.aborted) {
      commandCompletionInbox.cancelRun(commandCompletionOwner)
      await terminateOwnedCommandSessions(commandCompletionOwner)
    } else {
      commandCompletionInbox.cleanupRun(commandCompletionOwner)
    }
    // Test sessions aren't tracked by the completion inbox, so the loop never
    // waits for them; end them with the run on every path.
    await terminateOwnedTestSessions(commandCompletionOwner)
    // Drop this turn's auto-mode setter (only live turns registered one). Guard
    // against a newer turn for the same conversation having replaced it.
    if (isLiveTurn && autoModeSetters.get(conversationId) === setAutoMode) {
      autoModeSetters.delete(conversationId)
    }
    unregisterAutoModeSetter?.()
    // Tear down this run's execution backend (stop+remove a container; no-op for
    // Local). Never let cleanup failure mask the run's real result. The abort
    // controller is owned by the caller (runChat / the task runner), so it's
    // their responsibility to release it.
    try {
      await env.dispose()
    } catch (err) {
      console.error("Environment dispose failed:", err)
    }
  }
}

// Runs the agentic loop for one new user message, confined to `workspace`.
// Streams tokens and tool activity through `onEvent`, and returns the final
// result object — IPC serializes it back to the renderer. This is the thin
// "live turn" wrapper around runAgentLoop: it persists the new user message,
// kicks off title generation, and owns the conversation-keyed AbortController so
// the Stop button (chat:stop → stopChat) can cancel it. A "live turn" is just a
// task with a renderer attached; the durable task runner calls runAgentLoop
const READ_ONLY_SUBAGENT_EXTRA_TOOLS = new Set([
  "read_skill",
  "read_plan",
  "write_plan",
])

function isReadOnlyTool(name: string): boolean {
  if (READ_ONLY_SUBAGENT_EXTRA_TOOLS.has(name)) return true
  return getToolEffects(name)?.readOnly === true && !name.startsWith("browser_")
}

function readOnlyChildTools(parentToolNames: Set<string>): Set<string> {
  return new Set([...parentToolNames].filter(isReadOnlyTool))
}

async function childInstructionResource(input: {
  uri?: string
  roots: Record<string, string>
}): Promise<string | undefined> {
  if (!input.uri) return undefined
  const path = await resolveSkillResourcePath(
    { workspace: "", skillResourceRoots: input.roots },
    input.uri
  )
  const info = await stat(path)
  if (!info.isFile()) throw new Error("instruction_uri must resolve to a file")
  if (info.size > 64 * 1024)
    throw new Error("instruction_uri exceeds the 64 KiB limit")
  return readFile(path, "utf8")
}

// A Chat command tool, run with its context rooted in the conversation's
// scratch dir (see tools/chat_shell.ts).
async function runChatShellTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  let shellCtx: ToolContext
  try {
    shellCtx = await chatShellContext(ctx)
  } catch (err) {
    return toolError(
      "no_workspace",
      err instanceof Error ? err.message : String(err)
    )
  }
  return runTool(name, args, shellCtx)
}

async function spawnSubagentBatch(input: {
  input: SpawnSubagentsInput
  parentConversation: Conversation | undefined
  parentWorkspace?: string
  agentDir?: string
  parentAgent: AgentDefinition | null
  parentToolNames: Set<string>
  skillResourceRoots: Record<string, string>
  parentSignal: AbortSignal
  // A chat's subagents share its Python venv; see RunAgentLoopOptions.
  parentChatPythonVenv?: boolean
  parentAutoMode: boolean
  subscribeParentAutoMode: (
    subscriber: (enabled: boolean) => void
  ) => () => void
  parentOnEvent: OnEvent
  parentToolCallId: string
  depth: number
  ancestors: string[]
}): Promise<SubagentResult[]> {
  // Resolve every identity and resource before creating records: validation is
  // whole-call atomic. Writer environment preflight below is subset-atomic.
  const resolved = await Promise.all(
    input.input.assignments.map(async (assignment) => {
      let agent: AgentDefinition | null = null
      let identity: string
      if (assignment.agent.type === "named") {
        agent = await loadSpawnableAgent(assignment.agent.name, input.agentDir)
        if (!agent)
          throw new Error(
            `Unknown or ineligible agent '${assignment.agent.name}'.`
          )
        if (
          input.parentAgent?.children?.length &&
          !input.parentAgent.children.includes(agent.name)
        )
          throw new Error(`Agent '${agent.name}' is not an allowed child.`)
        if (input.ancestors.includes(agent.name))
          throw new Error(
            `Agent '${agent.name}' would create a delegation cycle.`
          )
        identity = agent.body
      } else {
        identity =
          assignment.agent.profile === "clone" && input.parentAgent
            ? `${input.parentAgent.body}\n\n${ephemeralProfilePrompt("clone")}`
            : ephemeralProfilePrompt(assignment.agent.profile)
      }
      const instruction = await childInstructionResource({
        uri: assignment.instructionUri,
        roots: input.skillResourceRoots,
      })
      return {
        assignment,
        agent,
        instructions: composeSubagentInstructions({ identity, instruction }),
      }
    })
  )

  const writers = resolved.filter((item) => item.assignment.access === "write")
  let lease:
    | Awaited<ReturnType<typeof repositoryDelegationLeases.acquire>>
    | undefined
  let repo: Awaited<ReturnType<typeof preflightWriterRepository>> | undefined
  const worktrees = new Map<string, WriterWorktree>()
  const approvalCoordinator = new SubagentApprovalCoordinator()
  const autoModeRelay = new SubagentAutoModeRelay(
    input.parentAutoMode,
    approvePendingForConversation
  )
  const unsubscribeParentAutoMode = input.subscribeParentAutoMode((enabled) =>
    autoModeRelay.set(enabled)
  )
  let writerPreflightError: string | undefined
  if (writers.length > 0) {
    if (!input.parentWorkspace) {
      writerPreflightError =
        "Write subagents require a workspace-backed Git repository."
    } else {
      try {
        lease = await repositoryDelegationLeases.acquire(
          input.parentWorkspace,
          `Subagent batch ${writers.map((w) => w.assignment.id).join(", ")}`
        )
        repo = await preflightWriterRepository(input.parentWorkspace)
        if (
          listSubagentArtifacts({
            repositoryId: lease.repositoryId,
            unresolved: true,
          }).length > 0
        ) {
          throw new Error(
            "repository_quarantined: interrupted writer artifacts require review. Use the amber 'Subagent cleanup' control in the top bar before starting writers"
          )
        }
        for (const writer of writers) {
          worktrees.set(
            writer.assignment.id,
            await createWriterWorktree({
              root: repo.root,
              baseOid: repo.baseOid,
              lease,
              assignmentId: writer.assignment.id,
            })
          )
        }
      } catch (error) {
        writerPreflightError =
          error instanceof Error ? error.message : String(error)
        for (const worktree of worktrees.values()) {
          if (repo) await removeWriterWorktree(repo.root, worktree, true)
        }
        worktrees.clear()
        if (lease) repositoryDelegationLeases.release(lease)
        lease = undefined
      }
    }
  }

  const runChild = async (
    item: (typeof resolved)[number]
  ): Promise<SubagentResult> => {
    const { assignment, agent, instructions } = item
    const identity =
      assignment.agent.type === "named"
        ? assignment.agent.name
        : assignment.agent.profile
    if (assignment.access === "write" && writerPreflightError) {
      return {
        id: assignment.id,
        status: "failed",
        identity,
        access: assignment.access,
        error: `Writer preflight failed: ${writerPreflightError}. Do this work in the parent instead.`,
      }
    }
    const worktree = worktrees.get(assignment.id)
    const worker = createConversation({
      mode: input.parentConversation?.mode ?? "interactive",
      workspaceId: input.parentConversation?.workspaceId ?? null,
      workingDirectory: input.parentConversation?.workingDirectory ?? null,
      accountId: input.parentConversation?.accountId ?? null,
      modelId: input.parentConversation?.modelId ?? null,
      agentName: agent?.name ?? null,
      title: `${assignment.id}: ${assignment.prompt.slice(0, 48)}`,
    })
    const task = createTask({
      conversationId: worker.id,
      sourceConversationId: input.parentConversation?.id ?? worker.id,
      status: "running",
      title: assignment.id,
      input: {
        kind: "subagent",
        assignmentId: assignment.id,
        identity,
        access: assignment.access,
        baseOid: worktree?.baseOid,
        branch: worktree?.branch,
        worktreePath: worktree?.path,
        repositoryId: lease?.repositoryId,
      },
    })
    const executionConfig = settingsService.getExecutionConfig()
    const artifact =
      worktree && lease
        ? createSubagentArtifact({
            repositoryId: lease.repositoryId,
            sessionId: lease.sessionId,
            assignmentId: assignment.id,
            backend: executionConfig.kind,
            branch: worktree.branch,
            worktreePath: worktree.path,
            markerPath: worktree.markerPath,
            detail:
              executionConfig.kind === "container"
                ? {
                    runtime: executionConfig.runtime,
                    containerName: containerNameForConversation(worker.id),
                  }
                : undefined,
          })
        : undefined
    const childAbort = new AbortController()
    let timeout: NodeJS.Timeout | undefined
    let approvalWaiting = false
    const scheduleLeaseTimeout = () => {
      if (!lease || childAbort.signal.aborted) return
      if (timeout) clearTimeout(timeout)
      timeout = setTimeout(
        () => {
          const kind = repositoryDelegationLeases.timeoutKind(lease!)
          if (kind) childAbort.abort(new Error(`delegation_${kind}_timeout`))
          else scheduleLeaseTimeout()
        },
        repositoryDelegationLeases.nextTimeoutMs(lease) + 1
      )
    }
    if (lease) scheduleLeaseTimeout()
    else {
      timeout = setTimeout(
        () => childAbort.abort(new Error("delegation_active_timeout")),
        30 * 60_000
      )
    }
    const stop = () => childAbort.abort(input.parentSignal.reason)
    if (input.parentSignal.aborted) stop()
    else input.parentSignal.addEventListener("abort", stop, { once: true })
    const startedAt = Date.now()
    let preserveBranch = false
    try {
      const childTools =
        assignment.access === "read"
          ? readOnlyChildTools(input.parentToolNames)
          : new Set(
              [...input.parentToolNames].filter(
                (name) =>
                  !name.startsWith("browser_") &&
                  name !== "ask_user_question" &&
                  name !== "run_todos_in_background" &&
                  name !== "present_plan" &&
                  name !== "spawn_subagent" &&
                  name !== "spawn_subagents"
              )
            )
      if (
        assignment.agent.type === "ephemeral" &&
        assignment.agent.profile === "planner"
      ) {
        childTools.add("write_plan")
        childTools.add("read_plan")
      }
      const result = await runAgentLoop({
        conversationId: worker.id,
        workspace: worktree?.path ?? input.parentWorkspace,
        agentDir: input.agentDir,
        agentOverride: agent,
        childInstructionPrefix: instructions,
        allowedToolNames: childTools,
        userMessage: assignment.prompt,
        abort: childAbort,
        autoMode: input.parentAutoMode,
        registerAutoModeSetter: (setter) =>
          autoModeRelay.register(worker.id, setter),
        onEvent: (event) => {
          if (event.type === "approval") {
            input.parentOnEvent({ ...event, id: input.parentToolCallId })
          }
        },
        agentDepth: input.depth,
        agentAncestors: input.ancestors,
        suppressUserQuestions: true,
        subagentRun: true,
        chatPythonVenv: input.parentChatPythonVenv,
        repositoryLeaseToken: lease?.token,
        beforeApproval: (signal) => approvalCoordinator.acquire(signal),
        onApprovalWaitingChange: (waiting) => {
          if (approvalWaiting === waiting || !lease) return
          approvalWaiting = waiting
          if (waiting) repositoryDelegationLeases.pause(lease)
          else repositoryDelegationLeases.resume(lease)
          scheduleLeaseTimeout()
        },
      })
      if (result.stopped || childAbort.signal.aborted)
        throw new Error("child stopped")
      if (result.error) throw new Error(result.error)
      let handback:
        | Awaited<ReturnType<typeof collectWriterHandback>>
        | undefined
      let verdict: Awaited<ReturnType<typeof mergeability>> | undefined
      if (worktree && repo) {
        handback = await collectWriterHandback(repo.root, worktree)
        verdict = await mergeability(repo.root, repo.baseOid, worktree.branch)
        preserveBranch = true
      }
      const fullResult = {
        content: result.content ?? "",
        durationMs: Date.now() - startedAt,
        ...handback,
        mergeability: verdict,
        usage: result.usage,
      }
      updateTask(task.id, { status: "completed", result: fullResult })
      if (artifact) settleSubagentArtifact(artifact.id, "resolved", fullResult)
      return {
        id: assignment.id,
        status: "completed",
        identity,
        access: assignment.access,
        content: result.content ?? "",
        taskId: task.id,
        conversationId: worker.id,
        durationMs: fullResult.durationMs,
        usage: result.usage,
        branch: handback?.branch,
        commits: handback?.commits,
        touchedFiles: handback?.touchedFiles.slice(0, 50),
        touchedFileCount: handback?.touchedFiles.length,
        touchedFilesTruncated:
          (handback?.touchedFiles.length ?? 0) > 50 || undefined,
        mergeability: verdict?.status,
        conflictingPaths: verdict?.paths.slice(0, 50),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      updateTask(task.id, {
        status: childAbort.signal.aborted ? "cancelled" : "failed",
        error: message,
      })
      if (artifact) {
        settleSubagentArtifact(artifact.id, "resolved", { error: message })
      }
      return {
        id: assignment.id,
        status: childAbort.signal.aborted ? "stopped" : "failed",
        identity,
        access: assignment.access,
        error: message,
        taskId: task.id,
        conversationId: worker.id,
      }
    } finally {
      if (timeout) clearTimeout(timeout)
      if (approvalWaiting && lease) repositoryDelegationLeases.resume(lease)
      input.parentSignal.removeEventListener("abort", stop)
      if (worktree && repo) {
        await removeWriterWorktree(repo.root, worktree, !preserveBranch)
      }
    }
  }

  try {
    const results = await Promise.all(resolved.map(runChild))
    if (input.input.prepareIntegration && lease && repo) {
      const branches = results
        .filter(
          (result) =>
            result.access === "write" &&
            result.status === "completed" &&
            typeof result.branch === "string"
        )
        .map((result) => result.branch!)
      if (branches.length > 0) {
        const integration = await stageIntegrationBranch({
          root: repo.root,
          baseOid: repo.baseOid,
          branches,
          lease,
        })
        for (const result of results) {
          if (result.access !== "write" || result.status !== "completed")
            continue
          result.integrationStatus = integration.status
          result.integrationBranch = integration.branch
          result.integrationError = integration.error
          if (integration.paths.length > 0) {
            result.conflictingPaths = integration.paths.slice(0, 50)
          }
        }
      }
    }
    return results
  } finally {
    unsubscribeParentAutoMode()
    if (lease) repositoryDelegationLeases.release(lease)
  }
}

// Spawn a custom agent as a subagent and block for its final answer. Called
// (indirectly, via ctx.spawnSubagent) from the spawn_subagent tool, which has
// already enforced the depth/cycle/whitelist gates. Runs a NESTED runAgentLoop
// synchronously in a forked worker conversation — NOT the durable TaskRunner
// (which is fire-and-forget and can't return a specific task's result, and would
// deadlock under its concurrency cap on a blocking wait). The worker is stamped
// with the child agent's name so the nested loop resolves the child's prompt,
// tools, and skills; it's backed by a completed `subagent` task row so it stays
// out of the sidebar (listConversations hides task transcripts) and is reaped by
// the session-delete cascade. The child's controller is chained to the parent's
// signal, so a parent Stop unwinds the whole subtree.
async function spawnSubagent(input: {
  agentName: string
  prompt: string
  parentWorkspace?: string
  // Directory to discover the child (and its own children) from — the parent's
  // agent-discovery dir, which for a Chat parent is the project directory, not
  // the confinement workspace.
  agentDir?: string
  parentConversation: Conversation | undefined
  parentSignal: AbortSignal
  // A chat's subagents share its Python venv; see RunAgentLoopOptions.
  parentChatPythonVenv?: boolean
  depth: number
  ancestors: string[]
}): Promise<{ content?: string; error?: string; stopped?: boolean }> {
  // Resolve the child definition up front so an unknown name fails cleanly
  // without creating an orphan worker conversation. Discovery uses the parent's
  // agentDir (not the confinement workspace) so a Chat child is found too.
  const child = await loadSpawnableAgent(input.agentName, input.agentDir)
  if (!child) {
    return { error: `Unknown agent '${input.agentName}'.` }
  }

  // Fork a private worker conversation, inheriting the parent's execution context
  // (mode → tools/prompt gating, workspace, LLM selection) and stamped with the
  // child agent so the nested loop applies its prompt/tools/skills.
  const worker = createConversation({
    mode: input.parentConversation?.mode ?? "interactive",
    workspaceId: input.parentConversation?.workspaceId ?? null,
    workingDirectory: input.parentConversation?.workingDirectory ?? null,
    accountId: input.parentConversation?.accountId ?? null,
    modelId: input.parentConversation?.modelId ?? null,
    agentName: child.name,
    title: `${child.name}: ${input.prompt.slice(0, 48)}`,
  })
  // Back the worker with a task row so it's not listed as a standalone chat and
  // is cascade-deleted with its source session. Self-sourced when there's no live
  // parent conversation (headless), else linked back to the parent.
  createTask({
    conversationId: worker.id,
    sourceConversationId: input.parentConversation?.id ?? worker.id,
    status: "completed",
    title: child.name,
    input: { kind: "subagent", agentName: child.name },
  })

  // Chain the child's controller to the parent's signal so parent Stop / shutdown
  // unwinds the child too, preserving the shutdown-vs-stop distinction.
  const childAbort = new AbortController()
  if (input.parentSignal.aborted) childAbort.abort(input.parentSignal.reason)
  else
    input.parentSignal.addEventListener(
      "abort",
      () => childAbort.abort(input.parentSignal.reason),
      { once: true }
    )

  try {
    const result = await runAgentLoop({
      conversationId: worker.id,
      workspace: input.parentWorkspace,
      // Pass the discovery dir explicitly: the worker conversation carries no
      // project link and (for Chat) no confinement workspace, so it couldn't
      // re-derive it. This keeps the child's own agent + grandchildren resolvable.
      agentDir: input.agentDir,
      agentOverride: child,
      childInstructionPrefix: composeSubagentInstructions({
        identity: child.body,
      }),
      userMessage: input.prompt,
      abort: childAbort,
      // No renderer for the child — its transcript is still persisted durably.
      onEvent: () => {},
      agentDepth: input.depth,
      agentAncestors: input.ancestors,
      suppressUserQuestions: true,
      subagentRun: true,
      chatPythonVenv: input.parentChatPythonVenv,
    })
    if (result.stopped || childAbort.signal.aborted) return { stopped: true }
    if (result.error) return { error: result.error }
    return { content: result.content }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

// directly with its own task-keyed controller.
export async function runChat(
  {
    conversationId,
    message,
    workspace,
    attachments,
    skills,
    planMode,
    autoMode,
    bashBlock,
  }: ChatRequest,
  onEvent: OnEvent = () => {},
  // Lets a live interactive/north_star turn hand work off to the background via
  // run_todos_in_background. Injected by the main-process IPC handler (which owns
  // the TaskRunner singleton) so the agent module never imports the runner.
  enqueueTask?: EnqueueTask,
  // Builds the agent browser handle for the turn. Injected by the IPC handler
  // (which owns the BrowserManager singleton) — same cycle-avoidance as above.
  provideBrowser?: (signal: AbortSignal) => BrowserHandle
): Promise<ChatResult> {
  // Generate first-message metadata independently of the agent turn. Repository
  // change subscribers refresh the sidebar as soon as the title is committed.
  // The conditional write prevents a late result from replacing a title assigned
  // while generation was in flight.
  const conversation = getConversation(conversationId)
  let bashCommand: string | undefined
  if (bashBlock !== undefined) {
    if (!conversation || planMode || conversationTurnPending(conversationId)) {
      return { error: "Run code needs an idle conversation outside plan mode." }
    }
    if (
      typeof bashBlock?.messageId !== "string" ||
      !Number.isSafeInteger(bashBlock.offset) ||
      bashBlock.offset < 0
    ) {
      return { error: "Invalid Bash block request." }
    }
    const source = getMessage(bashBlock.messageId)
    if (
      source?.conversationId !== conversationId ||
      source.role !== "assistant"
    ) {
      return { error: "This Bash block does not belong to this conversation." }
    }
    try {
      bashCommand = await bashBlockCommand(
        source.content ?? "",
        bashBlock.offset
      )
      if (conversationTurnPending(conversationId))
        return { error: "This conversation is already running." }
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Invalid Bash block.",
      }
    }
    workspace =
      conversation.mode === "chat"
        ? undefined
        : workingDirectoryOf(conversation)
    if (conversation.mode !== "chat" && !workspace)
      return { error: "This conversation has no execution workspace." }
    message = `Run this Bash block and report the result. Do not retry it or execute additional commands.\n\n${bashCommand}`
  }
  if (conversation && !conversation.title && message.trim()) {
    void generateTitle(message)
      .then((title) => {
        setConversationTitleIfUntitled(conversationId, title)
      })
      .catch((err) => {
        console.error("conversation title persistence failed:", err)
      })
  }

  // Register the abort controller for this turn so the Stop button (chat:stop →
  // stopChat) can cancel it. One turn per conversation (the UI disables Send
  // while loading), so a plain Map keyed by conversation is enough.
  return serializeConversationTurn(conversationId, async () => {
    const abort = new AbortController()
    abortControllers.set(conversationId, abort)
    const accountId =
      conversation?.accountId ?? settingsService.getLlm().activeAccountId
    const provider = accountId ? getAccount(accountId)?.provider : undefined
    const closeSteering =
      provider !== "claude_code" && provider !== "codex_cli" && !bashCommand
        ? openSteering(conversationId, randomUUID(), (state) =>
            onEvent({ type: "steering_state", state })
          )
        : undefined
    try {
      return await runAgentLoop({
        conversationId,
        workspace,
        attachments,
        skills,
        userMessage: message,
        receiveSteering: !!closeSteering,
        closeSteering,
        bashCommand,
        planMode,
        autoMode,
        // Snapshot the opt-in at turn start.
        conversationSubagentsEnabled:
          settingsService.getConversations().allowConversationSubagents,
        chatPythonVenv: true,
        onEvent,
        abort,
        enqueueTask,
        provideBrowser,
      })
    } finally {
      closeSteering?.()
      // Release this turn's abort controller (only if it's still the current one —
      // defensive against a future overlapping turn replacing it).
      if (abortControllers.get(conversationId) === abort) {
        abortControllers.delete(conversationId)
      }
    }
  })
}

export function runCompletionReport(
  conversationId: string,
  instruction: string,
  fallback: string,
  onEvent?: (event: ChatEvent) => void,
  onStarted?: () => void
): Promise<ChatResult> {
  return serializeConversationTurn(conversationId, async () => {
    if (!getConversation(conversationId)) return { stopped: true }
    const abort = new AbortController()
    abortControllers.set(conversationId, abort)
    try {
      onStarted?.()
      const result = await runAgentLoop({
        conversationId,
        abort,
        onEvent,
        reportOnly: true,
        userMessage: "Write the background task completion report now.",
        completionInstruction: instruction,
        allowedToolNames: new Set(),
        suppressUserQuestions: true,
        conversationSubagentsEnabled: false,
      })
      if (
        !result.stopped &&
        (result.error || !result.content?.trim()) &&
        getConversation(conversationId)
      ) {
        appendMessage({ conversationId, role: "assistant", content: fallback })
      }
      return result
    } finally {
      if (abortControllers.get(conversationId) === abort)
        abortControllers.delete(conversationId)
    }
  })
}

import { randomUUID } from "crypto"
import { stat } from "fs/promises"
import { basename, isAbsolute } from "path"
import {
  toolDefinitions,
  browserToolDefinitions,
  webSearchDefinition,
  webFetchDefinition,
  runTool,
  todoWriteTool,
  askUserQuestionTool,
  runTodosInBackgroundTool,
  indexQueryTool,
  writePlanTool,
  readPlanTool,
  presentPlanTool,
} from "./tools"
import type { BrowserHandle } from "../browser/manager"
import type { ToolImage } from "./tools/types"
import { readFileTool } from "./tools/read_file_tool"
import {
  listTodos,
  replaceTodos,
  isTodoListFinished,
} from "../db/repositories/todos"
import { createTask } from "../db/repositories/tasks"
import { todoSeed, finishedTodoTitle } from "../tasks/todo-run"
import { buildTodoListPrompt } from "./todo-prompt"
import { loadSkills } from "./skills/loader"
import { buildSkillsPrompt } from "./skills/prompt"
import { createReadSkillTool } from "./skills/tool"
import { skillSources } from "./skills/sources"
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
import { spawnSubagentTool } from "./tools/spawn_subagent"
import { flagForReworkTool } from "./tools/flag_for_rework"
import { loadSystemPrompt } from "./system-prompt"
import { logSystemPrompt } from "./prompt-log"
import { buildIndexSummary } from "../index/summary"
import {
  contextBuilder,
  SECTION_PRIORITY,
  type ContextSection,
} from "./context/context-builder"
import {
  taskStateSection,
  approvalsSection,
  summarySection,
  environmentSection,
} from "./context/sections"
import { repairDanglingToolCalls } from "./repair"
import { createEnvironment } from "./env"
import { LocalEnvironment } from "./env/local"
import type { Environment } from "./env/types"
import * as settingsService from "../settings/service"
import {
  resolveLlm,
  createCompletion,
  isTransientError,
  NoActiveProviderError,
  type LlmSelection,
} from "./providers"
import { appendMessage } from "../db/repositories/messages"
import {
  getConversation,
  createConversation,
  updateConversation,
} from "../db/repositories/conversations"
import { actionAllowlist } from "../db/repositories"
import { getWorkspace } from "../db/repositories/workspaces"
import { getProject } from "../db/repositories/projects"
import type { Conversation } from "../db/types"
import {
  PolicyEngine,
  type AllowlistLookup,
  type SandboxPolicyLookup,
} from "./approval/policy"
import { RegexCommandClassifier } from "./approval/regex-classifier"
import { FileActionClassifier } from "./approval/file-classifier"
import { DelegationClassifier } from "./approval/delegation-classifier"
import { BrowserActionClassifier } from "./approval/browser-classifier"
import { WebActionClassifier } from "./approval/web-classifier"
import { PlanModeClassifier } from "./approval/plan-mode-classifier"
import type {
  ActionKind,
  Gate,
  GateOutcome,
  ToolAction,
} from "./approval/types"
import type {
  Ask,
  AskResult,
  EnqueueTask,
  Question,
  QuestionAnswer,
} from "./tools/types"

// The single approval policy, shared across turns. The allowlist lookup is
// backed by the action_allowlist table; classifiers are tried in order (file
// first since it returns null for shell, then the regex command classifier).
const allowlistLookup: AllowlistLookup = {
  isAllowed(action: ToolAction, ctx) {
    return !!actionAllowlist.findMatch(action.kind, action.identity, {
      workspacePath: ctx.workspacePath,
      conversationId: ctx.conversationId,
    })
  },
}
// The sandbox policy reads live settings at decision time (like the file
// classifier), so a settings change takes effect on the next action without
// rebuilding the engine.
const sandboxPolicy: SandboxPolicyLookup = {
  autoApproves(category) {
    return settingsService.sandboxAutoApproves(category)
  },
}
const policy = new PolicyEngine(
  [
    // Delegation first: a `delegate` action always requires approval and is never
    // sandbox-downgraded or allowlisted (no category), so classify it before the
    // file/shell classifiers (which return null for it anyway).
    new DelegationClassifier(),
    // Browser navigation always prompts (no category → never sandbox-downgraded);
    // returns null for non-browser kinds, so placement is flexible.
    new BrowserActionClassifier(),
    // web_fetch always prompts (no category → never sandbox-downgraded), like
    // browser navigation; returns null for non-web kinds.
    new WebActionClassifier(),
    new FileActionClassifier(() => settingsService.getPermissions()),
    new RegexCommandClassifier(),
  ],
  allowlistLookup,
  sandboxPolicy
)

// Decision for one pending approval, set by resolveApproval and awaited inside
// the gate. `remember` persists an allowlist rule when the human chose "always".
interface PendingApproval {
  resolve: (decision: "approved" | "denied") => void
  action: ToolAction
  workspacePath?: string
  conversationId?: string
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
export const SHUTDOWN_ABORT_REASON = Symbol("agent:shutdown")

// Max output tokens per model turn. The agent emits tool calls whose arguments
// can be large (e.g. write_file_tool inlines a whole file as a JSON blob), so a
// low cap truncates the response mid-tool-call — the streamed arguments arrive as
// invalid JSON. 1024 was far too low for a file-writing agent; 8192 covers normal
// writes. A turn that still hits the ceiling is detected via finish_reason below
// and surfaced as a clean, retryable error rather than a cryptic JSON parse throw.
const MAX_OUTPUT_TOKENS = 8192

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
  // matching just in case. No `remember` — Auto is a session stance, not a rule.
  for (const [requestId, pending] of pendingApprovals) {
    if (pending.conversationId === conversationId) {
      resolveApproval(requestId, "approved")
    }
  }
}

// Called from the renderer over IPC ("chat:approve") to resolve a request the
// gate is blocked on. `requestId` is a process-unique token (not the model's
// tool-call id, which is only unique within a turn) so a decision can never
// resolve a different conversation's pending gate. On "approved" with a
// `remember` scope, the action is persisted to the allowlist so identical future
// actions skip the prompt — `"workspace"` for every conversation in this folder,
// `"conversation"` for just this session.
export function resolveApproval(
  requestId: string,
  decision: "approved" | "denied",
  remember?: "workspace" | "conversation"
): void {
  const pending = pendingApprovals.get(requestId)
  if (!pending) return
  pendingApprovals.delete(requestId)
  if (
    decision === "approved" &&
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
  }
  pending.resolve(decision)
}

// One pending ask_user_question round-trip, awaited inside the `ask` function.
// Keyed by a process-unique requestId so an answer can't resolve another turn's
// question (mirrors pendingApprovals).
const pendingQuestions = new Map<string, (result: AskResult) => void>()

// Called from the renderer over IPC ("chat:answer") to deliver the user's
// answers to a pending ask_user_question. No-op if the request is gone (already
// answered or the turn was stopped).
export function resolveQuestion(
  requestId: string,
  answers: QuestionAnswer[]
): void {
  const resolve = pendingQuestions.get(requestId)
  if (!resolve) return
  pendingQuestions.delete(requestId)
  resolve({ status: "answered", answers })
}

export interface ChatRequest {
  // The conversation this turn belongs to. Messages are persisted under it and
  // prior history is replayed into the prompt via the ContextBuilder.
  conversationId: string
  message: string
  // The directory the agent's filesystem tools are confined to. Optional: the
  // Chat view runs without a workspace and relies on inlined attachments.
  workspace?: string
  // Absolute paths of files to inline into the prompt (Chat view attachments).
  attachments?: string[]
  // Start this turn in plan mode (interactive/north_star only). See
  // RunAgentLoopOptions.planMode.
  planMode?: boolean
  // Start this turn in auto mode (any mode, including chat). See
  // RunAgentLoopOptions.autoMode.
  autoMode?: boolean
}

// A trimmed snippet of the first user message — the fallback title when the
// LLM-generated title request fails.
function titleFromMessage(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ")
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed
}

export interface ChatResult {
  content?: string
  error?: string
  // Stable code for renderer actions that should not depend on parsing the
  // human-readable error text.
  errorCode?: "execution_backend_unavailable"
  // True when the turn was cancelled by the user's Stop button (a clean stop,
  // not an error). The "⏹ Stopped by user." note is already persisted.
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
  errorCode?: ChatResult["errorCode"]
): ChatResult {
  appendMessage({
    conversationId,
    role: "assistant",
    content: `⚠️ The turn ended early: ${message}`,
  })
  return { error: message, retryable, errorCode }
}

// Streaming events emitted during a turn. `token` is a text delta to append to
// the assistant bubble; `tool` reports tool activity so the UI can show it. The
// tool-call `id` joins start↔done (and matches the persisted toolCallId), so the
// live markers render identically to the ones rebuilt from storage on reload.
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

type OnEvent = (event: ChatEvent) => void

// Normalize a content value (string or array of parts) to plain text.
function contentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) =>
        typeof part === "string" ? part : (part?.text ?? "")
      )
      .join("")
  }
  return ""
}

// Ask the model for a short (5-6 word) title summarizing the user's first
// message. Non-streaming and capped low so it's cheap. Falls back to a trimmed
// snippet on any failure so a conversation always gets a title.
export async function generateTitle(
  message: string,
  sel: LlmSelection
): Promise<string> {
  const fallback = titleFromMessage(message)
  try {
    const { client, model, apiMode } = resolveLlm(sel)
    const res = await createCompletion(
      client,
      model,
      32,
      {
        messages: [
          {
            role: "system",
            content:
              "You write short conversation titles. Given a user's first message, reply " +
              "with a 3-6 word title that summarizes its topic. Output ONLY the title " +
              "text: no quotes, no punctuation at the end, no preamble, and never answer " +
              "or respond to the message itself.",
          },
          // Delimit the message as quoted input with an explicit "Title:" cue so
          // the model titles it rather than answering it.
          {
            role: "user",
            content: `First message:\n"""\n${message}\n"""\n\nTitle:`,
          },
        ],
      },
      [],
      apiMode
    )
    const text = contentToText((res as any).choices?.[0]?.message?.content)
      .trim()
      .replace(/^["']|["']$/g, "")
      .replace(/[.\s]+$/, "")
    return text || fallback
  } catch (error) {
    console.error("Title generation failed:", error)
    return fallback
  }
}

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
  // Absolute paths of files to inline into the prompt (Chat view attachments).
  attachments?: string[]
  // A fresh user message to persist before the loop starts (a new turn). Omitted
  // when a durable task resumes — the loop continues from the already-persisted
  // transcript with no new user turn, since context is rebuilt from stored
  // messages each round.
  userMessage?: string
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
  // Start this turn in plan mode: the agent may read/search and write only its
  // plan file (write_plan), and must call present_plan for approval before it can
  // touch the workspace. Session-only (the renderer passes it per send; not
  // persisted). Ignored for chat mode. Flips off mid-turn when the user approves.
  planMode?: boolean
  // Start this turn in auto mode: all require_approval gate decisions are
  // automatically approved so the agent acts without confirmation prompts.
  // Session-only. Honored in every mode including chat (chat's browser_navigate
  // is a require_approval action). Can also be activated mid-turn when the user
  // picks "Yes, approve and work in Auto mode" in the plan approval question.
  autoMode?: boolean
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
  // Process phase context (plan 031.2): set only when this turn is a Process phase
  // worker (makeRunPhase). Threaded into ToolContext so flag_for_rework can reach
  // the run's graph + record a durable cross-phase rework flag. Absent otherwise.
  processRunId?: string
  processPhaseRunId?: string
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
  if (conversation.workspaceId) {
    const ws = getWorkspace(conversation.workspaceId)
    if (ws?.path) return ws.path
  }
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
  const { conversationId, workspace, attachments, userMessage, abort, taskId } =
    opts
  const onEvent: OnEvent = opts.onEvent ?? (() => {})

  // The workspace is optional. When provided it must be a real directory and
  // the agent's filesystem tools are confined to it; the Chat view sends no
  // workspace and relies on inlined attachments instead.
  const hasWorkspace = typeof workspace === "string" && workspace.length > 0
  if (hasWorkspace) {
    if (!isAbsolute(workspace!)) {
      return { error: "A valid absolute workspace path is required." }
    }
    try {
      const info = await stat(workspace!)
      if (!info.isDirectory()) {
        return { error: `Workspace is not a directory: ${workspace}` }
      }
    } catch {
      return { error: `Workspace does not exist: ${workspace}` }
    }
  }

  // Load the conversation once, here: its `mode` selects the base system prompt,
  // gates the todo tool, names the selected custom agent, and is reused below for
  // the title check. Defaults to "chat" if missing.
  const conversation = getConversation(conversationId)

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
  const agent = conversation?.agentName
    ? await loadAgent(conversation.agentName, agentDir)
    : null

  // Load skills (user → workspace, last-wins), then build the read_skill tool and
  // the Skills System prompt section. Only skill metadata enters the prompt;
  // bodies are fetched on demand via the tool. When a custom agent declares a
  // `skills` frontmatter, filter to its allowlist (tri-state: omitted → all;
  // [] → none; [list] → only those) before building the tool + prompt.
  const allSkills = await loadSkills(
    skillSources(hasWorkspace ? workspace : undefined)
  )
  const skills =
    agent?.skills === undefined
      ? allSkills
      : allSkills.filter((s) => agent.skills!.includes(s.name))
  const readSkillTool = createReadSkillTool(skills)

  // Filesystem tools are confined to a workspace, so the full set is only
  // offered when one exists. A Chat session has no workspace; instead it offers
  // just read_file_tool, scoped to the files the user attached (the attachment
  // list is the read allowlist — see read_file_tool's resolveReadable).
  const hasAttachments = !!attachments && attachments.length > 0

  // This conversation's LLM selection (provider account + model). Null fields
  // fall back to the global default inside resolveLlm, so a session that never
  // picked a model uses the default while one that did keeps its own.
  const llmSelection: LlmSelection = {
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

  // Auto mode: auto-approve any action that would otherwise require human
  // confirmation (require_approval → approved). Hard-blocks from classifiers
  // (e.g. plan-mode) are never bypassed. MUTABLE: present_plan can activate it
  // mid-turn when the user picks "Yes, approve and work in Auto mode". Available
  // in every mode including chat — unlike plan mode it doesn't depend on the
  // workspace toolset; chat's browser_navigate is a require_approval action auto
  // mode suppresses too. The renderer only sends autoMode where a mode toggle is
  // offered, so it's honored verbatim here.
  let autoMode = !!opts.autoMode
  // The turn-level auto-mode mutator: flips the live var and notifies the UI.
  // Shared by present_plan (via ctx.setAutoMode) and the mid-turn dropdown toggle
  // (via the autoModeSetters registry). The gate reads `autoMode` live, so both
  // paths take effect on the next gated action.
  const setAutoMode = (on: boolean) => {
    autoMode = on
    onEvent({ type: "auto_mode", enabled: on })
  }
  // Expose this turn's setter for the renderer's mid-turn Auto toggle, but only
  // for live turns (those with a renderer wired via provideBrowser). The durable
  // task runner and subagent spawns have no dropdown to toggle from, and keying
  // by conversation would let a background worker's entry clobber a live one.
  const isLiveTurn = !!opts.provideBrowser
  if (isLiveTurn) autoModeSetters.set(conversationId, setAutoMode)

  // Whether to surface the workspace index to the agent (plan 008/014): a
  // workspace-backed non-chat session with the "use index for context" setting on.
  // Gates BOTH the index_query_tool and the injected summary below.
  const useIndex =
    showTodos &&
    !!conversation?.workspaceId &&
    settingsService.getIndexing().useIndexForContext

  // The agent browser is offered when the caller wired a provider (the live chat
  // path does; the durable task runner does not — a background task has no window
  // to drive). Bound to this turn's signal so Stop unwinds an in-flight browser op.
  const browser = opts.provideBrowser?.(abort.signal)

  // Custom-agent tool restriction. When the selected agent declares a `tools`
  // frontmatter, this is the set of internal tool names it may be offered (plus
  // the universal floor, handled in buildTools); null = no restriction (omitted
  // frontmatter → full mode-appropriate toolset). Computed once — it doesn't
  // change mid-turn like planMode does.
  const agentToolNames = agentToolAllowlist(agent)

  // Subagent spawning. The spawn_subagent tool is offered only when BOTH gates
  // pass: the agent's `tools` includes the `agent` category AND its `children`
  // key is present (tri-state: omitted → cannot spawn even with the category;
  // [] → any loadable agent; [list] → only those). Resolve the concrete set of
  // spawnable child definitions now, both to gate the offering and to list them
  // in the Subagents prompt section. Depth is also a gate: a run already at the
  // max depth can't offer the tool (its children could never spawn anyway).
  const canSpawn =
    !!agent &&
    agentToolsIncludeCategory(agent, "agent") &&
    agent.children !== undefined &&
    (opts.agentDepth ?? 0) < MAX_AGENT_DEPTH
  let spawnableChildren: AgentDefinition[] = []
  if (canSpawn) {
    const loadable = await loadAgents(agentSources(agentDir))
    const allow = agent!.children!
    spawnableChildren = loadable.filter(
      (a) =>
        a.name !== agent!.name && // never list self
        (allow.length === 0 || allow.includes(a.name))
    )
  }
  const offerSpawn = canSpawn && spawnableChildren.length > 0

  // Names of the filesystem-mutating workspace tools. In plan mode these are
  // dropped from the offered toolset (so the model can't call them) and also
  // hard-blocked at the gate (belt-and-suspenders); write_plan replaces them as
  // the only allowed write.
  const MUTATING_TOOL_NAMES = new Set([
    "write_file_tool",
    "edit_file_tool",
    "run_shell_tool",
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
  const applyAgentTools = (defs: { function: { name: string } }[]) =>
    agentToolNames === null
      ? defs
      : defs.filter(
          (d) =>
            isUniversalTool(d.function.name) ||
            agentToolNames.has(d.function.name)
        )
  const buildTools = () =>
    applyAgentTools([
      ...(hasWorkspace
        ? planMode
          ? toolDefinitions.filter(
              (d) => !MUTATING_TOOL_NAMES.has(d.function.name)
            )
          : toolDefinitions
        : hasAttachments
          ? [readFileTool.definition]
          : []),
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
      // web_search is read-only (like file reads) so it stays available even in
      // plan mode; web_fetch is a gated network side effect (kind "web"), withheld
      // in plan mode like the other mutating/side-effecting tools.
      webSearchDefinition,
      ...(planMode ? [] : [webFetchDefinition]),
      // spawn_subagent: offered only when the agent+children gates pass and there
      // are children to spawn (offerSpawn). Withheld in plan mode like other
      // side-effecting tools. Not intersected away by the allowlist — offerSpawn
      // already required the `agent` category.
      ...(offerSpawn && !planMode ? [spawnSubagentTool.definition] : []),
      // flag_for_rework: offered only to a Process phase worker (plan 031.2 — when
      // this run carries process context). Lets the worker send a defect back to an
      // upstream phase instead of fixing out of lane. Not gated by the agent
      // allowlist (it's a process-structural capability, like spawn).
      ...(opts.processRunId && !planMode ? [flagForReworkTool.definition] : []),
      // Plan-mode tools: the only write (write_plan) + the approval handoff.
      ...(planMode
        ? [writePlanTool.definition, presentPlanTool.definition]
        : []),
      // read_plan: reads the conversation's own plan file (outside the workspace,
      // so read_file_tool can't). Offered whenever a plan CAN exist — both in
      // plan mode (re-read the draft) and after approval (consult it while
      // implementing). Withheld only where plans don't apply (Chat/subagents,
      // which have no conversationId path into a plan file anyway).
      ...(showTodos ? [readPlanTool.definition] : []),
      // ask_user_question is offered in every mode — clarification is universal.
      askUserQuestionTool.definition,
      readSkillTool.definition,
    ])
  // The non-droppable base prompt (mode prompt). Everything else is a droppable
  // context SECTION handed to the ContextBuilder, which budgets + composes them
  // into the system block under one global budget with an explicit drop order
  // (plan 014). This replaces the previous pile of `systemPrompt +=` appends.
  //
  // A selected custom agent's markdown body is PREPENDED to the mode prompt (and
  // stays non-droppable): the agent's persona/instructions sit on top of ours so
  // they frame everything the model reads, without discarding the mode behavior.
  const modePrompt = await loadSystemPrompt(conversation?.mode)
  const baseSystemPrompt = agent
    ? `${agent.body.trim()}\n\n${modePrompt}`
    : modePrompt
  const sections: ContextSection[] = []

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

  // Skills: the read_skill catalog. Kept longest under budget pressure (highest
  // priority) — dropping it would hide capabilities the agent is told it has.
  const skillsPrompt = buildSkillsPrompt(skills)
  if (skillsPrompt) {
    sections.push({
      name: "skills",
      priority: SECTION_PRIORITY.skills,
      content: skillsPrompt,
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

  // Todo list: re-injected each turn so a multi-step plan survives context
  // compression and tool round-trips (see todo_write). Mode-gated.
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
    const todoPrompt = buildTodoListPrompt(listTodos(conversationId))
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

  // Rolling conversation summary (plan 019): a compact digest of earlier turns
  // that have scrolled out of the walk-back, so a long conversation keeps its
  // early thread. Generated out of band by the `summarize` task; read here each
  // turn (possibly one generation stale — the recent messages cover the seam).
  // Highest-priority section (last dropped). Mode-gated like the others.
  if (showTodos) {
    const summary = summarySection(conversationId)
    if (summary) sections.push(summary)
  }

  // Workspace-index summary (plan 008): cheap structured orientation. Advisory,
  // most droppable. Gated by the "use index for context" setting + a workspace.
  if (useIndex && conversation?.workspaceId) {
    const indexSummary = buildIndexSummary(conversation.workspaceId)
    if (indexSummary) {
      sections.push({
        name: "index",
        priority: SECTION_PRIORITY.index,
        content: indexSummary,
      })
    }
  }

  // Before assembling context, repair any dangling tool-call tail from a turn
  // that was abandoned (the app quit, or a turn was left parked on an approval
  // gate, before its tool produced a result). Without this the rebuilt history
  // would carry an assistant tool_call with no matching `tool` message and the
  // next request would 400.
  //
  // The repair mode depends on the caller, distinguished by `userMessage`:
  //  - A durable-task RESUME passes no userMessage ("carry on"). Roll the
  //    incomplete turn back so the agent re-plans and re-issues the gated tool —
  //    the gate re-prompts (plan 012). A synthetic result would look like a
  //    finished call and the action would never be retried.
  //  - A live-chat turn passes a fresh userMessage. Synthesize an "interrupted"
  //    result and let the new message drive (live chat is ephemeral; the user
  //    retries by typing). A first task run also has no dangling tail, so its
  //    rollback is a no-op.
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
  if (userMessage !== undefined) {
    let userContent = userMessage || "What files are in the workspace?"
    if (hasAttachments) {
      const names = attachments!.map((p) => basename(p)).join(", ")
      const note = `Attached files (read with read_file_tool when needed): ${names}`
      userContent = userContent ? `${userContent}\n\n${note}` : note
    }
    // With attachments inlined, so history reflects what the model actually saw.
    appendMessage({ conversationId, role: "user", content: userContent })
  }

  // Assemble the prompt via the ContextBuilder: system prompt + a token-budgeted
  // walk-back over stored history (which already ends with the user message just
  // persisted). The array grows in-memory as the agent calls tools and we feed
  // results back; those turns are also persisted as they complete (below).
  const messages: any[] = contextBuilder.build(conversationId, {
    baseSystemPrompt,
    sections,
  })

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
  if (hasWorkspace) {
    try {
      const envConfig = settingsService.getExecutionConfig()
      sandboxed = envConfig.kind === "container"
      env = await createEnvironment(workspace!, conversationId, envConfig)
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
    env = new LocalEnvironment("")
  }

  try {
    // Tracks whether any earlier turn already streamed visible text. The model
    // may emit a preamble ("Let me check…"), call a tool, then continue in a
    // new turn — we insert a paragraph break before the later turn's first
    // token so the two pieces don't run together in the bubble.
    let streamedText = false

    // Agentic loop: call the model, run any tools it asks for, repeat until the
    // model returns a turn with no tool calls (the final answer). No round-trip
    // cap — like Claude Code, we let the model run until it's done; multi-step
    // tasks (and the todo list that tracks them) need more than a handful of
    // steps. A turn ends only on a tool-free reply or a thrown error (caught
    // below and surfaced/persisted).
    while (true) {
      // Stop pressed during the previous step's tool execution: break before
      // starting another model round-trip. (An abort mid-stream is caught by the
      // signal on create() below and handled in `catch`.)
      if (abort.signal.aborted) {
        appendMessage({
          conversationId,
          role: "assistant",
          content: "⏹ Stopped by user.",
        })
        return { stopped: true }
      }

      // Recompute the toolset from the live plan-mode flag: an approval during
      // the previous iteration's present_plan call flips planMode off, so this
      // round-trip regains the full filesystem toolset.
      const tools = buildTools()

      const stream = await createCompletion(
        llm.client,
        llm.model,
        MAX_OUTPUT_TOKENS,
        { messages, tools, stream: true },
        [
          undefined,
          // The abort signal. On the OpenAI-backed path the SDK forwards it to
          // fetch, so an abort tears the stream down directly. On the Portkey path
          // (3.1.0) it does NOT forward — Portkey only checks `signal.aborted` after
          // an error — so there the real cancellation is the `break` in the consume
          // loop below: breaking runs the stream iterator's return()/reader.cancel(),
          // which tears down the HTTP body.
          { signal: abort.signal },
        ],
        llm.apiMode
      )

      // Reassemble the streamed turn. Text deltas are forwarded live; tool-call
      // fragments arrive piecemeal and are accumulated by their `index`.
      let text = ""
      const toolAcc = new Map<
        number,
        { id: string; name: string; arguments: string }
      >()
      // The provider's reason for ending the turn (last non-null wins). "length"
      // means the output hit the token cap — the response (and any tool-call JSON
      // mid-stream) is truncated, so we must NOT try to parse it as complete.
      let finishReason: string | null = null

      for await (const chunk of stream) {
        // Stop pressed mid-stream: break so the iterator cancels the reader and
        // the HTTP stream stops. The post-loop abort check unwinds the turn.
        if (abort.signal.aborted) break

        const choice = chunk.choices[0]
        if (choice?.finish_reason) finishReason = choice.finish_reason
        const delta = choice?.delta
        if (!delta) continue

        const piece = contentToText(delta.content)
        if (piece) {
          // First visible token of a later turn: separate it from prior text.
          if (!text && streamedText) onEvent({ type: "token", delta: "\n\n" })
          text += piece
          streamedText = true
          onEvent({ type: "token", delta: piece })
        }

        for (const tc of (delta.tool_calls ?? []) as any[]) {
          const slot = toolAcc.get(tc.index) ?? {
            id: "",
            name: "",
            arguments: "",
          }
          if (tc.id) slot.id = tc.id
          if (tc.function?.name) slot.name = tc.function.name
          if (tc.function?.arguments) slot.arguments += tc.function.arguments
          toolAcc.set(tc.index, slot)
        }
      }

      // Stopped mid-stream (we broke out above): persist whatever text streamed
      // so far plus the stop note, and end the turn. Don't act on a partial
      // tool-call fragment.
      if (abort.signal.aborted) {
        appendMessage({
          conversationId,
          role: "assistant",
          content: text
            ? `${text}\n\n⏹ Stopped by user.`
            : "⏹ Stopped by user.",
        })
        return { stopped: true }
      }

      const toolCalls = [...toolAcc.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, v]) => v)

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
        return { error: note, retryable: true }
      }

      if (toolCalls.length === 0) {
        // No tool calls — this is the final answer. Persist it so the next turn
        // (and a reopened conversation) has the full transcript.
        appendMessage({ conversationId, role: "assistant", content: text })
        return { content: text }
      }

      // Record the assistant turn (text + the tool calls it requested) so the
      // follow-up request has the full context — both in-memory and persisted.
      messages.push({
        role: "assistant",
        content: text || null,
        tool_calls: toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        })),
      })
      appendMessage({
        conversationId,
        role: "assistant",
        content: text || null,
        toolCalls: toolCalls.map((c) => ({
          id: c.id,
          name: c.name,
          arguments: c.arguments,
        })),
      })

      // Images a tool produced this round (browser_screenshot). Collected across
      // the round's tool calls, then injected as a single follow-up user message
      // after the tool results so the vision model sees them on the next
      // round-trip. Tool results themselves stay text-only (persisted as strings).
      const turnImages: ToolImage[] = []

      // Execute each requested tool call and append its result. read_skill is
      // built per-chat (it closes over the loaded skills), so route it directly;
      // everything else goes through the static tool registry.
      for (const call of toolCalls) {
        onEvent({
          type: "tool",
          phase: "start",
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })
        const args = JSON.parse(call.arguments || "{}")
        // The approval gate for this tool call. `allow` and `hard_block` resolve
        // synchronously; `require_approval` emits an event and blocks until the
        // renderer calls resolveApproval over IPC. The event carries the tool-
        // call `id` (so the renderer attaches the card to the right marker) and
        // a process-unique `requestId` keying the pending map — the renderer
        // echoes the latter back, so a decision can't resolve another turn's gate.
        const gate: Gate = (action): Promise<GateOutcome> => {
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
            })
          if (decision.level === "allow") return Promise.resolve("approved")
          if (decision.level === "hard_block") return Promise.resolve("blocked")
          // Auto mode: automatically approve any action that would otherwise
          // require human confirmation. Hard-blocks still block (handled above).
          if (autoMode) return Promise.resolve("approved")
          const requestId = randomUUID()
          onEvent({
            type: "approval",
            id: call.id,
            requestId,
            tool: action.tool,
            summary: action.summary,
            reason: decision.reason,
            kind: action.kind,
          })
          return new Promise<GateOutcome>((resolve) => {
            pendingApprovals.set(requestId, {
              resolve,
              action,
              workspacePath: workspace,
              conversationId,
            })
            // If the turn is stopped while waiting on this approval, release the
            // gate (as a denial) so the loop can unwind instead of hanging — the
            // pre-PR2 "renderer disconnect hangs the gate" gap, closed by Stop.
            // EXCEPTION: an app-shutdown abort leaves the gate unresolved on
            // purpose — persisting a denial result here would record a decision
            // the user never made and wedge resume (plan 012). The process is
            // exiting anyway; the task stays waiting_for_approval and reconciles
            // to interrupted on next boot.
            abort.signal.addEventListener(
              "abort",
              () => {
                if (abort.signal.reason === SHUTDOWN_ABORT_REASON) return
                if (pendingApprovals.delete(requestId)) resolve("denied")
              },
              { once: true }
            )
          })
        }
        // The clarification prompt for ask_user_question. Emits a `question`
        // event and blocks until the renderer answers (chat:answer → resolveQuestion)
        // or the turn is stopped (resolves "cancelled" so the loop unwinds).
        const ask: Ask = (questions): Promise<AskResult> => {
          const requestId = randomUUID()
          onEvent({ type: "question", id: call.id, requestId, questions })
          return new Promise<AskResult>((resolve) => {
            pendingQuestions.set(requestId, resolve)
            abort.signal.addEventListener(
              "abort",
              () => {
                // Shutdown: leave unresolved so no synthetic answer is persisted
                // and the task reconciles to interrupted (mirrors the gate above).
                if (abort.signal.reason === SHUTDOWN_ABORT_REASON) return
                if (pendingQuestions.delete(requestId))
                  resolve({ status: "cancelled" })
              },
              { once: true }
            )
          })
        }
        // read_skill ignores these fields. With a workspace, file tools confine
        // to it; without one, read_file_tool reads only the attached files.
        const ctx = {
          workspace: workspace ?? "",
          attachments,
          conversationId,
          gate,
          ask,
          env,
          signal: abort.signal,
          enqueueTask: opts.enqueueTask,
          browser,
          emitImage: (image: ToolImage) => turnImages.push(image),
          // present_plan calls this on approval; the selected backend is already
          // running, so the next loop iteration can safely unlock mutations.
          setPlanMode: (on: boolean) => {
            planMode = on
            onEvent({ type: "plan_mode", enabled: on })
          },
          // present_plan calls this when the user picks "approve and Auto mode".
          // Shared with the mid-turn dropdown toggle (autoModeSetters registry).
          setAutoMode,
          // Subagent spawning: wired only when the running agent may spawn, so
          // the tool reports "unavailable" otherwise (it's also not offered).
          // agentChildren is the authorization whitelist; depth/ancestors bound
          // recursion. The child's name is appended to the ancestor chain here.
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
                  parentSignal: abort.signal,
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
          processRunId: opts.processRunId,
          processPhaseRunId: opts.processPhaseRunId,
        }
        const result =
          call.name === readSkillTool.definition.function.name
            ? await readSkillTool.execute(args, ctx)
            : await runTool(call.name, args, ctx)
        onEvent({
          type: "tool",
          phase: "done",
          id: call.id,
          name: call.name,
          result,
        })
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        })
        appendMessage({
          conversationId,
          role: "tool",
          content: result,
          toolCallId: call.id,
          toolName: call.name,
        })
      }

      // If any tool produced an image this round (browser_screenshot), inject it
      // as a user message with image content parts so the vision model sees it on
      // the next round-trip. `messages` is untyped (any[]) and passes straight to
      // the gateway (createCompletion forwards it), so content parts need no type
      // surgery. This is transient (not persisted via appendMessage): screenshots
      // aren't durable across reload in Phase 1 — the tool's text result remains
      // in the transcript as the record that a capture happened.
      if (turnImages.length > 0) {
        messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "Screenshot(s) from the agent browser tool call(s) above:",
            },
            ...turnImages.map((img) => ({
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${img.jpegBase64}` },
            })),
          ],
        })
      }
    }
  } catch (error) {
    // A user Stop aborts the in-flight stream, which surfaces here as an abort
    // error. That's a clean stop, not a failure: persist a neutral note (so the
    // transcript shows where it stopped) and return without an error banner.
    if (abort.signal.aborted) {
      appendMessage({
        conversationId,
        role: "assistant",
        content: "⏹ Stopped by user.",
      })
      return { stopped: true }
    }
    console.error("Portkey request failed:", error)
    const message = error instanceof Error ? error.message : "Request failed"
    const retryable = isTransientError(error)
    return failTurn(conversationId, message, retryable)
  } finally {
    // Drop this turn's auto-mode setter (only live turns registered one). Guard
    // against a newer turn for the same conversation having replaced it.
    if (isLiveTurn && autoModeSetters.get(conversationId) === setAutoMode) {
      autoModeSetters.delete(conversationId)
    }
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
  depth: number
  ancestors: string[]
}): Promise<{ content?: string; error?: string; stopped?: boolean }> {
  // Resolve the child definition up front so an unknown name fails cleanly
  // without creating an orphan worker conversation. Discovery uses the parent's
  // agentDir (not the confinement workspace) so a Chat child is found too.
  const child = await loadAgent(input.agentName, input.agentDir)
  if (!child) {
    return { error: `Unknown agent '${input.agentName}'.` }
  }

  // Fork a private worker conversation, inheriting the parent's execution context
  // (mode → tools/prompt gating, workspace, LLM selection) and stamped with the
  // child agent so the nested loop applies its prompt/tools/skills.
  const worker = createConversation({
    mode: input.parentConversation?.mode ?? "interactive",
    workspaceId: input.parentConversation?.workspaceId ?? null,
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
      userMessage: input.prompt,
      abort: childAbort,
      // No renderer for the child — its transcript is still persisted durably.
      onEvent: () => {},
      agentDepth: input.depth,
      agentAncestors: input.ancestors,
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
    planMode,
    autoMode,
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
  // For an untitled conversation, generate a short title from the first message
  // with a separate (non-streaming) LLM call. Kicked off here so it runs
  // concurrently with the agentic loop below; awaited in `finally` so it's
  // persisted before runChat returns and the renderer refreshes the sidebar.
  const conversation = getConversation(conversationId)
  const llmSelection: LlmSelection = {
    accountId: conversation?.accountId ?? null,
    modelId: conversation?.modelId ?? null,
  }
  const titlePromise =
    conversation && !conversation.title && message.trim()
      ? generateTitle(message, llmSelection).then((title) =>
          updateConversation(conversationId, { title })
        )
      : null

  // Register the abort controller for this turn so the Stop button (chat:stop →
  // stopChat) can cancel it. One turn per conversation (the UI disables Send
  // while loading), so a plain Map keyed by conversation is enough.
  const abort = new AbortController()
  abortControllers.set(conversationId, abort)
  try {
    return await runAgentLoop({
      conversationId,
      workspace,
      attachments,
      userMessage: message,
      planMode,
      autoMode,
      onEvent,
      abort,
      enqueueTask,
      provideBrowser,
    })
  } finally {
    // Release this turn's abort controller (only if it's still the current one —
    // defensive against a future overlapping turn replacing it).
    if (abortControllers.get(conversationId) === abort) {
      abortControllers.delete(conversationId)
    }
    // Ensure the title write lands before runChat resolves, so the sidebar
    // shows it as soon as the renderer refreshes. (generateTitle never rejects.)
    if (titlePromise) await titlePromise
  }
}

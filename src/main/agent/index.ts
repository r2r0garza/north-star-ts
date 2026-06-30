import { randomUUID } from "crypto"
import { stat } from "fs/promises"
import { basename, isAbsolute } from "path"
import { toolDefinitions, runTool, todoWriteTool, askUserQuestionTool, runTodosInBackgroundTool } from "./tools"
import { readFileTool } from "./tools/read_file_tool"
import { listTodos } from "../db/repositories/todos"
import { buildTodoListPrompt } from "./todo-prompt"
import { loadSkills } from "./skills/loader"
import { buildSkillsPrompt } from "./skills/prompt"
import { createReadSkillTool } from "./skills/tool"
import { skillSources } from "./skills/sources"
import { loadSystemPrompt } from "./system-prompt"
import { contextBuilder } from "./context/context-builder"
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
import { getConversation, updateConversation } from "../db/repositories/conversations"
import { actionAllowlist } from "../db/repositories"
import { PolicyEngine, type AllowlistLookup, type SandboxPolicyLookup } from "./approval/policy"
import { RegexCommandClassifier } from "./approval/regex-classifier"
import { FileActionClassifier } from "./approval/file-classifier"
import { DelegationClassifier } from "./approval/delegation-classifier"
import type { ActionKind, Gate, GateOutcome, ToolAction } from "./approval/types"
import type { Ask, AskResult, EnqueueTask, Question, QuestionAnswer } from "./tools/types"

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

// Called from the renderer over IPC ("chat:stop") to cancel an in-flight turn.
// Idempotent and safe to call when nothing is running (no-op if no controller).
export function stopChat(conversationId: string): void {
  abortControllers.get(conversationId)?.abort()
}

// Called from the renderer over IPC ("chat:approve") to resolve a request the
// gate is blocked on. `requestId` is a process-unique token (not the model's
// tool-call id, which is only unique within a turn) so a decision can never
// resolve a different conversation's pending gate. On "approved" with
// remember:"workspace", the action is persisted to the allowlist so identical
// future actions skip the prompt.
export function resolveApproval(
  requestId: string,
  decision: "approved" | "denied",
  remember?: "workspace"
): void {
  const pending = pendingApprovals.get(requestId)
  if (!pending) return
  pendingApprovals.delete(requestId)
  if (decision === "approved" && remember === "workspace" && pending.workspacePath) {
    actionAllowlist.addRule({
      tool: pending.action.tool,
      kind: pending.action.kind,
      identity: pending.action.identity,
      scope: "workspace",
      workspacePath: pending.workspacePath,
      conversationId: pending.conversationId ?? null,
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
export function resolveQuestion(requestId: string, answers: QuestionAnswer[]): void {
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
  // True when the turn was cancelled by the user's Stop button (a clean stop,
  // not an error). The "⏹ Stopped by user." note is already persisted.
  stopped?: boolean
  // Only meaningful alongside `error`: true when the failure was a transient
  // infrastructure hiccup (gateway 5xx, network/timeout) worth a backoff retry.
  // Classified at the catch block where the raw error's status/code is still
  // available; the task runner reads it to decide retry vs fail-fast (plan 011).
  retryable?: boolean
}

// Streaming events emitted during a turn. `token` is a text delta to append to
// the assistant bubble; `tool` reports tool activity so the UI can show it. The
// tool-call `id` joins start↔done (and matches the persisted toolCallId), so the
// live markers render identically to the ones rebuilt from storage on reload.
export type ChatEvent =
  | { type: "token"; delta: string }
  | { type: "tool"; phase: "start"; id: string; name: string; arguments: string }
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

type OnEvent = (event: ChatEvent) => void

// Normalize a content value (string or array of parts) to plain text.
function contentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part === "string" ? part : (part?.text ?? "")))
      .join("")
  }
  return ""
}

// Ask the model for a short (5-6 word) title summarizing the user's first
// message. Non-streaming and capped low so it's cheap. Falls back to a trimmed
// snippet on any failure so a conversation always gets a title.
async function generateTitle(message: string, sel: LlmSelection): Promise<string> {
  const fallback = titleFromMessage(message)
  try {
    const { client, model } = resolveLlm(sel)
    const res = await createCompletion(client, model, 32, {
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
        { role: "user", content: `First message:\n"""\n${message}\n"""\n\nTitle:` },
      ],
    })
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
}

// The core agentic loop, shared by the live `chat` path (runChat) and the
// durable task runner. Runs the model→tools cycle for `conversationId`, confined
// to `workspace`, streaming through `onEvent` and persisting every turn (user,
// assistant, tool results) as it goes so the transcript is durable and
// resumable. Returns the final result object.
export async function runAgentLoop(opts: RunAgentLoopOptions): Promise<ChatResult> {
  const { conversationId, workspace, attachments, userMessage, abort } = opts
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

  // Load skills (app-bundled → user → project, last-wins), then build the
  // read_skill tool and the Skills System prompt section. Only skill metadata
  // enters the prompt; bodies are fetched on demand via the tool.
  const skills = await loadSkills(skillSources(hasWorkspace ? workspace : undefined))
  const readSkillTool = createReadSkillTool(skills)

  // Filesystem tools are confined to a workspace, so the full set is only
  // offered when one exists. A Chat session has no workspace; instead it offers
  // just read_file_tool, scoped to the files the user attached (the attachment
  // list is the read allowlist — see read_file_tool's resolveReadable).
  const hasAttachments = !!attachments && attachments.length > 0

  // Load the conversation once, here: its `mode` selects the base system prompt,
  // gates the todo tool, and is reused below for the title check. Defaults to
  // "chat" if missing.
  const conversation = getConversation(conversationId)

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

  const tools = [
    ...(hasWorkspace
      ? toolDefinitions
      : hasAttachments
        ? [readFileTool.definition]
        : []),
    ...(showTodos
      ? [todoWriteTool.definition, runTodosInBackgroundTool.definition]
      : []),
    // ask_user_question is offered in every mode — clarification is universal.
    askUserQuestionTool.definition,
    readSkillTool.definition,
  ]
  const skillsPrompt = buildSkillsPrompt(skills)

  let systemPrompt = await loadSystemPrompt(conversation?.mode)
  if (skillsPrompt) systemPrompt += `\n\n${skillsPrompt}`

  // Re-inject the current task list each turn so a multi-step plan survives
  // context compression and tool round-trips (see todo_write). Mode-gated and
  // only when non-empty.
  if (showTodos) {
    const todoPrompt = buildTodoListPrompt(listTodos(conversationId))
    if (todoPrompt) systemPrompt += `\n\n${todoPrompt}`
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
  const messages: any[] = contextBuilder.build(conversationId, { systemPrompt })

  // Build this turn's execution backend (host or container). The backend is
  // selected by env var until the settings pane lands (see ./env/factory). A
  // container is started up front, so a missing/broken runtime fails clearly here
  // rather than hanging mid-turn; we surface the error instead of crashing. Chat
  // sessions (no workspace) only ever use the local attachment path, so a plain
  // LocalEnvironment is enough there.
  // Resolve this conversation's LLM provider + model up front (its own selection,
  // or the default). A missing/incomplete provider config fails the turn cleanly
  // here (before any container spin-up) rather than mid-loop. The renderer gates
  // Send on hasActiveProvider, so this is the backstop for a stale selection.
  let llm: ReturnType<typeof resolveLlm>
  try {
    llm = resolveLlm(llmSelection)
  } catch (err) {
    if (err instanceof NoActiveProviderError) return { error: err.message }
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
      return { error: `Execution backend unavailable: ${detail}` }
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

      const stream = await createCompletion(
        llm.client,
        llm.model,
        MAX_OUTPUT_TOKENS,
        { messages, tools, stream: true },
        [
          undefined,
          // We pass the signal, but the Portkey SDK (3.1.0) does NOT forward it to
          // the underlying fetch — it only checks `signal.aborted` after an error.
          // So aborting alone won't stop a healthy stream. The real cancellation is
          // the `break` in the consume loop below: breaking runs the stream
          // iterator's return()/reader.cancel(), which tears down the HTTP body.
          { signal: abort.signal },
        ]
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
          content: text ? `${text}\n\n⏹ Stopped by user.` : "⏹ Stopped by user.",
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
        appendMessage({ conversationId, role: "assistant", content: `⚠️ ${note}` })
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
          const decision = policy.decide(action, {
            workspacePath: workspace,
            conversationId,
            sandboxed,
          })
          if (decision.level === "allow") return Promise.resolve("approved")
          if (decision.level === "hard_block") return Promise.resolve("blocked")
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
                if (pendingQuestions.delete(requestId)) resolve({ status: "cancelled" })
              },
              { once: true }
            )
          })
        }
        // read_skill ignores these fields. With a workspace, file tools confine
        // to it; without one, read_file_tool reads only the attached files.
        const ctx = { workspace: workspace ?? "", attachments, conversationId, gate, ask, env, signal: abort.signal, enqueueTask: opts.enqueueTask }
        const result =
          call.name === readSkillTool.definition.function.name
            ? await readSkillTool.execute(args, ctx)
            : await runTool(call.name, args, ctx)
        onEvent({ type: "tool", phase: "done", id: call.id, name: call.name, result })
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
    // Persist the failure as an assistant note so a reopened conversation (and
    // the post-turn reconcile in the renderer) explains why the turn ended,
    // rather than stopping silently after the last tool call.
    appendMessage({
      conversationId,
      role: "assistant",
      content: `⚠️ The turn ended early: ${message}`,
    })
    return { error: message, retryable }
  } finally {
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
// directly with its own task-keyed controller.
export async function runChat(
  { conversationId, message, workspace, attachments }: ChatRequest,
  onEvent: OnEvent = () => {},
  // Lets a live interactive/north_star turn hand work off to the background via
  // run_todos_in_background. Injected by the main-process IPC handler (which owns
  // the TaskRunner singleton) so the agent module never imports the runner.
  enqueueTask?: EnqueueTask
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
      onEvent,
      abort,
      enqueueTask,
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

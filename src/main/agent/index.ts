import { Portkey } from "portkey-ai"
import { randomUUID } from "crypto"
import { stat } from "fs/promises"
import { basename, isAbsolute } from "path"
import { toolDefinitions, runTool, todoWriteTool } from "./tools"
import { readFileTool } from "./tools/read_file_tool"
import { listTodos } from "../db/repositories/todos"
import { buildTodoListPrompt } from "./todo-prompt"
import { loadSkills } from "./skills/loader"
import { buildSkillsPrompt } from "./skills/prompt"
import { createReadSkillTool } from "./skills/tool"
import { skillSources } from "./skills/sources"
import { loadSystemPrompt } from "./system-prompt"
import { contextBuilder } from "./context/context-builder"
import { appendMessage } from "../db/repositories/messages"
import { getConversation, updateConversation } from "../db/repositories/conversations"
import { actionAllowlist } from "../db/repositories"
import { PolicyEngine, type AllowlistLookup } from "./approval/policy"
import { RegexCommandClassifier } from "./approval/regex-classifier"
import { FileActionClassifier } from "./approval/file-classifier"
import type { Gate, GateOutcome, ToolAction } from "./approval/types"

const MODEL = "@aws-bedrock-use2/us.anthropic.claude-sonnet-4-6"

// Lazily construct the client so it reads process.env AFTER the main process
// has loaded .env.local — not at module-import time. NEXT_apiKey (from
// .env.local) takes priority over the system-wide PORTKEY_API_KEY.
let client: Portkey | undefined
function getClient(): Portkey {
  if (!client) {
    client = new Portkey({
      baseURL: "https://portkeygateway.perficient.com/v1",
      apiKey: process.env.NEXT_apiKey ?? process.env.PORTKEY_API_KEY,
    })
  }
  return client
}

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
const policy = new PolicyEngine(
  [new FileActionClassifier(), new RegexCommandClassifier()],
  allowlistLookup
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
async function generateTitle(message: string): Promise<string> {
  const fallback = titleFromMessage(message)
  try {
    const res = await getClient().chat.completions.create({
      model: MODEL,
      max_tokens: 32,
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

// Runs the agentic loop for one user message, confined to `workspace`.
// Streams tokens and tool activity through `onEvent`, and returns the final
// result object — IPC serializes it back to the renderer.
export async function runChat(
  { conversationId, message, workspace, attachments }: ChatRequest,
  onEvent: OnEvent = () => {}
): Promise<ChatResult> {
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

  // The todo tool is gated by mode, not workspace: chat is the tool-light mode
  // and doesn't get it; interactive/north_star do, with or without a workspace.
  const showTodos = conversation?.mode != null && conversation.mode !== "chat"

  const tools = [
    ...(hasWorkspace
      ? toolDefinitions
      : hasAttachments
        ? [readFileTool.definition]
        : []),
    ...(showTodos ? [todoWriteTool.definition] : []),
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

  // List any attached files by name so the model knows what it can read. The
  // contents are NOT inlined: the model reads them on demand via read_file_tool
  // (scoped to this attachment list), which supports large files via paging.
  let userContent = message ?? "What files are in the workspace?"
  if (hasAttachments) {
    const names = attachments!.map((p) => basename(p)).join(", ")
    const note =
      `Attached files (read with read_file_tool when needed): ${names}`
    userContent = userContent ? `${userContent}\n\n${note}` : note
  }

  // Persist the user message (with attachments inlined, so history reflects what
  // the model actually saw).
  appendMessage({ conversationId, role: "user", content: userContent })

  // For an untitled conversation, generate a short title from the first message
  // with a separate (non-streaming) LLM call. Kicked off here so it runs
  // concurrently with the agentic loop below; awaited in `finally` so it's
  // persisted before runChat returns and the renderer refreshes the sidebar.
  const titlePromise =
    conversation && !conversation.title && message.trim()
      ? generateTitle(message).then((title) =>
          updateConversation(conversationId, { title })
        )
      : null

  // Assemble the prompt via the ContextBuilder: system prompt + a token-budgeted
  // walk-back over stored history (which already ends with the user message just
  // persisted). The array grows in-memory as the agent calls tools and we feed
  // results back; those turns are also persisted as they complete (below).
  const messages: any[] = contextBuilder.build(conversationId, { systemPrompt })

  // Register the abort controller for this turn so the Stop button (chat:stop →
  // stopChat) can cancel it. One turn per conversation (the UI disables Send
  // while loading), so a plain Map keyed by conversation is enough.
  const abort = new AbortController()
  abortControllers.set(conversationId, abort)

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

      const stream = await getClient().chat.completions.create(
        {
          model: MODEL,
          max_tokens: 1024,
          messages,
          tools,
          stream: true,
        },
        undefined,
        // We pass the signal, but the Portkey SDK (3.1.0) does NOT forward it to
        // the underlying fetch — it only checks `signal.aborted` after an error.
        // So aborting alone won't stop a healthy stream. The real cancellation is
        // the `break` in the consume loop below: breaking runs the stream
        // iterator's return()/reader.cancel(), which tears down the HTTP body.
        { signal: abort.signal }
      )

      // Reassemble the streamed turn. Text deltas are forwarded live; tool-call
      // fragments arrive piecemeal and are accumulated by their `index`.
      let text = ""
      const toolAcc = new Map<
        number,
        { id: string; name: string; arguments: string }
      >()

      for await (const chunk of stream) {
        // Stop pressed mid-stream: break so the iterator cancels the reader and
        // the HTTP stream stops. The post-loop abort check unwinds the turn.
        if (abort.signal.aborted) break

        const delta = chunk.choices[0]?.delta
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
            abort.signal.addEventListener(
              "abort",
              () => {
                if (pendingApprovals.delete(requestId)) resolve("denied")
              },
              { once: true }
            )
          })
        }
        // read_skill ignores these fields. With a workspace, file tools confine
        // to it; without one, read_file_tool reads only the attached files.
        const ctx = { workspace: workspace ?? "", attachments, conversationId, gate }
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
    // Persist the failure as an assistant note so a reopened conversation (and
    // the post-turn reconcile in the renderer) explains why the turn ended,
    // rather than stopping silently after the last tool call.
    appendMessage({
      conversationId,
      role: "assistant",
      content: `⚠️ The turn ended early: ${message}`,
    })
    return { error: message }
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

import { Portkey } from "portkey-ai"
import { stat, readFile } from "fs/promises"
import { basename, isAbsolute } from "path"
import { toolDefinitions, runTool } from "./tools"
import { loadSkills } from "./skills/loader"
import { buildSkillsPrompt } from "./skills/prompt"
import { createReadSkillTool } from "./skills/tool"
import { skillSources } from "./skills/sources"
import { loadSystemPrompt } from "./system-prompt"
import { contextBuilder } from "./context/context-builder"
import { appendMessage } from "../db/repositories/messages"
import { getConversation, updateConversation } from "../db/repositories/conversations"

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

// Cap inlined attachment size so a stray large file can't blow the prompt.
const MAX_ATTACHMENT_BYTES = 256 * 1024

// Read each attachment and format it as a labeled, fenced block. Unreadable
// files become a short note rather than failing the whole turn.
async function buildAttachmentsText(paths: string[]): Promise<string> {
  const blocks = await Promise.all(
    paths.map(async (p) => {
      try {
        const info = await stat(p)
        if (!info.isFile()) return `--- ${basename(p)} (skipped: not a file) ---`
        if (info.size > MAX_ATTACHMENT_BYTES) {
          return `--- ${basename(p)} (skipped: ${info.size} bytes exceeds ${MAX_ATTACHMENT_BYTES}) ---`
        }
        const content = await readFile(p, "utf8")
        return `--- ${basename(p)} ---\n${content}`
      } catch (err) {
        const reason = err instanceof Error ? err.message : "unreadable"
        return `--- ${basename(p)} (skipped: ${reason}) ---`
      }
    })
  )
  return blocks.join("\n\n")
}

export interface ChatResult {
  content?: string
  error?: string
}

// Streaming events emitted during a turn. `token` is a text delta to append to
// the assistant bubble; `tool` reports tool activity so the UI can show it.
export type ChatEvent =
  | { type: "token"; delta: string }
  | { type: "tool"; name: string; phase: "start" | "done" }

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
  // enters the prompt; bodies are fetched on demand via the tool. Filesystem
  // tools are only offered when there's a workspace to confine them to.
  const skills = await loadSkills(skillSources(hasWorkspace ? workspace : undefined))
  const readSkillTool = createReadSkillTool(skills)
  const tools = [
    ...(hasWorkspace ? toolDefinitions : []),
    readSkillTool.definition,
  ]
  const skillsPrompt = buildSkillsPrompt(skills)

  let systemPrompt = await loadSystemPrompt()
  if (skillsPrompt) systemPrompt += `\n\n${skillsPrompt}`

  // Inline any attached files into the user message so the model can read them
  // without filesystem access (the Chat view has no workspace).
  let userContent = message ?? "What files are in the workspace?"
  if (attachments && attachments.length > 0) {
    const attachmentsText = await buildAttachmentsText(attachments)
    userContent = userContent
      ? `${userContent}\n\nAttached files:\n\n${attachmentsText}`
      : `Attached files:\n\n${attachmentsText}`
  }

  // Persist the user message (with attachments inlined, so history reflects what
  // the model actually saw).
  appendMessage({ conversationId, role: "user", content: userContent })

  // For an untitled conversation, generate a short title from the first message
  // with a separate (non-streaming) LLM call. Kicked off here so it runs
  // concurrently with the agentic loop below; awaited in `finally` so it's
  // persisted before runChat returns and the renderer refreshes the sidebar.
  const conversation = getConversation(conversationId)
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

  try {
    // Tracks whether any earlier turn already streamed visible text. The model
    // may emit a preamble ("Let me check…"), call a tool, then continue in a
    // new turn — we insert a paragraph break before the later turn's first
    // token so the two pieces don't run together in the bubble.
    let streamedText = false

    // Agentic loop: call the model, run any tools it asks for, repeat until done.
    for (let i = 0; i < 5; i++) {
      const stream = await getClient().chat.completions.create({
        model: MODEL,
        max_tokens: 1024,
        messages,
        tools,
        stream: true,
      })

      // Reassemble the streamed turn. Text deltas are forwarded live; tool-call
      // fragments arrive piecemeal and are accumulated by their `index`.
      let text = ""
      const toolAcc = new Map<
        number,
        { id: string; name: string; arguments: string }
      >()

      for await (const chunk of stream) {
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
        onEvent({ type: "tool", name: call.name, phase: "start" })
        const args = JSON.parse(call.arguments || "{}")
        // read_skill ignores the workspace; filesystem tools are only offered
        // when a workspace exists, so `?? ""` is never reached by them.
        const ctx = { workspace: workspace ?? "" }
        const result =
          call.name === readSkillTool.definition.function.name
            ? await readSkillTool.execute(args, ctx)
            : await runTool(call.name, args, ctx)
        onEvent({ type: "tool", name: call.name, phase: "done" })
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

    return { error: "Agent did not finish within the tool-call limit." }
  } catch (error) {
    console.error("Portkey request failed:", error)
    return { error: error instanceof Error ? error.message : "Request failed" }
  } finally {
    // Ensure the title write lands before runChat resolves, so the sidebar
    // shows it as soon as the renderer refreshes. (generateTitle never rejects.)
    if (titlePromise) await titlePromise
  }
}

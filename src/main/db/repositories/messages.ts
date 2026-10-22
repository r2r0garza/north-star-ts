import {
  validateCarrier,
  MAX_CARRIER_BYTES,
  type NativeAssistantCarrier,
} from "../../agent/providers/native-carrier"
import { randomUUID } from "crypto"
import { toolArtifactReference } from "./conversation-artifacts"
import { messageMedia, cleanupToolMedia } from "../../media/tool-media"
import { getDb } from "../connection"
import {
  defaultTokenCounter,
  type TokenCounter,
} from "../../agent/context/token-counter"
import { touchConversation } from "./conversations"
import type { Message, MessageRole, ToolCallRecord } from "../types"

interface MessageRow {
  id: string
  conversation_id: string
  seq: number
  role: MessageRole
  content: string | null
  tool_calls: string | null
  tool_call_id: string | null
  tool_name: string | null
  token_estimate: number | null
  created_at: number
  native_assistant: string | null
  reasoning: string | null
}

function readCarrier(raw: string) {
  if (Buffer.byteLength(raw) > MAX_CARRIER_BYTES) return undefined
  try {
    return validateCarrier(JSON.parse(raw))
  } catch {
    return undefined
  }
}

function toMessage(row: MessageRow): Message {
  const artifact =
    row.role === "tool" &&
    row.tool_call_id &&
    ["present_chart", "present_table"].includes(row.tool_name ?? "")
      ? toolArtifactReference(row.conversation_id, row.tool_call_id)
      : undefined
  return {
    ...(artifact ? { artifact } : {}),
    ...(row.role === "assistant" && row.native_assistant
      ? { nativeAssistant: readCarrier(row.native_assistant) }
      : {}),
    ...(row.role === "assistant" && row.reasoning
      ? { reasoning: row.reasoning }
      : {}),
    ...(row.role === "tool" && messageMedia(row.id).length
      ? { media: messageMedia(row.id) }
      : {}),
    id: row.id,
    conversationId: row.conversation_id,
    seq: row.seq,
    role: row.role,
    content: row.content,
    toolCalls: row.tool_calls
      ? (JSON.parse(row.tool_calls) as ToolCallRecord[])
      : null,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    tokenEstimate: row.token_estimate,
    createdAt: row.created_at,
  }
}

// Text used to estimate a message's token cost — the visible content plus any
// serialized tool-call arguments, which also occupy context.
function estimateText(
  content: string | null,
  toolCalls: ToolCallRecord[] | null
): string {
  let text = content ?? ""
  if (toolCalls?.length) text += JSON.stringify(toolCalls)
  return text
}

export interface AppendMessageInput {
  nativeAssistant?: NativeAssistantCarrier
  // Assistant reasoning, kept for the transcript UI only (never replayed).
  reasoning?: string
  conversationId: string
  role: MessageRole
  content?: string | null
  toolCalls?: ToolCallRecord[] | null
  toolCallId?: string | null
  toolName?: string | null
}

// Append a message, assigning the next per-conversation seq, caching a token
// estimate, and bumping the conversation's updated_at — all in one transaction
// so seq can't race under concurrent writes.
export function appendMessage(
  input: AppendMessageInput,
  counter: TokenCounter = defaultTokenCounter
): Message {
  const id = randomUUID()
  const now = Date.now()
  const toolCalls = input.toolCalls ?? null
  const content = input.content ?? null
  const carrier =
    input.role === "assistant"
      ? validateCarrier(input.nativeAssistant)
      : undefined
  const tokenEstimate = counter.count(estimateText(content, toolCalls))

  const db = getDb()
  const tx = db.transaction(() => {
    const row = db
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages WHERE conversation_id = ?"
      )
      .get(input.conversationId) as { maxSeq: number }
    const seq = row.maxSeq + 1
    db.prepare(
      `INSERT INTO messages
        (id, conversation_id, seq, role, content, tool_calls, tool_call_id, tool_name, token_estimate, created_at, native_assistant, reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.conversationId,
      seq,
      input.role,
      content,
      toolCalls ? JSON.stringify(toolCalls) : null,
      input.toolCallId ?? null,
      input.toolName ?? null,
      tokenEstimate,
      now,
      carrier ? JSON.stringify(carrier) : null,
      input.role === "assistant" && input.reasoning ? input.reasoning : null
    )
    if (input.role === "tool" && input.toolCallId) {
      db.prepare(
        `UPDATE tool_media SET message_id = ? WHERE conversation_id = ? AND tool_call_id = ? AND message_id IS NULL`
      ).run(id, input.conversationId, input.toolCallId)
      const media = messageMedia(id)
      if (media.length)
        db.prepare(
          "UPDATE messages SET token_estimate = token_estimate + ? WHERE id = ?"
        ).run(media.length * 8192, id)
    }
    touchConversation(input.conversationId)
    return seq
  })
  tx()
  return getMessage(id)!
}

export function getMessage(id: string): Message | undefined {
  const row = getDb().prepare("SELECT * FROM messages WHERE id = ?").get(id) as
    | MessageRow
    | undefined
  return row ? toMessage(row) : undefined
}

// All messages for a conversation in chronological (seq ASC) order — used for
// the renderer reload and by the ContextBuilder.
export function listMessages(conversationId: string): Message[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC"
    )
    .all(conversationId) as MessageRow[]
  return rows.map(toMessage)
}

export function listMessagesAfterSeq(
  conversationId: string,
  afterSeq: number
): Message[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC"
    )
    .all(conversationId, afterSeq) as MessageRow[]
  return rows.map(toMessage)
}

export function getMaxMessageSeq(conversationId: string): number {
  const row = getDb()
    .prepare(
      "SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages WHERE conversation_id = ?"
    )
    .get(conversationId) as { maxSeq: number }
  return row.maxSeq
}

export function deleteMessage(id: string): void {
  getDb().prepare("DELETE FROM messages WHERE id = ?").run(id)
  cleanupToolMedia()
}

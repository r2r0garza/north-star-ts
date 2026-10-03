import { countTokens } from "gpt-tokenizer/encoding/o200k_base"

// Local token counts for one model request and its response (plan 108). Every
// number here is an o200k_base count: exact for current OpenAI models, an
// estimate for everything else (Claude, Gemini, DeepSeek…). The usage log
// records `estimator: "o200k"` next to it so nobody mistakes it for exact.
//
// This is measurement only. It deliberately does NOT replace
// defaultTokenCounter (chars/4), which feeds messages.token_estimate and the
// summarize thresholds.

export const REQUEST_SIZE_ESTIMATOR = "o200k"

// Approximate per-message framing (role, separators). OpenAI's documented
// chat overhead is 3–4 tokens per message; other providers differ.
export const MESSAGE_OVERHEAD_TOKENS = 4

type RoleBucket = "system" | "user" | "assistant" | "tool"

export interface RequestSize {
  // Everything below plus MESSAGE_OVERHEAD_TOKENS per message.
  total: number
  byRole: Record<RoleBucket, number>
  // The serialized tool definitions offered with the request.
  toolDefs: number
  messageCount: number
  largestMessage: { role: RoleBucket; toolName?: string; tokens: number } | null
}

// Text that may contain "<|endoftext|>" and friends (a file the agent read,
// say) is counted as plain text rather than rejected.
const NO_SPECIAL = { disallowedSpecial: new Set<string>() }

function countText(text: string): number {
  if (!text) return 0
  try {
    return countTokens(text, NO_SPECIAL)
  } catch {
    return Math.ceil(text.length / 4)
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) =>
        typeof part === "string"
          ? part
          : typeof part?.text === "string"
            ? part.text
            : ""
      )
      .join("")
  }
  return ""
}

// The in-memory `messages` array is append-only within a turn (a rewritten
// message is a new object), so each message is encoded once and later rounds
// only pay for what's new. Tool definition objects are reused across rounds.
const messageCache = new WeakMap<object, number>()
const toolDefCache = new WeakMap<object, number>()

function messageTokens(message: any): number {
  if (!message || typeof message !== "object") return 0
  const cached = messageCache.get(message)
  if (cached !== undefined) return cached
  let tokens = countText(contentText(message.content))
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      tokens += countText(String(call?.function?.name ?? ""))
      tokens += countText(String(call?.function?.arguments ?? ""))
    }
  }
  messageCache.set(message, tokens)
  return tokens
}

function toolDefTokens(tool: unknown): number {
  if (!tool || typeof tool !== "object") return 0
  const cached = toolDefCache.get(tool)
  if (cached !== undefined) return cached
  let tokens = 0
  try {
    tokens = countText(JSON.stringify(tool))
  } catch {
    tokens = 0
  }
  toolDefCache.set(tool, tokens)
  return tokens
}

function bucketFor(role: unknown): RoleBucket {
  if (role === "system" || role === "developer") return "system"
  if (role === "assistant" || role === "tool") return role
  return "user"
}

export function measureRequest(
  messages: readonly any[],
  tools: readonly unknown[] = []
): RequestSize {
  const byRole: Record<RoleBucket, number> = {
    system: 0,
    user: 0,
    assistant: 0,
    tool: 0,
  }
  // Tool results carry only a call id; name them from the assistant message
  // that asked for them.
  const toolNames = new Map<string, string>()
  let largest: RequestSize["largestMessage"] = null
  for (const message of messages) {
    const role = bucketFor(message?.role)
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const name = call?.function?.name
        if (typeof call?.id === "string" && typeof name === "string") {
          toolNames.set(call.id, name)
        }
      }
    }
    const tokens = messageTokens(message)
    byRole[role] += tokens
    if (!largest || tokens > largest.tokens) {
      const toolName =
        role === "tool" ? toolNames.get(message.tool_call_id) : undefined
      largest = { role, tokens, ...(toolName ? { toolName } : {}) }
    }
  }
  let toolDefs = 0
  for (const tool of tools) toolDefs += toolDefTokens(tool)
  const total =
    byRole.system +
    byRole.user +
    byRole.assistant +
    byRole.tool +
    toolDefs +
    messages.length * MESSAGE_OVERHEAD_TOKENS
  return {
    total,
    byRole,
    toolDefs,
    messageCount: messages.length,
    largestMessage: largest,
  }
}

export function measureResponse(
  text: string,
  toolCalls: ReadonlyArray<{ name: string; arguments: string }>
): number {
  let tokens = countText(text)
  for (const call of toolCalls) {
    tokens += countText(call.name) + countText(call.arguments)
  }
  return tokens
}

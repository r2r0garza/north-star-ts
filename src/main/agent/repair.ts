import {
  appendMessage,
  deleteMessage,
  listMessages,
} from "../db/repositories/messages"

// The synthetic result appended (in "synthesize" mode) for a tool call that
// never produced one. The model API requires a `tool` message for every
// tool_call_id, so a half-finished turn would otherwise 400 the next request.
const INTERRUPTED_RESULT = "Interrupted before completion; result unknown."

// How to repair a dangling assistant tool-call tail — a turn left with tool
// calls that never produced results (the app quit, or a turn was abandoned,
// while a call was in flight, e.g. parked on an approval gate).
//
//  - "synthesize": append a synthetic "interrupted" result for each unanswered
//    call so the transcript is API-valid and PRESERVED. The model sees the
//    attempt was interrupted; a fresh user message drives what happens next.
//    Used by the live `chat` path (ephemeral — the user retries by typing).
//
//  - "rollback": DELETE the incomplete trailing turn (the assistant tool-call
//    message and every message after it) so the transcript ends at the prior
//    complete turn. On the next model round the agent re-plans and re-issues
//    the gated tool, which re-enters the gate and RE-PROMPTS. Used by the
//    durable task runner on resume — clicking Resume means "carry on and
//    re-attempt", not "tell me it was interrupted and stop" (plan 012). A
//    synthetic result would read as a finished call and the action would never
//    be retried.
export type RepairMode = "synthesize" | "rollback"

// Repair a dangling assistant tool-call tail for a conversation. No-op when the
// tail is already complete (every call answered) or there's no tool-calling
// turn. Idempotent.
export function repairDanglingToolCalls(
  conversationId: string,
  mode: RepairMode = "synthesize"
): void {
  const messages = listMessages(conversationId)
  let lastIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].toolCalls?.length) {
      lastIdx = i
      break
    }
  }
  if (lastIdx === -1) return
  const toolCalls = messages[lastIdx].toolCalls ?? []
  const answered = new Set(
    messages
      .slice(lastIdx + 1)
      .filter((m) => m.role === "tool" && m.toolCallId)
      .map((m) => m.toolCallId as string)
  )
  const unanswered = toolCalls.filter((c) => !answered.has(c.id))
  if (unanswered.length === 0) return

  if (mode === "rollback") {
    // Drop the incomplete turn entirely: the dangling assistant tool-call
    // message and everything after it (its partial tool results, if any). This
    // is the LAST assistant tool-call turn, so a blocked loop never advanced
    // past it — everything after lastIdx belongs to this same incomplete turn.
    // The transcript then ends at the prior complete turn (e.g. the user's
    // request), and the agent re-attempts from there.
    for (const m of messages.slice(lastIdx)) deleteMessage(m.id)
    return
  }

  // "synthesize": fill each unanswered call with an interrupted result.
  for (const call of unanswered) {
    appendMessage({
      conversationId,
      role: "tool",
      content: INTERRUPTED_RESULT,
      toolCallId: call.id,
      toolName: call.name,
    })
  }
}

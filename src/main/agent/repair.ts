import { appendMessage, listMessages } from "../db/repositories/messages"
import {
  listToolCallLifecycle,
  markToolCallNotStarted,
  markToolCallUnknown,
} from "../db/repositories/tool-call-lifecycle"
import { getToolEffects } from "./tools"
import type { ToolCallLifecycle, ToolCallRecord } from "../db/types"

// The synthetic result appended (in "synthesize" mode) for a tool call that
// never produced one. The model API requires a `tool` message for every
// tool_call_id, so a half-finished turn would otherwise 400 the next request.
export const INTERRUPTED_RESULT =
  "Interrupted before completion; result unknown."

export const NOT_STARTED_RESULT =
  "Interrupted before tool execution started; retry or re-request approval if still needed."

function isSideEffecting(call: ToolCallRecord): boolean {
  const effects = getToolEffects(call.name)
  return !effects || !effects.readOnly
}

export function unknownSideEffectingToolCalls(
  conversationId: string
): ToolCallRecord[] {
  const messages = listMessages(conversationId)
  const lifecycleByToolCallId = new Map(
    listToolCallLifecycle(conversationId).map((row) => [row.toolCallId, row])
  )
  const byToolCallId = new Map(
    messages
      .filter((m) => m.role === "tool" && m.toolCallId)
      .map((m) => [m.toolCallId as string, m])
  )
  const unknown: ToolCallRecord[] = []
  for (const message of messages) {
    if (message.role !== "assistant" || !message.toolCalls?.length) continue
    for (const call of message.toolCalls) {
      if (!isSideEffecting(call)) continue
      const lifecycle = lifecycleByToolCallId.get(call.id)
      if (lifecycle?.state === "settled_success") continue
      if (lifecycle?.state === "unknown") {
        unknown.push(call)
        continue
      }
      if (lifecycle?.state === "started") {
        unknown.push(call)
        continue
      }
      if (
        lifecycle?.state === "prepared" ||
        lifecycle?.state === "waiting_for_approval" ||
        lifecycle?.state === "not_started" ||
        lifecycle?.state === "settled_error"
      ) {
        continue
      }
      const result = byToolCallId.get(call.id)
      if (!result || result.content === INTERRUPTED_RESULT) unknown.push(call)
    }
  }
  return unknown
}

function recoveredToolResult(lifecycle: ToolCallLifecycle | undefined): {
  content: string
  markNotStarted: boolean
  markUnknown: boolean
} {
  if (!lifecycle)
    return {
      content: INTERRUPTED_RESULT,
      markNotStarted: false,
      markUnknown: true,
    }
  if (lifecycle.state === "settled_success") {
    return {
      content: lifecycle.result ?? "",
      markNotStarted: false,
      markUnknown: false,
    }
  }
  if (lifecycle.state === "settled_error") {
    return {
      content: lifecycle.result ?? lifecycle.error ?? INTERRUPTED_RESULT,
      markNotStarted: false,
      markUnknown: false,
    }
  }
  if (
    lifecycle.state === "prepared" ||
    lifecycle.state === "waiting_for_approval" ||
    lifecycle.state === "not_started"
  ) {
    return {
      content: lifecycle.result ?? NOT_STARTED_RESULT,
      markNotStarted: lifecycle.state === "prepared",
      markUnknown: false,
    }
  }
  return {
    content: INTERRUPTED_RESULT,
    markNotStarted: false,
    markUnknown: true,
  }
}

// How to repair a dangling assistant tool-call tail — a turn left with tool
// calls that never produced results (the app quit, or a turn was abandoned,
// while a call was in flight, e.g. parked on an approval gate).
//
// Both modes preserve the assistant tool-call turn and any completed sibling
// results. Deleting the turn erases durable evidence that a side-effecting call
// may already have started, and can make a resumed task re-plan the same action
// with a fresh tool-call id. Instead, append a synthetic "interrupted" result for
// each unanswered call so the transcript stays API-valid and recovery guards can
// see that a side-effecting outcome is unknown.
//
// "rollback" remains as a compatibility spelling for durable task callers that
// used to request deletion. It now means "repair without erasing evidence".
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

  void mode

  const lifecycleByToolCallId = new Map(
    listToolCallLifecycle(conversationId).map((row) => [row.toolCallId, row])
  )

  // Fill each unanswered call with an interrupted result.
  for (const call of unanswered) {
    const recovered = recoveredToolResult(lifecycleByToolCallId.get(call.id))
    if (recovered.markNotStarted) {
      markToolCallNotStarted({
        conversationId,
        toolCallId: call.id,
        result: recovered.content,
      })
    }
    if (recovered.markUnknown) {
      markToolCallUnknown({
        conversationId,
        toolCallId: call.id,
        error: recovered.content,
      })
    }
    appendMessage({
      conversationId,
      role: "tool",
      content: recovered.content,
      toolCallId: call.id,
      toolName: call.name,
    })
  }
}

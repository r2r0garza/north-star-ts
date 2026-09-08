import { createHash, randomUUID } from "crypto"
import { getDb } from "../connection"
import type {
  ToolCallLifecycle,
  ToolCallLifecycleState,
  ToolCallRecord,
} from "../types"

interface ToolCallLifecycleRow {
  id: string
  conversation_id: string
  assistant_message_id: string | null
  logical_round_id: string
  tool_call_id: string
  tool_name: string
  arguments: string
  invocation_id: string
  identity: string
  state: ToolCallLifecycleState
  result: string | null
  error: string | null
  prepared_at: number
  waiting_at: number | null
  started_at: number | null
  settled_at: number | null
  updated_at: number
}

function toLifecycle(row: ToolCallLifecycleRow): ToolCallLifecycle {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    assistantMessageId: row.assistant_message_id,
    logicalRoundId: row.logical_round_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    arguments: row.arguments,
    invocationId: row.invocation_id,
    identity: row.identity,
    state: row.state,
    result: row.result,
    error: row.error,
    preparedAt: row.prepared_at,
    waitingAt: row.waiting_at,
    startedAt: row.started_at,
    settledAt: row.settled_at,
    updatedAt: row.updated_at,
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortJson(child)])
  )
}

export function normalizeToolCallIdentity(call: ToolCallRecord): string {
  try {
    return JSON.stringify({
      name: call.name,
      arguments: sortJson(JSON.parse(call.arguments || "{}")),
    })
  } catch {
    return JSON.stringify({ name: call.name, arguments: call.arguments })
  }
}

export function stableToolInvocationId(input: {
  conversationId: string
  identity: string
}): string {
  const digest = createHash("sha256")
    .update(input.conversationId)
    .update("\0")
    .update(input.identity)
    .digest("hex")
    .slice(0, 32)
  return `toolinv_${digest}`
}

export function normalizeToolActionIdentity(input: {
  kind: string
  identity: string
}): string {
  return JSON.stringify({
    action: input.kind,
    identity: input.identity,
  })
}

export function recordToolCallIntents(input: {
  conversationId: string
  assistantMessageId?: string | null
  logicalRoundId: string
  calls: ToolCallRecord[]
  now?: number
}): ToolCallLifecycle[] {
  const now = input.now ?? Date.now()
  const db = getDb()
  const tx = db.transaction(() => {
    for (const call of input.calls) {
      const identity = normalizeToolCallIdentity(call)
      const invocationId = stableToolInvocationId({
        conversationId: input.conversationId,
        identity,
      })
      db.prepare(
        `INSERT INTO tool_call_lifecycle
          (id, conversation_id, assistant_message_id, logical_round_id,
           tool_call_id, tool_name, arguments, invocation_id, identity, state, result, error,
           prepared_at, waiting_at, started_at, settled_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, NULL, ?, NULL, NULL, NULL, ?)
         ON CONFLICT(conversation_id, tool_call_id) DO UPDATE SET
           assistant_message_id = COALESCE(tool_call_lifecycle.assistant_message_id, excluded.assistant_message_id),
           logical_round_id = excluded.logical_round_id,
           tool_name = excluded.tool_name,
           arguments = excluded.arguments,
           invocation_id = excluded.invocation_id,
           identity = excluded.identity,
           updated_at = excluded.updated_at`
      ).run(
        randomUUID(),
        input.conversationId,
        input.assistantMessageId ?? null,
        input.logicalRoundId,
        call.id,
        call.name,
        call.arguments,
        invocationId,
        identity,
        now,
        now
      )
    }
    return listToolCallLifecycle(input.conversationId)
  })
  return tx()
}

export function updateToolCallOperationIdentity(input: {
  conversationId: string
  toolCallId: string
  identity: string
  now?: number
}): ToolCallLifecycle | undefined {
  const now = input.now ?? Date.now()
  const invocationId = stableToolInvocationId({
    conversationId: input.conversationId,
    identity: input.identity,
  })
  getDb()
    .prepare(
      `UPDATE tool_call_lifecycle
       SET identity = ?,
           invocation_id = ?,
           updated_at = ?
       WHERE conversation_id = ? AND tool_call_id = ?
         AND state NOT IN ('settled_success','settled_error','not_started','unknown')`
    )
    .run(
      input.identity,
      invocationId,
      now,
      input.conversationId,
      input.toolCallId
    )
  return getToolCallLifecycle(input.conversationId, input.toolCallId)
}

export function findPriorToolCallLifecycleByInvocation(input: {
  conversationId: string
  invocationId: string
  excludeToolCallId?: string
}): ToolCallLifecycle[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM tool_call_lifecycle
       WHERE conversation_id = ?
         AND invocation_id = ?
         AND (? IS NULL OR tool_call_id != ?)
       ORDER BY updated_at DESC, prepared_at DESC, rowid DESC`
    )
    .all(
      input.conversationId,
      input.invocationId,
      input.excludeToolCallId ?? null,
      input.excludeToolCallId ?? null
    ) as ToolCallLifecycleRow[]
  return rows.map(toLifecycle)
}

export function markToolCallWaitingForApproval(input: {
  conversationId: string
  toolCallId: string
  now?: number
}): ToolCallLifecycle | undefined {
  return updateState({
    ...input,
    state: "waiting_for_approval",
    timestampColumn: "waiting_at",
  })
}

export function markToolCallStarted(input: {
  conversationId: string
  toolCallId: string
  now?: number
}): ToolCallLifecycle | undefined {
  return updateState({
    ...input,
    state: "started",
    timestampColumn: "started_at",
  })
}

export function markToolCallUnknown(input: {
  conversationId: string
  toolCallId: string
  error?: string | null
  now?: number
}): ToolCallLifecycle | undefined {
  const now = input.now ?? Date.now()
  getDb()
    .prepare(
      `UPDATE tool_call_lifecycle
       SET state = 'unknown',
           error = COALESCE(?, error),
           updated_at = ?
       WHERE conversation_id = ? AND tool_call_id = ?
         AND state NOT IN ('settled_success','settled_error','not_started','unknown')`
    )
    .run(input.error ?? null, now, input.conversationId, input.toolCallId)
  return getToolCallLifecycle(input.conversationId, input.toolCallId)
}

export function markToolCallNotStarted(input: {
  conversationId: string
  toolCallId: string
  result?: string | null
  now?: number
}): ToolCallLifecycle | undefined {
  const now = input.now ?? Date.now()
  getDb()
    .prepare(
      `UPDATE tool_call_lifecycle
       SET state = 'not_started',
           result = COALESCE(?, result),
           updated_at = ?
       WHERE conversation_id = ? AND tool_call_id = ?
         AND state IN ('prepared','waiting_for_approval')`
    )
    .run(input.result ?? null, now, input.conversationId, input.toolCallId)
  return getToolCallLifecycle(input.conversationId, input.toolCallId)
}

export function markToolCallSettled(input: {
  conversationId: string
  toolCallId: string
  state: "settled_success" | "settled_error"
  result?: string | null
  error?: string | null
  now?: number
}): ToolCallLifecycle | undefined {
  const now = input.now ?? Date.now()
  getDb()
    .prepare(
      `UPDATE tool_call_lifecycle
       SET state = ?,
           result = ?,
           error = ?,
           settled_at = ?,
           updated_at = ?
       WHERE conversation_id = ? AND tool_call_id = ?
         AND state NOT IN ('settled_success','settled_error','not_started','unknown')`
    )
    .run(
      input.state,
      input.result ?? null,
      input.error ?? null,
      now,
      now,
      input.conversationId,
      input.toolCallId
    )
  return getToolCallLifecycle(input.conversationId, input.toolCallId)
}

function updateState(input: {
  conversationId: string
  toolCallId: string
  state: ToolCallLifecycleState
  timestampColumn: "waiting_at" | "started_at"
  now?: number
}): ToolCallLifecycle | undefined {
  const now = input.now ?? Date.now()
  getDb()
    .prepare(
      `UPDATE tool_call_lifecycle
       SET state = ?,
           ${input.timestampColumn} = COALESCE(${input.timestampColumn}, ?),
           updated_at = ?
       WHERE conversation_id = ? AND tool_call_id = ?
         AND state NOT IN ('settled_success','settled_error','not_started','unknown')`
    )
    .run(input.state, now, now, input.conversationId, input.toolCallId)
  return getToolCallLifecycle(input.conversationId, input.toolCallId)
}

export function getToolCallLifecycle(
  conversationId: string,
  toolCallId: string
): ToolCallLifecycle | undefined {
  const row = getDb()
    .prepare(
      "SELECT * FROM tool_call_lifecycle WHERE conversation_id = ? AND tool_call_id = ?"
    )
    .get(conversationId, toolCallId) as ToolCallLifecycleRow | undefined
  return row ? toLifecycle(row) : undefined
}

export function listToolCallLifecycle(
  conversationId: string
): ToolCallLifecycle[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM tool_call_lifecycle
       WHERE conversation_id = ?
       ORDER BY prepared_at ASC, rowid ASC`
    )
    .all(conversationId) as ToolCallLifecycleRow[]
  return rows.map(toLifecycle)
}

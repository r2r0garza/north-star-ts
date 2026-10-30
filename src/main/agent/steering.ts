import type {
  SteeringInput,
  SteeringMessage,
  SteeringState,
} from "../../shared/steering"
import { getDb } from "../db/connection"

interface Session {
  runId: string
  notify: (state: SteeringState) => void
  wake?: () => void
  validate?: (input: SteeringInput) => void
}
const sessions = new Map<string, Session>()

export function steeringState(conversationId: string): SteeringState {
  const session = sessions.get(conversationId)
  const rows = getDb()
    .prepare(
      "SELECT id, run_id, payload, status, created_at FROM steering_messages WHERE conversation_id = ? AND status IN ('queued', 'returned') ORDER BY created_at, rowid"
    )
    .all(conversationId) as Array<{
    id: string
    run_id: string
    payload: string
    status: "queued" | "returned"
    created_at: number
  }>
  return {
    runId: session?.runId ?? null,
    messages: rows.map((row) => ({
      ...JSON.parse(row.payload),
      id: row.id,
      conversationId,
      runId: row.run_id,
      createdAt: row.created_at,
      status:
        row.status === "queued" && session?.runId === row.run_id
          ? "queued"
          : "returned",
    })),
  }
}

function publish(conversationId: string): SteeringState {
  const state = steeringState(conversationId)
  sessions.get(conversationId)?.notify(state)
  return state
}

export function openSteering(
  conversationId: string,
  runId: string,
  notify: Session["notify"]
): () => void {
  getDb()
    .prepare(
      "UPDATE steering_messages SET status = 'returned' WHERE conversation_id = ? AND status = 'queued'"
    )
    .run(conversationId)
  sessions.set(conversationId, { runId, notify })
  publish(conversationId)
  return () => {
    if (sessions.get(conversationId)?.runId !== runId) return
    getDb()
      .prepare(
        "UPDATE steering_messages SET status = 'returned' WHERE conversation_id = ? AND run_id = ? AND status = 'queued'"
      )
      .run(conversationId, runId)
    sessions.delete(conversationId)
    notify(steeringState(conversationId))
  }
}

export function queueSteering(
  conversationId: string,
  runId: string,
  input: SteeringInput
): SteeringState {
  const session = sessions.get(conversationId)
  if (!session || session.runId !== runId)
    throw new Error("The agent is no longer running. Send this message again.")
  if (
    !input ||
    typeof input.id !== "string" ||
    !input.id ||
    typeof input.message !== "string" ||
    !input.message.trim() ||
    !Array.isArray(input.attachments) ||
    !input.attachments.every((v) => typeof v === "string") ||
    !Array.isArray(input.skills) ||
    !input.skills.every((v) => typeof v === "string")
  )
    throw new Error("Invalid steering message.")
  session.validate?.(input)
  const existing = getDb()
    .prepare(
      "SELECT conversation_id, run_id FROM steering_messages WHERE id = ?"
    )
    .get(input.id) as { conversation_id: string; run_id: string } | undefined
  if (
    existing &&
    (existing.conversation_id !== conversationId || existing.run_id !== runId)
  )
    throw new Error("Invalid steering message ID.")
  if (!existing)
    getDb()
      .prepare(
        "INSERT INTO steering_messages (id, conversation_id, run_id, payload, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)"
      )
      .run(input.id, conversationId, runId, JSON.stringify(input), Date.now())
  const state = publish(conversationId)
  session.wake?.()
  return state
}

export function cancelSteering(
  conversationId: string,
  id: string
): SteeringState {
  getDb()
    .prepare(
      "UPDATE steering_messages SET status = 'cancelled' WHERE id = ? AND conversation_id = ? AND status IN ('queued', 'returned')"
    )
    .run(id, conversationId)
  return publish(conversationId)
}

export function consumeSteering(
  conversationId: string,
  deliver: (message: SteeringMessage) => void
): boolean {
  const session = sessions.get(conversationId)
  if (!session) return false
  const pending = steeringState(conversationId).messages.filter(
    (message) => message.status === "queued"
  )
  for (const message of pending) {
    getDb().transaction(() => {
      deliver(message)
      getDb()
        .prepare(
          "UPDATE steering_messages SET status = 'delivered' WHERE id = ? AND status = 'queued'"
        )
        .run(message.id)
    })()
  }
  if (pending.length) publish(conversationId)
  return pending.length > 0
}

export function setSteeringWake(
  conversationId: string,
  wake: () => void
): () => void {
  const session = sessions.get(conversationId)
  if (!session) return () => {}
  session.wake = wake
  if (
    steeringState(conversationId).messages.some(
      (message) => message.status === "queued"
    )
  )
    wake()
  return () => {
    if (session.wake === wake) session.wake = undefined
  }
}

export function validateSteeringWith(
  conversationId: string,
  validate: NonNullable<Session["validate"]>
): void {
  const session = sessions.get(conversationId)
  if (session) session.validate = validate
}

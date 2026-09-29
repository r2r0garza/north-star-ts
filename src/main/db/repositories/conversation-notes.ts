import { randomUUID } from "crypto"
import { getDb } from "../connection"

// Notes for a conversation that's mid-turn (a running agent): the agent loop
// picks them up before its next model round, so a running phase can be
// steered without cancelling it. From the user (a nudge) or from Mission
// Control (a phase running long, a Refocus reminder, a retracted lesson).
export type ConversationNoteSource = "user" | "mission-control" | "refocus"

export interface ConversationNote {
  id: string
  conversationId: string
  body: string
  source: ConversationNoteSource
  createdAt: number
}

export function addConversationNote(
  conversationId: string,
  body: string,
  source: ConversationNoteSource
): ConversationNote {
  const note = {
    id: randomUUID(),
    conversationId,
    body: body.trim(),
    source,
    createdAt: Date.now(),
  }
  getDb()
    .prepare(
      "INSERT INTO conversation_notes (id, conversation_id, body, source, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(note.id, conversationId, note.body, source, note.createdAt)
  return note
}

// Undelivered notes, oldest first, marked delivered as they're taken.
export function takeConversationNotes(
  conversationId: string
): ConversationNote[] {
  const db = getDb()
  return db.transaction(() => {
    const rows = db
      .prepare(
        "SELECT id, conversation_id, body, source, created_at FROM conversation_notes WHERE conversation_id = ? AND delivered_at IS NULL ORDER BY created_at"
      )
      .all(conversationId) as Array<{
      id: string
      conversation_id: string
      body: string
      source: ConversationNoteSource
      created_at: number
    }>
    if (rows.length)
      db.prepare(
        `UPDATE conversation_notes SET delivered_at = ? WHERE id IN (${rows.map(() => "?").join(",")})`
      ).run(Date.now(), ...rows.map((r) => r.id))
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      body: r.body,
      source: r.source,
      createdAt: r.created_at,
    }))
  })()
}

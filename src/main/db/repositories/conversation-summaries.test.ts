import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { runMigrations } from "../migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

// Back the repo with an in-memory SQLite DB (real schema, real migrations)
// instead of the app's on-disk connection, which needs an Electron context.
let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

// better-sqlite3 ships a native binary built for ONE Node ABI (Electron here).
// Under plain-Node vitest it may fail to load; skip the DB-backed tests rather
// than fail when the ABI mismatches.

import {
  getConversationSummary,
  upsertConversationSummary,
  deleteConversationSummary,
} from "./conversation-summaries"

function freshConversation(): string {
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    "INSERT INTO conversations (id, mode, title, workspace_id, created_at, updated_at) VALUES (?, 'north_star', NULL, NULL, ?, ?)"
  ).run(id, now, now)
  return id
}

describe.skipIf(!sqliteLoads)("conversation-summaries repository", () => {
  beforeEach(() => {
    db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
  })

  it("returns undefined when no summary exists", () => {
    const convId = freshConversation()
    expect(getConversationSummary(convId)).toBeUndefined()
  })

  it("inserts and reads back a summary", () => {
    const convId = freshConversation()
    const record = upsertConversationSummary({
      conversationId: convId,
      summary: "## Decisions\n- chose sqlite",
      coversThrough: 12,
      messageCount: 12,
      tokenEstimate: 42,
    })
    expect(record.summary).toContain("chose sqlite")
    expect(record.coversThrough).toBe(12)
    expect(record.messageCount).toBe(12)
    expect(record.tokenEstimate).toBe(42)

    const read = getConversationSummary(convId)
    expect(read?.summary).toContain("chose sqlite")
    expect(read?.coversThrough).toBe(12)
  })

  it("upserts in place (one row, advancing coverage)", () => {
    const convId = freshConversation()
    upsertConversationSummary({
      conversationId: convId,
      summary: "first",
      coversThrough: 5,
      messageCount: 5,
    })
    const second = upsertConversationSummary({
      conversationId: convId,
      summary: "second",
      coversThrough: 20,
      messageCount: 20,
    })
    expect(second.summary).toBe("second")
    expect(second.coversThrough).toBe(20)

    const count = db
      .prepare(
        "SELECT COUNT(*) AS n FROM conversation_summaries WHERE conversation_id = ?"
      )
      .get(convId) as { n: number }
    expect(count.n).toBe(1)
  })

  it("null token estimate round-trips", () => {
    const convId = freshConversation()
    const record = upsertConversationSummary({
      conversationId: convId,
      summary: "no cost",
      coversThrough: 3,
      messageCount: 3,
    })
    expect(record.tokenEstimate).toBeNull()
  })

  it("deletes a summary", () => {
    const convId = freshConversation()
    upsertConversationSummary({
      conversationId: convId,
      summary: "gone soon",
      coversThrough: 1,
      messageCount: 1,
    })
    deleteConversationSummary(convId)
    expect(getConversationSummary(convId)).toBeUndefined()
  })

  it("cascades on conversation delete", () => {
    const convId = freshConversation()
    upsertConversationSummary({
      conversationId: convId,
      summary: "cascade me",
      coversThrough: 1,
      messageCount: 1,
    })
    db.prepare("DELETE FROM conversations WHERE id = ?").run(convId)
    expect(getConversationSummary(convId)).toBeUndefined()
  })
})

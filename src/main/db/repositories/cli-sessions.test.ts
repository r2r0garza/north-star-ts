import { beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../migrations"

let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

import { createConversation, deleteConversation } from "./conversations"
import {
  ensureCliSession,
  getCliSession,
  touchCliSession,
} from "./cli-sessions"

beforeEach(() => {
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe("cli-sessions repo", () => {
  it("creates once and reuses the same conversation session", () => {
    const conversation = createConversation({ mode: "chat" })
    const first = ensureCliSession(conversation.id, "claude_code")
    const second = ensureCliSession(conversation.id, "claude_code")
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.session.sessionId).toBe(first.session.sessionId)
    touchCliSession(conversation.id, "claude_code")
    expect(getCliSession(conversation.id, "claude_code")).toBeTruthy()
  })

  it("cascades with its conversation", () => {
    const conversation = createConversation({ mode: "interactive" })
    ensureCliSession(conversation.id, "claude_code")
    deleteConversation(conversation.id)
    expect(getCliSession(conversation.id, "claude_code")).toBeUndefined()
  })
})

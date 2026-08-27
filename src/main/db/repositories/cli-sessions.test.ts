import { beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

// better-sqlite3's native binary is built for the Electron ABI here; under
// plain-Node vitest it may not load (see native-module-rebuild note). SQLite-
// backed tests skip rather than fail when the ABI mismatches.

import { createConversation, deleteConversation } from "./conversations"
import {
  ensureCliSession,
  getCliSession,
  touchCliSession,
} from "./cli-sessions"

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)("cli-sessions repo", () => {
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

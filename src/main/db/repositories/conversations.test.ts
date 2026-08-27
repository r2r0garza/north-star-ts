import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

import {
  createConversation,
  getConversation,
  updateConversation,
  listConversations,
} from "./conversations"
import { createTask } from "./tasks"

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)(
  "conversations — per-conversation LLM selection",
  () => {
    it("defaults a new conversation's account/model to null (inherit default)", () => {
      const c = createConversation({ mode: "chat" })
      expect(c.accountId).toBeNull()
      expect(c.modelId).toBeNull()
    })

    it("persists an explicit selection at create time", () => {
      const c = createConversation({
        mode: "chat",
        accountId: "acc-1",
        modelId: "model-x",
      })
      expect(getConversation(c.id)?.accountId).toBe("acc-1")
      expect(getConversation(c.id)?.modelId).toBe("model-x")
    })

    it("updates the selection and can clear it back to null", () => {
      const c = createConversation({ mode: "north_star" })
      updateConversation(c.id, { accountId: "acc-2", modelId: "model-y" })
      expect(getConversation(c.id)?.modelId).toBe("model-y")
      updateConversation(c.id, { accountId: null, modelId: null })
      expect(getConversation(c.id)?.accountId).toBeNull()
      expect(getConversation(c.id)?.modelId).toBeNull()
    })

    it("leaves the selection untouched when updating only the title", () => {
      const c = createConversation({
        mode: "chat",
        accountId: "acc-1",
        modelId: "model-x",
      })
      updateConversation(c.id, { title: "Renamed" })
      const updated = getConversation(c.id)!
      expect(updated.title).toBe("Renamed")
      expect(updated.accountId).toBe("acc-1")
      expect(updated.modelId).toBe("model-x")
    })
  }
)

describe.skipIf(!sqliteLoads)("listConversations — sidebar visibility", () => {
  const has = (id: string) => listConversations().some((c) => c.id === id)

  it("lists a plain conversation with no backing task", () => {
    const c = createConversation({ mode: "chat" })
    expect(has(c.id)).toBe(true)
  })

  it("hides a forked worker transcript (a non-inline_todos task's conversation)", () => {
    const source = createConversation({ mode: "interactive" })
    const worker = createConversation({ mode: "interactive" })
    // A durable todo_run fork: its own conversation, sourced from `source`.
    createTask({
      conversationId: worker.id,
      sourceConversationId: source.id,
      status: "queued",
      input: { kind: "todo_run" },
    })
    expect(has(worker.id)).toBe(false) // the worker fork is hidden
    expect(has(source.id)).toBe(true) // the source stays visible
  })

  it("keeps a real conversation visible when it has an inline_todos marker", () => {
    // Regression: finishing an inline todo list writes a self-sourced
    // inline_todos task onto the REAL conversation. It must NOT be hidden.
    const c = createConversation({ mode: "north_star" })
    createTask({
      conversationId: c.id,
      status: "completed",
      input: { kind: "inline_todos", todos: [] },
    })
    expect(has(c.id)).toBe(true)
  })

  it("hides workspace_index / summarize worker conversations", () => {
    for (const kind of ["workspace_index", "summarize"]) {
      const w = createConversation({ mode: "interactive" })
      createTask({
        conversationId: w.id,
        sourceConversationId: null,
        status: "completed",
        input: { kind },
      })
      expect(has(w.id)).toBe(false)
    }
  })
})

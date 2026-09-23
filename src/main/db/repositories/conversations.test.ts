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
  setConversationTitleIfUntitled,
  subscribeConversationChanges,
  listConversations,
  searchConversations,
  deleteConversation,
} from "./conversations"
import { createTask } from "./tasks"
import { appendMessage, deleteMessage } from "./messages"

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)("conversations — change events", () => {
  it("publishes committed mutations", () => {
    const events: string[][] = []
    const unsubscribe = subscribeConversationChanges((event) => {
      events.push(event.conversationIds)
    })

    const conversation = createConversation({ mode: "chat" })
    updateConversation(conversation.id, { title: "Renamed" })
    unsubscribe()
    updateConversation(conversation.id, { title: "Not observed" })

    expect(events).toEqual([[conversation.id], [conversation.id]])
  })

  it("does not replace a title assigned while generation was in flight", () => {
    const conversation = createConversation({ mode: "chat" })
    updateConversation(conversation.id, { title: "Manual title" })

    const unchanged = setConversationTitleIfUntitled(
      conversation.id,
      "Generated title"
    )

    expect(unchanged?.title).toBe("Manual title")
  })
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

describe.skipIf(!sqliteLoads)("searchConversations", () => {
  it("searches titles case-insensitively and ranks title matches before content", () => {
    const content = createConversation({ mode: "chat", title: "Notes" })
    appendMessage({
      conversationId: content.id,
      role: "user",
      content: "We should discuss Project Aurora tomorrow.",
    })
    const title = createConversation({
      mode: "interactive",
      title: "Project Aurora",
    })

    const results = searchConversations("PROJECT AUR")

    expect(results.map((result) => result.conversationId)).toEqual([
      title.id,
      content.id,
    ])
    expect(results[0].matchKind).toBe("title")
    expect(results[1].snippet).toContain("\u0001Aur\u0002ora")
    expect(results[1].targetMessageId).toBeDefined()
    expect(results[0].targetMessageId).toBeNull()
  })

  it("combines query terms across title and visible transcript content", () => {
    const conversation = createConversation({
      mode: "north_star",
      title: "Release planning",
    })
    appendMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: "The deployment checklist is ready.",
    })

    const [result] = searchConversations("release deploy")

    expect(result.conversationId).toBe(conversation.id)
    expect(result.matchKind).toBe("title_and_content")
  })

  it("returns one result per conversation and excludes internal text", () => {
    const visible = createConversation({ mode: "chat", title: "Visible" })
    appendMessage({
      conversationId: visible.id,
      role: "user",
      content: "needle one",
    })
    appendMessage({
      conversationId: visible.id,
      role: "assistant",
      content: "needle two",
    })
    const hidden = createConversation({ mode: "chat", title: "Hidden" })
    appendMessage({
      conversationId: hidden.id,
      role: "system",
      content: "needle",
    })
    appendMessage({
      conversationId: hidden.id,
      role: "tool",
      content: "needle",
    })
    appendMessage({
      conversationId: hidden.id,
      role: "assistant",
      content: "Ordinary reply",
      toolCalls: [{ id: "call", name: "tool", arguments: "needle" }],
    })

    expect(
      searchConversations("needle").map((result) => result.conversationId)
    ).toEqual([visible.id])
  })

  it("shares sidebar worker visibility while retaining inline todo conversations", () => {
    const worker = createConversation({
      mode: "interactive",
      title: "Secret worker",
    })
    createTask({
      conversationId: worker.id,
      status: "completed",
      input: { kind: "summarize" },
    })
    const inline = createConversation({
      mode: "north_star",
      title: "Visible marker",
    })
    createTask({
      conversationId: inline.id,
      status: "completed",
      input: { kind: "inline_todos", todos: [] },
    })

    expect(searchConversations("worker")).toEqual([])
    expect(searchConversations("marker")[0].conversationId).toBe(inline.id)
  })

  it("handles invalid input, clamps limits, and removes deleted rows", () => {
    expect(searchConversations("***")).toEqual([])
    const conversations = Array.from({ length: 55 }, (_, index) =>
      createConversation({ mode: "chat", title: `Bounded result ${index}` })
    )
    expect(searchConversations("bounded", { limit: 999 })).toHaveLength(50)

    const message = appendMessage({
      conversationId: conversations[0].id,
      role: "user",
      content: "ephemeral transcript",
    })
    expect(searchConversations("ephemeral")).toHaveLength(1)
    deleteMessage(message.id)
    expect(searchConversations("ephemeral")).toEqual([])
    deleteConversation(conversations[1].id)
    expect(
      searchConversations("result 1").some(
        (r) => r.conversationId === conversations[1].id
      )
    ).toBe(false)
  })
})

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

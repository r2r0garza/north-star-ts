import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { runMigrations } from "../migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

import { appendMessage } from "./messages"
import { createTask } from "./tasks"
import {
  conversationRead,
  conversationSearch,
  conversationTreeSearch,
} from "./conversation-recall"

function freshConversation(): string {
  const id = randomUUID()
  db.prepare(
    "INSERT INTO conversations (id, mode, title, workspace_id, created_at, updated_at) VALUES (?, 'interactive', NULL, NULL, 0, 0)"
  ).run(id)
  return id
}

function message(conversationId: string, content: string): void {
  appendMessage(
    { conversationId, role: "user", content },
    { count: () => 1 }
  )
}

describe.skipIf(!sqliteLoads)("conversation recall repository", () => {
  beforeEach(() => {
    db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
  })

  it("searches only the current conversation by default", () => {
    const current = freshConversation()
    const other = freshConversation()
    message(current, "alpha needle")
    message(other, "other needle")

    const hits = conversationSearch(current, "needle")
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      conversationId: current,
      source: "current",
      seq: 1,
      role: "user",
    })
  })

  it("applies role and sequence filters", () => {
    const conversation = freshConversation()
    message(conversation, "needle early")
    appendMessage(
      { conversationId: conversation, role: "assistant", content: "needle late" },
      { count: () => 1 }
    )

    const hits = conversationSearch(conversation, "needle", {
      roles: ["assistant"],
      afterSeq: 1,
    })
    expect(hits.map((hit) => hit.seq)).toEqual([2])
  })

  it("reads exact current-conversation messages in chronological order", () => {
    const conversation = freshConversation()
    message(conversation, "first")
    appendMessage(
      {
        conversationId: conversation,
        role: "assistant",
        content: "second",
        toolCalls: [{ id: "call-1", name: "search_tool", arguments: "{}" }],
      },
      { count: () => 1 }
    )
    message(conversation, "third")

    const rows = conversationRead(conversation, 1, 3, 2)
    expect(rows.map((row) => [row.seq, row.content])).toEqual([
      [1, "first"],
      [2, "second"],
    ])
    expect(rows[1].toolCalls?.[0].name).toBe("search_tool")
  })

  it("searches task and nested subagent descendants without reaching siblings", () => {
    const current = freshConversation()
    const taskWorker = freshConversation()
    const subagentWorker = freshConversation()
    const sibling = freshConversation()
    createTask({
      conversationId: taskWorker,
      sourceConversationId: current,
      input: { kind: "todo_run" },
    })
    createTask({
      conversationId: subagentWorker,
      sourceConversationId: taskWorker,
      input: { kind: "subagent" },
    })
    createTask({
      conversationId: sibling,
      sourceConversationId: freshConversation(),
      input: { kind: "todo_run" },
    })

    message(current, "root needle")
    message(taskWorker, "task needle")
    message(subagentWorker, "subagent needle")
    message(sibling, "sibling needle")

    const hits = conversationTreeSearch(current, "needle")
    expect(hits.map((hit) => hit.source).sort()).toEqual([
      "current",
      "subagent",
      "task",
    ])
    expect(hits.some((hit) => hit.conversationId === sibling)).toBe(false)
  })

  it("can exclude task or subagent result classes", () => {
    const current = freshConversation()
    const taskWorker = freshConversation()
    const subagentWorker = freshConversation()
    createTask({
      conversationId: taskWorker,
      sourceConversationId: current,
      input: { kind: "todo_run" },
    })
    createTask({
      conversationId: subagentWorker,
      sourceConversationId: current,
      input: { kind: "subagent" },
    })
    message(current, "shared needle")
    message(taskWorker, "shared needle")
    message(subagentWorker, "shared needle")

    const hits = conversationTreeSearch(current, "needle", {
      includeTasks: false,
    })
    expect(hits.map((hit) => hit.source).sort()).toEqual([
      "current",
      "subagent",
    ])
  })

  it("parameterizes unsafe FTS input", () => {
    const conversation = freshConversation()
    message(conversation, "literal token")

    expect(() =>
      conversationSearch(conversation, "token' OR conversation_id:*")
    ).not.toThrow()
  })
})

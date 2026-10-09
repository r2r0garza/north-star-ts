import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

import { appendMessage, getMessage, listMessagesAfterSeq } from "./messages"
import { ContextBuilder } from "../../agent/context/context-builder"
import {
  nativeAssistant,
  historyFingerprint,
} from "../../agent/providers/claude-subscription/native-carrier"
import { translateHistory } from "../../agent/providers/claude-subscription/history"

function insertConversation(id: string): void {
  db.prepare(
    "INSERT INTO conversations (id, mode, title, workspace_id, created_at, updated_at) VALUES (?, 'north_star', NULL, NULL, 1, 1)"
  ).run(id)
}

function insertMessage(input: {
  id: string
  conversationId: string
  seq: number
  role: "user" | "assistant"
  content: string
  toolCalls?: string
}): void {
  db.prepare(
    `INSERT INTO messages
      (id, conversation_id, seq, role, content, tool_calls, tool_call_id, tool_name, token_estimate, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`
  ).run(
    input.id,
    input.conversationId,
    input.seq,
    input.role,
    input.content,
    input.toolCalls ?? null,
    input.seq
  )
}

describe.skipIf(!sqliteLoads)("messages repository", () => {
  beforeEach(() => {
    db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
  })

  it("persists private native blocks across connection recreation and ContextBuilder replay", () => {
    insertConversation("native")
    appendMessage({
      conversationId: "native",
      role: "user",
      content: "question",
    })
    const model = "claude-sonnet-4-6"
    const blocks = [
      { type: "thinking", thinking: "private", signature: "opaque" },
      { type: "text", text: "answer" },
    ]
    const saved = appendMessage({
      conversationId: "native",
      role: "assistant",
      content: "answer",
      nativeAssistant: {
        version: 1,
        provider: "claude_subscription",
        model,
        prefix: historyFingerprint(
          translateHistory([{ role: "user", content: "question" }]).frames
        ),
        blocks,
      },
    })
    appendMessage({
      conversationId: "native",
      role: "user",
      content: "continue",
    })
    const bytes = db.serialize()
    db.close()
    db = new Database(bytes)
    expect(getMessage(saved.id)?.nativeAssistant?.blocks).toEqual(blocks)
    const messages = new ContextBuilder({ log: () => {} }).build("native", {
      baseSystemPrompt: "system",
    })
    expect(messages[2][nativeAssistant]?.blocks).toEqual(blocks)
    expect(JSON.stringify(messages)).not.toContain("opaque")
    expect(
      translateHistory(messages, undefined, model).frames[1].message.content
    ).toEqual(blocks)
    db.prepare("UPDATE messages SET content = 'edited' WHERE id = ?").run(
      saved.id
    )
    const edited = new ContextBuilder({ log: () => {} }).build("native", {
      baseSystemPrompt: "system",
    })
    expect(
      translateHistory(edited, undefined, model).frames[1].message.content
    ).toEqual([{ type: "text", text: "edited" }])
  })

  it("ignores malformed persisted carriers", () => {
    insertConversation("broken")
    const saved = appendMessage({
      conversationId: "broken",
      role: "assistant",
      content: "safe",
    })
    db.prepare("UPDATE messages SET native_assistant = ? WHERE id = ?").run(
      "{broken",
      saved.id
    )
    expect(getMessage(saved.id)?.nativeAssistant).toBeUndefined()
  })

  it("lists only the mapped conversation tail in ascending sequence order", () => {
    insertConversation("target")
    insertConversation("other")
    insertMessage({
      id: "target-4",
      conversationId: "target",
      seq: 4,
      role: "assistant",
      content: "tool request",
      toolCalls: JSON.stringify([
        { id: "call-1", name: "read_file", arguments: '{"path":"a.txt"}' },
      ]),
    })
    insertMessage({
      id: "target-2",
      conversationId: "target",
      seq: 2,
      role: "assistant",
      content: "boundary",
    })
    insertMessage({
      id: "other-3",
      conversationId: "other",
      seq: 3,
      role: "user",
      content: "unrelated",
    })
    insertMessage({
      id: "target-3",
      conversationId: "target",
      seq: 3,
      role: "user",
      content: "new question",
    })

    const messages = listMessagesAfterSeq("target", 2)

    expect(messages.map((message) => message.id)).toEqual([
      "target-3",
      "target-4",
    ])
    expect(messages[1]?.toolCalls).toEqual([
      { id: "call-1", name: "read_file", arguments: '{"path":"a.txt"}' },
    ])
    expect(listMessagesAfterSeq("target", 4)).toEqual([])
  })
})

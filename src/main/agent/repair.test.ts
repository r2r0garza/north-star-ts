import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

// In-memory DB shared by the repository imports (mirrors the runner test).
let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))

import { repairDanglingToolCalls } from "./repair"
import { appendMessage, listMessages } from "../db/repositories/messages"
import { createConversation } from "../db/repositories/conversations"

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)("repairDanglingToolCalls", () => {
  it("synthesizes a tool result for an unanswered tool_call", () => {
    const conv = createConversation({ mode: "chat" })
    // A turn abandoned mid-flight: assistant requested a tool but no result was
    // persisted before the app quit (e.g. parked on an approval gate).
    appendMessage({ conversationId: conv.id, role: "user", content: "go" })
    appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call-1", name: "run_shell", arguments: "{}" }],
    })

    repairDanglingToolCalls(conv.id)

    const toolMsgs = listMessages(conv.id).filter((m) => m.role === "tool")
    expect(toolMsgs).toHaveLength(1)
    expect(toolMsgs[0].toolCallId).toBe("call-1")
    expect(toolMsgs[0].content).toContain("Interrupted")
  })

  it("repairs only the unanswered calls in a partially-answered turn", () => {
    const conv = createConversation({ mode: "chat" })
    appendMessage({ conversationId: conv.id, role: "user", content: "go" })
    appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [
        { id: "call-1", name: "read_file_tool", arguments: "{}" },
        { id: "call-2", name: "run_shell", arguments: "{}" },
      ],
    })
    // Only the first call produced a result before the crash.
    appendMessage({
      conversationId: conv.id,
      role: "tool",
      content: "ok",
      toolCallId: "call-1",
      toolName: "read_file_tool",
    })

    repairDanglingToolCalls(conv.id)

    const toolMsgs = listMessages(conv.id).filter((m) => m.role === "tool")
    expect(toolMsgs.map((m) => m.toolCallId).sort()).toEqual([
      "call-1",
      "call-2",
    ])
    const synthesized = toolMsgs.find((m) => m.toolCallId === "call-2")
    expect(synthesized?.content).toContain("Interrupted")
  })

  it("leaves an already-answered tool_call alone (idempotent)", () => {
    const conv = createConversation({ mode: "chat" })
    appendMessage({ conversationId: conv.id, role: "user", content: "go" })
    appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call-1", name: "run_shell", arguments: "{}" }],
    })
    appendMessage({
      conversationId: conv.id,
      role: "tool",
      content: "ok",
      toolCallId: "call-1",
      toolName: "run_shell",
    })

    repairDanglingToolCalls(conv.id)
    repairDanglingToolCalls(conv.id)

    // No synthetic duplicate added on either pass.
    expect(listMessages(conv.id).filter((m) => m.role === "tool")).toHaveLength(
      1
    )
  })

  it("is a no-op when there is no tool-calling turn", () => {
    const conv = createConversation({ mode: "chat" })
    appendMessage({ conversationId: conv.id, role: "user", content: "hi" })
    appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: "hello",
    })

    repairDanglingToolCalls(conv.id)

    expect(listMessages(conv.id).filter((m) => m.role === "tool")).toHaveLength(
      0
    )
  })
})

describe.skipIf(!sqliteLoads)("repairDanglingToolCalls — rollback mode", () => {
  it("deletes the incomplete trailing turn so the agent re-attempts", () => {
    const conv = createConversation({ mode: "chat" })
    // A task parked on an approval gate at quit: the user's request and the
    // assistant's gated tool-call are persisted, but no result.
    appendMessage({
      conversationId: conv.id,
      role: "user",
      content: "delete build/",
    })
    appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: "I'll delete it.",
      toolCalls: [
        {
          id: "call-1",
          name: "run_shell",
          arguments: '{"cmd":"rm -rf build"}',
        },
      ],
    })

    repairDanglingToolCalls(conv.id, "rollback")

    // The incomplete assistant turn is gone — the transcript ends at the user
    // request, so the resumed loop re-plans and re-issues the gated tool (the
    // gate re-prompts). No synthetic tool result was inserted.
    const msgs = listMessages(conv.id)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe("user")
    expect(msgs.some((m) => m.role === "tool")).toBe(false)
  })

  it("drops partial tool results from the incomplete turn too", () => {
    const conv = createConversation({ mode: "chat" })
    appendMessage({
      conversationId: conv.id,
      role: "user",
      content: "do two things",
    })
    appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [
        { id: "call-1", name: "read_file_tool", arguments: "{}" },
        { id: "call-2", name: "run_shell", arguments: "{}" },
      ],
    })
    // The first call finished before the quit; the second was gated and never did.
    appendMessage({
      conversationId: conv.id,
      role: "tool",
      content: "ok",
      toolCallId: "call-1",
      toolName: "read_file_tool",
    })

    repairDanglingToolCalls(conv.id, "rollback")

    // The whole incomplete turn (assistant + its partial tool result) is removed.
    const msgs = listMessages(conv.id)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe("user")
  })

  it("preserves a prior complete tool turn, dropping only the dangling one", () => {
    const conv = createConversation({ mode: "chat" })
    appendMessage({ conversationId: conv.id, role: "user", content: "go" })
    // An earlier, fully-completed tool turn.
    appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call-1", name: "read_file_tool", arguments: "{}" }],
    })
    appendMessage({
      conversationId: conv.id,
      role: "tool",
      content: "file contents",
      toolCallId: "call-1",
      toolName: "read_file_tool",
    })
    // The later, interrupted tool turn (parked on a gate).
    appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call-2", name: "run_shell", arguments: "{}" }],
    })

    repairDanglingToolCalls(conv.id, "rollback")

    // The earlier complete turn stays; only the dangling tail is gone.
    const msgs = listMessages(conv.id)
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool"])
    expect(msgs[1].toolCalls?.[0].id).toBe("call-1")
  })

  it("is a no-op when the trailing tool turn is already complete", () => {
    const conv = createConversation({ mode: "chat" })
    appendMessage({ conversationId: conv.id, role: "user", content: "go" })
    appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call-1", name: "run_shell", arguments: "{}" }],
    })
    appendMessage({
      conversationId: conv.id,
      role: "tool",
      content: "ok",
      toolCallId: "call-1",
      toolName: "run_shell",
    })

    repairDanglingToolCalls(conv.id, "rollback")

    // Nothing dangling → nothing deleted.
    expect(listMessages(conv.id)).toHaveLength(3)
  })
})

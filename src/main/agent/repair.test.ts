import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

// In-memory DB shared by the repository imports (mirrors the runner test).
let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))

import {
  INTERRUPTED_RESULT,
  repairDanglingToolCalls,
  unknownSideEffectingToolCalls,
} from "./repair"
import { appendMessage, listMessages } from "../db/repositories/messages"
import { createConversation } from "../db/repositories/conversations"
import {
  getToolCallLifecycle,
  markToolCallSettled,
  markToolCallStarted,
  markToolCallWaitingForApproval,
  recordToolCallIntents,
} from "../db/repositories/tool-call-lifecycle"

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

  it("marks prepared-but-not-started calls not_started, not unknown", () => {
    const conv = createConversation({ mode: "chat" })
    appendMessage({ conversationId: conv.id, role: "user", content: "go" })
    const assistant = appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "call-1",
          name: "run_shell_tool",
          arguments: '{"cmd":"echo hi"}',
        },
      ],
    })
    recordToolCallIntents({
      conversationId: conv.id,
      assistantMessageId: assistant.id,
      logicalRoundId: "after-seq:1",
      calls: [
        {
          id: "call-1",
          name: "run_shell_tool",
          arguments: '{"cmd":"echo hi"}',
        },
      ],
    })

    repairDanglingToolCalls(conv.id)

    expect(getToolCallLifecycle(conv.id, "call-1")).toMatchObject({
      state: "not_started",
      result:
        "Interrupted before tool execution started; retry or re-request approval if still needed.",
    })
    expect(unknownSideEffectingToolCalls(conv.id)).toEqual([])
  })

  it("does not mark approval-waiting calls unknown", () => {
    const conv = createConversation({ mode: "chat" })
    appendMessage({ conversationId: conv.id, role: "user", content: "go" })
    const assistant = appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "call-1",
          name: "run_shell_tool",
          arguments: '{"cmd":"rm build"}',
        },
      ],
    })
    recordToolCallIntents({
      conversationId: conv.id,
      assistantMessageId: assistant.id,
      logicalRoundId: "after-seq:1",
      calls: [
        {
          id: "call-1",
          name: "run_shell_tool",
          arguments: '{"cmd":"rm build"}',
        },
      ],
    })
    markToolCallWaitingForApproval({
      conversationId: conv.id,
      toolCallId: "call-1",
    })

    repairDanglingToolCalls(conv.id)

    expect(getToolCallLifecycle(conv.id, "call-1")?.state).toBe(
      "waiting_for_approval"
    )
    expect(unknownSideEffectingToolCalls(conv.id)).toEqual([])
  })

  it("marks started calls without terminal evidence unknown", () => {
    const conv = createConversation({ mode: "chat" })
    appendMessage({ conversationId: conv.id, role: "user", content: "go" })
    const assistant = appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "call-1",
          name: "run_shell_tool",
          arguments: '{"cmd":"touch x"}',
        },
      ],
    })
    recordToolCallIntents({
      conversationId: conv.id,
      assistantMessageId: assistant.id,
      logicalRoundId: "after-seq:1",
      calls: [
        {
          id: "call-1",
          name: "run_shell_tool",
          arguments: '{"cmd":"touch x"}',
        },
      ],
    })
    markToolCallStarted({
      conversationId: conv.id,
      toolCallId: "call-1",
    })

    repairDanglingToolCalls(conv.id)

    expect(getToolCallLifecycle(conv.id, "call-1")?.state).toBe("unknown")
    expect(unknownSideEffectingToolCalls(conv.id)).toEqual([
      { id: "call-1", name: "run_shell_tool", arguments: '{"cmd":"touch x"}' },
    ])
  })

  it("preserves settled sibling output while marking an unresolved mutation unknown", () => {
    const conv = createConversation({ mode: "chat" })
    appendMessage({ conversationId: conv.id, role: "user", content: "go" })
    const assistant = appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "call-1",
          name: "run_shell_tool",
          arguments: '{"cmd":"echo done"}',
        },
        {
          id: "call-2",
          name: "run_shell_tool",
          arguments: '{"cmd":"touch side-effect"}',
        },
      ],
    })
    recordToolCallIntents({
      conversationId: conv.id,
      assistantMessageId: assistant.id,
      logicalRoundId: "after-seq:1",
      calls: assistant.toolCalls!,
    })
    appendMessage({
      conversationId: conv.id,
      role: "tool",
      content: "done",
      toolCallId: "call-1",
      toolName: "run_shell_tool",
    })
    markToolCallSettled({
      conversationId: conv.id,
      toolCallId: "call-1",
      state: "settled_success",
      result: "done",
    })
    markToolCallStarted({
      conversationId: conv.id,
      toolCallId: "call-2",
    })

    repairDanglingToolCalls(conv.id)

    const toolMsgs = listMessages(conv.id).filter((m) => m.role === "tool")
    expect(toolMsgs.map((m) => [m.toolCallId, m.content])).toEqual([
      ["call-1", "done"],
      ["call-2", INTERRUPTED_RESULT],
    ])
    expect(getToolCallLifecycle(conv.id, "call-1")?.state).toBe(
      "settled_success"
    )
    expect(getToolCallLifecycle(conv.id, "call-2")?.state).toBe("unknown")
    expect(unknownSideEffectingToolCalls(conv.id)).toEqual([
      {
        id: "call-2",
        name: "run_shell_tool",
        arguments: '{"cmd":"touch side-effect"}',
      },
    ])
  })

  it("replays settled lifecycle output for an unanswered call", () => {
    const conv = createConversation({ mode: "chat" })
    appendMessage({ conversationId: conv.id, role: "user", content: "go" })
    const assistant = appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "call-1",
          name: "run_shell_tool",
          arguments: '{"cmd":"echo ok"}',
        },
      ],
    })
    recordToolCallIntents({
      conversationId: conv.id,
      assistantMessageId: assistant.id,
      logicalRoundId: "after-seq:1",
      calls: [
        {
          id: "call-1",
          name: "run_shell_tool",
          arguments: '{"cmd":"echo ok"}',
        },
      ],
    })
    markToolCallSettled({
      conversationId: conv.id,
      toolCallId: "call-1",
      state: "settled_success",
      result: "ok",
    })

    repairDanglingToolCalls(conv.id)

    const toolMsgs = listMessages(conv.id).filter((m) => m.role === "tool")
    expect(toolMsgs).toHaveLength(1)
    expect(toolMsgs[0]).toMatchObject({
      toolCallId: "call-1",
      content: "ok",
    })
    expect(unknownSideEffectingToolCalls(conv.id)).toEqual([])
  })
})

describe.skipIf(!sqliteLoads)("repairDanglingToolCalls — rollback mode", () => {
  it("preserves the incomplete trailing turn and records an unknown result", () => {
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

    const msgs = listMessages(conv.id)
    expect(msgs).toHaveLength(3)
    expect(msgs[0].role).toBe("user")
    expect(msgs[1].role).toBe("assistant")
    expect(msgs[1].toolCalls?.[0].id).toBe("call-1")
    expect(msgs[2]).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
      toolName: "run_shell",
      content: INTERRUPTED_RESULT,
    })
  })

  it("preserves completed sibling results in the incomplete turn", () => {
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

    const msgs = listMessages(conv.id)
    expect(msgs.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
    ])
    expect(msgs[2]).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
      content: "ok",
    })
    expect(msgs[3]).toMatchObject({
      role: "tool",
      toolCallId: "call-2",
      content: INTERRUPTED_RESULT,
    })
  })

  it("preserves a prior complete tool turn while repairing the dangling one", () => {
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

    const msgs = listMessages(conv.id)
    expect(msgs.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
    ])
    expect(msgs[1].toolCalls?.[0].id).toBe("call-1")
    expect(msgs[4]).toMatchObject({
      role: "tool",
      toolCallId: "call-2",
      content: INTERRUPTED_RESULT,
    })
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

describe.skipIf(!sqliteLoads)("unknownSideEffectingToolCalls", () => {
  it("does not flag a prepared side-effecting call as unknown", () => {
    const conv = createConversation({ mode: "chat" })
    appendMessage({ conversationId: conv.id, role: "user", content: "go" })
    const assistant = appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call-1", name: "run_shell_tool", arguments: "{}" }],
    })
    recordToolCallIntents({
      conversationId: conv.id,
      assistantMessageId: assistant.id,
      logicalRoundId: "after-seq:1",
      calls: [{ id: "call-1", name: "run_shell_tool", arguments: "{}" }],
    })

    expect(unknownSideEffectingToolCalls(conv.id)).toEqual([])
  })

  it("uses lifecycle rows to identify a started side-effecting call", () => {
    const conv = createConversation({ mode: "chat" })
    appendMessage({ conversationId: conv.id, role: "user", content: "go" })
    const assistant = appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call-1", name: "run_shell_tool", arguments: "{}" }],
    })
    recordToolCallIntents({
      conversationId: conv.id,
      assistantMessageId: assistant.id,
      logicalRoundId: "after-seq:1",
      calls: [{ id: "call-1", name: "run_shell_tool", arguments: "{}" }],
    })
    markToolCallStarted({
      conversationId: conv.id,
      toolCallId: "call-1",
    })

    expect(unknownSideEffectingToolCalls(conv.id)).toEqual([
      { id: "call-1", name: "run_shell_tool", arguments: "{}" },
    ])
  })

  it("trusts settled lifecycle evidence over an interrupted transcript marker", () => {
    const conv = createConversation({ mode: "chat" })
    appendMessage({ conversationId: conv.id, role: "user", content: "go" })
    const assistant = appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call-1", name: "run_shell_tool", arguments: "{}" }],
    })
    recordToolCallIntents({
      conversationId: conv.id,
      assistantMessageId: assistant.id,
      logicalRoundId: "after-seq:1",
      calls: [{ id: "call-1", name: "run_shell_tool", arguments: "{}" }],
    })
    markToolCallSettled({
      conversationId: conv.id,
      toolCallId: "call-1",
      state: "settled_success",
      result: "ok",
    })
    appendMessage({
      conversationId: conv.id,
      role: "tool",
      content: INTERRUPTED_RESULT,
      toolCallId: "call-1",
      toolName: "run_shell_tool",
    })

    expect(unknownSideEffectingToolCalls(conv.id)).toEqual([])
  })

  it("treats interrupted side-effecting results as unknown", () => {
    const conv = createConversation({ mode: "chat" })
    appendMessage({ conversationId: conv.id, role: "user", content: "go" })
    appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [
        { id: "call-1", name: "read_file_tool", arguments: "{}" },
        { id: "call-2", name: "run_shell_tool", arguments: "{}" },
      ],
    })
    appendMessage({
      conversationId: conv.id,
      role: "tool",
      content: "ok",
      toolCallId: "call-1",
      toolName: "read_file_tool",
    })
    appendMessage({
      conversationId: conv.id,
      role: "tool",
      content: INTERRUPTED_RESULT,
      toolCallId: "call-2",
      toolName: "run_shell_tool",
    })

    expect(unknownSideEffectingToolCalls(conv.id)).toEqual([
      { id: "call-2", name: "run_shell_tool", arguments: "{}" },
    ])
  })

  it("does not flag completed side-effecting results", () => {
    const conv = createConversation({ mode: "chat" })
    appendMessage({ conversationId: conv.id, role: "user", content: "go" })
    appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call-1", name: "run_shell_tool", arguments: "{}" }],
    })
    appendMessage({
      conversationId: conv.id,
      role: "tool",
      content: "executed once",
      toolCallId: "call-1",
      toolName: "run_shell_tool",
    })

    expect(unknownSideEffectingToolCalls(conv.id)).toEqual([])
  })
})

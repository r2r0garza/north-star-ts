import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

import { createConversation } from "./conversations"
import { appendMessage } from "./messages"
import {
  findPriorToolCallLifecycleByInvocation,
  getToolCallLifecycle,
  markToolCallNotStarted,
  markToolCallSettled,
  markToolCallStarted,
  markToolCallWaitingForApproval,
  normalizeToolActionIdentity,
  normalizeToolCallIdentity,
  recordToolCallIntents,
  stableToolInvocationId,
  updateToolCallOperationIdentity,
} from "./tool-call-lifecycle"

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)("tool_call_lifecycle repository", () => {
  it("persists intent, start, wait, and terminal evidence idempotently", () => {
    const conv = createConversation({ mode: "chat" })
    const assistant = appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [
        { id: "call-1", name: "run_shell_tool", arguments: '{"b":2,"a":1}' },
      ],
    })

    recordToolCallIntents({
      conversationId: conv.id,
      assistantMessageId: assistant.id,
      logicalRoundId: "after-seq:1",
      calls: [
        { id: "call-1", name: "run_shell_tool", arguments: '{"b":2,"a":1}' },
      ],
      now: 1000,
    })
    recordToolCallIntents({
      conversationId: conv.id,
      assistantMessageId: assistant.id,
      logicalRoundId: "after-seq:1",
      calls: [
        { id: "call-1", name: "run_shell_tool", arguments: '{"b":2,"a":1}' },
      ],
      now: 1001,
    })
    expect(getToolCallLifecycle(conv.id, "call-1")).toMatchObject({
      assistantMessageId: assistant.id,
      logicalRoundId: "after-seq:1",
      state: "prepared",
      preparedAt: 1000,
    })

    markToolCallStarted({
      conversationId: conv.id,
      toolCallId: "call-1",
      now: 1002,
    })
    markToolCallWaitingForApproval({
      conversationId: conv.id,
      toolCallId: "call-1",
      now: 1003,
    })
    markToolCallSettled({
      conversationId: conv.id,
      toolCallId: "call-1",
      state: "settled_success",
      result: "ok",
      now: 1004,
    })

    expect(getToolCallLifecycle(conv.id, "call-1")).toMatchObject({
      state: "settled_success",
      result: "ok",
      startedAt: 1002,
      waitingAt: 1003,
      settledAt: 1004,
    })
  })

  it("normalizes JSON object argument identity with stable key order", () => {
    expect(
      normalizeToolCallIdentity({
        id: "a",
        name: "tool",
        arguments: '{"b":2,"a":{"d":4,"c":3}}',
      })
    ).toBe('{"name":"tool","arguments":{"a":{"c":3,"d":4},"b":2}}')
  })

  it("uses a stable invocation id for equivalent calls with regenerated provider ids", () => {
    const conv = createConversation({ mode: "chat" })
    const firstAssistant = appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "provider-call-1",
          name: "run_shell_tool",
          arguments: '{"b":2,"a":1}',
        },
      ],
    })
    const secondAssistant = appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "provider-call-2",
          name: "run_shell_tool",
          arguments: '{"a":1,"b":2}',
        },
      ],
    })

    recordToolCallIntents({
      conversationId: conv.id,
      assistantMessageId: firstAssistant.id,
      logicalRoundId: "after-seq:1",
      calls: [
        {
          id: "provider-call-1",
          name: "run_shell_tool",
          arguments: '{"b":2,"a":1}',
        },
      ],
      now: 1000,
    })
    markToolCallStarted({
      conversationId: conv.id,
      toolCallId: "provider-call-1",
      now: 1001,
    })
    recordToolCallIntents({
      conversationId: conv.id,
      assistantMessageId: secondAssistant.id,
      logicalRoundId: "after-seq:2",
      calls: [
        {
          id: "provider-call-2",
          name: "run_shell_tool",
          arguments: '{"a":1,"b":2}',
        },
      ],
      now: 1002,
    })

    const first = getToolCallLifecycle(conv.id, "provider-call-1")
    const second = getToolCallLifecycle(conv.id, "provider-call-2")
    expect(first?.invocationId).toBe(second?.invocationId)
    expect(second?.invocationId).toBe(
      stableToolInvocationId({
        conversationId: conv.id,
        identity: '{"name":"run_shell_tool","arguments":{"a":1,"b":2}}',
      })
    )
    expect(
      findPriorToolCallLifecycleByInvocation({
        conversationId: conv.id,
        invocationId: second!.invocationId,
        excludeToolCallId: "provider-call-2",
      }).map((row) => row.toolCallId)
    ).toEqual(["provider-call-1"])
  })

  it("upgrades prepared calls to normalized action identity before execution", () => {
    const conv = createConversation({ mode: "chat" })
    const firstAssistant = appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "provider-call-1",
          name: "write_file_tool",
          arguments: '{"path":"a.txt","content":"one","mode":"create"}',
        },
      ],
    })
    const secondAssistant = appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "provider-call-2",
          name: "write_file_tool",
          arguments: '{"path":"a.txt","content":"two","mode":"append"}',
        },
      ],
    })
    const operationIdentity = normalizeToolActionIdentity({
      kind: "file_write",
      identity: "file_write:a.txt",
    })

    recordToolCallIntents({
      conversationId: conv.id,
      assistantMessageId: firstAssistant.id,
      logicalRoundId: "after-seq:1",
      calls: [
        {
          id: "provider-call-1",
          name: "write_file_tool",
          arguments: '{"path":"a.txt","content":"one","mode":"create"}',
        },
      ],
      now: 1000,
    })
    recordToolCallIntents({
      conversationId: conv.id,
      assistantMessageId: secondAssistant.id,
      logicalRoundId: "after-seq:2",
      calls: [
        {
          id: "provider-call-2",
          name: "write_file_tool",
          arguments: '{"path":"a.txt","content":"two","mode":"append"}',
        },
      ],
      now: 1001,
    })

    updateToolCallOperationIdentity({
      conversationId: conv.id,
      toolCallId: "provider-call-1",
      identity: operationIdentity,
      now: 1002,
    })
    updateToolCallOperationIdentity({
      conversationId: conv.id,
      toolCallId: "provider-call-2",
      identity: operationIdentity,
      now: 1003,
    })

    const first = getToolCallLifecycle(conv.id, "provider-call-1")
    const second = getToolCallLifecycle(conv.id, "provider-call-2")
    expect(first?.identity).toBe(operationIdentity)
    expect(second?.identity).toBe(operationIdentity)
    expect(first?.invocationId).toBe(second?.invocationId)
    expect(
      findPriorToolCallLifecycleByInvocation({
        conversationId: conv.id,
        invocationId: second!.invocationId,
        excludeToolCallId: "provider-call-2",
      }).map((row) => row.toolCallId)
    ).toEqual(["provider-call-1"])
  })

  it("marks prepared calls as not started without blocking resume", () => {
    const conv = createConversation({ mode: "chat" })
    const assistant = appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [
        { id: "call-1", name: "run_shell_tool", arguments: "{}" },
        { id: "call-2", name: "run_shell_tool", arguments: "{}" },
      ],
    })

    recordToolCallIntents({
      conversationId: conv.id,
      assistantMessageId: assistant.id,
      logicalRoundId: "after-seq:1",
      calls: assistant.toolCalls!,
      now: 1000,
    })
    markToolCallStarted({
      conversationId: conv.id,
      toolCallId: "call-1",
      now: 1001,
    })
    markToolCallNotStarted({
      conversationId: conv.id,
      toolCallId: "call-2",
      result: "Interrupted before run_shell_tool started.",
      now: 1002,
    })
    markToolCallNotStarted({
      conversationId: conv.id,
      toolCallId: "call-1",
      result: "should not overwrite a started call",
      now: 1003,
    })

    expect(getToolCallLifecycle(conv.id, "call-2")).toMatchObject({
      state: "not_started",
      result: "Interrupted before run_shell_tool started.",
    })
    expect(getToolCallLifecycle(conv.id, "call-1")).toMatchObject({
      state: "started",
    })
  })
})

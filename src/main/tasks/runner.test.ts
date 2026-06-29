import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../db/migrations"
import type { ChatResult } from "../agent"
import type { RunAgentLoopOptions } from "../agent"

// In-memory DB shared by the runner's repository imports (mirrors the repo test
// pattern in db/repositories/*.test.ts).
let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))

// Stub the agent core. Each test sets `loopImpl` to control what a "run" does:
// emit events, return a result, or observe the options it was called with.
let loopImpl: (opts: RunAgentLoopOptions) => Promise<ChatResult>
const loopCalls: RunAgentLoopOptions[] = []
vi.mock("../agent", () => ({
  runAgentLoop: (opts: RunAgentLoopOptions) => {
    loopCalls.push(opts)
    return loopImpl(opts)
  },
}))

let sqliteLoads = true
try {
  new Database(":memory:").close()
} catch {
  sqliteLoads = false
}

import { TaskRunner } from "./runner"
import { createTask, getTask, listTasks } from "../db/repositories/tasks"
import { appendMessage, listMessages } from "../db/repositories/messages"
import { listEvents } from "../db/repositories/task-events"
import { createConversation } from "../db/repositories/conversations"

// Wait for the wakeable pump to settle: poll until every task has left the
// queued/running states (or a timeout). The pump runs on microtasks, so a few
// awaited ticks are enough in practice; the loop is a safety net.
async function settle(timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5))
    const pending = [...listTasks({ status: "queued" }), ...listTasks({ status: "running" })]
    if (pending.length === 0) return
  }
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
  loopCalls.length = 0
  loopImpl = async () => ({ content: "done" })
})

describe.skipIf(!sqliteLoads)("TaskRunner — reconcile on start", () => {
  it("marks an orphaned running task interrupted (manual resume), not requeued", async () => {
    const conv = createConversation({ mode: "chat" })
    const task = createTask({
      conversationId: conv.id,
      status: "running",
      input: { kind: "agent_chat", message: "hi" },
    })
    // Never let the loop run — if reconcile wrongly requeued it, the test would
    // see it leave `interrupted`.
    loopImpl = async () => ({ content: "should not run" })

    const runner = new TaskRunner()
    runner.start()
    await settle()

    expect(getTask(task.id)?.status).toBe("interrupted")
    expect(loopCalls).toHaveLength(0)
    await runner.stop()
  })
})

describe.skipIf(!sqliteLoads)("TaskRunner — enqueue + run", () => {
  it("persists the user message, runs the loop, completes, logs events", async () => {
    const conv = createConversation({ mode: "chat" })
    const runner = new TaskRunner()
    runner.start()

    const task = runner.enqueue({ conversationId: conv.id, message: "do the thing" })
    await settle()

    const finished = getTask(task.id)!
    expect(finished.status).toBe("completed")
    expect(finished.result).toBe("done")

    // The task runs in its OWN forked conversation, linked back to the source —
    // its messages never touch the live conversation.
    expect(finished.sourceConversationId).toBe(conv.id)
    expect(finished.conversationId).not.toBe(conv.id)
    expect(listMessages(conv.id)).toHaveLength(0)

    // The user message was persisted into the private transcript up front;
    // runAgentLoop got no fresh userMessage (resume == first-run code path).
    const msgs = listMessages(finished.conversationId)
    expect(msgs.map((m) => m.content)).toContain("do the thing")
    expect(loopCalls[0].userMessage).toBeUndefined()
    expect(loopCalls[0].conversationId).toBe(finished.conversationId)

    // A status_change to completed and a task_completed event are in the log.
    const types = listEvents(task.id).map((e) => e.type)
    expect(types).toContain("status_change")
    expect(types).toContain("task_completed")
    await runner.stop()
  })

  it("maps a stopped result to cancelled and an error to failed", async () => {
    const conv = createConversation({ mode: "chat" })
    const runner = new TaskRunner()
    runner.start()

    loopImpl = async () => ({ stopped: true })
    const stopped = runner.enqueue({ conversationId: conv.id, message: "a" })
    await settle()
    expect(getTask(stopped.id)?.status).toBe("cancelled")

    // A second conversation so the per-conversation guard doesn't serialize them.
    const conv2 = createConversation({ mode: "chat" })
    loopImpl = async () => ({ error: "boom" })
    const failed = runner.enqueue({ conversationId: conv2.id, message: "b" })
    await settle()
    expect(getTask(failed.id)?.status).toBe("failed")
    expect(getTask(failed.id)?.error).toBe("boom")
    await runner.stop()
  })

  it("flips to waiting_for_approval when the loop emits a gate, and back on markRunning", async () => {
    const conv = createConversation({ mode: "chat" })
    const runner = new TaskRunner()
    runner.start()

    // The loop emits an approval event (the gate), then blocks until we resolve.
    let release: () => void
    const blocked = new Promise<void>((r) => {
      release = r
    })
    loopImpl = async (opts) => {
      opts.onEvent?.({
        type: "approval",
        id: "call-1",
        requestId: "req-1",
        tool: "run_shell",
        summary: "rm -rf build",
        reason: "destructive",
      })
      await blocked
      return { content: "done" }
    }

    const task = runner.enqueue({ conversationId: conv.id, message: "go" })
    // Wait for the gate event to flip status (poll briefly).
    for (let i = 0; i < 50 && getTask(task.id)?.status !== "waiting_for_approval"; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(getTask(task.id)?.status).toBe("waiting_for_approval")

    // Resolve: markRunning flips it back, then let the loop finish.
    runner.markRunning(task.id)
    expect(getTask(task.id)?.status).toBe("running")
    release!()
    await settle()
    expect(getTask(task.id)?.status).toBe("completed")
    await runner.stop()
  })
})

describe.skipIf(!sqliteLoads)("TaskRunner — dangling tool_call repair on resume", () => {
  it("synthesizes a tool result for an unanswered tool_call before resuming", async () => {
    const conv = createConversation({ mode: "chat" })
    // Simulate a crash mid-turn: user msg + assistant turn with a tool_call, but
    // no tool result persisted before the app died.
    appendMessage({ conversationId: conv.id, role: "user", content: "go" })
    appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call-1", name: "run_shell", arguments: "{}" }],
    })
    const task = createTask({
      conversationId: conv.id,
      status: "interrupted",
      input: { kind: "agent_chat", message: "go" },
    })

    const runner = new TaskRunner()
    runner.start()
    runner.resume(task.id)
    await settle()

    // A synthetic tool result for call-1 was appended before the loop ran, so
    // the rebuilt context is API-valid (every tool_call has a tool message).
    const toolMsgs = listMessages(conv.id).filter((m) => m.role === "tool")
    expect(toolMsgs).toHaveLength(1)
    expect(toolMsgs[0].toolCallId).toBe("call-1")
    expect(getTask(task.id)?.status).toBe("completed")
    await runner.stop()
  })

  it("leaves an already-answered tool_call alone", async () => {
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
    const task = createTask({
      conversationId: conv.id,
      status: "interrupted",
      input: { kind: "agent_chat", message: "go" },
    })

    const runner = new TaskRunner()
    runner.start()
    runner.resume(task.id)
    await settle()

    // Still exactly one tool message — no synthetic duplicate added.
    expect(listMessages(conv.id).filter((m) => m.role === "tool")).toHaveLength(1)
    await runner.stop()
  })
})

describe.skipIf(!sqliteLoads)("TaskRunner — transient retry with backoff", () => {
  // Tiny delays so backoff completes within a test tick; 3 total attempts.
  const fastBackoff = { baseMs: 1, maxMs: 2, maxAttempts: 3 }

  it("retries a transient failure and completes on the next attempt", async () => {
    const conv = createConversation({ mode: "chat" })
    let call = 0
    loopImpl = async () => {
      call++
      return call === 1 ? { error: "gateway 502", retryable: true } : { content: "done" }
    }

    const runner = new TaskRunner({ backoff: fastBackoff })
    runner.start()
    const task = runner.enqueue({ conversationId: conv.id, message: "go" })
    await settle()

    expect(getTask(task.id)?.status).toBe("completed")
    expect(loopCalls).toHaveLength(2)
    const events = listEvents(task.id)
    const attempts = events.filter((e) => e.type === "attempt")
    expect(attempts).toHaveLength(1)
    expect((attempts[0].payload as { n: number }).n).toBe(1)
    await runner.stop()
  })

  it("fails after exhausting the attempt budget", async () => {
    const conv = createConversation({ mode: "chat" })
    loopImpl = async () => ({ error: "still 503", retryable: true })

    const runner = new TaskRunner({ backoff: fastBackoff })
    runner.start()
    const task = runner.enqueue({ conversationId: conv.id, message: "go" })
    await settle()

    expect(getTask(task.id)?.status).toBe("failed")
    expect(getTask(task.id)?.error).toBe("still 503")
    // maxAttempts total runs, maxAttempts-1 attempt events, one terminal failure.
    expect(loopCalls).toHaveLength(fastBackoff.maxAttempts)
    const types = listEvents(task.id).map((e) => e.type)
    expect(types.filter((t) => t === "attempt")).toHaveLength(fastBackoff.maxAttempts - 1)
    expect(types.filter((t) => t === "task_failed")).toHaveLength(1)
    await runner.stop()
  })

  it("does not retry a deterministic failure", async () => {
    const conv = createConversation({ mode: "chat" })
    loopImpl = async () => ({ error: "bad args", retryable: false })

    const runner = new TaskRunner({ backoff: fastBackoff })
    runner.start()
    const task = runner.enqueue({ conversationId: conv.id, message: "go" })
    await settle()

    expect(getTask(task.id)?.status).toBe("failed")
    expect(loopCalls).toHaveLength(1)
    expect(listEvents(task.id).filter((e) => e.type === "attempt")).toHaveLength(0)
    await runner.stop()
  })

  it("does not retry a user Stop", async () => {
    const conv = createConversation({ mode: "chat" })
    loopImpl = async () => ({ stopped: true })

    const runner = new TaskRunner({ backoff: fastBackoff })
    runner.start()
    const task = runner.enqueue({ conversationId: conv.id, message: "go" })
    await settle()

    expect(getTask(task.id)?.status).toBe("cancelled")
    expect(loopCalls).toHaveLength(1)
    await runner.stop()
  })

  it("cancel during backoff clears the timer and settles cancelled", async () => {
    const conv = createConversation({ mode: "chat" })
    loopImpl = async () => ({ error: "502", retryable: true })

    // Long backoff so the task is reliably mid-sleep when we cancel it.
    const runner = new TaskRunner({ backoff: { baseMs: 10_000, maxMs: 10_000, maxAttempts: 3 } })
    runner.start()
    const task = runner.enqueue({ conversationId: conv.id, message: "go" })

    // Wait for the first run to fail and arm the backoff timer.
    for (let i = 0; i < 50 && loopCalls.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(loopCalls).toHaveLength(1)

    runner.cancel(task.id)
    expect(getTask(task.id)?.status).toBe("cancelled")

    // Give the (cleared) timer a chance to wrongly fire — it must not re-run.
    await new Promise((r) => setTimeout(r, 30))
    expect(loopCalls).toHaveLength(1)
    await runner.stop()
  })

  it("stop during backoff prevents a re-run", async () => {
    const conv = createConversation({ mode: "chat" })
    loopImpl = async () => ({ error: "502", retryable: true })

    const runner = new TaskRunner({ backoff: { baseMs: 10_000, maxMs: 10_000, maxAttempts: 3 } })
    runner.start()
    runner.enqueue({ conversationId: conv.id, message: "go" })

    for (let i = 0; i < 50 && loopCalls.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(loopCalls).toHaveLength(1)

    await runner.stop()
    await new Promise((r) => setTimeout(r, 30))
    expect(loopCalls).toHaveLength(1)
  })

  it("frees the concurrency slot during backoff so a sibling can run", async () => {
    const convA = createConversation({ mode: "chat" })
    const convB = createConversation({ mode: "chat" })
    loopImpl = async (opts) => {
      // Task A (convA) fails transiently once; task B always completes. With
      // concurrency 1, B can only run if A's slot is freed during A's backoff.
      const isA = listMessages(opts.conversationId).some((m) => m.content === "task-a")
      if (isA) return { error: "502", retryable: true }
      return { content: "b-done" }
    }

    const runner = new TaskRunner({ concurrency: 1, backoff: { baseMs: 20, maxMs: 20, maxAttempts: 3 } })
    runner.start()
    const a = runner.enqueue({ conversationId: convA.id, message: "task-a" })
    const b = runner.enqueue({ conversationId: convB.id, message: "task-b" })
    await settle()

    expect(getTask(b.id)?.status).toBe("completed")
    expect(getTask(a.id)?.status).toBe("failed")
    await runner.stop()
  })

  it("never runs a same-conversation sibling concurrently across a backoff gap", async () => {
    // Two tasks share one conversation (created directly — enqueue would fork a
    // private conversation per task and they'd never collide). The first fails
    // transiently then succeeds with a small in-loop delay; the second also
    // delays. The per-conversation guard — extended to cover backing-off tasks —
    // must keep them from ever executing at the same time on the shared log.
    const conv = createConversation({ mode: "chat" })
    appendMessage({ conversationId: conv.id, role: "user", content: "go" })
    const t1 = createTask({
      conversationId: conv.id,
      status: "queued",
      input: { kind: "agent_chat", message: "go" },
    })
    const t2 = createTask({
      conversationId: conv.id,
      status: "queued",
      input: { kind: "agent_chat", message: "go" },
    })

    let active = 0
    let maxActive = 0
    let firstRun = true
    loopImpl = async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 10))
      active--
      if (firstRun) {
        firstRun = false
        return { error: "502", retryable: true }
      }
      return { content: "ok" }
    }

    const runner = new TaskRunner({ concurrency: 2, backoff: { baseMs: 15, maxMs: 15, maxAttempts: 3 } })
    runner.start()
    await settle()

    expect(maxActive).toBe(1)
    expect(getTask(t1.id)?.status).toBe("completed")
    expect(getTask(t2.id)?.status).toBe("completed")
    await runner.stop()
  })
})

describe.skipIf(!sqliteLoads)("TaskRunner — concurrent tasks under the cap", () => {
  it("runs two tasks from one source to completion in their own transcripts", async () => {
    const conv = createConversation({ mode: "chat" })
    loopImpl = async () => {
      await new Promise((r) => setTimeout(r, 10))
      return { content: "done" }
    }

    const runner = new TaskRunner({ concurrency: 2 })
    runner.start()
    const a = runner.enqueue({ conversationId: conv.id, message: "first" })
    const b = runner.enqueue({ conversationId: conv.id, message: "second" })
    await settle()

    // Each task forks its own private conversation, so there's no shared-log
    // race — both run (concurrently under the cap) and complete.
    expect(getTask(a.id)?.status).toBe("completed")
    expect(getTask(b.id)?.status).toBe("completed")
    expect(getTask(a.id)?.conversationId).not.toBe(getTask(b.id)?.conversationId)
    expect(loopCalls).toHaveLength(2)
    await runner.stop()
  })
})

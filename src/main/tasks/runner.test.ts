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
// SHUTDOWN_ABORT_REASON is a real const the runner imports — re-export a stable
// sentinel (via vi.hoisted so it exists when the hoisted mock factory runs) so
// identity comparisons (signal.reason === SHUTDOWN_ABORT_REASON) hold across the
// runner and the test.
const { SHUTDOWN_ABORT_REASON } = vi.hoisted(() => ({
  SHUTDOWN_ABORT_REASON: Symbol("agent:shutdown"),
}))
let loopImpl: (opts: RunAgentLoopOptions) => Promise<ChatResult>
const loopCalls: RunAgentLoopOptions[] = []
vi.mock("../agent", () => ({
  SHUTDOWN_ABORT_REASON,
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
import { createApproval, listApprovals } from "../db/repositories/approvals"
import { appendEvent } from "../db/repositories/task-events"
import { createCheckpoint } from "../db/repositories/task-checkpoints"
import {
  createConversation,
  getConversation,
} from "../db/repositories/conversations"
import { listTodos } from "../db/repositories/todos"

// Wait for the wakeable pump to settle: poll until every task has left the
// queued/running states (or a timeout). The pump runs on microtasks, so a few
// awaited ticks are enough in practice; the loop is a safety net.
async function settle(timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5))
    const pending = [
      ...listTasks({ status: "queued" }),
      ...listTasks({ status: "running" }),
    ]
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

describe.skipIf(!sqliteLoads)(
  "TaskRunner — registerKind (producer auto-resume opt-in)",
  () => {
    it("auto-resumes an orphaned running task of a registered auto-resume kind", async () => {
      const conv = createConversation({ mode: "chat" })
      const task = createTask({
        conversationId: conv.id,
        status: "running",
        input: { kind: "auto_kind", message: "reindex" },
      })

      const runner = new TaskRunner()
      // A background producer opts its kind into auto-resume BEFORE start().
      runner.registerKind("auto_kind", { autoResume: true })
      runner.start()
      await settle()

      // reconcile re-queued it (autoResume) instead of interrupting; the pump ran it.
      expect(getTask(task.id)?.status).toBe("completed")
      expect(loopCalls).toHaveLength(1)
      await runner.stop()
    })

    it("auto-resumes an orphaned waiting_for_approval task and denies its stale row", async () => {
      const conv = createConversation({ mode: "chat" })
      const task = createTask({
        conversationId: conv.id,
        status: "waiting_for_approval",
        input: { kind: "auto_kind", message: "reindex" },
      })
      createApproval({ taskId: task.id, request: { requestId: "req-1" } })

      const runner = new TaskRunner()
      runner.registerKind("auto_kind", { autoResume: true })
      runner.start()
      await settle()

      // The stale gate is swept (denied/superseded restart), then the task
      // re-queues and runs — not left interrupted.
      expect(getTask(task.id)?.status).toBe("completed")
      expect(loopCalls).toHaveLength(1)
      const rows = listApprovals({ taskId: task.id })
      expect(rows).toHaveLength(1)
      expect(rows[0].status).toBe("denied")
      expect((rows[0].decision as { superseded: string }).superseded).toBe(
        "restart"
      )
      await runner.stop()
    })

    it("still interrupts an orphaned task of an UNregistered kind", async () => {
      const conv = createConversation({ mode: "chat" })
      const task = createTask({
        conversationId: conv.id,
        status: "running",
        input: { kind: "never_registered", message: "x" },
      })
      loopImpl = async () => ({ content: "should not run" })

      const runner = new TaskRunner()
      runner.start()
      await settle()

      expect(getTask(task.id)?.status).toBe("interrupted")
      expect(loopCalls).toHaveLength(0)
      await runner.stop()
    })

    it("enqueues a custom kind with a non-existent conversationId and still runs headless", async () => {
      const runner = new TaskRunner()
      runner.registerKind("auto_kind", { autoResume: true })
      runner.start()

      // No subscriber attached, and the source conversation does not exist: enqueue
      // must still fork a valid private worker conversation and drive the loop.
      const task = runner.enqueue({
        conversationId: "does-not-exist",
        message: "headless work",
        kind: "auto_kind",
      })
      await settle()

      const finished = getTask(task.id)!
      expect(finished.status).toBe("completed")
      // No live source to link back to: not the bogus id. createTask treats a null
      // source as self-sourced (points at the task's own forked worker conversation),
      // which keeps the source_conversation_id FK satisfied.
      expect(finished.sourceConversationId).not.toBe("does-not-exist")
      expect(finished.sourceConversationId).toBe(finished.conversationId)
      expect(finished.conversationId).not.toBe("does-not-exist")
      // The user message landed in the forked private transcript.
      expect(
        listMessages(finished.conversationId).map((m) => m.content)
      ).toContain("headless work")
      expect(loopCalls).toHaveLength(1)
      expect(loopCalls[0].conversationId).toBe(finished.conversationId)
      await runner.stop()
    })
  }
)

describe.skipIf(!sqliteLoads)("TaskRunner — todo_run seed (plan 016)", () => {
  it("seeds the handed-off todo list into the forked worker conversation", async () => {
    const conv = createConversation({ mode: "interactive" })
    const runner = new TaskRunner()
    runner.registerKind("todo_run", { autoResume: true })
    runner.start()

    const seedTodos = [
      { itemId: "a", content: "first item", status: "completed" as const },
      { itemId: "b", content: "second item", status: "pending" as const },
      { itemId: "c", content: "third item", status: "in_progress" as const },
    ]
    const task = runner.enqueue({
      conversationId: conv.id,
      message: "work the list",
      kind: "todo_run",
      title: "3 tasks",
      seedTodos,
    })
    await settle()

    const finished = getTask(task.id)!
    expect(finished.status).toBe("completed")
    // The fork is a NEW conversation; its todos table was empty until enqueue
    // seeded the snapshot. The source conversation's list is untouched (empty).
    const forkedTodos = listTodos(finished.conversationId)
    expect(forkedTodos.map((t) => [t.itemId, t.content, t.status])).toEqual([
      ["a", "first item", "completed"],
      ["b", "second item", "pending"],
      ["c", "third item", "in_progress"],
    ])
    expect(listTodos(conv.id)).toHaveLength(0)
    await runner.stop()
  })

  it("auto-resumes an orphaned todo_run task on reconcile", async () => {
    const conv = createConversation({ mode: "interactive" })
    const task = createTask({
      conversationId: conv.id,
      status: "running",
      input: { kind: "todo_run", message: "work the list" },
    })

    const runner = new TaskRunner()
    runner.registerKind("todo_run", { autoResume: true })
    runner.start()
    await settle()

    expect(getTask(task.id)?.status).toBe("completed")
    expect(loopCalls).toHaveLength(1)
    await runner.stop()
  })
})

describe.skipIf(!sqliteLoads)("TaskRunner — enqueue + run", () => {
  it("persists the user message, runs the loop, completes, logs events", async () => {
    const conv = createConversation({ mode: "chat" })
    const runner = new TaskRunner()
    runner.start()

    const task = runner.enqueue({
      conversationId: conv.id,
      message: "do the thing",
    })
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
    for (
      let i = 0;
      i < 50 && getTask(task.id)?.status !== "waiting_for_approval";
      i++
    ) {
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

describe.skipIf(!sqliteLoads)(
  "TaskRunner — durable approval recovery (plan 012)",
  () => {
    // Drive a task until the loop emits an approval gate and blocks. Returns the
    // task, its release fn (resolves the blocked loop), and the runner.
    async function enqueueBlockedOnApproval(requestId = "req-1") {
      const conv = createConversation({ mode: "chat" })
      const runner = new TaskRunner()
      runner.start()

      let release: () => void
      const blocked = new Promise<void>((r) => {
        release = r
      })
      loopImpl = async (opts) => {
        opts.onEvent?.({
          type: "approval",
          id: "call-1",
          requestId,
          tool: "run_shell",
          summary: "rm -rf build",
          reason: "destructive",
        })
        await blocked
        return { content: "done" }
      }

      const task = runner.enqueue({ conversationId: conv.id, message: "go" })
      for (
        let i = 0;
        i < 50 && getTask(task.id)?.status !== "waiting_for_approval";
        i++
      ) {
        await new Promise((r) => setTimeout(r, 5))
      }
      return { task, release: release!, runner }
    }

    it("writes a pending approval row when the loop emits a gate", async () => {
      const { task, release, runner } = await enqueueBlockedOnApproval()

      const pending = listApprovals({ taskId: task.id, status: "pending" })
      expect(pending).toHaveLength(1)
      expect((pending[0].request as { requestId: string }).requestId).toBe(
        "req-1"
      )
      expect((pending[0].request as { tool: string }).tool).toBe("run_shell")

      release()
      await settle()
      await runner.stop()
    })

    it("resolves the row approved and flips to running on recordApprovalDecision", async () => {
      const { task, release, runner } = await enqueueBlockedOnApproval()

      runner.recordApprovalDecision(task.id, "req-1", "approved")
      expect(getTask(task.id)?.status).toBe("running")

      const resolved = listApprovals({ taskId: task.id })
      expect(resolved).toHaveLength(1)
      expect(resolved[0].status).toBe("approved")
      expect(resolved[0].resolvedAt).not.toBeNull()
      expect(
        listApprovals({ taskId: task.id, status: "pending" })
      ).toHaveLength(0)

      release()
      await settle()
      expect(getTask(task.id)?.status).toBe("completed")
      await runner.stop()
    })

    it("only resolves the row matching the requestId", async () => {
      const { task, release, runner } = await enqueueBlockedOnApproval("req-1")
      // A second, unrelated pending row (e.g. one re-created on a prior resume).
      createApproval({ taskId: task.id, request: { requestId: "stale" } })

      runner.recordApprovalDecision(task.id, "req-1", "approved")

      const stillPending = listApprovals({ taskId: task.id, status: "pending" })
      expect(stillPending).toHaveLength(1)
      expect((stillPending[0].request as { requestId: string }).requestId).toBe(
        "stale"
      )

      release()
      await settle()
      await runner.stop()
    })

    it("on shutdown, aborts the gate with the shutdown reason and leaves it unresolved", async () => {
      const conv = createConversation({ mode: "chat" })
      const runner = new TaskRunner()
      runner.start()

      // Model the real agent loop's gate: on abort it resolves "denied" UNLESS the
      // abort is a shutdown, in which case it stays parked (no tool result). This
      // is the exact behavior the fix added to agent/index.ts.
      let capturedSignal: AbortSignal | undefined
      let deniedByAbort = false
      loopImpl = async (opts) => {
        capturedSignal = opts.abort.signal
        opts.onEvent?.({
          type: "approval",
          id: "call-1",
          requestId: "req-1",
          tool: "run_shell",
          summary: "rm -rf build",
          reason: "destructive",
        })
        await new Promise<void>((resolve) => {
          opts.abort.signal.addEventListener("abort", () => {
            if (opts.abort.signal.reason === SHUTDOWN_ABORT_REASON) return // stay parked
            deniedByAbort = true
            resolve()
          })
        })
        return { content: "done" }
      }

      const task = runner.enqueue({ conversationId: conv.id, message: "go" })
      for (
        let i = 0;
        i < 50 && getTask(task.id)?.status !== "waiting_for_approval";
        i++
      ) {
        await new Promise((r) => setTimeout(r, 5))
      }
      expect(getTask(task.id)?.status).toBe("waiting_for_approval")

      await runner.stop()

      // The gate saw a shutdown abort and did NOT fabricate a denial: the loop is
      // still parked, the task is still waiting_for_approval, and its pending
      // approval row survives for the next boot's reconcile to interrupt.
      expect(capturedSignal?.reason).toBe(SHUTDOWN_ABORT_REASON)
      expect(deniedByAbort).toBe(false)
      expect(getTask(task.id)?.status).toBe("waiting_for_approval")
      expect(
        listApprovals({ taskId: task.id, status: "pending" })
      ).toHaveLength(1)
    })

    it("on reconcile, denies a stale pending row and interrupts the task", async () => {
      const conv = createConversation({ mode: "chat" })
      const task = createTask({
        conversationId: conv.id,
        status: "waiting_for_approval",
        input: { kind: "agent_chat", message: "hi" },
      })
      createApproval({ taskId: task.id, request: { requestId: "req-1" } })
      loopImpl = async () => ({ content: "should not run" })

      const runner = new TaskRunner()
      runner.start()
      await settle()

      expect(getTask(task.id)?.status).toBe("interrupted")
      const rows = listApprovals({ taskId: task.id })
      expect(rows).toHaveLength(1)
      expect(rows[0].status).toBe("denied")
      expect((rows[0].decision as { superseded: string }).superseded).toBe(
        "restart"
      )
      expect(loopCalls).toHaveLength(0)
      await runner.stop()
    })
  }
)

// Dangling tool-call repair moved out of the runner into runAgentLoop (shared by
// the live chat path too) — see repair.test.ts. The runner test mocks
// runAgentLoop, so repair is exercised there against a real DB instead.

describe.skipIf(!sqliteLoads)(
  "TaskRunner — transient retry with backoff",
  () => {
    // Tiny delays so backoff completes within a test tick; 3 total attempts.
    const fastBackoff = { baseMs: 1, maxMs: 2, maxAttempts: 3 }

    it("retries a transient failure and completes on the next attempt", async () => {
      const conv = createConversation({ mode: "chat" })
      let call = 0
      loopImpl = async () => {
        call++
        return call === 1
          ? { error: "gateway 502", retryable: true }
          : { content: "done" }
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
      expect(types.filter((t) => t === "attempt")).toHaveLength(
        fastBackoff.maxAttempts - 1
      )
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
      expect(
        listEvents(task.id).filter((e) => e.type === "attempt")
      ).toHaveLength(0)
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
      const runner = new TaskRunner({
        backoff: { baseMs: 10_000, maxMs: 10_000, maxAttempts: 3 },
      })
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

      const runner = new TaskRunner({
        backoff: { baseMs: 10_000, maxMs: 10_000, maxAttempts: 3 },
      })
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
        const isA = listMessages(opts.conversationId).some(
          (m) => m.content === "task-a"
        )
        if (isA) return { error: "502", retryable: true }
        return { content: "b-done" }
      }

      const runner = new TaskRunner({
        concurrency: 1,
        backoff: { baseMs: 20, maxMs: 20, maxAttempts: 3 },
      })
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

      const runner = new TaskRunner({
        concurrency: 2,
        backoff: { baseMs: 15, maxMs: 15, maxAttempts: 3 },
      })
      runner.start()
      await settle()

      expect(maxActive).toBe(1)
      expect(getTask(t1.id)?.status).toBe("completed")
      expect(getTask(t2.id)?.status).toBe("completed")
      await runner.stop()
    })
  }
)

describe.skipIf(!sqliteLoads)(
  "TaskRunner — concurrent tasks under the cap",
  () => {
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
      expect(getTask(a.id)?.conversationId).not.toBe(
        getTask(b.id)?.conversationId
      )
      expect(loopCalls).toHaveLength(2)
      await runner.stop()
    })
  }
)

describe.skipIf(!sqliteLoads)(
  "TaskRunner — deterministic executor seam (plan 008)",
  () => {
    it("drives a kind's run executor instead of runAgentLoop", async () => {
      let ran = false
      const runner = new TaskRunner()
      runner.registerKind("indexer", {
        autoResume: true,
        run: async () => {
          ran = true
          return { content: "indexed" }
        },
      })
      runner.start()
      const task = runner.enqueueKind({ kind: "indexer", input: {} })
      await settle()

      expect(ran).toBe(true)
      // The agent loop was never touched for a deterministic kind.
      expect(loopCalls).toHaveLength(0)
      expect(getTask(task.id)?.status).toBe("completed")
      await runner.stop()
    })

    it("maps executor results to terminal statuses", async () => {
      const runner = new TaskRunner()
      runner.registerKind("ok", {
        autoResume: false,
        run: async () => ({ content: "x" }),
      })
      runner.registerKind("boom", {
        autoResume: false,
        run: async () => ({ error: "bad", retryable: false }),
      })
      runner.registerKind("halt", {
        autoResume: false,
        run: async () => ({ stopped: true }),
      })
      runner.start()
      const ok = runner.enqueueKind({ kind: "ok", input: {} })
      const boom = runner.enqueueKind({ kind: "boom", input: {} })
      const halt = runner.enqueueKind({ kind: "halt", input: {} })
      await settle()

      expect(getTask(ok.id)?.status).toBe("completed")
      expect(getTask(boom.id)?.status).toBe("failed")
      expect(getTask(halt.id)?.status).toBe("cancelled")
      await runner.stop()
    })

    it("passes the resolved workspace to the executor", async () => {
      // enqueueKind forks a conversation with the given workspaceId, but the task's
      // workspace is resolved via that conversation → workspace path. Seed a
      // workspace row and link it so resolveWorkspace returns its path.
      const now = Date.now()
      const wsId = "ws-seam"
      db.prepare(
        "INSERT INTO workspaces (id, path, name, created_at, updated_at) VALUES (?, ?, 'w', ?, ?)"
      ).run(wsId, "/tmp/seam-ws", now, now)
      let seen: string | undefined = "unset"
      const runner = new TaskRunner()
      runner.registerKind("probe", {
        autoResume: false,
        run: async ({ workspace }) => {
          seen = workspace
          return { content: "x" }
        },
      })
      runner.start()
      runner.enqueueKind({ kind: "probe", input: { workspaceId: wsId } })
      await settle()

      expect(seen).toBe("/tmp/seam-ws")
      await runner.stop()
    })
  }
)

describe.skipIf(!sqliteLoads)("TaskRunner — pause/resume (plan 008)", () => {
  it("pauses a running task (abort reason → paused) and resumes it from paused", async () => {
    const runner = new TaskRunner()
    runner.registerKind("slow", {
      autoResume: true,
      run: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ stopped: true }))
        }),
    })
    runner.start()
    const task = runner.enqueueKind({ kind: "slow", input: {} })
    // Let it start running.
    await new Promise((r) => setTimeout(r, 20))
    expect(getTask(task.id)?.status).toBe("running")

    runner.pause(task.id)
    await settle()
    expect(getTask(task.id)?.status).toBe("paused")

    // Resume: the paused task re-queues and runs again.
    let secondRun = false
    runner.registerKind("slow", {
      autoResume: true,
      run: async () => {
        secondRun = true
        return { content: "done" }
      },
    })
    runner.resume(task.id)
    await settle()
    expect(secondRun).toBe(true)
    expect(getTask(task.id)?.status).toBe("completed")
    await runner.stop()
  })

  it("pauses a still-queued task directly", async () => {
    const runner = new TaskRunner({ concurrency: 1 })
    // A blocker occupies the single slot (aborts on stop) so the second task
    // stays queued long enough to be paused.
    runner.registerKind("blocker", {
      autoResume: false,
      run: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ stopped: true }))
        }),
    })
    runner.registerKind("waiter", {
      autoResume: true,
      run: async () => ({ content: "x" }),
    })
    runner.start()
    runner.enqueueKind({ kind: "blocker", input: {} })
    await new Promise((r) => setTimeout(r, 20))
    const waiter = runner.enqueueKind({ kind: "waiter", input: {} })
    runner.pause(waiter.id)
    expect(getTask(waiter.id)?.status).toBe("paused")
    await runner.stop()
  })

  it("leaves a paused task paused across a restart (not auto-resumed)", async () => {
    const conv = createConversation({ mode: "interactive" })
    const task = createTask({
      conversationId: conv.id,
      status: "paused",
      input: { kind: "workspace_index", workspaceId: "w" },
    })
    const runner = new TaskRunner()
    runner.registerKind("workspace_index", {
      autoResume: true,
      run: async () => ({ content: "x" }),
    })
    runner.start()
    await settle()
    // reconcile only touches running/waiting_for_approval; a paused task stays put.
    expect(getTask(task.id)?.status).toBe("paused")
    await runner.stop()
  })
})

describe.skipIf(!sqliteLoads)(
  "TaskRunner — deleteSourceConversation (plan 022)",
  () => {
    it("deletes a sourced task, its worker conversation, and all child rows", async () => {
      const source = createConversation({ mode: "chat" })
      const runner = new TaskRunner()
      runner.start()
      const task = runner.enqueue({
        conversationId: source.id,
        message: "background work",
      })
      // Add child rows that must cascade away with the worker conversation/task.
      createApproval({ taskId: task.id, request: { requestId: "req-1" } })
      appendEvent({ taskId: task.id, type: "note", payload: { x: 1 } })
      createCheckpoint({ taskId: task.id, state: { at: "start" } })
      await settle()
      expect(getTask(task.id)?.status).toBe("completed")
      const workerConvId = task.conversationId

      await runner.deleteSourceConversation(source.id)

      // Task, worker conversation, source conversation, and children all gone.
      expect(getTask(task.id)).toBeUndefined()
      expect(getConversation(workerConvId)).toBeUndefined()
      expect(getConversation(source.id)).toBeUndefined()
      expect(listApprovals({ taskId: task.id })).toHaveLength(0)
      expect(listEvents(task.id)).toHaveLength(0)
      // No dangling references anywhere.
      expect(db.pragma("foreign_key_check")).toHaveLength(0)
      await runner.stop()
    })

    it("aborts a running task and settles it BEFORE deleting the row (no FK throw)", async () => {
      const source = createConversation({ mode: "chat" })
      const runner = new TaskRunner()
      runner.start()

      // The loop blocks until aborted; on abort it returns {stopped:true}, which
      // runOne maps to `cancelled` with a post-abort updateTask/emit — those
      // writes must complete before deleteSourceConversation removes the row.
      let sawAbort = false
      loopImpl = (opts) =>
        new Promise((resolve) => {
          opts.abort.signal.addEventListener("abort", () => {
            sawAbort = true
            resolve({ stopped: true })
          })
        })

      const task = runner.enqueue({
        conversationId: source.id,
        message: "long job",
      })
      // Wait until it's actually running (occupying a slot).
      for (let i = 0; i < 50 && getTask(task.id)?.status !== "running"; i++) {
        await new Promise((r) => setTimeout(r, 5))
      }
      expect(getTask(task.id)?.status).toBe("running")

      // Should not throw despite the row being deleted right after the in-flight
      // run settles (deleteSourceConversation awaits the runOne promise first).
      await runner.deleteSourceConversation(source.id)

      expect(sawAbort).toBe(true)
      expect(getTask(task.id)).toBeUndefined()
      expect(getConversation(source.id)).toBeUndefined()
      expect(db.pragma("foreign_key_check")).toHaveLength(0)
      await runner.stop()
    })

    it("reaps nested tasks sourced from a worker conversation (transitive)", async () => {
      const source = createConversation({ mode: "chat" })
      const runner = new TaskRunner()
      runner.start()

      // A parent task whose loop enqueues a NESTED task sourced from its own
      // worker conversation (the recursive producer path). Enqueue once, then
      // stop driving so we can delete deterministically.
      const parent = runner.enqueue({
        conversationId: source.id,
        message: "parent",
      })
      await settle()
      // Simulate the nested hand-off: a task sourced from the parent's worker conv.
      const nested = runner.enqueue({
        conversationId: parent.conversationId,
        message: "nested",
      })
      await settle()
      expect(nested.sourceConversationId).toBe(parent.conversationId)

      await runner.deleteSourceConversation(source.id)

      expect(getTask(parent.id)).toBeUndefined()
      expect(getTask(nested.id)).toBeUndefined()
      expect(getConversation(nested.conversationId)).toBeUndefined()
      expect(db.pragma("foreign_key_check")).toHaveLength(0)
      await runner.stop()
    })
  }
)

describe.skipIf(!sqliteLoads)("TaskRunner — reapOrphans on start (plan 022)", () => {
  // createTask coerces a null sourceConversationId to conversationId (self-sourced,
  // tasks.ts). A genuine orphan has source_conversation_id NULL — the state the
  // ON DELETE SET NULL leaves behind — so null it directly, as the real delete did.
  function orphan(taskId: string): void {
    db.prepare("UPDATE tasks SET source_conversation_id = NULL WHERE id = ?").run(
      taskId
    )
  }

  it("reaps a source-less task of a surface-less kind on boot (never requeues)", async () => {
    // An orphan left by a pre-fix session delete: an auto-resume kind with NO
    // independent surface, left `running` by a crash. reapOrphans must delete it
    // before reconcile would flip it to queued and the pump run it.
    const workerConv = createConversation({ mode: "interactive" })
    const task = createTask({
      conversationId: workerConv.id,
      status: "running",
      input: { kind: "todo_run", message: "orphaned list" },
    })
    orphan(task.id)

    const runner = new TaskRunner()
    runner.registerKind("todo_run", { autoResume: true })
    runner.start()
    await settle()

    // Reaped before reconcile/seed could requeue it — gone, never ran.
    expect(getTask(task.id)).toBeUndefined()
    expect(getConversation(workerConv.id)).toBeUndefined()
    expect(loopCalls).toHaveLength(0)
    expect(db.pragma("foreign_key_check")).toHaveLength(0)
    await runner.stop()
  })

  it("keeps a source-less workspace_index task (hasIndependentSurface) and auto-resumes it", async () => {
    const workerConv = createConversation({ mode: "interactive" })
    const task = createTask({
      conversationId: workerConv.id,
      status: "running",
      input: { kind: "workspace_index", workspaceId: "w" },
    })
    orphan(task.id)

    const runner = new TaskRunner()
    let ran = false
    runner.registerKind("workspace_index", {
      autoResume: true,
      hasIndependentSurface: true,
      run: async () => {
        ran = true
        return { content: "indexed" }
      },
    })
    runner.start()
    await settle()

    // Not reaped (independent surface); reconcile auto-resumed it and it ran.
    expect(ran).toBe(true)
    expect(getTask(task.id)?.status).toBe("completed")
    await runner.stop()
  })
})

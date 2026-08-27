import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

// Real schema + real repos over an in-memory DB (like the index service test).
let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))

// The executor's one LLM call goes through the providers barrel. Mock it so the
// service is exercised without a network/gateway. `resolveLlm` returns a stub
// client + model; `createCompletion` returns whatever `nextCompletion` is set to
// (or throws `nextError`). isTransientError/NoActiveProviderError pass through
// real-enough shims for the retry-classification branches.
let nextCompletion: unknown
let nextError: unknown
let completionCalls = 0
// The `base` arg passed to the last createCompletion call — lets tests assert the
// assembled prompt (system + user messages) without exporting internal helpers.
let lastBase: { messages?: { role: string; content: string }[] } | undefined
vi.mock("../agent/providers", () => {
  // Defined inside the factory (vi.mock is hoisted above module scope).
  class NoActiveProviderError extends Error {}
  return {
    resolveLlm: () => ({
      client: {},
      model: "test-model",
      accountId: "a1",
      apiMode: "completions",
    }),
    createCompletion: async (
      _client: unknown,
      _model: string,
      _max: number,
      base: { messages?: { role: string; content: string }[] }
    ) => {
      completionCalls++
      lastBase = base
      if (nextError) throw nextError
      return nextCompletion
    },
    isTransientError: (err: unknown) =>
      err instanceof Error && err.message === "transient",
    NoActiveProviderError,
  }
})

// maybeSummarize live-reads the two thresholds from the settings service. Mock it
// with a mutable object so each test sets the triggers it needs without standing
// up the real settings repo/cache. Only getIndexing is consulted here.
const indexingSettings = {
  autoIndexNewWorkspaces: true,
  useIndexForContext: true,
  includeEmbeddings: false,
  summarizeMessageThreshold: 0,
  summarizeTokenThreshold: 80000,
}
vi.mock("../settings/service", () => ({
  getIndexing: () => indexingSettings,
}))

import { SummaryService, SUMMARIZE_KIND } from "./service"
import { NoActiveProviderError as FakeNoProvider } from "../agent/providers"
import { appendMessage } from "../db/repositories/messages"
import {
  getConversationSummary,
  upsertConversationSummary,
} from "../db/repositories/conversation-summaries"
import { listTasks } from "../db/repositories/tasks"
import type { TaskRunner } from "../tasks/runner"
import type { Task } from "../db/types"

// A fake runner: records enqueueKind calls and writes a real queued task row (so
// the trigger's "already in flight?" dedupe can read it back). Mirrors the shape
// enqueueKind persists: kind + conversationId ride in the input blob.
interface FakeRunner extends TaskRunner {
  calls: number
}
function fakeRunner(): FakeRunner {
  const obj = {
    calls: 0,
    enqueueKind(input: {
      kind: string
      title?: string | null
      input: { conversationId?: string }
    }) {
      this.calls++
      const id = randomUUID()
      const convId = randomUUID()
      const now = Date.now()
      db.prepare(
        "INSERT INTO conversations (id, mode, title, workspace_id, created_at, updated_at) VALUES (?, 'interactive', NULL, NULL, ?, ?)"
      ).run(convId, now, now)
      db.prepare(
        "INSERT INTO tasks (id, conversation_id, source_conversation_id, title, status, input, result, error, created_at, updated_at) VALUES (?, ?, NULL, ?, 'queued', ?, NULL, NULL, ?, ?)"
      ).run(
        id,
        convId,
        input.title ?? null,
        JSON.stringify({ kind: input.kind, ...input.input }),
        now,
        now
      )
      return { id }
    },
  }
  return obj as unknown as FakeRunner
}

function freshConversation(): string {
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    "INSERT INTO conversations (id, mode, title, workspace_id, created_at, updated_at) VALUES (?, 'north_star', NULL, NULL, ?, ?)"
  ).run(id, now, now)
  return id
}

function seedMessages(convId: string, n: number): void {
  for (let i = 0; i < n; i++) {
    appendMessage({
      conversationId: convId,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i} with a little content to give it some tokens`,
    })
  }
}

// The summarize task's input blob, as the runner would build it.
function summarizeTask(convId: string): Task {
  return {
    id: "task-1",
    conversationId: "worker",
    sourceConversationId: null,
    title: null,
    status: "running",
    input: { kind: SUMMARIZE_KIND, conversationId: convId },
    result: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

const abortSignal = () => new AbortController().signal

describe.skipIf(!sqliteLoads)("SummaryService.maybeSummarize (trigger)", () => {
  let runner: FakeRunner
  let svc: SummaryService

  beforeEach(() => {
    db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    runner = fakeRunner()
    svc = new SummaryService(runner)
    // Reset to the shipped defaults (token-only, 80k) before each test tweaks it.
    indexingSettings.summarizeMessageThreshold = 0
    indexingSettings.summarizeTokenThreshold = 80000
  })

  it("does not fire on message count at the token-only default", () => {
    // msg threshold 0 (disabled), token threshold high — a chatty-but-small
    // conversation stays well under 80k tokens, so no trigger.
    const convId = freshConversation()
    seedMessages(convId, 40)
    svc.maybeSummarize(convId)
    expect(runner.calls).toBe(0)
  })

  it("fires on the message threshold once enough fresh turns accumulate", () => {
    indexingSettings.summarizeMessageThreshold = 20
    const convId = freshConversation()
    seedMessages(convId, 19)
    svc.maybeSummarize(convId)
    expect(runner.calls).toBe(0) // one short of the threshold

    seedMessages(convId, 1)
    svc.maybeSummarize(convId)
    expect(runner.calls).toBe(1) // exactly at the threshold

    const tasks = listTasks()
    const input = tasks[0].input as { kind?: string; conversationId?: string }
    expect(input.kind).toBe(SUMMARIZE_KIND)
    expect(input.conversationId).toBe(convId)
  })

  it("fires below the old 10-message floor when the threshold is low", () => {
    // Proves MIN_MESSAGES is gone: a threshold of 3 fires at 3 messages.
    indexingSettings.summarizeMessageThreshold = 3
    const convId = freshConversation()
    seedMessages(convId, 3)
    svc.maybeSummarize(convId)
    expect(runner.calls).toBe(1)
  })

  it("fires on the token threshold (whichever comes first) with msg disabled", () => {
    // msg=0 (off), a tiny token budget → the token trigger fires on its own.
    indexingSettings.summarizeMessageThreshold = 0
    indexingSettings.summarizeTokenThreshold = 50
    const convId = freshConversation()
    seedMessages(convId, 12) // comfortably >50 tokens of content
    svc.maybeSummarize(convId)
    expect(runner.calls).toBe(1)
  })

  it("never fires when both thresholds are 0", () => {
    indexingSettings.summarizeMessageThreshold = 0
    indexingSettings.summarizeTokenThreshold = 0
    const convId = freshConversation()
    seedMessages(convId, 100)
    svc.maybeSummarize(convId)
    expect(runner.calls).toBe(0)
  })

  it("does not enqueue a duplicate while one is already in flight", () => {
    indexingSettings.summarizeMessageThreshold = 20
    const convId = freshConversation()
    seedMessages(convId, 22)
    svc.maybeSummarize(convId)
    svc.maybeSummarize(convId)
    expect(runner.calls).toBe(1)
  })

  it("only counts fresh turns past coversThrough for the threshold", () => {
    indexingSettings.summarizeMessageThreshold = 20
    const convId = freshConversation()
    seedMessages(convId, 22)
    // Pretend everything so far is already summarized.
    upsertConversationSummary({
      conversationId: convId,
      summary: "prior",
      coversThrough: 22,
      messageCount: 22,
    })
    svc.maybeSummarize(convId)
    expect(runner.calls).toBe(0)

    // Add a few more, still below threshold → still no enqueue.
    seedMessages(convId, 3)
    svc.maybeSummarize(convId)
    expect(runner.calls).toBe(0)
  })
})

describe.skipIf(!sqliteLoads)("SummaryService.execute (executor)", () => {
  let svc: SummaryService

  beforeEach(() => {
    db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    svc = new SummaryService(fakeRunner())
    nextCompletion = undefined
    nextError = undefined
    completionCalls = 0
    lastBase = undefined
  })

  it("errors when the task has no conversationId", async () => {
    const task = summarizeTask("")
    ;(task.input as { conversationId?: string }).conversationId = undefined
    const res = await svc.execute({
      task,
      signal: abortSignal(),
      emit: () => {},
      workspace: undefined,
    })
    expect(res.error).toContain("missing conversationId")
  })

  it("writes a summary from the LLM response and advances coverage", async () => {
    const convId = freshConversation()
    seedMessages(convId, 12)
    nextCompletion = {
      choices: [{ message: { content: "## Decisions\n- shipped it" } }],
    }
    const res = await svc.execute({
      task: summarizeTask(convId),
      signal: abortSignal(),
      emit: () => {},
      workspace: undefined,
    })
    expect(res.content).toContain("summarized 12 messages")

    const stored = getConversationSummary(convId)
    expect(stored?.summary).toContain("shipped it")
    expect(stored?.coversThrough).toBe(12)
    expect(stored?.messageCount).toBe(12)
    expect(stored?.tokenEstimate).toBeGreaterThan(0)
  })

  it("folds only the turns past coversThrough (incremental)", async () => {
    const convId = freshConversation()
    seedMessages(convId, 10)
    upsertConversationSummary({
      conversationId: convId,
      summary: "old digest",
      coversThrough: 10,
      messageCount: 10,
    })
    seedMessages(convId, 5) // seq 11..15
    nextCompletion = {
      choices: [{ message: { content: "new digest" } }],
    }
    const res = await svc.execute({
      task: summarizeTask(convId),
      signal: abortSignal(),
      emit: () => {},
      workspace: undefined,
    })
    expect(res.content).toContain("summarized 15 messages")
    const stored = getConversationSummary(convId)
    expect(stored?.summary).toBe("new digest")
    expect(stored?.coversThrough).toBe(15)
  })

  it("no-ops when the summary is already current", async () => {
    const convId = freshConversation()
    seedMessages(convId, 8)
    upsertConversationSummary({
      conversationId: convId,
      summary: "current",
      coversThrough: 8,
      messageCount: 8,
    })
    const res = await svc.execute({
      task: summarizeTask(convId),
      signal: abortSignal(),
      emit: () => {},
      workspace: undefined,
    })
    expect(res.content).toContain("already current")
    expect(completionCalls).toBe(0)
  })

  it("classifies a transient LLM error as retryable", async () => {
    const convId = freshConversation()
    seedMessages(convId, 8)
    nextError = new Error("transient")
    const res = await svc.execute({
      task: summarizeTask(convId),
      signal: abortSignal(),
      emit: () => {},
      workspace: undefined,
    })
    expect(res.error).toBe("transient")
    expect(res.retryable).toBe(true)
    expect(getConversationSummary(convId)).toBeUndefined()
  })

  it("fails fast (no retry) when no provider is configured", async () => {
    const convId = freshConversation()
    seedMessages(convId, 8)
    nextError = new FakeNoProvider("no provider")
    const res = await svc.execute({
      task: summarizeTask(convId),
      signal: abortSignal(),
      emit: () => {},
      workspace: undefined,
    })
    expect(res.error).toContain("no provider")
    expect(res.retryable).toBe(false)
  })

  it("treats an empty LLM summary as a non-retryable error", async () => {
    const convId = freshConversation()
    seedMessages(convId, 8)
    nextCompletion = { choices: [{ message: { content: "   " } }] }
    const res = await svc.execute({
      task: summarizeTask(convId),
      signal: abortSignal(),
      emit: () => {},
      workspace: undefined,
    })
    expect(res.error).toContain("empty summary")
    expect(res.retryable).toBe(false)
  })

  it("strips a conversational preamble before the first heading", async () => {
    const convId = freshConversation()
    seedMessages(convId, 8)
    nextCompletion = {
      choices: [
        {
          message: {
            content:
              "Sure, go for it — what are you testing?\n\n## Decisions\n- None yet.",
          },
        },
      ],
    }
    await svc.execute({
      task: summarizeTask(convId),
      signal: abortSignal(),
      emit: () => {},
      workspace: undefined,
    })
    const stored = getConversationSummary(convId)
    expect(stored?.summary).toBe("## Decisions\n- None yet.")
    expect(stored?.summary).not.toContain("go for it")
  })

  it("keeps off-format output that has no heading", async () => {
    const convId = freshConversation()
    seedMessages(convId, 8)
    nextCompletion = {
      choices: [{ message: { content: "just a plain sentence, no headings" } }],
    }
    await svc.execute({
      task: summarizeTask(convId),
      signal: abortSignal(),
      emit: () => {},
      workspace: undefined,
    })
    const stored = getConversationSummary(convId)
    expect(stored?.summary).toBe("just a plain sentence, no headings")
  })

  it("retries and does not store a truncated (finish_reason=length) summary", async () => {
    const convId = freshConversation()
    seedMessages(convId, 8)
    nextCompletion = {
      choices: [
        {
          message: { content: "## Decisions\n- half a thought that got cut" },
          finish_reason: "length",
        },
      ],
    }
    const res = await svc.execute({
      task: summarizeTask(convId),
      signal: abortSignal(),
      emit: () => {},
      workspace: undefined,
    })
    expect(res.error).toContain("truncated")
    expect(res.retryable).toBe(true)
    // Nothing persisted — the next attempt regenerates cleanly.
    expect(getConversationSummary(convId)).toBeUndefined()
  })

  it("builds a fenced prompt with no continuable transcript cue", async () => {
    const convId = freshConversation()
    seedMessages(convId, 8)
    nextCompletion = {
      choices: [{ message: { content: "## Decisions\n- ok" } }],
    }
    await svc.execute({
      task: summarizeTask(convId),
      signal: abortSignal(),
      emit: () => {},
      workspace: undefined,
    })
    const user =
      lastBase?.messages?.find((m) => m.role === "user")?.content ?? ""
    // Delimited as data, not an open chat log ending in a completion cue.
    expect(user).toContain("<new_turns>")
    expect(user).toContain("</new_turns>")
    expect(user).toContain("<prior_summary>")
    expect(user).not.toMatch(/UPDATED SUMMARY:\s*$/)
    expect(user).toContain("do NOT add any turns of your own")
  })
})

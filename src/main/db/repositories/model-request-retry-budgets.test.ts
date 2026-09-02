import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

import { createConversation } from "./conversations"
import {
  completeBudget,
  createLinkedRetryBudget,
  consumeAttempt,
  exhaustBudget,
  getBudget,
  listBudgetsForConversation,
  recordFailure,
} from "./model-request-retry-budgets"

let conversationId: string

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
  conversationId = createConversation({ mode: "chat" }).id
})

describe.skipIf(!sqliteLoads)("model request retry budgets repo", () => {
  it("creates a budget while consuming the first attempt", () => {
    const budget = consumeAttempt({
      conversationId,
      logicalRoundId: "after-seq:1",
      maxAttempts: 3,
      maxElapsedMs: 120_000,
      now: 1000,
    })

    expect(budget.status).toBe("in_progress")
    expect(budget.attemptsConsumed).toBe(1)
    expect(budget.maxAttempts).toBe(3)
    expect(budget.firstAttemptAt).toBe(1000)
    expect(budget.deadlineAt).toBe(121_000)
    expect(budget.parentBudgetId).toBeNull()
    expect(budget.retrySequence).toBe(0)
    expect(budget.source).toBe("automatic")
    expect(budget.completedAt).toBeNull()
    expect(budget.exhaustedAt).toBeNull()
  })

  it("durably consumes attempts before transport and reloads state", () => {
    consumeAttempt({
      conversationId,
      logicalRoundId: "after-seq:2",
      maxAttempts: 3,
      maxElapsedMs: 120_000,
      now: 1000,
    })
    recordFailure({
      conversationId,
      logicalRoundId: "after-seq:2",
      error: "gateway 503",
      now: 1100,
    })

    const reloaded = getBudget(conversationId, "after-seq:2")!
    expect(reloaded.attemptsConsumed).toBe(1)
    expect(reloaded.lastError).toBe("gateway 503")

    const second = consumeAttempt({
      conversationId,
      logicalRoundId: "after-seq:2",
      maxAttempts: 3,
      maxElapsedMs: 120_000,
      now: 1200,
    })
    expect(second.attemptsConsumed).toBe(2)
    expect(second.firstAttemptAt).toBe(1000)
    expect(second.deadlineAt).toBe(121_000)
  })

  it("marks successful completion", () => {
    consumeAttempt({
      conversationId,
      logicalRoundId: "after-seq:3",
      maxAttempts: 3,
      maxElapsedMs: 120_000,
      now: 1000,
    })

    const completed = completeBudget({
      conversationId,
      logicalRoundId: "after-seq:3",
      now: 2000,
    })

    expect(completed.status).toBe("completed")
    expect(completed.completedAt).toBe(2000)
    expect(completed.exhaustedAt).toBeNull()
  })

  it("marks exhaustion with the last error", () => {
    consumeAttempt({
      conversationId,
      logicalRoundId: "after-seq:4",
      maxAttempts: 3,
      maxElapsedMs: 120_000,
      now: 1000,
    })

    const exhausted = exhaustBudget({
      conversationId,
      logicalRoundId: "after-seq:4",
      error: "gateway timeout",
      now: 3000,
    })

    expect(exhausted.status).toBe("exhausted")
    expect(exhausted.lastError).toBe("gateway timeout")
    expect(exhausted.exhaustedAt).toBe(3000)
  })

  it("exhausts on reload when attempts are already consumed", () => {
    consumeAttempt({
      conversationId,
      logicalRoundId: "after-seq:5",
      maxAttempts: 1,
      maxElapsedMs: 120_000,
      now: 1000,
    })
    recordFailure({
      conversationId,
      logicalRoundId: "after-seq:5",
      error: "gateway 502",
      now: 1100,
    })

    const exhausted = consumeAttempt({
      conversationId,
      logicalRoundId: "after-seq:5",
      maxAttempts: 1,
      maxElapsedMs: 120_000,
      now: 1200,
    })

    expect(exhausted.status).toBe("exhausted")
    expect(exhausted.attemptsConsumed).toBe(1)
    expect(exhausted.lastError).toBe("gateway 502")
  })

  it("creates a linked user retry budget from the latest exhausted budget", () => {
    const parent = consumeAttempt({
      conversationId,
      logicalRoundId: "after-seq:1",
      maxAttempts: 1,
      maxElapsedMs: 120_000,
      now: 1000,
    })
    exhaustBudget({
      conversationId,
      logicalRoundId: "after-seq:1",
      error: "gateway 503",
      now: 1500,
    })

    const retry = createLinkedRetryBudget({
      conversationId,
      logicalRoundId: "after-seq:2",
      now: 2000,
    })!

    expect(retry).toMatchObject({
      logicalRoundId: "after-seq:2",
      parentBudgetId: parent.id,
      retrySequence: 1,
      source: "user_retry",
      status: "in_progress",
      attemptsConsumed: 0,
      maxAttempts: 3,
      firstAttemptAt: 2000,
      deadlineAt: 122_000,
    })
    expect(listBudgetsForConversation(conversationId).map((b) => b.id)).toEqual(
      [parent.id, retry.id]
    )
  })
})

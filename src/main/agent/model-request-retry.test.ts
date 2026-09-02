import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))

import { createConversation } from "../db/repositories/conversations"
import {
  consumeAttempt,
  getBudget,
  recordFailure,
} from "../db/repositories/model-request-retry-budgets"
import {
  createCompletionRoundWithRetry,
  ModelRequestRetryExhaustedError,
  type RetryClock,
} from "./model-request-retry"

function transientError(
  message: string,
  headers?: Map<string, string>
): Error & { transient: true; headers?: Map<string, string> } {
  const err = new Error(message) as Error & {
    transient: true
    headers?: Map<string, string>
  }
  err.transient = true
  if (headers) err.headers = headers
  return err
}

function streamText(content: string): AsyncIterable<any> {
  return (async function* () {
    yield {
      choices: [{ delta: { content }, finish_reason: "stop" }],
    }
  })()
}

function failingPartialStream(error: Error): AsyncIterable<any> {
  return (async function* () {
    yield {
      choices: [
        {
          delta: {
            content: "abandoned text",
            tool_calls: [
              {
                index: 0,
                id: "abandoned_tool",
                type: "function",
                function: {
                  name: "read_file_tool",
                  arguments: '{"path":"partial',
                },
              },
            ],
          },
        },
      ],
    }
    throw error
  })()
}

function makeClock(start = 1000): RetryClock & {
  sleeps: number[]
} {
  let now = start
  const sleeps: number[] = []
  return {
    sleeps,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms)
      now += ms
    },
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

let conversationId: string

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
  conversationId = createConversation({ mode: "chat" }).id
})

describe.skipIf(!sqliteLoads)("model request retry coordinator", () => {
  it("uses capped exponential backoff with injected deterministic jitter", async () => {
    const clock = makeClock()
    const attempts: number[] = []
    const jitters = [0.5, 0.25]

    const round = await createCompletionRoundWithRetry({
      conversationId,
      logicalRoundId: "after-seq:1",
      signal: new AbortController().signal,
      clock,
      random: () => jitters.shift() ?? 0,
      isTransientError: (err) =>
        (err as { transient?: boolean }).transient === true,
      request: async () => {
        attempts.push(clock.now())
        if (attempts.length === 1) throw transientError("first")
        if (attempts.length === 2) throw transientError("second")
        return streamText("ok")
      },
    })

    expect(round.text).toBe("ok")
    expect(attempts).toEqual([1000, 1500, 2000])
    expect(clock.sleeps).toEqual([500, 500])
    expect(getBudget(conversationId, "after-seq:1")).toMatchObject({
      status: "in_progress",
      attemptsConsumed: 3,
      lastError: "second",
    })
  })

  it("honors valid Retry-After seconds", async () => {
    const clock = makeClock()
    let attempts = 0

    await createCompletionRoundWithRetry({
      conversationId,
      logicalRoundId: "after-seq:2",
      signal: new AbortController().signal,
      clock,
      random: () => 0,
      isTransientError: () => true,
      request: async () => {
        attempts += 1
        if (attempts === 1) {
          throw transientError(
            "rate limited",
            new Map([["retry-after", "2.5"]])
          )
        }
        return streamText("ok")
      },
    })

    expect(attempts).toBe(2)
    expect(clock.sleeps).toEqual([2500])
  })

  it("honors valid Retry-After HTTP dates", async () => {
    const clock = makeClock(Date.UTC(2026, 8, 2, 12, 0, 0))
    let attempts = 0

    await createCompletionRoundWithRetry({
      conversationId,
      logicalRoundId: "after-seq:3",
      signal: new AbortController().signal,
      clock,
      isTransientError: () => true,
      request: async () => {
        attempts += 1
        if (attempts === 1) {
          throw transientError(
            "rate limited",
            new Map([["retry-after", "Wed, 02 Sep 2026 12:00:03 GMT"]])
          )
        }
        return streamText("ok")
      },
    })

    expect(attempts).toBe(2)
    expect(clock.sleeps).toEqual([3000])
  })

  it("exhausts when Retry-After exceeds the remaining elapsed-time budget", async () => {
    const clock = makeClock()
    let attempts = 0

    await expect(
      createCompletionRoundWithRetry({
        conversationId,
        logicalRoundId: "after-seq:4",
        signal: new AbortController().signal,
        clock,
        config: {
          maxAttempts: 3,
          baseDelayMs: 1000,
          maxDelayMs: 30_000,
          maxElapsedMs: 2000,
        },
        isTransientError: () => true,
        request: async () => {
          attempts += 1
          throw transientError("rate limited", new Map([["retry-after", "3"]]))
        },
      })
    ).rejects.toThrow(ModelRequestRetryExhaustedError)

    expect(attempts).toBe(1)
    expect(clock.sleeps).toEqual([])
    expect(getBudget(conversationId, "after-seq:4")).toMatchObject({
      status: "exhausted",
      attemptsConsumed: 1,
      lastError: "rate limited",
    })
  })

  it("exhausts when computed delay exceeds the remaining elapsed-time budget", async () => {
    const clock = makeClock()
    let attempts = 0

    await expect(
      createCompletionRoundWithRetry({
        conversationId,
        logicalRoundId: "after-seq:5",
        signal: new AbortController().signal,
        clock,
        random: () => 0.75,
        config: {
          maxAttempts: 3,
          baseDelayMs: 1000,
          maxDelayMs: 30_000,
          maxElapsedMs: 500,
        },
        isTransientError: () => true,
        request: async () => {
          attempts += 1
          throw transientError("gateway timeout")
        },
      })
    ).rejects.toThrow(ModelRequestRetryExhaustedError)

    expect(attempts).toBe(1)
    expect(clock.sleeps).toEqual([])
    expect(getBudget(conversationId, "after-seq:5")).toMatchObject({
      status: "exhausted",
      attemptsConsumed: 1,
      lastError: "gateway timeout",
    })
  })

  it("exhausts by attempt count", async () => {
    const clock = makeClock()
    let attempts = 0

    await expect(
      createCompletionRoundWithRetry({
        conversationId,
        logicalRoundId: "after-seq:6",
        signal: new AbortController().signal,
        clock,
        random: () => 0,
        config: {
          maxAttempts: 2,
          baseDelayMs: 1000,
          maxDelayMs: 30_000,
          maxElapsedMs: 120_000,
        },
        isTransientError: () => true,
        request: async () => {
          attempts += 1
          throw transientError(`outage ${attempts}`)
        },
      })
    ).rejects.toThrow("Model request failed after 2 attempts: outage 2")

    expect(attempts).toBe(2)
    expect(clock.sleeps).toEqual([0])
    expect(getBudget(conversationId, "after-seq:6")).toMatchObject({
      status: "exhausted",
      attemptsConsumed: 2,
      lastError: "outage 2",
    })
  })

  it("cancels during backoff and makes no late provider request", async () => {
    let now = 1000
    const sleeps: number[] = []
    let sleepSignal: AbortSignal | undefined
    let resolveSleep: (() => void) | undefined
    const clock: RetryClock = {
      now: () => now,
      sleep: (ms, signal) => {
        sleeps.push(ms)
        now += ms
        sleepSignal = signal
        return new Promise((resolve) => {
          resolveSleep = resolve
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    }
    const abort = new AbortController()
    let attempts = 0

    const run = createCompletionRoundWithRetry({
      conversationId,
      logicalRoundId: "after-seq:7",
      signal: abort.signal,
      clock,
      random: () => 0.5,
      isTransientError: () => true,
      request: async () => {
        attempts += 1
        throw transientError("temporary outage")
      },
    })

    await flushMicrotasks()
    expect(sleeps).toEqual([500])
    abort.abort()
    expect(sleepSignal?.aborted).toBe(true)
    resolveSleep?.()
    await expect(run).rejects.toThrow("temporary outage")

    expect(attempts).toBe(1)
    expect(getBudget(conversationId, "after-seq:7")).toMatchObject({
      status: "in_progress",
      attemptsConsumed: 1,
      lastError: "temporary outage",
    })
  })

  it("cancels shutdown during backoff and makes no late provider request", async () => {
    const clock = makeClock()
    let sleepSignal: AbortSignal | undefined
    let releaseSleep: (() => void) | undefined
    clock.sleep = (ms, signal) => {
      clock.sleeps.push(ms)
      sleepSignal = signal
      return new Promise((resolve) => {
        releaseSleep = resolve
        signal.addEventListener("abort", () => resolve(), { once: true })
      })
    }
    const abort = new AbortController()
    let attempts = 0

    const run = createCompletionRoundWithRetry({
      conversationId,
      logicalRoundId: "after-seq:8",
      signal: abort.signal,
      clock,
      random: () => 0.25,
      isTransientError: () => true,
      request: async () => {
        attempts += 1
        throw transientError("shutdown outage")
      },
    })

    await flushMicrotasks()
    expect(clock.sleeps).toEqual([250])
    abort.abort("shutdown")
    expect(sleepSignal?.aborted).toBe(true)
    releaseSleep?.()
    await expect(run).rejects.toThrow("shutdown outage")
    expect(attempts).toBe(1)
  })

  it("discards partial stream text and tool fragments before retrying", async () => {
    const clock = makeClock()
    let attempts = 0

    const round = await createCompletionRoundWithRetry({
      conversationId,
      logicalRoundId: "after-seq:9",
      signal: new AbortController().signal,
      clock,
      random: () => 0,
      isTransientError: () => true,
      request: async () => {
        attempts += 1
        if (attempts === 1) {
          return failingPartialStream(transientError("socket died"))
        }
        return streamText("clean retry")
      },
    })

    expect(round).toMatchObject({
      text: "clean retry",
      toolFragments: [],
      finishReason: "stop",
    })
    expect(attempts).toBe(2)
    expect(getBudget(conversationId, "after-seq:9")).toMatchObject({
      attemptsConsumed: 2,
      lastError: "socket died",
    })
  })

  it("makes zero new transport attempts when auto-resuming an exhausted budget", async () => {
    const clock = makeClock(5000)
    let attempts = 0
    consumeAttempt({
      conversationId,
      logicalRoundId: "after-seq:10",
      maxAttempts: 1,
      maxElapsedMs: 1000,
      now: 1000,
    })
    recordFailure({
      conversationId,
      logicalRoundId: "after-seq:10",
      error: "gateway 503",
      now: 1100,
    })

    await expect(
      createCompletionRoundWithRetry({
        conversationId,
        logicalRoundId: "after-seq:10",
        signal: new AbortController().signal,
        clock,
        isTransientError: () => true,
        request: async () => {
          attempts += 1
          throw new Error("provider must not be called")
        },
      })
    ).rejects.toThrow("Model request failed after 1 attempts: gateway 503")

    expect(attempts).toBe(0)
    expect(getBudget(conversationId, "after-seq:10")).toMatchObject({
      status: "exhausted",
      attemptsConsumed: 1,
      lastError: "gateway 503",
    })
  })
})

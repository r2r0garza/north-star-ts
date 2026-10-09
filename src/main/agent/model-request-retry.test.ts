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
  MODEL_RESPONSE_DIAGNOSTIC_MAX_BYTES,
  ModelRequestRetryExhaustedError,
  ModelResponseValidationError,
  mayRejectStreamOptions,
  streamUsageRequested,
  testStreamUsage,
  withStreamUsage,
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

function streamEmpty(finishReason: string | null): AsyncIterable<any> {
  return (async function* () {
    yield {
      choices: [{ delta: {}, finish_reason: finishReason }],
    }
  })()
}

function streamChunk(chunk: any): AsyncIterable<any> {
  return (async function* () {
    yield chunk
  })()
}

function parseDiagnostic(lastError: string | null): any {
  expect(lastError).toContain("[model_response_diagnostic]")
  const json = lastError!.slice(
    lastError!.indexOf("[model_response_diagnostic]") +
      "[model_response_diagnostic]".length
  )
  return JSON.parse(json.trim())
}

function rejectEmptyRound(round: {
  text: string
  toolFragments: unknown[]
  finishReason: string | null
}): void {
  if (round.text.trim() || round.toolFragments.length > 0) return
  throw new ModelResponseValidationError("empty model response", {
    retryable: round.finishReason === null || round.finishReason === "stop",
  })
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
  it("retains fragmented refusal and finish reason, discards tools, and never recovers refusal markup", async () => {
    const recover = vi.fn((text: string) => text)
    const events: any[] = []
    const round = await createCompletionRoundWithRetry({
      conversationId,
      logicalRoundId: "refusal",
      signal: new AbortController().signal,
      isTransientError: () => false,
      recoverVisibleText: recover,
      onAttemptEvent: (event) => events.push(event),
      request: async () =>
        (async function* () {
          yield {
            choices: [
              {
                delta: {
                  refusal: "Cannot ",
                  reasoning_content: "hidden",
                  tool_calls: [
                    {
                      index: 0,
                      function: { name: "exec_command", arguments: "{" },
                    },
                  ],
                },
              },
            ],
          }
          yield {
            choices: [
              { delta: { refusal: "help." }, finish_reason: "refusal" },
            ],
          }
        })(),
    })
    expect(round).toMatchObject({
      text: "Cannot help.",
      refusal: "Cannot help.",
      finishReason: "refusal",
      toolFragments: [],
    })
    expect(round.diagnostics).toMatchObject({
      refusalFieldRecognized: true,
      reasoningFieldRecognized: true,
      toolFragmentCount: 1,
    })
    expect(recover).not.toHaveBeenCalled()
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.delta)
        .join("")
    ).toBe("Cannot help.")
  })
  it("does not treat a null refusal field as a refusal or leak reasoning into text", async () => {
    const round = await createCompletionRoundWithRetry({
      conversationId,
      logicalRoundId: "not-refused",
      signal: new AbortController().signal,
      isTransientError: () => false,
      request: async () =>
        streamChunk({
          choices: [
            {
              delta: {
                content: [
                  { type: "text", text: "Answer" },
                  { type: "thinking", text: "hidden" },
                  { type: "reasoning", text: "hidden" },
                ],
                refusal: null,
                reasoning_content: "hidden",
              },
              finish_reason: "stop",
            },
          ],
        }),
    })
    expect(round.text).toBe("Answer")
    expect(round.refusal).toBeUndefined()
  })

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

    const failure = createCompletionRoundWithRetry({
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

    await expect(failure).rejects.toMatchObject({
      message: "Model request failed after 2 attempts: outage 2",
      retryable: true,
    })

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

  it("rolls back partial streamed text before retrying", async () => {
    const clock = makeClock()
    let attempts = 0
    const events: Array<Record<string, unknown>> = []

    const round = await createCompletionRoundWithRetry({
      conversationId,
      logicalRoundId: "after-seq:9",
      signal: new AbortController().signal,
      clock,
      random: () => 0,
      isTransientError: () => true,
      onAttemptEvent: (event) => events.push(event),
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
    expect(events).toEqual([
      { type: "start", attemptId: "after-seq:9:attempt:1", attempt: 1 },
      {
        type: "text",
        attemptId: "after-seq:9:attempt:1",
        delta: "abandoned text",
      },
      {
        type: "rollback",
        attemptId: "after-seq:9:attempt:1",
        retrying: true,
        error: expect.objectContaining({ message: "socket died" }),
      },
      { type: "start", attemptId: "after-seq:9:attempt:2", attempt: 2 },
      {
        type: "text",
        attemptId: "after-seq:9:attempt:2",
        delta: "clean retry",
      },
      { type: "commit", attemptId: "after-seq:9:attempt:2" },
    ])
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

  it("retries transient empty stop responses within the same logical round", async () => {
    const clock = makeClock()
    let attempts = 0

    const round = await createCompletionRoundWithRetry({
      conversationId,
      logicalRoundId: "after-seq:11",
      signal: new AbortController().signal,
      clock,
      random: () => 0,
      isTransientError: () => false,
      validateRound: rejectEmptyRound,
      request: async () => {
        attempts += 1
        return attempts === 1 ? streamEmpty("stop") : streamText("accepted")
      },
    })

    expect(round.text).toBe("accepted")
    expect(attempts).toBe(2)
    expect(clock.sleeps).toEqual([0])
    expect(getBudget(conversationId, "after-seq:11")).toMatchObject({
      status: "in_progress",
      attemptsConsumed: 2,
    })
    const diagnostic = parseDiagnostic(
      getBudget(conversationId, "after-seq:11")!.lastError
    )
    expect(diagnostic).toMatchObject({
      message: "empty model response",
      chunkCount: 1,
      choiceSeen: true,
      deltaSeen: true,
      finishReason: "stop",
      rawTextCharCount: 0,
      recoveredVisibleTextCharCount: 0,
    })
  })

  it("exhausts repeated transient empty stop responses", async () => {
    const clock = makeClock()
    let attempts = 0

    await expect(
      createCompletionRoundWithRetry({
        conversationId,
        logicalRoundId: "after-seq:12",
        signal: new AbortController().signal,
        clock,
        random: () => 0,
        config: {
          maxAttempts: 2,
          baseDelayMs: 1000,
          maxDelayMs: 30_000,
          maxElapsedMs: 120_000,
        },
        isTransientError: () => false,
        validateRound: rejectEmptyRound,
        request: async () => {
          attempts += 1
          return streamEmpty("stop")
        },
      })
    ).rejects.toThrow(
      "Model request failed after 2 attempts: empty model response"
    )

    expect(attempts).toBe(2)
    expect(getBudget(conversationId, "after-seq:12")).toMatchObject({
      status: "exhausted",
      attemptsConsumed: 2,
    })
    expect(getBudget(conversationId, "after-seq:12")!.lastError).toContain(
      "[model_response_diagnostic]"
    )
  })

  it("does not retry deterministic empty length responses", async () => {
    const clock = makeClock()
    let attempts = 0

    await expect(
      createCompletionRoundWithRetry({
        conversationId,
        logicalRoundId: "after-seq:13",
        signal: new AbortController().signal,
        clock,
        isTransientError: () => true,
        validateRound: rejectEmptyRound,
        request: async () => {
          attempts += 1
          return streamEmpty("length")
        },
      })
    ).rejects.toThrow("empty model response")

    expect(attempts).toBe(1)
    expect(clock.sleeps).toEqual([])
    expect(getBudget(conversationId, "after-seq:13")).toMatchObject({
      status: "exhausted",
      attemptsConsumed: 1,
    })
    const diagnostic = parseDiagnostic(
      getBudget(conversationId, "after-seq:13")!.lastError
    )
    expect(diagnostic.finishReason).toBe("length")
  })

  it("does not grant a new attempt when an empty response arrives after the deadline", async () => {
    let now = 1000
    const clock: RetryClock & { sleeps: number[] } = {
      sleeps: [],
      now: () => now,
      sleep: async (ms) => {
        clock.sleeps.push(ms)
        now += ms
      },
    }
    let attempts = 0

    await expect(
      createCompletionRoundWithRetry({
        conversationId,
        logicalRoundId: "after-seq:14",
        signal: new AbortController().signal,
        clock,
        random: () => 0,
        config: {
          maxAttempts: 3,
          baseDelayMs: 1000,
          maxDelayMs: 30_000,
          maxElapsedMs: 100,
        },
        isTransientError: () => false,
        validateRound: rejectEmptyRound,
        request: async () => {
          attempts += 1
          now = 1200
          return streamEmpty("stop")
        },
      })
    ).rejects.toThrow(
      "Model request failed after 1 attempts: empty model response"
    )

    expect(attempts).toBe(1)
    expect(clock.sleeps).toEqual([])
    expect(getBudget(conversationId, "after-seq:14")).toMatchObject({
      status: "exhausted",
      attemptsConsumed: 1,
    })
    expect(getBudget(conversationId, "after-seq:14")!.lastError).toContain(
      "[model_response_diagnostic]"
    )
  })

  it("records distinct bounded diagnostics for empty stream shapes", async () => {
    const cases = [
      {
        id: "empty-eof",
        stream: (async function* () {})(),
        expected: { chunkCount: 0, choiceSeen: false, deltaSeen: false },
      },
      {
        id: "reasoning-only",
        stream: streamChunk({
          choices: [
            {
              delta: { reasoning_content: "hidden sentinel" },
              finish_reason: "stop",
            },
          ],
        }),
        expected: {
          reasoningFieldRecognized: true,
          refusalFieldRecognized: null,
        },
      },
    ]

    for (const testCase of cases) {
      await expect(
        createCompletionRoundWithRetry({
          conversationId,
          logicalRoundId: `after-seq:${testCase.id}`,
          signal: new AbortController().signal,
          clock: makeClock(),
          config: {
            maxAttempts: 1,
            baseDelayMs: 1000,
            maxDelayMs: 30_000,
            maxElapsedMs: 120_000,
          },
          isTransientError: () => false,
          validateRound: rejectEmptyRound,
          request: async () => testCase.stream,
        })
      ).rejects.toThrow("empty model response")

      const diagnostic = parseDiagnostic(
        getBudget(conversationId, `after-seq:${testCase.id}`)!.lastError
      )
      expect(diagnostic).toMatchObject(testCase.expected)
      expect(JSON.stringify(diagnostic)).not.toContain("sentinel")
    }
  })

  it("records resolved request identity, usage, provider request id, recovered text, and tool counts", async () => {
    await expect(
      createCompletionRoundWithRetry({
        conversationId,
        logicalRoundId: "after-seq:diagnostic-rich",
        signal: new AbortController().signal,
        clock: makeClock(),
        config: {
          maxAttempts: 1,
          baseDelayMs: 1000,
          maxDelayMs: 30_000,
          maxElapsedMs: 120_000,
        },
        requestIdentity: {
          accountId: "acct-1",
          modelId: "model-1",
          apiMode: "completions",
        },
        recoverVisibleText: () => "",
        isTransientError: () => false,
        validateRound: () => {
          throw new ModelResponseValidationError("empty model response", {
            retryable: false,
          })
        },
        request: async () =>
          streamChunk({
            _request_id: "req-123",
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              total_tokens: 12,
            },
            choices: [
              {
                delta: {
                  content: "<tool_call>{}</tool_call>",
                  tool_calls: [{ index: 3 }],
                },
                finish_reason: "stop",
              },
            ],
          }),
      })
    ).rejects.toThrow("empty model response")

    const diagnostic = parseDiagnostic(
      getBudget(conversationId, "after-seq:diagnostic-rich")!.lastError
    )
    expect(diagnostic).toMatchObject({
      request: {
        accountId: "acct-1",
        modelId: "model-1",
        apiMode: "completions",
      },
      providerRequestId: "req-123",
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      rawTextCharCount: "<tool_call>{}</tool_call>".length,
      recoveredVisibleTextCharCount: 0,
      toolFragmentCount: 1,
      terminalToolCallCount: 1,
    })
  })

  it("caps adversarial diagnostic serialization and keeps it valid", async () => {
    const hostile = "credential://secret@example.com/".repeat(500)

    await expect(
      createCompletionRoundWithRetry({
        conversationId,
        logicalRoundId: "after-seq:hostile-diagnostic",
        signal: new AbortController().signal,
        clock: makeClock(),
        config: {
          maxAttempts: 1,
          baseDelayMs: 1000,
          maxDelayMs: 30_000,
          maxElapsedMs: 120_000,
        },
        requestIdentity: {
          accountId: hostile,
          modelId: hostile,
          apiMode: "completions",
        },
        isTransientError: () => false,
        validateRound: () => {
          throw new ModelResponseValidationError(hostile, { retryable: false })
        },
        request: async () =>
          streamChunk({
            _request_id: hostile,
            choices: [{ delta: {}, finish_reason: hostile }],
          }),
      })
    ).rejects.toThrow(hostile)

    const lastError = getBudget(
      conversationId,
      "after-seq:hostile-diagnostic"
    )!.lastError!
    const diagnostic = parseDiagnostic(lastError)
    expect(
      Buffer.byteLength(JSON.stringify(diagnostic), "utf8")
    ).toBeLessThanOrEqual(MODEL_RESPONSE_DIAGNOSTIC_MAX_BYTES)
    expect(diagnostic.providerRequestId.length).toBeLessThanOrEqual(160)
    expect(diagnostic.request.accountId.length).toBeLessThanOrEqual(160)
  })
})

describe.skipIf(!sqliteLoads)("streamed usage reporting (plan 108)", () => {
  it("picks up the trailing usage chunk that has an empty choices array", async () => {
    const round = await createCompletionRoundWithRetry({
      conversationId,
      logicalRoundId: "after-seq:usage-tail",
      signal: new AbortController().signal,
      clock: makeClock(),
      isTransientError: () => false,
      request: async () =>
        (async function* () {
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      function: { name: "list_files", arguments: "{}" },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }
          yield {
            choices: [],
            usage: { prompt_tokens: 1200, completion_tokens: 30 },
          }
        })(),
    })

    expect(round.finishReason).toBe("tool_calls")
    expect(round.toolFragments).toHaveLength(1)
    expect(round.diagnostics.usage).toEqual({
      promptTokens: 1200,
      completionTokens: 30,
      totalTokens: undefined,
    })
  })

  it("reads Responses-shaped input/output usage", async () => {
    const round = await createCompletionRoundWithRetry({
      conversationId,
      logicalRoundId: "after-seq:usage-responses",
      signal: new AbortController().signal,
      clock: makeClock(),
      isTransientError: () => false,
      request: async () =>
        streamChunk({
          usage: { input_tokens: 900, output_tokens: 12, total_tokens: 912 },
          choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
        }),
    })

    expect(round.diagnostics.usage).toEqual({
      promptTokens: 900,
      completionTokens: 12,
      totalTokens: 912,
    })
  })
})

describe("stream_options fallback (plan 108)", () => {
  beforeEach(() => testStreamUsage.reset())

  function badRequest(message: string): Error & { status: number } {
    return Object.assign(new Error(message), { status: 400 })
  }

  it("treats any 400/422, or an unstatused error naming stream_options, as a possible refusal", () => {
    expect(mayRejectStreamOptions(badRequest("400 Bad Request"))).toBe(true)
    expect(
      mayRejectStreamOptions(
        Object.assign(new Error("Unprocessable"), { status: 422 })
      )
    ).toBe(true)
    expect(
      mayRejectStreamOptions(new Error("unknown field stream_options"))
    ).toBe(true)
    expect(mayRejectStreamOptions(new Error("fetch failed"))).toBe(false)
    for (const status of [401, 404, 429, 502]) {
      expect(
        mayRejectStreamOptions(
          Object.assign(new Error("stream_options"), { status })
        )
      ).toBe(false)
    }
  })

  it("asks for usage only on Chat Completions accounts", async () => {
    const sent: unknown[] = []
    await withStreamUsage(
      { accountId: "a", apiMode: "codex_responses" },
      async (options) => sent.push(options)
    )
    await withStreamUsage(
      { accountId: "a", apiMode: "completions" },
      async (options) => sent.push(options)
    )
    expect(sent).toEqual([undefined, { include_usage: true }])
  })

  it.each([400, 422])(
    "never probes stream usage for locally validated clients (HTTP %s)",
    async (status) => {
      const identity = {
        accountId: "subscription",
        apiMode: "completions" as const,
        client: { compatibilityProbes: false as const },
      }
      const error = Object.assign(new Error("Bad request"), { status })
      const send = vi.fn().mockRejectedValue(error)
      await expect(withStreamUsage(identity, send)).rejects.toBe(error)
      expect(send).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenCalledWith({ include_usage: true })
      expect(streamUsageRequested(identity)).toBe(true)
    }
  )

  it("retries once without stream_options and remembers the account", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const identity = { accountId: "bridge", apiMode: "completions" as const }
    const sent: unknown[] = []
    const send = async (options: unknown) => {
      sent.push(options)
      if (options) throw badRequest("400 unknown parameter: stream_options")
      return "stream"
    }

    await expect(withStreamUsage(identity, send)).resolves.toBe("stream")
    expect(sent).toEqual([{ include_usage: true }, undefined])
    expect(streamUsageRequested(identity)).toBe(false)

    await withStreamUsage(identity, send)
    expect(sent).toEqual([{ include_usage: true }, undefined, undefined])
    // Other accounts still ask.
    expect(
      streamUsageRequested({ accountId: "other", apiMode: "completions" })
    ).toBe(true)
    warn.mockRestore()
  })

  it("falls back on a bare 400 that never names stream_options", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const identity = { accountId: "vague", apiMode: "completions" as const }
    const sent: unknown[] = []
    await expect(
      withStreamUsage(identity, async (options) => {
        sent.push(options)
        if (options) throw badRequest("400 Bad Request")
        return "stream"
      })
    ).resolves.toBe("stream")
    expect(sent).toEqual([{ include_usage: true }, undefined])
    expect(streamUsageRequested(identity)).toBe(false)
  })

  it("throws the retry's error and keeps asking when the request itself is bad", async () => {
    const identity = { accountId: "bad", apiMode: "completions" as const }
    const sent: unknown[] = []
    await expect(
      withStreamUsage(identity, async (options) => {
        sent.push(options)
        throw badRequest(options ? "400 first" : "400 invalid messages")
      })
    ).rejects.toThrow("invalid messages")
    expect(sent).toEqual([{ include_usage: true }, undefined])
    expect(streamUsageRequested(identity)).toBe(true)
  })

  it("rethrows other failures without a retry", async () => {
    const identity = { accountId: "auth", apiMode: "completions" as const }
    const sent: unknown[] = []
    await expect(
      withStreamUsage(identity, async (options) => {
        sent.push(options)
        throw Object.assign(new Error("invalid api key"), { status: 401 })
      })
    ).rejects.toThrow("invalid api key")
    expect(sent).toEqual([{ include_usage: true }])
    expect(streamUsageRequested(identity)).toBe(true)
  })
})

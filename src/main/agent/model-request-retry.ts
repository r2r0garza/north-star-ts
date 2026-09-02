import type { ToolCallDelta } from "./tool-stream"
import type { ModelRequestRetryBudget } from "../db/types"
import {
  consumeAttempt as consumeModelRequestRetryAttempt,
  exhaustBudget as exhaustModelRequestRetryBudget,
  recordFailure as recordModelRequestRetryFailure,
} from "../db/repositories/model-request-retry-budgets"

export const MODEL_REQUEST_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  maxElapsedMs: 120_000,
}

export interface CompletionRound {
  text: string
  toolFragments: ToolCallDelta[]
  finishReason: string | null
}

export class ModelRequestRetryExhaustedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ModelRequestRetryExhaustedError"
  }
}

export interface RetryClock {
  now(): number
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

interface RetryRepository {
  consumeAttempt(input: {
    conversationId: string
    logicalRoundId: string
    maxAttempts: number
    maxElapsedMs: number
    now?: number
  }): ModelRequestRetryBudget
  recordFailure(input: {
    conversationId: string
    logicalRoundId: string
    error: string
    now?: number
  }): ModelRequestRetryBudget
  exhaustBudget(input: {
    conversationId: string
    logicalRoundId: string
    error: string
    now?: number
  }): ModelRequestRetryBudget
}

export function retryAfterMs(error: unknown, now = Date.now()): number | null {
  const headers = (error as { headers?: unknown } | null)?.headers
  const get =
    headers && typeof (headers as { get?: unknown }).get === "function"
      ? (name: string) =>
          (headers as { get: (name: string) => string | null }).get(name)
      : null
  const retryAfterMsValue = get?.("retry-after-ms")
  if (retryAfterMsValue) {
    const parsed = Number.parseFloat(retryAfterMsValue)
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed)
  }
  const retryAfter = get?.("retry-after")
  if (!retryAfter) return null
  const seconds = Number.parseFloat(retryAfter)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000)
  }
  const date = Date.parse(retryAfter)
  if (!Number.isNaN(date)) return Math.max(0, date - now)
  return null
}

export function modelRetryDelayMs(input: {
  attempt: number
  error: unknown
  now?: number
  random?: () => number
  config?: typeof MODEL_REQUEST_RETRY
}): number {
  const config = input.config ?? MODEL_REQUEST_RETRY
  const advised = retryAfterMs(input.error, input.now)
  if (advised !== null) return advised
  const ceiling = Math.min(
    config.maxDelayMs,
    config.baseDelayMs * 2 ** (input.attempt - 1)
  )
  return Math.floor((input.random ?? Math.random)() * ceiling)
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      signal.removeEventListener("abort", done)
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })
}

const defaultClock: RetryClock = {
  now: () => Date.now(),
  sleep: abortableDelay,
}

const defaultRepository: RetryRepository = {
  consumeAttempt: consumeModelRequestRetryAttempt,
  recordFailure: recordModelRequestRetryFailure,
  exhaustBudget: exhaustModelRequestRetryBudget,
}

// Normalize a content value (string or array of parts) to plain text.
function contentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) =>
        typeof part === "string" ? part : (part?.text ?? "")
      )
      .join("")
  }
  return ""
}

async function consumeCompletionStream(
  stream: AsyncIterable<any>,
  signal: AbortSignal
): Promise<CompletionRound> {
  let text = ""
  const toolFragments: ToolCallDelta[] = []
  let finishReason: string | null = null

  for await (const chunk of stream) {
    if (signal.aborted) break
    const choice = chunk.choices[0]
    if (choice?.finish_reason) finishReason = choice.finish_reason
    const delta = choice?.delta
    if (!delta) continue

    const piece = contentToText(delta.content)
    if (piece) text += piece

    for (const tc of (delta.tool_calls ?? []) as ToolCallDelta[]) {
      toolFragments.push(tc)
    }
  }

  return { text, toolFragments, finishReason }
}

export async function createCompletionRoundWithRetry(input: {
  conversationId: string
  logicalRoundId: string
  request: () => Promise<AsyncIterable<any>>
  isTransientError: (error: unknown) => boolean
  signal: AbortSignal
  clock?: RetryClock
  random?: () => number
  repository?: RetryRepository
  config?: typeof MODEL_REQUEST_RETRY
}): Promise<CompletionRound> {
  const {
    conversationId,
    logicalRoundId,
    request,
    isTransientError,
    signal,
    random,
  } = input
  const clock = input.clock ?? defaultClock
  const repository = input.repository ?? defaultRepository
  const config = input.config ?? MODEL_REQUEST_RETRY
  let lastError: unknown
  let attemptsUsed = 0

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    const budget = repository.consumeAttempt({
      conversationId,
      logicalRoundId,
      maxAttempts: config.maxAttempts,
      maxElapsedMs: config.maxElapsedMs,
      now: clock.now(),
    })
    attemptsUsed = budget.attemptsConsumed
    if (budget.status === "exhausted") {
      lastError = budget.lastError ?? "Retry budget exhausted before transport"
      break
    }
    if (budget.status === "completed") {
      throw new ModelRequestRetryExhaustedError(
        `Model request retry budget for ${logicalRoundId} is already completed`
      )
    }

    try {
      const stream = await request()
      return await consumeCompletionStream(stream, signal)
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      repository.recordFailure({
        conversationId,
        logicalRoundId,
        error: message,
        now: clock.now(),
      })
      if (signal.aborted) throw error
      if (!isTransientError(error)) {
        repository.exhaustBudget({
          conversationId,
          logicalRoundId,
          error: message,
          now: clock.now(),
        })
        throw error
      }

      const delay = modelRetryDelayMs({
        attempt: attemptsUsed,
        error,
        now: clock.now(),
        random,
        config,
      })
      const hasAttempt = attemptsUsed < budget.maxAttempts
      const hasBudget = clock.now() + delay <= budget.deadlineAt
      if (!hasAttempt || !hasBudget) {
        repository.exhaustBudget({
          conversationId,
          logicalRoundId,
          error: message,
          now: clock.now(),
        })
        break
      }

      await clock.sleep(delay, signal)
      if (signal.aborted) throw error
    }
  }

  const message =
    lastError instanceof Error ? lastError.message : String(lastError)
  throw new ModelRequestRetryExhaustedError(
    `Model request failed after ${attemptsUsed} attempts: ${message}`
  )
}

import type { ToolCallDelta } from "./tool-stream"
import type { ApiMode, ModelRequestRetryBudget } from "../db/types"
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
  diagnostics: ModelResponseAttemptDiagnostics
}

export class ModelRequestRetryExhaustedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ModelRequestRetryExhaustedError"
  }
}

export class ModelResponseValidationError extends Error {
  readonly retryable: boolean
  diagnostics?: ModelResponseAttemptDiagnostics

  constructor(
    message: string,
    options?: {
      retryable?: boolean
      diagnostics?: ModelResponseAttemptDiagnostics
    }
  ) {
    super(message)
    this.name = "ModelResponseValidationError"
    this.retryable = options?.retryable === true
    this.diagnostics = options?.diagnostics
  }
}

export interface ModelResponseRequestIdentity {
  accountId: string
  modelId: string
  apiMode: ApiMode
}

export interface ModelResponseAttemptDiagnostics {
  code: string
  message: string
  request: ModelResponseRequestIdentity | null
  elapsedMs: number
  chunkCount: number
  choiceSeen: boolean
  deltaSeen: boolean
  rawTextCharCount: number
  recoveredVisibleTextCharCount: number
  toolFragmentCount: number
  terminalToolCallCount: number
  finishReason: string | null
  refusalFieldRecognized: boolean | null
  reasoningFieldRecognized: boolean | null
  providerRequestId: string | null
  usage: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  } | null
}

export const MODEL_RESPONSE_DIAGNOSTIC_MAX_BYTES = 4096

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

function cappedString(value: unknown, max = 160): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max)
  return trimmed.length > 0 ? trimmed : null
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function usageFromChunk(chunk: any): ModelResponseAttemptDiagnostics["usage"] {
  const usage = chunk?.usage
  if (!usage || typeof usage !== "object") return null
  const promptTokens = finiteNumber(usage.prompt_tokens)
  const completionTokens = finiteNumber(usage.completion_tokens)
  const totalTokens = finiteNumber(usage.total_tokens)
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined
  ) {
    return null
  }
  return { promptTokens, completionTokens, totalTokens }
}

function providerRequestIdFromChunk(chunk: any): string | null {
  return (
    cappedString(chunk?._request_id) ??
    cappedString(chunk?.request_id) ??
    cappedString(chunk?.response?.request_id) ??
    null
  )
}

function diagnosticErrorText(input: {
  message: string
  diagnostics?: ModelResponseAttemptDiagnostics
}): string {
  if (!input.diagnostics) return input.message
  const message =
    cappedString(input.message, 500) ?? "model response validation failed"
  const payload = boundedDiagnosticPayload(input.diagnostics)
  return `${message}\n\n[model_response_diagnostic] ${payload}`
}

function boundedDiagnosticPayload(
  diagnostics: ModelResponseAttemptDiagnostics
): string {
  const capped: ModelResponseAttemptDiagnostics = {
    ...diagnostics,
    code: diagnostics.code.slice(0, 80),
    message: diagnostics.message.slice(0, 300),
    finishReason: cappedString(diagnostics.finishReason, 80),
    providerRequestId: cappedString(diagnostics.providerRequestId, 160),
    request: diagnostics.request
      ? {
          accountId: diagnostics.request.accountId.slice(0, 160),
          modelId: diagnostics.request.modelId.slice(0, 160),
          apiMode: diagnostics.request.apiMode,
        }
      : null,
  }
  let json = JSON.stringify(capped)
  const max = MODEL_RESPONSE_DIAGNOSTIC_MAX_BYTES
  while (Buffer.byteLength(json, "utf8") > max && capped.message.length > 0) {
    capped.message = capped.message.slice(
      0,
      Math.max(0, capped.message.length - 50)
    )
    json = JSON.stringify(capped)
  }
  if (Buffer.byteLength(json, "utf8") <= max) return json
  return JSON.stringify({
    code: capped.code,
    message: capped.message.slice(0, 80),
    request: capped.request,
    elapsedMs: capped.elapsedMs,
    chunkCount: capped.chunkCount,
    choiceSeen: capped.choiceSeen,
    deltaSeen: capped.deltaSeen,
    rawTextCharCount: capped.rawTextCharCount,
    recoveredVisibleTextCharCount: capped.recoveredVisibleTextCharCount,
    toolFragmentCount: capped.toolFragmentCount,
    terminalToolCallCount: capped.terminalToolCallCount,
    finishReason: capped.finishReason,
    refusalFieldRecognized: capped.refusalFieldRecognized,
    reasoningFieldRecognized: capped.reasoningFieldRecognized,
  })
}

async function consumeCompletionStream(
  stream: AsyncIterable<any>,
  signal: AbortSignal,
  input: {
    startedAt: number
    now: () => number
    requestIdentity?: ModelResponseRequestIdentity | null
    recoverVisibleText?: (rawText: string) => string
  }
): Promise<CompletionRound> {
  let text = ""
  const toolFragments: ToolCallDelta[] = []
  let finishReason: string | null = null
  let chunkCount = 0
  let choiceSeen = false
  let deltaSeen = false
  let refusalFieldRecognized: boolean | null = null
  let reasoningFieldRecognized: boolean | null = null
  let providerRequestId: string | null = null
  let usage: ModelResponseAttemptDiagnostics["usage"] = null
  const terminalToolCallIndexes = new Set<number>()

  for await (const chunk of stream) {
    if (signal.aborted) break
    chunkCount += 1
    providerRequestId ??= providerRequestIdFromChunk(chunk)
    usage ??= usageFromChunk(chunk)
    const choice = chunk.choices?.[0]
    if (choice) choiceSeen = true
    if (choice?.finish_reason) finishReason = choice.finish_reason
    const delta = choice?.delta
    if (!delta) continue
    deltaSeen = true
    if (Object.prototype.hasOwnProperty.call(delta, "refusal")) {
      refusalFieldRecognized = true
    }
    if (
      Object.prototype.hasOwnProperty.call(delta, "reasoning") ||
      Object.prototype.hasOwnProperty.call(delta, "reasoning_content")
    ) {
      reasoningFieldRecognized = true
    }

    const piece = contentToText(delta.content)
    if (piece) text += piece

    for (const tc of (delta.tool_calls ?? []) as ToolCallDelta[]) {
      toolFragments.push(tc)
      if (typeof tc.index === "number") terminalToolCallIndexes.add(tc.index)
    }
  }

  const recoveredText = input.recoverVisibleText?.(text) ?? text
  return {
    text,
    toolFragments,
    finishReason,
    diagnostics: {
      code: "model_response_validation_failed",
      message: "",
      request: input.requestIdentity ?? null,
      elapsedMs: Math.max(0, input.now() - input.startedAt),
      chunkCount,
      choiceSeen,
      deltaSeen,
      rawTextCharCount: text.length,
      recoveredVisibleTextCharCount: recoveredText.length,
      toolFragmentCount: toolFragments.length,
      terminalToolCallCount: terminalToolCallIndexes.size,
      finishReason,
      refusalFieldRecognized,
      reasoningFieldRecognized,
      providerRequestId,
      usage,
    },
  }
}

export async function createCompletionRoundWithRetry(input: {
  conversationId: string
  logicalRoundId: string
  request: () => Promise<AsyncIterable<any>>
  isTransientError: (error: unknown) => boolean
  validateRound?: (round: CompletionRound) => void
  requestIdentity?: ModelResponseRequestIdentity | null
  recoverVisibleText?: (rawText: string) => string
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
    validateRound,
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
      const startedAt = clock.now()
      const stream = await request()
      const round = await consumeCompletionStream(stream, signal, {
        startedAt,
        now: clock.now,
        requestIdentity: input.requestIdentity,
        recoverVisibleText: input.recoverVisibleText,
      })
      if (!signal.aborted && validateRound) {
        try {
          validateRound(round)
        } catch (validationError) {
          if (validationError instanceof ModelResponseValidationError) {
            validationError.diagnostics = {
              ...round.diagnostics,
              code: "model_response_validation_failed",
              message: validationError.message,
            }
          }
          throw validationError
        }
      }
      return round
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      const persistedError = diagnosticErrorText({
        message,
        diagnostics:
          error instanceof ModelResponseValidationError
            ? error.diagnostics
            : undefined,
      })
      repository.recordFailure({
        conversationId,
        logicalRoundId,
        error: persistedError,
        now: clock.now(),
      })
      if (signal.aborted) throw error
      const retryable =
        error instanceof ModelResponseValidationError
          ? error.retryable
          : isTransientError(error)
      if (!retryable) {
        repository.exhaustBudget({
          conversationId,
          logicalRoundId,
          error: persistedError,
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
          error: persistedError,
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

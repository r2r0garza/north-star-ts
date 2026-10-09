import {
  nativeAssistant,
  validateCarrier,
} from "./providers/claude-subscription/native-carrier"
import type { ToolCallDelta } from "./tool-stream"
import { modelRequestPermits } from "./model-permits"
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

// How long a model request may go silent. Reasoning models can think a while
// before the first chunk, so that wait is generous; after that, a stream that
// sends nothing for minutes has hung (nav-test-9: a Codex-subscription stream
// stayed open with no data for 15 minutes and blocked the phase).
export const MODEL_STREAM_IDLE = {
  firstChunkMs: 5 * 60_000,
  betweenChunksMs: 2 * 60_000,
}

// Streamed Chat Completions only report usage when asked (plan 108). Some
// OpenAI-compatible bridges reject the unknown parameter; such an account is
// remembered for the session and asked again only after a restart.
const STREAM_USAGE_OPTIONS = { include_usage: true } as const
const streamUsageRejectedAccounts = new Set<string>()

export function streamUsageRequested(identity: {
  accountId: string
  apiMode: ApiMode
}): boolean {
  return (
    identity.apiMode === "completions" &&
    !streamUsageRejectedAccounts.has(identity.accountId)
  )
}

// A failure that could be the provider refusing stream_options. Bridges often
// reject unknown parameters with a bare 400/422 that never names the field, so
// any 400/422 qualifies; withStreamUsage's retry without it tells the cases
// apart. With no numeric status, the error must name stream_options.
export function mayRejectStreamOptions(error: unknown): boolean {
  const e = (error ?? {}) as {
    status?: unknown
    code?: unknown
    message?: unknown
    error?: unknown
  }
  if (typeof e.status === "number") return e.status === 400 || e.status === 422
  let body = ""
  try {
    body = JSON.stringify(e.error ?? "")
  } catch {
    // An unserializable body just isn't searched.
  }
  const text = `${String(e.code ?? "")} ${String(e.message ?? error)} ${body}`
  return /stream_options/i.test(text)
}

// Send a streamed request asking for usage. If a request with stream_options
// fails in a way that could be a refusal of it, retry once without it: when
// that succeeds, the account is remembered for the session and never asked
// again; when it fails too, the request itself was bad and the retry's error
// is the one thrown. Usage reporting never fails a turn on its own.
export async function withStreamUsage<T>(
  identity: {
    accountId: string
    apiMode: ApiMode
    client?: { compatibilityProbes?: false }
  },
  send: (streamOptions: typeof STREAM_USAGE_OPTIONS | undefined) => Promise<T>
): Promise<T> {
  if (!streamUsageRequested(identity)) return send(undefined)
  if (identity.client?.compatibilityProbes === false)
    return send(STREAM_USAGE_OPTIONS)
  try {
    return await send(STREAM_USAGE_OPTIONS)
  } catch (error) {
    if (!mayRejectStreamOptions(error)) throw error
  }
  const result = await send(undefined)
  streamUsageRejectedAccounts.add(identity.accountId)
  console.warn(
    `[ctx] provider account ${identity.accountId} rejected stream_options; continuing without usage reporting.`
  )
  return result
}

export const testStreamUsage = {
  reset: () => streamUsageRejectedAccounts.clear(),
}

// A request or its stream sent nothing for too long. Not retried within the
// round's transient budget (its time window is gone by then); the agent loop
// re-issues the round.
export class StreamStalledError extends Error {
  constructor(
    readonly waitedMs: number,
    readonly firstChunk: boolean
  ) {
    super(
      `The model ${firstChunk ? "sent no response" : "stopped sending"} for ${Math.round(waitedMs / 1000)} s; the request looks hung.`
    )
    this.name = "StreamStalledError"
  }
}

// Settle with `promise`, or reject with `stalled()` after `ms`. One `then`,
// so a result or error arrives no later than awaiting `promise` directly.
function withinTime<T>(
  promise: Promise<T>,
  ms: number,
  stalled: () => Error
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(stalled()), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

// The stream's chunks, failing with StreamStalledError when the next one
// doesn't arrive in time.
async function* idleGuarded<T>(
  stream: AsyncIterable<T>,
  idle: typeof MODEL_STREAM_IDLE
): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]()
  let first = true
  try {
    for (;;) {
      const ms = first ? idle.firstChunkMs : idle.betweenChunksMs
      const next = await withinTime(
        iterator.next(),
        ms,
        () => new StreamStalledError(ms, first)
      )
      if (next.done) return
      first = false
      yield next.value
    }
  } finally {
    // Don't wait: a hung stream's return() can hang too.
    void Promise.resolve(iterator.return?.()).catch(() => {})
  }
}

export interface CompletionRound {
  nativeAssistant?: import("./providers/claude-subscription/native-carrier").NativeAssistantCarrier
  refusal?: string
  text: string
  toolFragments: ToolCallDelta[]
  finishReason: string | null
  diagnostics: ModelResponseAttemptDiagnostics
}

export type CompletionAttemptEvent =
  | { type: "start"; attemptId: string; attempt: number }
  | { type: "text"; attemptId: string; delta: string }
  | { type: "commit"; attemptId: string }
  | {
      type: "rollback"
      attemptId: string
      retrying: boolean
      // Why the attempt was rolled back.
      error: unknown
    }

export class ModelRequestRetryExhaustedError extends Error {
  readonly retryable: boolean

  constructor(message: string, options?: { retryable?: boolean }) {
    super(message)
    this.name = "ModelRequestRetryExhaustedError"
    this.retryable = options?.retryable === true
  }
}

export class ModelResponseValidationError extends Error {
  readonly retryable: boolean
  // The round was cut off at the output-token cap. Not retried here at the same
  // cap; the agent loop re-issues the round with a higher one.
  readonly outputLimit: boolean
  diagnostics?: ModelResponseAttemptDiagnostics

  constructor(
    message: string,
    options?: {
      retryable?: boolean
      outputLimit?: boolean
      diagnostics?: ModelResponseAttemptDiagnostics
    }
  ) {
    super(message)
    this.name = "ModelResponseValidationError"
    this.retryable = options?.retryable === true
    this.outputLimit = options?.outputLimit === true
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
        typeof part === "string"
          ? part
          : [
                "reasoning",
                "thinking",
                "reasoning_content",
                "redacted_thinking",
              ].includes(part?.type)
            ? ""
            : (part?.text ?? "")
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
  // Chat Completions spells it prompt/completion; the Responses API (the
  // Codex subscription bridge passes its usage through) spells it input/output.
  const promptTokens =
    finiteNumber(usage.prompt_tokens) ?? finiteNumber(usage.input_tokens)
  const completionTokens =
    finiteNumber(usage.completion_tokens) ?? finiteNumber(usage.output_tokens)
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
    attemptId: string
    onAttemptEvent?: (event: CompletionAttemptEvent) => void
  }
): Promise<CompletionRound> {
  let text = ""
  let nativeMetadata: CompletionRound["nativeAssistant"]
  let refusal = ""
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
    if (delta[nativeAssistant])
      nativeMetadata = validateCarrier(delta[nativeAssistant])
    if (Object.prototype.hasOwnProperty.call(delta, "refusal")) {
      refusalFieldRecognized = true
      refusal += contentToText(delta.refusal)
    }
    if (
      Object.prototype.hasOwnProperty.call(delta, "reasoning") ||
      Object.prototype.hasOwnProperty.call(delta, "reasoning_content")
    ) {
      reasoningFieldRecognized = true
    }

    const piece = contentToText(delta.content)
    if (piece) {
      text += piece
      input.onAttemptEvent?.({
        type: "text",
        attemptId: input.attemptId,
        delta: piece,
      })
    }

    for (const tc of (delta.tool_calls ?? []) as ToolCallDelta[]) {
      toolFragments.push(tc)
      if (typeof tc.index === "number") terminalToolCallIndexes.add(tc.index)
    }
  }

  const refused =
    refusal.trim().length > 0 ||
    finishReason === "content_filter" ||
    finishReason === "refusal"
  if (refused) {
    const explanation =
      refusal.trim() || text.trim() || "The model declined this request."
    if (!text.trim() || (refusal.trim() && !text.includes(refusal.trim()))) {
      const piece = text.trim() ? `\n\n${explanation}` : explanation
      text += piece
      input.onAttemptEvent?.({
        type: "text",
        attemptId: input.attemptId,
        delta: piece,
      })
    }
    refusal = explanation
  }
  const recoveredText = refused
    ? text
    : (input.recoverVisibleText?.(text) ?? text)
  return {
    ...(refused ? { refusal } : {}),
    nativeAssistant: nativeMetadata,
    text,
    toolFragments: refused ? [] : toolFragments,
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
  onAttemptEvent?: (event: CompletionAttemptEvent) => void
  signal: AbortSignal
  clock?: RetryClock
  random?: () => number
  repository?: RetryRepository
  config?: typeof MODEL_REQUEST_RETRY
  idle?: typeof MODEL_STREAM_IDLE
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

    const attemptId = `${logicalRoundId}:attempt:${attemptsUsed}`
    input.onAttemptEvent?.({ type: "start", attemptId, attempt: attemptsUsed })
    let releasePermit: (() => void) | undefined
    try {
      // One permit covers one request/stream only. Release it before the agent
      // loop can execute tools, so a parent blocked in spawn_subagents holds none.
      releasePermit = await modelRequestPermits.acquire(signal)
      const startedAt = clock.now()
      const idle = input.idle ?? MODEL_STREAM_IDLE
      const stream = await withinTime(
        request(),
        idle.firstChunkMs,
        () => new StreamStalledError(idle.firstChunkMs, true)
      )
      const round = await consumeCompletionStream(
        idleGuarded(stream, idle),
        signal,
        {
          startedAt,
          now: clock.now,
          requestIdentity: input.requestIdentity,
          recoverVisibleText: input.recoverVisibleText,
          attemptId,
          onAttemptEvent: input.onAttemptEvent,
        }
      )
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
      input.onAttemptEvent?.({ type: "commit", attemptId })
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
          : error instanceof StreamStalledError
            ? false
            : isTransientError(error)
      if (!retryable) {
        input.onAttemptEvent?.({
          type: "rollback",
          attemptId,
          retrying: false,
          error,
        })
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
        input.onAttemptEvent?.({
          type: "rollback",
          attemptId,
          retrying: false,
          error,
        })
        repository.exhaustBudget({
          conversationId,
          logicalRoundId,
          error: persistedError,
          now: clock.now(),
        })
        break
      }

      input.onAttemptEvent?.({
        type: "rollback",
        attemptId,
        retrying: true,
        error,
      })
      await clock.sleep(delay, signal)
      if (signal.aborted) throw error
    } finally {
      releasePermit?.()
    }
  }

  const message =
    lastError instanceof Error ? lastError.message : String(lastError)
  throw new ModelRequestRetryExhaustedError(
    `Model request failed after ${attemptsUsed} attempts: ${message}`,
    {
      retryable:
        !(lastError instanceof ModelResponseValidationError) &&
        isTransientError(lastError),
    }
  )
}

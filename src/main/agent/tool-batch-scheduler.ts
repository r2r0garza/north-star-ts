import type { ToolEffects, ToolImage, ToolExecutionPolicy } from "./tools/types"

export interface ScheduledToolCall {
  id: string
  name: string
  arguments: string
}

export interface ScheduledToolResult {
  call: ScheduledToolCall
  result: string
  images: ToolImage[]
  error: boolean
  outcome: "success" | "error" | "unknown" | "not_started"
}

export interface ToolBatchSchedulerOptions {
  effectsFor: (name: string) => ToolEffects | undefined
  execute: (
    call: ScheduledToolCall,
    index: number,
    signal: AbortSignal
  ) => Promise<{ result: string; images?: ToolImage[] }>
  onStart?: (call: ScheduledToolCall) => void
  onDone?: (call: ScheduledToolCall, result: string) => void
  policyFor?: (call: ScheduledToolCall) => ToolExecutionPolicy | undefined
  onSettled?: (result: ScheduledToolResult) => void | Promise<void>
  onBatchSettled?: (results: ScheduledToolResult[]) => void | Promise<void>
  concurrency?: number
  signal?: AbortSignal
}

const DEFAULT_CONCURRENCY = 4

function canRunInReadBatch(effects: ToolEffects | undefined): boolean {
  return !!(
    effects?.readOnly &&
    effects.parallelSafe &&
    effects.idempotent &&
    !effects.destructive &&
    !effects.openWorld
  )
}

function errorResult(name: string, err: unknown): string {
  return `Error running ${name}: ${err instanceof Error ? err.message : String(err)}`
}

function unknownResult(name: string): string {
  return `Interrupted while ${name} was running; result unknown.`
}

function notStartedResult(name: string): string {
  return `Interrupted before ${name} started.`
}

function partitionToolCalls(
  calls: ScheduledToolCall[],
  effectsFor: (name: string) => ToolEffects | undefined
): ScheduledToolCall[][] {
  const batches: ScheduledToolCall[][] = []
  let readBatch: ScheduledToolCall[] = []
  const flushReads = () => {
    if (readBatch.length > 0) {
      batches.push(readBatch)
      readBatch = []
    }
  }

  for (const call of calls) {
    if (canRunInReadBatch(effectsFor(call.name))) {
      readBatch.push(call)
    } else {
      flushReads()
      batches.push([call])
    }
  }
  flushReads()
  return batches
}

// Lifecycle failures are infrastructure failures, never model-facing tool output.
export class ToolLifecycleError extends Error {
  constructor(
    readonly stage: "tool_dispatch" | "tool_execution" | "result_persistence",
    readonly toolCallId: string,
    cause: unknown
  ) {
    super(`Tool ${stage} failed`, { cause })
    this.name = "ToolLifecycleError"
  }
}

async function lifecycle(
  stage: ToolLifecycleError["stage"],
  call: ScheduledToolCall,
  action: () => void | Promise<void>
): Promise<void> {
  try {
    await action()
  } catch (error) {
    throw error instanceof ToolLifecycleError
      ? error
      : new ToolLifecycleError(stage, call.id, error)
  }
}

function skipped(call: ScheduledToolCall): ScheduledToolResult {
  return {
    call,
    result: notStartedResult(call.name),
    images: [],
    error: false,
    outcome: "not_started",
  }
}

async function executeCall(
  call: ScheduledToolCall,
  index: number,
  opts: ToolBatchSchedulerOptions,
  stop: AbortSignal
): Promise<ScheduledToolResult> {
  const deadline = new AbortController()
  const signal = AbortSignal.any([stop, deadline.signal])
  const timeoutMs = opts.policyFor?.(call)?.timeoutMs
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: () => void = () => {}
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  if (timeoutMs !== undefined) {
    timer = setTimeout(
      () => deadline.abort(new Error(`Deadline exceeded after ${timeoutMs}ms`)),
      timeoutMs
    )
  }
  try {
    // Attaching both handlers quarantines late success AND late rejection. Only
    // this scope can publish terminal results; backend cancellation is cooperative.
    const output = await Promise.race([
      interrupted,
      Promise.resolve().then(() => {
        signal.throwIfAborted()
        return opts.execute(call, index, signal)
      }),
    ])
    if (signal.aborted) throw signal.reason
    return {
      call,
      result: output.result,
      images: output.images ?? [],
      error: false,
      outcome: "success",
    }
  } catch (error) {
    if (error instanceof ToolLifecycleError) throw error
    const unknown = signal.aborted && !opts.effectsFor(call.name)?.readOnly
    return {
      call,
      result: unknown
        ? `${unknownResult(call.name)} Reconcile before retrying; cancellation does not undo effects.`
        : signal.aborted
          ? `ERROR[${deadline.signal.aborted ? "tool_timeout" : "tool_cancelled"}]: ${call.name} ${deadline.signal.aborted ? "exceeded its execution deadline" : "was cancelled"}.`
          : errorResult(call.name, error),
      images: [],
      error: true,
      outcome: unknown ? "unknown" : "error",
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
  }
}

export async function runToolCallBatches(
  calls: ScheduledToolCall[],
  opts: ToolBatchSchedulerOptions
): Promise<ScheduledToolResult[]> {
  const fault = new AbortController()
  const stop = AbortSignal.any([
    fault.signal,
    ...(opts.signal ? [opts.signal] : []),
  ])
  const results: ScheduledToolResult[] = []
  let blocked = false
  let baseIndex = 0
  for (const batch of partitionToolCalls(calls, opts.effectsFor)) {
    const batchResults: ScheduledToolResult[] = new Array(batch.length)
    let next = 0
    let failure: unknown
    async function worker(): Promise<void> {
      try {
        while (next < batch.length && !fault.signal.aborted) {
          const index = next++
          const call = batch[index]
          let result = skipped(call)
          let announced = false
          if (!stop.aborted && !blocked) {
            announced = true
            await lifecycle("tool_dispatch", call, () => opts.onStart?.(call))
            if (!stop.aborted)
              result = await executeCall(call, baseIndex + index, opts, stop)
          }
          if (result.outcome === "unknown") blocked = true
          batchResults[index] = result
          await lifecycle("result_persistence", call, () =>
            opts.onSettled?.(result)
          )
          if (announced) {
            await lifecycle("tool_execution", call, () =>
              opts.onDone?.(call, result.result)
            )
          }
        }
      } catch (error) {
        failure ??= error
        fault.abort(error)
      }
    }
    await Promise.all(
      Array.from(
        {
          length: Math.min(
            Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY),
            batch.length
          ),
        },
        () => worker()
      )
    )
    if (failure) throw failure
    await lifecycle("result_persistence", batch[0], () =>
      opts.onBatchSettled?.(batchResults)
    )
    results.push(...batchResults)
    baseIndex += batch.length
  }
  return results
}

export const testExports = { canRunInReadBatch, partitionToolCalls }

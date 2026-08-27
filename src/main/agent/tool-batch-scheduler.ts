import type { ToolEffects, ToolImage } from "./tools/types"

export interface ScheduledToolCall {
  id: string
  name: string
  arguments: string
}

export interface ScheduledToolResult {
  call: ScheduledToolCall
  result: string
  images: ToolImage[]
}

export interface ToolBatchSchedulerOptions {
  effectsFor: (name: string) => ToolEffects | undefined
  execute: (
    call: ScheduledToolCall,
    index: number
  ) => Promise<{ result: string; images?: ToolImage[] }>
  onStart?: (call: ScheduledToolCall) => void
  onDone?: (call: ScheduledToolCall, result: string) => void
  onBatchSettled?: (results: ScheduledToolResult[]) => void | Promise<void>
  concurrency?: number
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

async function runBatch(
  batch: ScheduledToolCall[],
  baseIndex: number,
  opts: ToolBatchSchedulerOptions
): Promise<ScheduledToolResult[]> {
  const results: ScheduledToolResult[] = new Array(batch.length)
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)
  let next = 0

  async function worker(): Promise<void> {
    while (next < batch.length) {
      const index = next++
      const call = batch[index]
      opts.onStart?.(call)
      try {
        const output = await opts.execute(call, baseIndex + index)
        results[index] = {
          call,
          result: output.result,
          images: output.images ?? [],
        }
      } catch (err) {
        results[index] = {
          call,
          result: errorResult(call.name, err),
          images: [],
        }
      }
      opts.onDone?.(call, results[index].result)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, batch.length) }, () => worker())
  )
  return results
}

export async function runToolCallBatches(
  calls: ScheduledToolCall[],
  opts: ToolBatchSchedulerOptions
): Promise<ScheduledToolResult[]> {
  const batches = partitionToolCalls(calls, opts.effectsFor)
  const results: ScheduledToolResult[] = []
  let baseIndex = 0
  for (const batch of batches) {
    const batchResults = await runBatch(batch, baseIndex, opts)
    await opts.onBatchSettled?.(batchResults)
    results.push(...batchResults)
    baseIndex += batch.length
  }
  return results
}

export const testExports = {
  canRunInReadBatch,
  partitionToolCalls,
}

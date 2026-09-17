export const DEFAULT_MODEL_REQUEST_CONCURRENCY = 6
export const DEFAULT_MODEL_PERMIT_WAIT_MS = 10 * 60_000

interface Waiter {
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  timer: ReturnType<typeof setTimeout>
  onAbort: () => void
}

export class ModelRequestPermitPool {
  private active = 0
  private readonly queue: Waiter[] = []

  constructor(
    private readonly concurrency = DEFAULT_MODEL_REQUEST_CONCURRENCY,
    private readonly waitMs = DEFAULT_MODEL_PERMIT_WAIT_MS
  ) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.active < this.concurrency) {
      this.active += 1
      return Promise.resolve(this.releaseFn())
    }
    return new Promise((resolve, reject) => {
      const waiter = {} as Waiter
      waiter.resolve = resolve
      waiter.reject = reject
      waiter.signal = signal
      waiter.onAbort = () => this.remove(waiter, signal?.reason ?? new Error("cancelled"))
      waiter.timer = setTimeout(
        () => this.remove(waiter, new Error("model_slot_timeout")),
        this.waitMs
      )
      signal?.addEventListener("abort", waiter.onAbort, { once: true })
      this.queue.push(waiter)
    })
  }

  private remove(waiter: Waiter, error: unknown): void {
    const index = this.queue.indexOf(waiter)
    if (index < 0) return
    this.queue.splice(index, 1)
    clearTimeout(waiter.timer)
    waiter.signal?.removeEventListener("abort", waiter.onAbort)
    waiter.reject(error instanceof Error ? error : new Error(String(error)))
  }

  private releaseFn(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
      this.drain()
    }
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const waiter = this.queue.shift()!
      clearTimeout(waiter.timer)
      waiter.signal?.removeEventListener("abort", waiter.onAbort)
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason)
        continue
      }
      this.active += 1
      waiter.resolve(this.releaseFn())
    }
  }
}

export const modelRequestPermits = new ModelRequestPermitPool()

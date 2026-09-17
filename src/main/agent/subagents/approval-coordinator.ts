export class SubagentApprovalCoordinator {
  private active = false
  private readonly queue: Array<{
    resolve: (release: () => void) => void
    reject: (error: unknown) => void
    signal?: AbortSignal
    onAbort?: () => void
  }> = []

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal } as (typeof this.queue)[number]
      waiter.onAbort = () => {
        const index = this.queue.indexOf(waiter)
        if (index >= 0) this.queue.splice(index, 1)
        reject(signal?.reason)
      }
      signal?.addEventListener("abort", waiter.onAbort, { once: true })
      this.queue.push(waiter)
      this.advance()
    })
  }

  private advance(): void {
    if (this.active) return
    const waiter = this.queue.shift()
    if (!waiter) return
    waiter.signal?.removeEventListener("abort", waiter.onAbort!)
    if (waiter.signal?.aborted) {
      waiter.reject(waiter.signal.reason)
      this.advance()
      return
    }
    this.active = true
    let released = false
    waiter.resolve(() => {
      if (released) return
      released = true
      this.active = false
      this.advance()
    })
  }
}

import type { Readable, Writable } from "stream"

// Chrome DevTools Protocol over Electron's --remote-debugging-pipe (plan 119
// Phase A): NUL-delimited JSON on fd 3 (host → target) and fd 4 (target →
// host). The pipe exists only between this host and the process it spawned, so
// there is no listener to discover and no endpoint the model can name.
export type CdpEvent = { method: string; params: unknown; sessionId?: string }

// shortcut: one buffered message is capped at 32 MiB (screenshots fit); a
// target sending more is treated as a protocol failure.
const MAX_MESSAGE_CHARS = 32 * 1024 * 1024

export class CdpPipe {
  private nextId = 0
  private buffer = ""
  private closedError: Error | null = null
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private readonly listeners = new Set<(event: CdpEvent) => void>()

  constructor(
    private readonly toTarget: Writable,
    fromTarget: Readable
  ) {
    fromTarget.setEncoding("utf8")
    fromTarget.on("data", (chunk: string) => this.receive(chunk))
    fromTarget.on("close", () => this.close(new Error("CDP pipe closed")))
    fromTarget.on("error", (error) => this.close(error))
    toTarget.on("error", (error) => this.close(error))
  }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: { sessionId?: string; timeoutMs?: number } = {}
  ): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError)
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, options.timeoutMs ?? 10_000)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      const message: Record<string, unknown> = { id, method, params }
      if (options.sessionId) message.sessionId = options.sessionId
      this.toTarget.write(JSON.stringify(message) + "\0")
    })
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get closed(): boolean {
    return this.closedError !== null
  }

  close(reason = new Error("CDP pipe closed")): void {
    if (this.closedError) return
    this.closedError = reason
    for (const { reject } of this.pending.values()) reject(reason)
    this.pending.clear()
    this.listeners.clear()
    this.toTarget.destroy()
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MAX_MESSAGE_CHARS) {
      this.close(new Error("CDP message exceeded the size limit"))
      return
    }
    for (let end; (end = this.buffer.indexOf("\0")) >= 0; ) {
      const raw = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      let message: {
        id?: number
        method?: string
        params?: unknown
        sessionId?: string
        result?: unknown
        error?: { message?: string }
      }
      try {
        message = JSON.parse(raw)
      } catch {
        this.close(new Error("Malformed CDP message"))
        return
      }
      if (typeof message.id === "number") {
        const waiter = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (!waiter) continue
        if (message.error)
          waiter.reject(new Error(message.error.message ?? "CDP error"))
        else waiter.resolve(message.result)
      } else if (typeof message.method === "string") {
        const event = {
          method: message.method,
          params: message.params,
          sessionId: message.sessionId,
        }
        for (const listener of this.listeners) listener(event)
      }
    }
  }
}

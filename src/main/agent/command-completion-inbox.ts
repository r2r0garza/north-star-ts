import { randomUUID } from "crypto"

export interface CommandCompletionOwner {
  conversationId: string
  workspace: string
  runId: string
}

export interface CommandCompletionEvent {
  id: string
  sessionId: string
  conversationId: string
  workspace: string
  runId: string
  command: string
  cwd: string
  status: string
  exitCode: number | null
  signal: string | null
  durationMs: number
  cursor: number
  nextCursor: number
  totalBytes: number
  droppedBytes: number
  omittedBytes: number
  modelTruncated: boolean
  truncated: boolean
  cleanupError: unknown
  output: string
  createdAt: number
}

interface RegisteredCommand {
  sessionId: string
  owner: CommandCompletionOwner
  initialResultPersisted: boolean
  releaseRetainedOutput?: () => void
}

interface Waiter {
  owner: CommandCompletionOwner
  sessionIds?: Set<string>
  resolve: () => void
}

const MAX_DRAIN_BYTES = 192 * 1024

function sameOwner(
  a: CommandCompletionOwner,
  b: CommandCompletionOwner
): boolean {
  return (
    a.conversationId === b.conversationId &&
    a.workspace === b.workspace &&
    a.runId === b.runId
  )
}

export class CommandCompletionInbox {
  private registered = new Map<string, RegisteredCommand>()
  private retainedOutput = new Map<string, () => void>()
  private queued: CommandCompletionEvent[] = []
  private delivered = new Map<string, CommandCompletionEvent>()
  private consumed = new Set<string>()
  private cancelledRuns = new Set<string>()
  private waiters = new Map<string, Waiter>()

  enqueue(input: {
    sessionId: string
    owner: CommandCompletionOwner
    event: Omit<
      CommandCompletionEvent,
      "id" | "conversationId" | "workspace" | "runId" | "createdAt"
    >
  }): void {
    const registered = this.registered.get(input.sessionId)
    if (!registered || !sameOwner(registered.owner, input.owner)) return
    if (this.cancelledRuns.has(input.owner.runId)) return
    if (
      this.queued.some((event) => event.sessionId === input.sessionId) ||
      [...this.delivered.values()].some(
        (event) => event.sessionId === input.sessionId
      )
    ) {
      return
    }
    const event: CommandCompletionEvent = {
      id: randomUUID(),
      conversationId: input.owner.conversationId,
      workspace: input.owner.workspace,
      runId: input.owner.runId,
      ...input.event,
      createdAt: Date.now(),
    }
    this.queued.push(event)
    if (registered.initialResultPersisted) {
      this.registered.delete(input.sessionId)
      this.wakeMatching(input.owner, input.sessionId)
    }
  }

  register(
    sessionId: string,
    owner: CommandCompletionOwner,
    opts: { releaseRetainedOutput?: () => void } = {}
  ): void {
    if (this.cancelledRuns.has(owner.runId)) return
    if (opts.releaseRetainedOutput) {
      this.retainedOutput.set(sessionId, opts.releaseRetainedOutput)
    }
    this.registered.set(sessionId, {
      sessionId,
      owner,
      initialResultPersisted: false,
      releaseRetainedOutput: opts.releaseRetainedOutput,
    })
  }

  markInitialResultPersisted(
    owner: CommandCompletionOwner,
    sessionId: string
  ): void {
    const registered = this.registered.get(sessionId)
    if (!registered || !sameOwner(registered.owner, owner)) return
    registered.initialResultPersisted = true
    if (this.queued.some((event) => event.sessionId === sessionId)) {
      this.registered.delete(sessionId)
      this.wakeMatching(owner, sessionId)
    }
  }

  drain(
    owner: CommandCompletionOwner,
    opts: { sessionIds?: string[]; maxBytes?: number } = {}
  ): CommandCompletionEvent[] {
    const sessionIds = opts.sessionIds ? new Set(opts.sessionIds) : undefined
    const maxBytes = opts.maxBytes ?? MAX_DRAIN_BYTES
    const drained: CommandCompletionEvent[] = []
    let bytes = 0
    const remaining: CommandCompletionEvent[] = []
    const readySessionIds = new Set(
      [...this.registered.values()]
        .filter((command) => command.initialResultPersisted)
        .map((command) => command.sessionId)
    )
    for (const event of this.queued) {
      if (
        !sameOwner(event, owner) ||
        (sessionIds && !sessionIds.has(event.sessionId)) ||
        (this.registered.has(event.sessionId) &&
          !readySessionIds.has(event.sessionId))
      ) {
        remaining.push(event)
        continue
      }
      const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8")
      if (drained.length > 0 && bytes + eventBytes > maxBytes) {
        remaining.push(event)
        continue
      }
      bytes += eventBytes
      drained.push(event)
      this.delivered.set(event.id, event)
    }
    this.queued = remaining
    return drained
  }

  markConsumed(eventIds: string[]): void {
    for (const id of eventIds) {
      this.consumed.add(id)
      const event = this.delivered.get(id)
      this.delivered.delete(id)
      if (event) this.releaseSession(event.sessionId)
    }
  }

  hasPending(owner: CommandCompletionOwner, sessionIds?: string[]): boolean {
    const ids = sessionIds ? new Set(sessionIds) : undefined
    if (
      this.queued.some((event) => {
        if (!sameOwner(event, owner) || (ids && !ids.has(event.sessionId))) {
          return false
        }
        const registered = this.registered.get(event.sessionId)
        return !registered || registered.initialResultPersisted
      })
    ) {
      return true
    }
    for (const command of this.registered.values()) {
      if (
        sameOwner(command.owner, owner) &&
        (!ids || ids.has(command.sessionId))
      ) {
        return true
      }
    }
    return false
  }

  waitForEvent(
    owner: CommandCompletionOwner,
    opts: { sessionIds?: string[]; signal?: AbortSignal } = {}
  ): Promise<void> {
    if (!this.hasPending(owner, opts.sessionIds)) return Promise.resolve()
    const sessionIds = opts.sessionIds ? new Set(opts.sessionIds) : undefined
    if (
      this.queued.some(
        (event) =>
          sameOwner(event, owner) &&
          (!sessionIds || sessionIds.has(event.sessionId)) &&
          (this.registered.get(event.sessionId)?.initialResultPersisted ?? true)
      )
    ) {
      return Promise.resolve()
    }
    if (opts.signal?.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const id = randomUUID()
      const done = () => {
        this.waiters.delete(id)
        opts.signal?.removeEventListener("abort", done)
        resolve()
      }
      this.waiters.set(id, { owner, sessionIds, resolve: done })
      opts.signal?.addEventListener("abort", done, { once: true })
    })
  }

  cancelRun(owner: CommandCompletionOwner): void {
    this.cancelledRuns.add(owner.runId)
    for (const [sessionId, command] of this.registered) {
      if (sameOwner(command.owner, owner)) {
        this.registered.delete(sessionId)
        this.releaseSession(sessionId)
      }
    }
    const retainedQueued: CommandCompletionEvent[] = []
    for (const event of this.queued) {
      if (sameOwner(event, owner)) this.releaseSession(event.sessionId)
      else retainedQueued.push(event)
    }
    this.queued = retainedQueued
    for (const [id, event] of this.delivered) {
      if (sameOwner(event, owner)) {
        this.delivered.delete(id)
        this.releaseSession(event.sessionId)
      }
    }
    for (const [id, waiter] of this.waiters) {
      if (sameOwner(waiter.owner, owner)) {
        this.waiters.delete(id)
        waiter.resolve()
      }
    }
  }

  cleanupRun(owner: CommandCompletionOwner): void {
    if (this.hasPending(owner)) return
    this.cancelledRuns.delete(owner.runId)
    for (const [id, event] of this.delivered) {
      if (sameOwner(event, owner)) this.delivered.delete(id)
    }
    for (const eventId of [...this.consumed]) {
      if (!this.delivered.has(eventId)) this.consumed.delete(eventId)
    }
  }

  canReleaseSession(owner: CommandCompletionOwner, sessionId: string): boolean {
    const registered = this.registered.get(sessionId)
    if (registered && sameOwner(registered.owner, owner)) return false
    if (
      this.queued.some(
        (event) => sameOwner(event, owner) && event.sessionId === sessionId
      )
    ) {
      return false
    }
    for (const event of this.delivered.values()) {
      if (sameOwner(event, owner) && event.sessionId === sessionId) return false
    }
    return true
  }

  private releaseSession(sessionId: string): void {
    const release = this.retainedOutput.get(sessionId)
    this.retainedOutput.delete(sessionId)
    release?.()
  }

  private wakeMatching(owner: CommandCompletionOwner, sessionId: string): void {
    for (const [id, waiter] of this.waiters) {
      if (
        sameOwner(waiter.owner, owner) &&
        (!waiter.sessionIds || waiter.sessionIds.has(sessionId))
      ) {
        this.waiters.delete(id)
        waiter.resolve()
      }
    }
  }
}

export const commandCompletionInbox = new CommandCompletionInbox()

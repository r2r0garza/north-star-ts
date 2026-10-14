// Coalesces streamed text deltas per key (a conversation id) and hands them
// over at most once per interval. A model can stream 100+ tokens a second;
// applying each one as its own React update re-renders the transcript every
// time, which pins the renderer for the length of a long reply.
//
// Callers that apply any other update to the same state must flush() first so
// buffered text lands before it (tool rows, stream checkpoints, resets).
export interface TokenBatcher {
  push(key: string, delta: string): void
  flush(): void
  dispose(): void
}

export const TOKEN_BATCH_INTERVAL_MS = 50

export function createTokenBatcher(
  onFlush: (batch: Map<string, string>) => void,
  intervalMs = TOKEN_BATCH_INTERVAL_MS
): TokenBatcher {
  let pending = new Map<string, string>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (pending.size === 0) return
    const batch = pending
    pending = new Map()
    onFlush(batch)
  }

  return {
    push(key, delta) {
      if (!delta) return
      pending.set(key, (pending.get(key) ?? "") + delta)
      timer ??= setTimeout(flush, intervalMs)
    },
    flush,
    dispose() {
      if (timer) clearTimeout(timer)
      timer = null
      pending = new Map()
    },
  }
}

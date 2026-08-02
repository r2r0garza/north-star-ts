import type { Debugger } from "electron"

// Thin async helpers over Electron's `webContents.debugger` (Chrome DevTools
// Protocol). The whole surface is Promise-based, so a CDP round-trip never
// blocks the main-process event loop — other conversations keep progressing
// while a browser tool awaits here.
//
// Every command is raced against a deadline AND the turn's AbortSignal (see
// `withDeadline`), so a page that never finishes loading, or a Stop pressed
// mid-navigation, unwinds the turn promptly instead of hanging it.

// Raised when a CDP call is cancelled by the turn's AbortSignal (user Stop /
// shutdown). Distinct from a timeout so callers can report the right reason.
export class BrowserAbortError extends Error {
  constructor() {
    super("Browser operation aborted")
    this.name = "BrowserAbortError"
  }
}

// Raised when a CDP call exceeds its deadline.
export class BrowserTimeoutError extends Error {
  constructor(ms: number) {
    super(`Browser operation timed out after ${ms}ms`)
    this.name = "BrowserTimeoutError"
  }
}

// Race a promise against a timeout and an AbortSignal. The underlying CDP call
// keeps running if it loses the race, but the caller stops waiting — acceptable
// because the page/debugger is torn down on dispose and a stale result is
// simply ignored. Rejects with BrowserAbortError / BrowserTimeoutError so the
// tool can surface a clean, actionable message to the model.
export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  signal?: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BrowserAbortError())
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new BrowserTimeoutError(ms))
    }, ms)
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new BrowserAbortError())
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (v) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(v)
      },
      (e) => {
        if (settled) return
        settled = true
        cleanup()
        reject(e)
      }
    )
  })
}

// Send one CDP command, bounded by a deadline + abort signal. `dbg` must already
// be attached (BrowserSession owns attach/detach). Generic over the CDP result
// shape; callers pass the domain method (e.g. "Page.navigate") and params.
export function sendCommand<T = unknown>(
  dbg: Debugger,
  method: string,
  params: Record<string, unknown> | undefined,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  return withDeadline(
    dbg.sendCommand(method, params) as Promise<T>,
    timeoutMs,
    signal
  )
}

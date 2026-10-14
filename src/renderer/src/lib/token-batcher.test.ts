import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTokenBatcher } from "./token-batcher"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("createTokenBatcher", () => {
  it("coalesces deltas per key into one flush per interval", () => {
    const flushes: Array<Record<string, string>> = []
    const batcher = createTokenBatcher(
      (batch) => flushes.push(Object.fromEntries(batch)),
      50
    )

    batcher.push("a", "Hel")
    batcher.push("a", "lo")
    batcher.push("b", "Hi")
    expect(flushes).toEqual([])

    vi.advanceTimersByTime(50)
    expect(flushes).toEqual([{ a: "Hello", b: "Hi" }])

    batcher.push("a", " world")
    vi.advanceTimersByTime(50)
    expect(flushes).toEqual([{ a: "Hello", b: "Hi" }, { a: " world" }])
  })

  it("flushes pending text immediately and cancels the timer", () => {
    const onFlush = vi.fn()
    const batcher = createTokenBatcher(onFlush, 50)

    batcher.push("a", "x")
    batcher.flush()
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush.mock.calls[0][0]).toEqual(new Map([["a", "x"]]))

    vi.advanceTimersByTime(100)
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it("ignores empty deltas and empty flushes", () => {
    const onFlush = vi.fn()
    const batcher = createTokenBatcher(onFlush, 50)

    batcher.push("a", "")
    batcher.flush()
    vi.advanceTimersByTime(100)
    expect(onFlush).not.toHaveBeenCalled()
  })

  it("drops pending text on dispose", () => {
    const onFlush = vi.fn()
    const batcher = createTokenBatcher(onFlush, 50)

    batcher.push("a", "x")
    batcher.dispose()
    vi.advanceTimersByTime(100)
    batcher.flush()
    expect(onFlush).not.toHaveBeenCalled()
  })
})

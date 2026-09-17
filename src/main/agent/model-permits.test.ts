import { describe, expect, it, vi } from "vitest"
import { ModelRequestPermitPool } from "./model-permits"

describe("ModelRequestPermitPool", () => {
  it("releases a request permit so queued child requests make progress", async () => {
    const pool = new ModelRequestPermitPool(1, 1000)
    const releaseParent = await pool.acquire()
    let acquired = false
    const child = pool.acquire().then((release) => {
      acquired = true
      release()
    })
    await Promise.resolve()
    expect(acquired).toBe(false)
    releaseParent()
    await child
    expect(acquired).toBe(true)
  })

  it("times out a queued waiter", async () => {
    vi.useFakeTimers()
    const pool = new ModelRequestPermitPool(1, 10)
    const release = await pool.acquire()
    const queued = pool.acquire()
    const assertion = expect(queued).rejects.toThrow("model_slot_timeout")
    await vi.advanceTimersByTimeAsync(10)
    await assertion
    release()
    vi.useRealTimers()
  })
})

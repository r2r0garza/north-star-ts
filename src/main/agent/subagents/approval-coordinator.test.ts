import { describe, expect, it } from "vitest"
import { SubagentApprovalCoordinator } from "./approval-coordinator"

describe("SubagentApprovalCoordinator", () => {
  it("admits child approvals in FIFO order", async () => {
    const coordinator = new SubagentApprovalCoordinator()
    const order: string[] = []
    const releaseFirst = await coordinator.acquire()
    const second = coordinator.acquire().then((release) => {
      order.push("second")
      release()
    })
    const third = coordinator.acquire().then((release) => {
      order.push("third")
      release()
    })

    await Promise.resolve()
    expect(order).toEqual([])
    releaseFirst()
    await Promise.all([second, third])
    expect(order).toEqual(["second", "third"])
  })

  it("removes an aborted waiter without blocking the queue", async () => {
    const coordinator = new SubagentApprovalCoordinator()
    const releaseFirst = await coordinator.acquire()
    const abort = new AbortController()
    const cancelled = coordinator.acquire(abort.signal)
    const next = coordinator.acquire()
    abort.abort(new Error("stopped"))
    releaseFirst()

    await expect(cancelled).rejects.toThrow("stopped")
    const releaseNext = await next
    releaseNext()
  })
})

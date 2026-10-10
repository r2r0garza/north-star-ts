import { describe, expect, it } from "vitest"
import { serializeConversationTurn } from "./conversation-turns"

describe("conversation turn serialization", () => {
  it("waits for the active turn before reporting while other conversations remain independent", async () => {
    let release!: () => void
    const order: string[] = []
    const active = serializeConversationTurn("a", async () => {
      order.push("active")
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    const report = serializeConversationTurn("a", async () => {
      order.push("report")
    })
    await serializeConversationTurn("b", async () => {
      order.push("other")
    })
    expect(order).toEqual(["active", "other"])
    release()
    await Promise.all([active, report])
    expect(order).toEqual(["active", "other", "report"])
  })
  it("does not strand a queued report after a failed foreground turn", async () => {
    const failed = serializeConversationTurn("failed", async () => {
      throw new Error("failure")
    })
    const report = serializeConversationTurn("failed", async () => "reported")
    await expect(failed).rejects.toThrow("failure")
    await expect(report).resolves.toBe("reported")
  })
})

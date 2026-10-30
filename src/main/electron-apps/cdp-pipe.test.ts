import { PassThrough } from "stream"
import { describe, expect, it } from "vitest"
import { CdpPipe } from "./cdp-pipe"

function pair() {
  const toTarget = new PassThrough()
  const fromTarget = new PassThrough()
  const sent: Record<string, unknown>[] = []
  toTarget.setEncoding("utf8")
  toTarget.on("data", (chunk: string) => {
    for (const raw of chunk.split("\0").filter(Boolean)) sent.push(JSON.parse(raw))
  })
  return { pipe: new CdpPipe(toTarget, fromTarget), fromTarget, sent }
}

describe("CdpPipe", () => {
  it("correlates split responses and dispatches events", async () => {
    const { pipe, fromTarget, sent } = pair()
    const events: string[] = []
    pipe.onEvent((e) => events.push(e.method))
    const result = pipe.send("Target.getTargets", {}, { sessionId: "s1" })
    await new Promise((r) => setImmediate(r))
    expect(sent[0]).toEqual({ id: 1, method: "Target.getTargets", params: {}, sessionId: "s1" })
    const reply = JSON.stringify({ id: 1, result: { ok: true } })
    fromTarget.write(reply.slice(0, 5))
    fromTarget.write(reply.slice(5) + "\0" + JSON.stringify({ method: "Target.targetCreated" }) + "\0")
    await expect(result).resolves.toEqual({ ok: true })
    expect(events).toEqual(["Target.targetCreated"])
  })

  it("rejects on protocol errors, timeouts and close", async () => {
    const { pipe, fromTarget } = pair()
    const failed = pipe.send("X.y")
    fromTarget.write(JSON.stringify({ id: 1, error: { message: "nope" } }) + "\0")
    await expect(failed).rejects.toThrow("nope")
    await expect(pipe.send("Slow.call", {}, { timeoutMs: 5 })).rejects.toThrow(/timed out/)
    const pending = pipe.send("Never.answers")
    fromTarget.end()
    await expect(pending).rejects.toThrow(/closed/)
    expect(pipe.closed).toBe(true)
    await expect(pipe.send("After.close")).rejects.toThrow(/closed/)
  })

  it("closes on malformed messages", async () => {
    const { pipe, fromTarget } = pair()
    const pending = pipe.send("A.b")
    fromTarget.write("{not json\0")
    await expect(pending).rejects.toThrow(/Malformed/)
  })
})

import { describe, expect, it } from "vitest"
import { createServer, request, type IncomingMessage } from "http"
import type { AddressInfo } from "net"
import { once } from "events"
import { startTestAdmission } from "./admission"

const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`
const start =
  frame({
    type: "message_start",
    message: {
      id: "msg_pressure",
      role: "assistant",
      content: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }) +
  frame({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  })
const text = "é".repeat(16 * 1024)
const delta = frame({
  type: "content_block_delta",
  index: 0,
  delta: { type: "text_delta", text },
})
const end =
  frame({ type: "content_block_stop", index: 0 }) +
  frame({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 1 },
  }) +
  frame({ type: "message_stop" })

async function pressureFixture() {
  let closed!: () => void
  const socketClosed = new Promise<void>((resolve) => {
    closed = resolve
  })
  let paused = 0
  const server = createServer(async (req, res) => {
    req.resume()
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.on("error", () => {})
    try {
      res.write(start)
      for (let i = 0; i < 192; i++) {
        if (!res.write(delta)) {
          paused++
          await once(res, "drain")
        }
      }
      res.end(end)
    } catch {}
  })
  server.on("connection", (socket) => socket.once("close", closed))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    socketClosed,
    paused: () => paused,
    close: async () => {
      const done = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await done
    },
  }
}
async function openPaused(baseUrl: string) {
  const req = request(baseUrl + "/v1/messages", {
    method: "POST",
    agent: false,
  })
  req.on("error", () => {})
  const response = new Promise<IncomingMessage>((resolve) =>
    req.once("response", (res) => {
      res.on("error", () => {})
      res.pause()
      resolve(res)
    })
  )
  req.end("{}")
  return { req, res: await response }
}

describe("relay backpressure", () => {
  it("preserves bytes and authoritative text after a slow reader resumes", async () => {
    const upstream = await pressureFixture()
    const relay = await startTestAdmission({
      upstream: upstream.origin,
      signal: new AbortController().signal,
      downstreamIdleMs: 2000,
    })
    let consumer: Awaited<ReturnType<typeof openPaused>> | undefined
    try {
      relay.enable()
      consumer = await openPaused(relay.baseUrl)
      const chunks: Buffer[] = []
      consumer.res.on("data", (chunk) => chunks.push(chunk))
      const ended = once(consumer.res, "end")
      consumer.res.resume()
      await ended
      const result = await relay.response
      expect(result.text).toBe(text.repeat(192))
      expect(Buffer.concat(chunks).toString()).toBe(
        start + delta.repeat(192) + end
      )
      expect(upstream.paused()).toBeGreaterThan(0)
      await upstream.socketClosed
    } finally {
      consumer?.req.destroy()
      await relay.close()
      await upstream.close()
    }
  }, 10000)
  it.each(["disconnect", "abort", "timeout"])(
    "bounds a blocked downstream on %s",
    async (mode) => {
      const upstream = await pressureFixture()
      const controller = new AbortController()
      const relay = await startTestAdmission({
        upstream: upstream.origin,
        signal: controller.signal,
        readIdleMs: 5000,
        downstreamIdleMs: 100,
      })
      let consumer: Awaited<ReturnType<typeof openPaused>> | undefined
      try {
        relay.enable()
        consumer = await openPaused(relay.baseUrl)
        const failed = expect(relay.response).rejects.toThrow()
        if (mode === "disconnect") consumer.res.destroy()
        if (mode === "abort") controller.abort()
        await failed
        await upstream.socketClosed
        expect(relay.diagnostics().admitted).toBe(1)
      } finally {
        consumer?.req.destroy()
        await relay.close()
        await upstream.close()
      }
    },
    10000
  )
})

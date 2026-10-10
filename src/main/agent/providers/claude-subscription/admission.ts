import { transformCacheWire, MAX_WIRE_BYTES } from "./cache-wire"
import type { ReplayFrame } from "./history"
import { randomBytes } from "crypto"
import {
  createServer,
  request as httpRequest,
  type OutgoingHttpHeaders,
} from "http"
import { request as httpsRequest } from "https"
import type { AddressInfo, Socket } from "net"
import type { ServerResponse } from "http"

function waitForDrain(
  res: ServerResponse,
  signal: AbortSignal,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer)
      res.off("drain", drained)
      res.off("close", closed)
      res.off("error", closed)
      signal.removeEventListener("abort", cancelled)
      if (error) reject(error)
      else resolve()
    }
    const drained = () => finish()
    const closed = () =>
      finish(
        new ClaudeSubscriptionError(
          "claude_subscription_downstream_closed",
          "Claude subscription response consumer disconnected."
        )
      )
    const cancelled = () => finish(aborted())
    const timer = setTimeout(
      () =>
        finish(
          new ClaudeSubscriptionError(
            "claude_subscription_downstream_stalled",
            "Claude subscription response consumer stopped reading."
          )
        ),
      timeoutMs
    )
    res.once("drain", drained)
    res.once("close", closed)
    res.once("error", closed)
    signal.addEventListener("abort", cancelled, { once: true })
    if (signal.aborted) cancelled()
    else if (res.destroyed) closed()
    else if (!res.writableNeedDrain) drained()
  })
}
import { ClaudeSubscriptionError, aborted } from "./errors"
import { ResponseCapture, type CapturedResponse } from "./sse"

const excluded = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
])
function headers(input: OutgoingHttpHeaders): OutgoingHttpHeaders {
  const deny = new Set(excluded)
  for (const value of String(input.connection ?? "").split(","))
    deny.add(value.trim().toLowerCase())
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !deny.has(key.toLowerCase()))
  )
}

export function guardProxyEnvironment(env: NodeJS.ProcessEnv): void {
  const conflicts = Object.keys(env).filter(
    (key) => /^(?:https?_proxy|all_proxy)$/i.test(key) && env[key]
  )
  if (conflicts.length)
    throw new ClaudeSubscriptionError(
      "claude_subscription_proxy_unsupported",
      `Subscription transport does not yet support configured proxies (${conflicts.join(", ")}); it will not connect directly.`
    )
}

interface RelayOptions {
  frames?: ReplayFrame[]
  signal: AbortSignal
  onDelta?: (kind: "text" | "reasoning", text: string) => void
  readIdleMs?: number
  downstreamIdleMs?: number
}
interface TestRelayOptions extends RelayOptions {
  upstream: string
}

export function startAdmission(options: RelayOptions) {
  return createAdmission(options, new URL("https://api.anthropic.com"))
}

// Separate entry point: production client never accepts an upstream override.
export function startTestAdmission(options: TestRelayOptions) {
  const upstream = new URL(options.upstream)
  if (
    upstream.protocol !== "http:" ||
    upstream.hostname !== "127.0.0.1" ||
    upstream.pathname !== "/" ||
    upstream.search ||
    upstream.username ||
    upstream.password
  ) {
    throw new Error("Test upstream must be a loopback HTTP origin.")
  }
  return createAdmission(options, upstream)
}

async function createAdmission(options: RelayOptions, upstream: URL) {
  const route = `/${randomBytes(32).toString("hex")}`
  let admitted = 0
  let blocked = 0
  let recoveryBlocked = 0
  let enabled = false
  let settled = false
  const sockets = new Set<Socket>()
  const upstreamRequests = new Set<ReturnType<typeof httpRequest>>()
  let resolve!: (response: CapturedResponse) => void
  let reject!: (error: unknown) => void
  const response = new Promise<CapturedResponse>((yes, no) => {
    resolve = yes
    reject = no
  })
  void response.catch(() => {})
  const fail = (error: unknown) => {
    if (!settled) {
      settled = true
      reject(error)
    }
  }
  const safeTransportError = () =>
    new ClaudeSubscriptionError(
      "claude_subscription_transport",
      "Claude subscription upstream connection failed."
    )
  const listener = createServer(async (req, res) => {
    if (
      (req.url !== `${route}/v1/messages` &&
        req.url !== `${route}/v1/messages?beta=true`) ||
      req.method !== "POST" ||
      req.headers.origin !== undefined ||
      req.headers.host !== host
    ) {
      blocked++
      res.writeHead(404).end()
      return
    }
    if (!enabled || admitted) {
      blocked++
      if (admitted) recoveryBlocked++
      if (!enabled)
        fail(
          new ClaudeSubscriptionError(
            "claude_subscription_replay_generation",
            "Claude attempted generation during history replay."
          )
        )
      res.writeHead(409).end()
      return
    }
    admitted++
    let wire: Buffer | undefined
    if (options.frames) {
      try {
        const chunks: Buffer[] = []
        let bytes = 0
        for await (const chunk of req) {
          bytes += chunk.length
          if (bytes > MAX_WIRE_BYTES) throw new Error("wire limit")
          chunks.push(Buffer.from(chunk))
        }
        wire = transformCacheWire(
          Buffer.concat(chunks),
          options.frames,
          (code) => console.debug("[claude-subscription] wire", { code })
        )
      } catch {
        fail(
          new ClaudeSubscriptionError(
            "claude_subscription_request_limit",
            "Subscription request exceeded its bounded wire envelope."
          )
        )
        res.writeHead(413).end()
        return
      }
    }
    const capture = new ResponseCapture(options.onDelta)
    const target = new URL(
      req.url!.endsWith("?beta=true")
        ? "/v1/messages?beta=true"
        : "/v1/messages",
      upstream
    )
    const upstreamReq = (
      upstream.protocol === "https:" ? httpsRequest : httpRequest
    )(target, {
      method: "POST",
      agent: false,
      headers: { ...headers(req.headers), "accept-encoding": "identity" },
      signal: options.signal,
    })
    upstreamRequests.add(upstreamReq)
    const idleMs = options.readIdleMs ?? 180000
    const connectTimer = setTimeout(
      () => upstreamReq.destroy(safeTransportError()),
      30000
    )
    upstreamReq.setTimeout(idleMs, () =>
      upstreamReq.destroy(safeTransportError())
    )
    upstreamReq.once("error", () => {
      clearTimeout(connectTimer)
      upstreamRequests.delete(upstreamReq)
      fail(options.signal.aborted ? aborted() : safeTransportError())
      res.destroy()
    })
    upstreamReq.once("response", async (incoming) => {
      clearTimeout(connectTimer)
      try {
        const status = incoming.statusCode ?? 502
        const requestId = incoming.headers["request-id"]
        metadata.status = status
        if (
          typeof requestId === "string" &&
          /^[A-Za-z0-9_-]{1,200}$/.test(requestId)
        )
          metadata.requestId = requestId
        res.writeHead(status, headers(incoming.headers))
        if (status !== 200) {
          incoming.resume()
          res.end()
          const retryAfter = incoming.headers["retry-after"]
          const safeHeaders =
            typeof retryAfter === "string" &&
            /^[\w ,:+./-]{1,128}$/.test(retryAfter)
              ? { "retry-after": retryAfter }
              : undefined
          fail(
            new ClaudeSubscriptionError(
              "claude_subscription_upstream",
              `Claude subscription upstream returned HTTP ${status}.`,
              status,
              safeHeaders
            )
          )
          incoming.destroy()
          return
        }
        if (
          !String(incoming.headers["content-type"] ?? "").startsWith(
            "text/event-stream"
          )
        )
          throw safeTransportError()
        incoming.setTimeout(idleMs, () =>
          incoming.destroy(safeTransportError())
        )
        for await (const chunk of incoming) {
          capture.push(chunk)
          if (!res.write(chunk))
            await waitForDrain(
              res,
              options.signal,
              options.downstreamIdleMs ?? idleMs
            )
        }
        const result = capture.finish()
        res.end()
        if (!settled) {
          settled = true
          resolve(result)
        }
      } catch (error) {
        fail(
          error instanceof ClaudeSubscriptionError
            ? error
            : options.signal.aborted
              ? aborted()
              : safeTransportError()
        )
        incoming.destroy()
        res.destroy()
      } finally {
        upstreamRequests.delete(upstreamReq)
      }
    })
    res.once("close", () => {
      if (!res.writableEnded) upstreamReq.destroy(safeTransportError())
    })
    req.once("error", () => upstreamReq.destroy(safeTransportError()))
    if (wire) upstreamReq.end(wire)
    else req.pipe(upstreamReq)
  })
  listener.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  listener.requestTimeout = 30000
  listener.headersTimeout = 10000
  const metadata: { status?: number; requestId?: string } = {}
  const onAbort = () => {
    fail(aborted())
    for (const request of upstreamRequests) request.destroy()
    for (const socket of sockets) socket.destroy()
  }
  if (options.signal.aborted) throw aborted()
  await new Promise<void>((yes, no) => {
    listener.once("error", no)
    listener.listen(0, "127.0.0.1", () => {
      listener.off("error", no)
      yes()
    })
  })
  const host = `127.0.0.1:${(listener.address() as AddressInfo).port}`
  options.signal.addEventListener("abort", onAbort, { once: true })
  if (options.signal.aborted) onAbort()
  return {
    baseUrl: `http://${host}${route}`,
    response,
    enable() {
      enabled = true
    },
    diagnostics: () => ({ ...metadata, admitted, blocked, recoveryBlocked }),
    async close() {
      options.signal.removeEventListener("abort", onAbort)
      if (!settled) fail(aborted())
      for (const request of upstreamRequests) request.destroy()
      const closed = new Promise<void>((yes) => listener.close(() => yes()))
      for (const socket of sockets) socket.destroy()
      await closed
    },
  }
}

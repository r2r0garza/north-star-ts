import { lookup as dnsLookup } from "node:dns/promises"
import net from "node:net"

const MAX_REDIRECTS = 10
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024
const BLOCKED_IPV4_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]
const BLOCKED_IPV6_RANGES: Array<[string, number]> = [
  ["::", 96],
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]

export type SafeFetchLookup = (
  hostname: string
) => Promise<Array<{ address: string; family?: number }>>

export interface SafeFetchOptions extends RequestInit {
  lookup?: SafeFetchLookup
  maxRedirects?: number
  timeoutMs?: number | null
}

export interface SafeFetchTextOptions extends SafeFetchOptions {
  maxBodyBytes?: number
}

class UnsafeUrlError extends Error {
  name = "UnsafeUrlError"
}

export class SafeFetchTimeoutError extends Error {
  name = "SafeFetchTimeoutError"

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms.`)
  }
}

export class SafeFetchBodyTooLargeError extends Error {
  name = "SafeFetchBodyTooLargeError"

  constructor(maxBodyBytes: number) {
    super(`Response body exceeded ${maxBodyBytes} decoded bytes.`)
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname
}

function ipv4ToNumber(address: string): number | null {
  const parts = address.split(".")
  if (parts.length !== 4) return null
  let result = 0
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null
    const value = Number(part)
    if (value < 0 || value > 255) return null
    result = result * 256 + value
  }
  return result >>> 0
}

function isIPv4InRange(address: string, base: string, prefix: number): boolean {
  const value = ipv4ToNumber(address)
  const baseValue = ipv4ToNumber(base)
  if (value === null || baseValue === null) return false
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (value & mask) === (baseValue & mask)
}

function parseIPv6(address: string): bigint | null {
  const zoneIndex = address.indexOf("%")
  const withoutZone = zoneIndex >= 0 ? address.slice(0, zoneIndex) : address
  const embeddedMatch = withoutZone.match(/(.+:)(\d+\.\d+\.\d+\.\d+)$/)
  let input = withoutZone
  const embedded = embeddedMatch ? ipv4ToNumber(embeddedMatch[2]) : null
  if (embeddedMatch) {
    if (embedded === null) return null
    const high = ((embedded >>> 16) & 0xffff).toString(16)
    const low = (embedded & 0xffff).toString(16)
    input = `${embeddedMatch[1]}${high}:${low}`
  }

  const halves = input.split("::")
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(":") : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  if (left.some((part) => !part) || right.some((part) => !part)) return null
  const missing = 8 - left.length - right.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null
  const parts = [...left, ...Array(missing).fill("0"), ...right]
  if (parts.length !== 8) return null

  let result = 0n
  for (const part of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null
    result = (result << 16n) + BigInt(parseInt(part, 16))
  }
  return result
}

function isIPv6InRange(address: string, base: string, prefix: number): boolean {
  const value = parseIPv6(address)
  const baseValue = parseIPv6(base)
  if (value === null || baseValue === null) return false
  const bits = 128n
  const hostBits = bits - BigInt(prefix)
  const mask =
    hostBits === 128n ? 0n : ((1n << bits) - 1n) ^ ((1n << hostBits) - 1n)
  return (value & mask) === (baseValue & mask)
}

function ipv4FromMappedIPv6(address: string): string | null {
  const value = parseIPv6(address)
  if (value === null) return null
  if (value >> 32n !== 0xffffn) return null
  const v4 = Number(value & 0xffffffffn)
  return [
    (v4 >>> 24) & 255,
    (v4 >>> 16) & 255,
    (v4 >>> 8) & 255,
    v4 & 255,
  ].join(".")
}

export function isPrivateOrLocalAddress(address: string): boolean {
  const normalized = normalizeHostname(address)
  if (net.isIP(normalized) === 4) {
    return BLOCKED_IPV4_RANGES.some(([base, prefix]) =>
      isIPv4InRange(normalized, base, prefix)
    )
  }

  if (net.isIP(normalized) === 6) {
    const mapped = ipv4FromMappedIPv6(normalized)
    if (mapped) return isPrivateOrLocalAddress(mapped)
    return BLOCKED_IPV6_RANGES.some(([base, prefix]) =>
      isIPv6InRange(normalized, base, prefix)
    )
  }

  return false
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status)
}

async function defaultLookup(
  hostname: string
): Promise<Array<{ address: string; family?: number }>> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true })
  return results.map((result) => ({
    address: result.address,
    family: result.family,
  }))
}

export async function assertPublicHttpUrl(
  url: URL,
  lookup: SafeFetchLookup = defaultLookup
): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError(
      `Only http(s) URLs are supported (got ${url.protocol}).`
    )
  }

  const hostname = normalizeHostname(url.hostname)
  if (!hostname || hostname.toLowerCase() === "localhost") {
    throw new UnsafeUrlError(
      "Local hostnames are not allowed for headless fetches."
    )
  }
  if (isPrivateOrLocalAddress(hostname)) {
    throw new UnsafeUrlError(
      "Private, local, link-local, and metadata addresses are not allowed for headless fetches."
    )
  }
  if (net.isIP(hostname)) return

  const addresses = await lookup(hostname)
  if (addresses.length === 0) {
    throw new UnsafeUrlError(`Could not resolve ${hostname}.`)
  }
  const blocked = addresses.find((result) =>
    isPrivateOrLocalAddress(result.address)
  )
  if (blocked) {
    throw new UnsafeUrlError(
      `${hostname} resolves to a private, local, link-local, or metadata address.`
    )
  }
}

export async function safeFetch(
  input: string | URL,
  options: SafeFetchOptions = {}
): Promise<Response> {
  const {
    lookup,
    maxRedirects = MAX_REDIRECTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    ...fetchOptions
  } = options
  let current = typeof input === "string" ? new URL(input) : new URL(input.href)
  const deadline = makeDeadlineSignal(signal ?? undefined, timeoutMs)

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      throwIfAborted(deadline.signal)
      await abortable(assertPublicHttpUrl(current, lookup), deadline.signal)
      throwIfAborted(deadline.signal)
      const res = await fetch(current.href, {
        ...fetchOptions,
        redirect: "manual",
        signal: deadline.signal,
      })

      if (!isRedirect(res.status)) return res

      const location = res.headers.get("location")
      if (!location) return res
      if (hop === maxRedirects) {
        throw new UnsafeUrlError("Too many redirects while fetching URL.")
      }
      current = new URL(location, current)
    }

    throw new UnsafeUrlError("Too many redirects while fetching URL.")
  } catch (err) {
    deadline.dispose()
    throw normalizeAbortError(err)
  }
}

export async function safeFetchText(
  input: string | URL,
  options: SafeFetchTextOptions = {}
): Promise<{ response: Response; text: string }> {
  const {
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    ...fetchOptions
  } = options
  const deadline = makeDeadlineSignal(signal ?? undefined, timeoutMs)
  try {
    const response = await safeFetch(input, {
      ...fetchOptions,
      timeoutMs: null,
      signal: deadline.signal,
    })
    const text = await readResponseText(response, {
      maxBodyBytes,
      signal: deadline.signal,
    })
    return { response, text }
  } catch (err) {
    throw normalizeAbortError(err)
  } finally {
    deadline.dispose()
  }
}

export async function readResponseText(
  response: Response,
  opts: { maxBodyBytes?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  if (maxBodyBytes <= 0 || !Number.isFinite(maxBodyBytes)) {
    throw new Error("maxBodyBytes must be a positive finite number")
  }
  if (!response.body) return ""

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let totalBytes = 0

  try {
    while (true) {
      throwIfAborted(opts.signal)
      const { done, value } = await readChunk(reader, opts.signal)
      if (done) break
      if (!value) continue

      totalBytes += value.byteLength
      if (totalBytes > maxBodyBytes) {
        await reader.cancel(new SafeFetchBodyTooLargeError(maxBodyBytes))
        throw new SafeFetchBodyTooLargeError(maxBodyBytes)
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join("")
  } catch (err) {
    throw normalizeAbortError(err)
  } finally {
    reader.releaseLock()
  }
}

function makeDeadlineSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | null
): { signal: AbortSignal; dispose: () => void } {
  if (timeoutMs === null) {
    return {
      signal: signal ?? new AbortController().signal,
      dispose: () => {},
    }
  }
  if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    throw new Error("timeoutMs must be a positive finite number")
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(new SafeFetchTimeoutError(timeoutMs))
  }, timeoutMs)
  ;(timeout as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()

  const abortFromCaller = () => {
    controller.abort(getAbortReason(signal))
  }
  if (signal?.aborted) {
    abortFromCaller()
  } else {
    signal?.addEventListener("abort", abortFromCaller, { once: true })
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", abortFromCaller)
    },
  }
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read()
  throwIfAborted(signal)

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort)
      const reason = getAbortReason(signal)
      void reader.cancel(reason).catch(() => {})
      reject(reason)
    }
    signal.addEventListener("abort", onAbort, { once: true })
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort)
        resolve(result)
      },
      (err) => {
        signal.removeEventListener("abort", onAbort)
        reject(err)
      }
    )
  })
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal)

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort)
      reject(getAbortReason(signal))
    }
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener("abort", onAbort)
        reject(err)
      }
    )
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw getAbortReason(signal)
}

function getAbortReason(signal?: AbortSignal): unknown {
  return (
    signal?.reason ??
    new DOMException("The operation was aborted.", "AbortError")
  )
}

function normalizeAbortError(err: unknown): unknown {
  if (err instanceof SafeFetchTimeoutError) return err
  if (err instanceof SafeFetchBodyTooLargeError) return err
  if (err instanceof Error && err.name === "TimeoutError") {
    return new SafeFetchTimeoutError(DEFAULT_TIMEOUT_MS)
  }
  return err
}

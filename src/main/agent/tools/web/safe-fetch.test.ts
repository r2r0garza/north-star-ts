import { afterEach, describe, expect, it, vi } from "vitest"
import {
  assertPublicHttpUrl,
  isPrivateOrLocalAddress,
  readResponseText,
  SafeFetchBodyTooLargeError,
  SafeFetchTimeoutError,
  safeFetch,
  safeFetchText,
  type SafeFetchLookup,
} from "./safe-fetch"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("isPrivateOrLocalAddress", () => {
  it("blocks loopback, private, link-local, metadata, and IPv4-mapped aliases", () => {
    expect(isPrivateOrLocalAddress("127.0.0.1")).toBe(true)
    expect(isPrivateOrLocalAddress("127.0.0.1")).toBe(true)
    expect(isPrivateOrLocalAddress("10.2.3.4")).toBe(true)
    expect(isPrivateOrLocalAddress("172.20.0.1")).toBe(true)
    expect(isPrivateOrLocalAddress("192.168.1.5")).toBe(true)
    expect(isPrivateOrLocalAddress("169.254.169.254")).toBe(true)
    expect(isPrivateOrLocalAddress("::1")).toBe(true)
    expect(isPrivateOrLocalAddress("fc00::1")).toBe(true)
    expect(isPrivateOrLocalAddress("fe80::1")).toBe(true)
    expect(isPrivateOrLocalAddress("::127.0.0.1")).toBe(true)
    expect(isPrivateOrLocalAddress("::ffff:127.0.0.1")).toBe(true)
    expect(isPrivateOrLocalAddress("93.184.216.34")).toBe(false)
    expect(isPrivateOrLocalAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(
      false
    )
  })
})

describe("assertPublicHttpUrl", () => {
  it("rejects direct local and metadata destinations", async () => {
    await expect(assertPublicHttpUrl(new URL("http://127.1/"))).rejects.toThrow(
      /private|local|metadata/i
    )
    await expect(
      assertPublicHttpUrl(new URL("http://169.254.169.254/latest"))
    ).rejects.toThrow(/private|local|metadata/i)
    await expect(assertPublicHttpUrl(new URL("http://[::1]/"))).rejects.toThrow(
      /private|local|metadata/i
    )
  })

  it("rejects hostnames resolving to private addresses", async () => {
    const lookup: SafeFetchLookup = vi.fn(async () => [
      { address: "192.168.0.10", family: 4 },
    ])

    await expect(
      assertPublicHttpUrl(new URL("https://example.test/data"), lookup)
    ).rejects.toThrow(/resolves to/i)
    expect(lookup).toHaveBeenCalledWith("example.test")
  })
})

describe("safeFetch", () => {
  it("does not fetch direct private URLs", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(safeFetch("http://127.0.0.1/secret")).rejects.toThrow(
      /private|local|metadata/i
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("revalidates redirects before fetching the next hop", async () => {
    const lookup: SafeFetchLookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ])
    const fetchMock = vi.fn(
      async () =>
        new Response("", {
          status: 302,
          headers: { location: "http://127.0.0.1/admin" },
        })
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      safeFetch("https://public.example/start", { lookup })
    ).rejects.toThrow(/private|local|metadata/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      "https://public.example/start",
      expect.objectContaining({ redirect: "manual" })
    )
  })

  it("follows public redirects and returns the final response", async () => {
    const lookup: SafeFetchLookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ])
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("", {
          status: 302,
          headers: { location: "/final" },
        })
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    const res = await safeFetch("https://public.example/start", { lookup })
    expect(await res.text()).toBe("ok")
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://public.example/final",
      expect.objectContaining({ redirect: "manual" })
    )
  })
})

describe("readResponseText", () => {
  it("streams response text through a decoded-byte cap", async () => {
    const res = new Response("1234567890")

    await expect(
      readResponseText(res, { maxBodyBytes: 5 })
    ).rejects.toBeInstanceOf(SafeFetchBodyTooLargeError)
  })

  it("does not split multi-byte UTF-8 characters while decoding chunks", async () => {
    const encoded = new TextEncoder().encode("a🙂b")
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 2))
        controller.enqueue(encoded.slice(2))
        controller.close()
      },
    })

    await expect(
      readResponseText(new Response(stream), { maxBodyBytes: encoded.length })
    ).resolves.toBe("a🙂b")
  })
})

describe("safeFetchText", () => {
  it("applies an independent request deadline", async () => {
    vi.useFakeTimers()
    const lookup: SafeFetchLookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ])
    const fetchMock = vi.fn(
      (_url: string, opts?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            reject(opts.signal?.reason)
          })
        })
    )
    vi.stubGlobal("fetch", fetchMock)

    const promise = safeFetchText("https://public.example/slow", {
      lookup,
      timeoutMs: 25,
    })
    const assertion = expect(promise).rejects.toBeInstanceOf(
      SafeFetchTimeoutError
    )
    await vi.advanceTimersByTimeAsync(25)

    await assertion
  })

  it("applies the request deadline while validating DNS", async () => {
    vi.useFakeTimers()
    const lookup: SafeFetchLookup = vi.fn(
      () => new Promise<Array<{ address: string; family?: number }>>(() => {})
    )
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const promise = safeFetchText("https://public.example/slow-dns", {
      lookup,
      timeoutMs: 25,
    })
    const assertion = expect(promise).rejects.toBeInstanceOf(
      SafeFetchTimeoutError
    )
    await vi.advanceTimersByTimeAsync(25)

    await assertion
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("reports caller cancellation separately from timeouts", async () => {
    const lookup: SafeFetchLookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ])
    const controller = new AbortController()
    const fetchMock = vi.fn(
      (_url: string, opts?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            reject(opts.signal?.reason)
          })
        })
    )
    vi.stubGlobal("fetch", fetchMock)

    const promise = safeFetchText("https://public.example/slow", {
      lookup,
      signal: controller.signal,
      timeoutMs: 30_000,
    })
    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: "AbortError" })
  })
})

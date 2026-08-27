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
  type SafeFetchOptions,
} from "./safe-fetch"

type SafeFetchTransport = NonNullable<SafeFetchOptions["transport"]>

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
    const transport: SafeFetchTransport = vi.fn()

    await expect(
      safeFetch("http://127.0.0.1/secret", { transport })
    ).rejects.toThrow(/private|local|metadata/i)
    expect(transport).not.toHaveBeenCalled()
  })

  it("pins the initial connection to the validated DNS address set", async () => {
    const lookup: SafeFetchLookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ])
    const privateEndpoint = vi.fn()
    const transport: SafeFetchTransport = vi.fn(
      async (_url, _opts, approvedAddresses) => {
        if (
          approvedAddresses.some(
            (result: { address: string }) => result.address === "127.0.0.1"
          )
        ) {
          privateEndpoint()
        }
        return new Response("ok", { status: 200 })
      }
    )

    const res = await safeFetch("https://public.example/start", {
      lookup,
      transport,
    })

    expect(await res.text()).toBe("ok")
    expect(transport).toHaveBeenCalledWith(
      new URL("https://public.example/start"),
      expect.objectContaining({ redirect: "manual" }),
      [{ address: "93.184.216.34", family: 4 }],
      expect.any(AbortSignal)
    )
    expect(privateEndpoint).not.toHaveBeenCalled()
  })

  it("revalidates redirects before fetching the next hop", async () => {
    const lookup: SafeFetchLookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ])
    const transport: SafeFetchTransport = vi.fn(
      async () =>
        new Response("", {
          status: 302,
          headers: { location: "http://127.0.0.1/admin" },
        })
    )

    await expect(
      safeFetch("https://public.example/start", { lookup, transport })
    ).rejects.toThrow(/private|local|metadata/i)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport).toHaveBeenCalledWith(
      new URL("https://public.example/start"),
      expect.objectContaining({ redirect: "manual" }),
      [{ address: "93.184.216.34", family: 4 }],
      expect.any(AbortSignal)
    )
  })

  it("pins redirect hop connections to their validated DNS address sets", async () => {
    const lookup: SafeFetchLookup = vi
      .fn()
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "93.184.216.35", family: 4 }])
    const privateEndpoint = vi.fn()
    const transport: SafeFetchTransport = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("", {
          status: 302,
          headers: { location: "https://cdn.example/final" },
        })
      )
      .mockImplementationOnce(async (_url, _opts, approvedAddresses) => {
        if (
          approvedAddresses.some(
            (result: { address: string }) => result.address === "127.0.0.1"
          )
        ) {
          privateEndpoint()
        }
        return new Response("ok", { status: 200 })
      })

    const res = await safeFetch("https://public.example/start", {
      lookup,
      transport,
    })

    expect(await res.text()).toBe("ok")
    expect(lookup).toHaveBeenNthCalledWith(2, "cdn.example")
    expect(transport).toHaveBeenNthCalledWith(
      2,
      new URL("https://cdn.example/final"),
      expect.objectContaining({ redirect: "manual" }),
      [{ address: "93.184.216.35", family: 4 }],
      expect.any(AbortSignal)
    )
    expect(privateEndpoint).not.toHaveBeenCalled()
  })

  it("follows public redirects and returns the final response", async () => {
    const lookup: SafeFetchLookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ])
    const transport: SafeFetchTransport = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("", {
          status: 302,
          headers: { location: "/final" },
        })
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))

    const res = await safeFetch("https://public.example/start", {
      lookup,
      transport,
    })
    expect(await res.text()).toBe("ok")
    expect(transport).toHaveBeenNthCalledWith(
      2,
      new URL("https://public.example/final"),
      expect.objectContaining({ redirect: "manual" }),
      [{ address: "93.184.216.34", family: 4 }],
      expect.any(AbortSignal)
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
    const transport: SafeFetchTransport = vi.fn(
      (_url, _opts, _approvedAddresses, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(signal.reason)
          })
        })
    )

    const promise = safeFetchText("https://public.example/slow", {
      lookup,
      transport,
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
    const transport: SafeFetchTransport = vi.fn()

    const promise = safeFetchText("https://public.example/slow-dns", {
      lookup,
      transport,
      timeoutMs: 25,
    })
    const assertion = expect(promise).rejects.toBeInstanceOf(
      SafeFetchTimeoutError
    )
    await vi.advanceTimersByTimeAsync(25)

    await assertion
    expect(transport).not.toHaveBeenCalled()
  })

  it("reports caller cancellation separately from timeouts", async () => {
    const lookup: SafeFetchLookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ])
    const controller = new AbortController()
    const transport: SafeFetchTransport = vi.fn(
      (_url, _opts, _approvedAddresses, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(signal.reason)
          })
        })
    )

    const promise = safeFetchText("https://public.example/slow", {
      lookup,
      transport,
      signal: controller.signal,
      timeoutMs: 30_000,
    })
    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: "AbortError" })
  })

  it("releases deadline resources immediately after a successful response", async () => {
    vi.useFakeTimers()
    const lookup: SafeFetchLookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ])
    const transport: SafeFetchTransport = vi.fn(async () => new Response("ok"))

    await expect(
      safeFetchText("https://public.example/ok", {
        lookup,
        transport,
        timeoutMs: 30_000,
      })
    ).resolves.toMatchObject({ text: "ok" })

    expect(vi.getTimerCount()).toBe(0)
  })
})

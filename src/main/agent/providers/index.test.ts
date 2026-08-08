import { describe, it, expect } from "vitest"
import { isTransientError } from "./index"

describe("isTransientError", () => {
  it("treats 408/429/5xx HTTP status as transient", () => {
    expect(isTransientError({ status: 408 })).toBe(true)
    expect(isTransientError({ status: 429 })).toBe(true)
    expect(isTransientError({ status: 500 })).toBe(true)
    expect(isTransientError({ status: 502 })).toBe(true)
    expect(isTransientError({ status: 503 })).toBe(true)
    expect(isTransientError({ status: 599 })).toBe(true)
  })

  it("treats other 4xx HTTP status as deterministic", () => {
    expect(isTransientError({ status: 400 })).toBe(false)
    expect(isTransientError({ status: 401 })).toBe(false)
    expect(isTransientError({ status: 403 })).toBe(false)
    expect(isTransientError({ status: 404 })).toBe(false)
    expect(isTransientError({ status: 422 })).toBe(false)
  })

  it("treats connection-layer codes and SDK connection errors as transient", () => {
    expect(isTransientError({ code: "ECONNRESET" })).toBe(true)
    expect(isTransientError({ code: "ETIMEDOUT" })).toBe(true)
    expect(isTransientError({ code: "UND_ERR_CONNECT_TIMEOUT" })).toBe(true)
    expect(isTransientError({ name: "APIConnectionError" })).toBe(true)
    expect(isTransientError({ name: "APIConnectionTimeoutError" })).toBe(true)
  })

  it("treats unknown or non-object errors as deterministic", () => {
    expect(isTransientError({ code: "EACCES" })).toBe(false)
    expect(isTransientError({ name: "TypeError" })).toBe(false)
    expect(isTransientError({})).toBe(false)
    expect(isTransientError(null)).toBe(false)
    expect(isTransientError("boom")).toBe(false)
    expect(isTransientError(new Error("oops"))).toBe(false)
  })

  it("prefers status over code when both are present", () => {
    // A 400 with a transient-looking code is still deterministic.
    expect(isTransientError({ status: 400, code: "ECONNRESET" })).toBe(false)
  })

  it("treats a mid-stream 'terminated' TypeError as transient (message + cause)", () => {
    // undici surfaces a socket death as TypeError("terminated") with the real
    // code on .cause — both the message and the cause must classify transient.
    const withCause = Object.assign(new TypeError("terminated"), {
      cause: { code: "UND_ERR_SOCKET" },
    })
    expect(isTransientError(withCause)).toBe(true)
    // Bare "terminated" with no cause → still transient via the message match.
    expect(isTransientError(new TypeError("terminated"))).toBe(true)
    expect(isTransientError({ message: "terminated" })).toBe(true)
  })

  it("walks a nested cause chain to find a transient code", () => {
    expect(
      isTransientError({
        message: "request failed",
        cause: { cause: { code: "ECONNRESET" } },
      })
    ).toBe(true)
  })

  it("does not infinite-loop on a self-referential cause", () => {
    const e: { message: string; cause?: unknown } = { message: "nope" }
    e.cause = e
    expect(isTransientError(e)).toBe(false)
  })

  it("keeps deterministic errors non-retryable despite the cause walk", () => {
    expect(isTransientError({ status: 404, cause: { code: "ECONNRESET" } })).toBe(
      false
    ) // a real 4xx status short-circuits before the cause is consulted
    expect(isTransientError(new Error("bad request"))).toBe(false)
    expect(isTransientError({ message: "invalid argument" })).toBe(false)
  })
})

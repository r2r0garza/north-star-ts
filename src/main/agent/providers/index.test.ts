import { describe, it, expect, vi } from "vitest"
import { createCompletion, isTransientError, type LlmClient } from "./index"
import { ClaudeSubscriptionError } from "./claude-subscription/errors"

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

  it("treats the OpenAI overload turn-ending message as transient", () => {
    expect(
      isTransientError(
        new Error(
          "The turn ended early: Our servers are currently overloaded. Please try again later."
        )
      )
    ).toBe(true)
  })

  it("treats a bare fetch failure as transient", () => {
    expect(isTransientError(new TypeError("fetch failed"))).toBe(true)
    expect(
      isTransientError(
        new Error("Model request failed after 3 attempts: fetch failed")
      )
    ).toBe(true)
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
    expect(
      isTransientError({ status: 404, cause: { code: "ECONNRESET" } })
    ).toBe(false) // a real 4xx status short-circuits before the cause is consulted
    expect(isTransientError(new Error("bad request"))).toBe(false)
    expect(isTransientError({ message: "invalid argument" })).toBe(false)
  })
})

describe("subscription attempt compatibility", () => {
  const unsupported = () =>
    Object.assign(
      new Error("unsupported_parameter max_tokens; use max_completion_tokens"),
      { status: 400 }
    )
  const client = (
    create: LlmClient["chat"]["completions"]["create"],
    probes = true
  ): LlmClient => ({
    ...(probes ? {} : { compatibilityProbes: false as const }),
    chat: { completions: { create } },
    models: { list: async () => ({ data: [] }) },
  })
  it("retains token-field probing for existing providers", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(unsupported())
      .mockResolvedValue("ok")
    await expect(
      createCompletion(client(create), "probe-regression", 10, {})
    ).resolves.toBe("ok")
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[1][0]).toMatchObject({ max_completion_tokens: 10 })
  })
  it("ignores another provider's learned token field and never probes", async () => {
    const gateway = vi
      .fn()
      .mockRejectedValueOnce(unsupported())
      .mockResolvedValue("ok")
    await createCompletion(client(gateway), "shared-route", 10, {})
    const failure = unsupported()
    const create = vi.fn().mockRejectedValue(failure)
    await expect(
      createCompletion(client(create, false), "shared-route", 10, {})
    ).rejects.toBe(failure)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0]).toEqual({
      model: "shared-route",
      max_tokens: 10,
    })
  })
  it.each(["cli_missing", "cli_incompatible", "environment"])(
    "keeps %s deterministic even with a 503 status",
    (suffix) => {
      expect(
        isTransientError(
          new ClaudeSubscriptionError(
            `claude_subscription_${suffix}`,
            "Setup failed",
            503
          )
        )
      ).toBe(false)
    }
  )
  it("preserves genuine upstream status and Retry-After", () => {
    const error = new ClaudeSubscriptionError(
      "claude_subscription_upstream",
      "Rate limited",
      429,
      { "retry-after": "4" }
    )
    expect(isTransientError(error)).toBe(true)
    expect(error.headers).toEqual({ "retry-after": "4" })
    expect(
      isTransientError(
        new ClaudeSubscriptionError(
          "claude_subscription_upstream",
          "Unavailable",
          503
        )
      )
    ).toBe(true)
    expect(
      isTransientError(
        new ClaudeSubscriptionError(
          "claude_subscription_upstream",
          "Invalid",
          400
        )
      )
    ).toBe(false)
  })
})

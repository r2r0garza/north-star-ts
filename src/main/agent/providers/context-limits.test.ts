import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }))

import { ContextOverflowError } from "./anthropic"
import { isContextOverflow } from "./context-limits"

describe("isContextOverflow", () => {
  it("recognizes each in-scope adapter's overflow", () => {
    // Anthropic and Google adapters map theirs to ContextOverflowError.
    expect(isContextOverflow(new ContextOverflowError("too long"))).toBe(true)
    // OpenAI-style accounts (Portkey, openai, openai_compatible).
    expect(
      isContextOverflow(
        Object.assign(
          new Error("This model's maximum context length is 128000 tokens."),
          {
            status: 400,
            code: "context_length_exceeded",
          }
        )
      )
    ).toBe(true)
    // Codex subscription: a failed terminal response, `code: message`.
    expect(
      isContextOverflow(
        new Error(
          "context_length_exceeded: Your input exceeds the context window of this model."
        )
      )
    ).toBe(true)
    // Wrapped in a cause chain.
    expect(
      isContextOverflow(
        new Error("turn failed", { cause: new ContextOverflowError("x") })
      )
    ).toBe(true)
  })

  it("does not treat output-limit or other 4xx errors as overflow", () => {
    expect(isContextOverflow(new Error("max_tokens is too large"))).toBe(false)
    expect(
      isContextOverflow(
        Object.assign(new Error("invalid api key"), { status: 401 })
      )
    ).toBe(false)
  })
})

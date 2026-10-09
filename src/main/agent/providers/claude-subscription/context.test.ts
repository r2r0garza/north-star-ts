import { describe, expect, it } from "vitest"
import { claudeSubscriptionContextLimit } from "./context"
import { validateRequest } from "./request"

const body = {
  model: "claude-sonnet-4-6",
  max_tokens: 256,
  messages: [{ role: "user", content: "hello" }],
}

describe("subscription context admission", () => {
  it("caps standard CLI aliases and documented routes without widening unknown routes", () => {
    for (const route of [
      "claude-sonnet-4-6",
      "claude-opus-4-5-20251101",
      "claude-haiku-4-5",
      "sonnet",
      "opus",
      "haiku",
    ])
      expect(claudeSubscriptionContextLimit(route)).toBe(200000)
    for (const route of [
      "haiku-custom",
      "default",
      "opusplan",
      "claude-sonnet-4-6-custom",
      "claude-future-9",
    ])
      expect(claudeSubscriptionContextLimit(route)).toBe(32000)
    expect(() => validateRequest({ ...body, model: "sonnet[1m]" })).toThrow()
  })

  it.each(["haiku", "sonnet", "opus"])(
    "admits a large tool catalog on %s without pinning native alias resolution",
    (alias) => {
      const request = {
        ...body,
        model: alias,
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              description: "x".repeat(100000),
              parameters: { type: "object" },
            },
          },
        ],
      }
      expect(validateRequest(request).model).toBe(alias)
      expect(request.model).toBe(alias)
      request.tools[0].function.description = "x".repeat(200000)
      expect(() => validateRequest(request)).toThrow(
        /200000-token route budget/
      )
      expect(() => validateRequest(request)).toThrow(
        /tools\/request options \d+/
      )
      expect(() => validateRequest(request)).toThrow(
        /restarting cannot shrink the tool catalog/
      )
    }
  )

  it.each(["system", "history", "tools", "output"])(
    "includes %s in the preflight and never mutates canonical input",
    (part) => {
      const request: Record<string, unknown> = { ...body }
      const large = "x".repeat(200000)
      if (part === "system")
        request.messages = [
          { role: "system", content: large },
          ...body.messages,
        ]
      if (part === "history")
        request.messages = [
          { role: "user", content: large },
          { role: "assistant", content: "old answer" },
          ...body.messages,
        ]
      if (part === "tools")
        request.tools = [
          {
            type: "function",
            function: {
              name: "read",
              description: large,
              parameters: { type: "object" },
            },
          },
        ]
      if (part === "output") {
        request.model = "claude-manual-1"
        request.max_tokens = 32000
      }
      const snapshot = JSON.stringify(request)
      expect(() => validateRequest(request)).toThrowError(
        expect.objectContaining({
          code: "claude_subscription_context_overflow",
          status: 400,
        })
      )
      expect(JSON.stringify(request)).toBe(snapshot)
    }
  )

  it("counts UTF-8 bytes rather than underestimating non-English history", () => {
    expect(() =>
      validateRequest({
        ...body,
        messages: [{ role: "user", content: "界".repeat(65000) }],
      })
    ).toThrow(/context exceeds/)
  })

  it.each([false, true])(
    "reserves attachment cost for user and tool media (tool=%s)",
    (tool) => {
      const media = [
        { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
      ]
      const request = {
        ...body,
        model: "claude-manual-1",
        messages: tool
          ? [
              { role: "user", content: "inspect" },
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call",
                    type: "function",
                    function: { name: "read", arguments: "{}" },
                  },
                ],
              },
              {
                role: "tool",
                tool_call_id: "call",
                content: [...media, ...media],
              },
            ]
          : [{ role: "user", content: [...media, ...media] }],
      }
      expect(() => validateRequest(request)).toThrow(/context exceeds/)
      request.model = body.model
      const result = validateRequest(request)
      expect(JSON.stringify(result.frames)).toContain('"type":"image"')
    }
  )

  it("rebuilds fresh canonical history and requires no native session", () => {
    const request = {
      ...body,
      messages: [
        { role: "system", content: "host summary of earlier turns" },
        { role: "user", content: "edited tail" },
      ],
    }
    expect(validateRequest(request).system).toBe(
      "host summary of earlier turns"
    )
    expect(JSON.stringify(validateRequest(request).frames)).toContain(
      "edited tail"
    )
    request.messages[1].content = "new edit"
    const replay = validateRequest(request)
    expect(JSON.stringify(replay.frames)).not.toContain("edited tail")
    expect(JSON.stringify(replay.frames)).toContain("new edit")
    expect(replay.frames).toHaveLength(1)
  })

  it.each([undefined, false])(
    "accepts actual auxiliary defaults (stream=%s)",
    (stream) => {
      const result = validateRequest({ ...body, stream })
      expect(result.stream).toBe(false)
      expect(result.frames).toHaveLength(1)
    }
  )
})

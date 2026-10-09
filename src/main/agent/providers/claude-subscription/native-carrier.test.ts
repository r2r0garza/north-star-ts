import { describe, expect, it } from "vitest"
import {
  historyFingerprint,
  nativeAssistant,
  replayCarrier,
  validateCarrier,
  MAX_CARRIER_BYTES,
} from "./native-carrier"
import { translateHistory } from "./history"

const model = "claude-sonnet-4-6"
const user = { role: "user", content: "inspect" }
const prefix = historyFingerprint(translateHistory([user]).frames)
const blocks = [
  { type: "thinking", thinking: "private", signature: "opaque-signature" },
  { type: "text", text: "before" },
  { type: "tool_use", id: "a", name: "mcp__ns__read", input: { path: "a" } },
  { type: "redacted_thinking", data: "opaque-data" },
  { type: "text", text: "after" },
]
const carrier = {
  version: 1,
  provider: "claude_subscription",
  model,
  prefix,
  blocks,
}
const assistant = {
  role: "assistant",
  content: "beforeafter",
  tool_calls: [
    {
      id: "a",
      type: "function",
      function: { name: "read", arguments: '{"path":"a"}' },
    },
  ],
  [nativeAssistant]: carrier,
}
const result = { role: "tool", tool_call_id: "a", content: "done" }
const replay = (a = assistant, u = user, m = model) =>
  translateHistory([u, a, result], undefined, m).frames[1].message.content

describe("native assistant carrier", () => {
  it("restores ordered blocks from a serialized carrier without exposing signatures as text", () => {
    const restored = {
      ...assistant,
      [nativeAssistant]: JSON.parse(JSON.stringify(carrier)),
    }
    expect(replay(restored)).toEqual(blocks)
    expect(JSON.stringify(restored)).not.toContain("opaque-signature")
    expect(replay(restored)[0].type).toBe("thinking")
  })
  it.each([
    ["text edit", { ...assistant, content: "before after" }, user, model],
    [
      "input edit",
      {
        ...assistant,
        tool_calls: [
          {
            ...assistant.tool_calls[0],
            function: { name: "read", arguments: '{"path":"b"}' },
          },
        ],
      },
      user,
      model,
    ],
    [
      "tool rename",
      {
        ...assistant,
        tool_calls: [
          {
            ...assistant.tool_calls[0],
            function: { name: "write", arguments: '{"path":"a"}' },
          },
        ],
      },
      user,
      model,
    ],
    ["history edit", assistant, { ...user, content: "changed" }, model],
    ["model switch", assistant, user, "claude-opus-4-6"],
    [
      "unknown version",
      { ...assistant, [nativeAssistant]: { ...carrier, version: 2 } },
      user,
      model,
    ],
    [
      "foreign provider",
      { ...assistant, [nativeAssistant]: { ...carrier, provider: "other" } },
      user,
      model,
    ],
  ])("invalidates %s", (_name, a, u, m) => {
    expect(
      replay(a as typeof assistant, u, m).some((b) => b.type === "thinking")
    ).toBe(false)
  })
  it("does not let metadata bypass pending-call validation", () => {
    expect(() =>
      translateHistory(
        [user, { ...assistant, tool_calls: [] }, result],
        undefined,
        model
      )
    ).toThrow()
  })
  it("invalidates deletions, summaries and protected/unknown block additions", () => {
    expect(
      replayCarrier(carrier, model, historyFingerprint([]), blocks)
    ).toBeUndefined()
    expect(
      validateCarrier({
        ...carrier,
        blocks: [
          ...blocks,
          { type: "text", text: "x", cache_control: { type: "ephemeral" } },
        ],
      })
    ).toBeUndefined()
    expect(
      validateCarrier({ ...carrier, blocks: [{ type: "server_tool_use" }] })
    ).toBeUndefined()
    expect(
      validateCarrier({
        ...carrier,
        blocks: [{ type: "thinking", thinking: "x", signature: "" }],
      })
    ).toBeUndefined()
    expect(
      validateCarrier({
        ...carrier,
        blocks: [{ type: "text", text: "x".repeat(MAX_CARRIER_BYTES) }],
      })
    ).toBeUndefined()
  })
  it("hashes canonical projections, not signature carriers or replay query flags", () => {
    const before = translateHistory(
      [user, assistant, result],
      undefined,
      model
    ).frames
    const canonical = translateHistory(
      [user, { ...assistant, [nativeAssistant]: undefined }, result],
      undefined,
      model
    ).frames
    expect(historyFingerprint(before)).toBe(historyFingerprint(canonical))
  })
})

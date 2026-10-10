import { describe, expect, it, vi } from "vitest"
import { restoreQueriedResults } from "./tool-result-restoration"
import { transformCacheWire } from "./cache-wire"
import type { NativeBlock, ReplayFrame } from "./history"

const host: NativeBlock[] = [
  {
    type: "tool_result",
    tool_use_id: "a",
    content: [{ type: "text", text: "first" }],
  },
  {
    type: "tool_result",
    tool_use_id: "b",
    content: [{ type: "text", text: "second" }],
    is_error: true,
  },
]
const frame = (content: NativeBlock[]): ReplayFrame[] => [
  { type: "user", message: { role: "user", content } },
]

describe("lossless queried result restoration", () => {
  it("accepts only scalar/single plain-text and missing/false boolean equivalence", () => {
    const queried = structuredClone(host)
    queried[0].content = "first"
    queried[0].is_error = false
    expect(restoreQueriedResults(queried, host)).toEqual(host)
    expect(queried[0].content).toBe("first")
  })
  it.each([
    [
      "prefix",
      (q: NativeBlock[]) => {
        q[0].content = "prefix first"
      },
    ],
    [
      "suffix",
      (q: NativeBlock[]) => {
        q[0].content = "first suffix"
      },
    ],
    [
      "reminder",
      (q: NativeBlock[]) => {
        q[0].content.push({
          type: "text",
          text: "<system-reminder>protected</system-reminder>",
        })
      },
    ],
    [
      "duplicate IDs",
      (q: NativeBlock[]) => {
        q[1].tool_use_id = "a"
      },
    ],
    [
      "reordered IDs",
      (q: NativeBlock[]) => {
        q.reverse()
      },
    ],
    [
      "changed ID",
      (q: NativeBlock[]) => {
        q[0].tool_use_id = "c"
      },
    ],
    [
      "error",
      (q: NativeBlock[]) => {
        q[0].is_error = true
      },
    ],
    [
      "nonboolean error",
      (q: NativeBlock[]) => {
        q[0].is_error = 0
      },
    ],
    [
      "null error",
      (q: NativeBlock[]) => {
        q[0].is_error = null
      },
    ],
    [
      "cache marker",
      (q: NativeBlock[]) => {
        q[0].cache_control = { type: "ephemeral" }
      },
    ],
    [
      "text metadata",
      (q: NativeBlock[]) => {
        q[0].content[0].citations = []
      },
    ],
    [
      "media",
      (q: NativeBlock[]) => {
        q[0].content.push({
          type: "image",
          source: { type: "base64", data: "AAAA", media_type: "image/png" },
        })
      },
    ],
    [
      "protected addition",
      (q: NativeBlock[]) => {
        q.push({ type: "text", text: "protected" })
      },
    ],
    [
      "missing result",
      (q: NativeBlock[]) => {
        q.pop()
      },
    ],
  ])("forwards %s unchanged with bounded diagnostics", (_name, mutate) => {
    const queried = structuredClone(host)
    mutate(queried)
    const diagnostic = vi.fn()
    expect(restoreQueriedResults(queried, host, diagnostic)).toBe(queried)
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith("tool_result_mismatch")
  })
  it("preserves equal media, metadata and marks without laundering", () => {
    const media = [
      {
        type: "tool_result",
        tool_use_id: "a",
        is_error: false,
        cache_control: { type: "ephemeral", ttl: "1h" },
        content: [
          { type: "text", text: "protected", citations: [] },
          {
            type: "image",
            source: { type: "base64", data: "AAAA", media_type: "image/png" },
          },
        ],
      },
    ]
    expect(restoreQueriedResults(structuredClone(media), media)).toEqual(media)
    const changed = structuredClone(media)
    changed[0].content[1].source!.data = "BBBB"
    expect(restoreQueriedResults(changed, media)).toBe(changed)
  })
})

describe("conservative cache wire seam", () => {
  it("restores provable scalar results without touching system or tool marks", () => {
    const body = {
      model: "claude-sonnet-4-6",
      system: [
        {
          type: "text",
          text: "identity",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      tools: [{ name: "read", cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: host.map((b) => ({ ...b, content: b.content[0].text })),
        },
      ],
    }
    const output = JSON.parse(
      transformCacheWire(
        Buffer.from(JSON.stringify(body)),
        frame(host)
      ).toString()
    )
    expect(output.system).toEqual(body.system)
    expect(output.tools).toEqual(body.tools)
    expect(output.messages[0].content).toEqual(host)
  })
  it.each([
    ["cold first turn", [{ type: "text", text: "question" }]],
    ["parallel results", host],
    [
      "edited result",
      [{ ...host[0], content: [{ type: "text", text: "edited" }] }],
    ],
    [
      "media result",
      [
        {
          ...host[0],
          content: [
            {
              type: "image",
              source: { type: "base64", data: "AAAA", media_type: "image/png" },
            },
          ],
        },
      ],
    ],
  ])("keeps exact %s bytes stable", (_name, content) => {
    const raw = Buffer.from(
      JSON.stringify({ messages: [{ role: "user", content }] }, null, 2)
    )
    expect(transformCacheWire(raw, frame(content as NativeBlock[]))).toBe(raw)
  })
  it.each([
    {},
    { messages: [{ role: "user", content: "unknown" }] },
    {
      messages: [
        {
          role: "user",
          content: [
            ...host,
            { type: "thinking", thinking: "protected", signature: "opaque" },
          ],
        },
      ],
    },
    {
      messages: [
        {
          role: "user",
          content: host.map((b) => ({
            ...b,
            cache_control: { type: "ephemeral", ttl: "1h" },
          })),
        },
      ],
    },
  ])("does not relocate marks or remove unknown additions", (body) => {
    const raw = Buffer.from(JSON.stringify(body))
    const diagnostic = vi.fn()
    expect(transformCacheWire(raw, frame(host), diagnostic)).toBe(raw)
    expect(diagnostic).toHaveBeenCalledTimes(1)
  })
})

import { describe, expect, it } from "vitest"
import {
  MESSAGE_OVERHEAD_TOKENS,
  measureRequest,
  measureResponse,
} from "./request-size"

const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
]

function transcript(): any[] {
  return [
    { role: "system", content: "You are a careful coding agent." },
    { role: "user", content: "Summarize README.md for me." },
    {
      role: "assistant",
      content: "Let me read it.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"README.md"}' },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_1",
      content: "# Project\n\n".concat(
        "Long line of documentation. ".repeat(80)
      ),
    },
  ]
}

describe("measureRequest", () => {
  it("sums the role breakdown, tool definitions, and per-message overhead", () => {
    const messages = transcript()
    const size = measureRequest(messages, tools)
    const roles =
      size.byRole.system +
      size.byRole.user +
      size.byRole.assistant +
      size.byRole.tool
    expect(size.messageCount).toBe(4)
    expect(size.toolDefs).toBeGreaterThan(0)
    expect(size.total).toBe(
      roles + size.toolDefs + messages.length * MESSAGE_OVERHEAD_TOKENS
    )
    for (const role of ["system", "user", "assistant", "tool"] as const) {
      expect(size.byRole[role]).toBeGreaterThan(0)
    }
  })

  it("names the tool behind the largest tool result", () => {
    const size = measureRequest(transcript(), tools)
    expect(size.largestMessage).toEqual({
      role: "tool",
      toolName: "read_file",
      tokens: size.byRole.tool,
    })
  })

  it("counts assistant tool-call names and arguments", () => {
    const bare = measureRequest([{ role: "assistant", content: "Reading." }])
    const withCall = measureRequest([
      {
        role: "assistant",
        content: "Reading.",
        tool_calls: [
          {
            id: "c",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "src/a/very/long/path.ts" }),
            },
          },
        ],
      },
    ])
    expect(withCall.byRole.assistant).toBeGreaterThan(bare.byRole.assistant)
  })

  it("is stable across repeated calls and appended messages", () => {
    const messages = transcript()
    const first = measureRequest(messages, tools)
    expect(measureRequest(messages, tools)).toEqual(first)
    messages.push({ role: "user", content: "Thanks!" })
    const grown = measureRequest(messages, tools)
    expect(grown.byRole.user).toBeGreaterThan(first.byRole.user)
    expect(grown.byRole.tool).toBe(first.byRole.tool)
  })

  it("counts array content parts and tolerates special-token text", () => {
    const size = measureRequest([
      {
        role: "user",
        content: [{ type: "text", text: "a file with <|endoftext|> inside" }],
      },
    ])
    expect(size.byRole.user).toBeGreaterThan(0)
  })

  it("buckets developer messages with system", () => {
    const size = measureRequest([{ role: "developer", content: "Be brief." }])
    expect(size.byRole.system).toBeGreaterThan(0)
  })
})

describe("measureResponse", () => {
  it("counts text plus tool-call names and arguments", () => {
    const text = measureResponse("Done.", [])
    const both = measureResponse("Done.", [
      { name: "read_file", arguments: '{"path":"README.md"}' },
    ])
    expect(text).toBeGreaterThan(0)
    expect(both).toBeGreaterThan(text)
  })

  it("gives 0 for an empty response", () => {
    expect(measureResponse("", [])).toBe(0)
  })
})

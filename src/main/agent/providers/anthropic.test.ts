import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildAnthropicClient,
  contextWindowFor,
  ContextOverflowError,
  effortLevels,
  translateRequest,
} from "./anthropic"
import { isTransientError } from "./index"
import { nativeAssistant } from "./native-carrier"
import { accumulateToolCalls } from "../tool-stream"

const model = "claude-opus-5-5"
const tool = (name: string) => ({
  type: "function",
  function: {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
})
const call = (id: string, path: string) => ({
  id,
  type: "function",
  function: { name: "read", arguments: JSON.stringify({ path }) },
})

// Recorded-shape Messages API stream for one thinking + text + tool_use round.
function sse(events: Array<Record<string, any>>): string {
  return events
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("")
}
function round(
  stop: string,
  content: Array<Record<string, any>> = [],
  extra: Record<string, any> = {}
) {
  return sse([
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          cache_read_input_tokens: 90,
          cache_creation_input_tokens: 5,
        },
        input_transformations: [],
        ...extra,
      },
    },
    ...content,
    {
      type: "message_delta",
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 20 },
    },
    { type: "message_stop" },
  ])
}
const thinkingTextTool = [
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "", signature: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "plan" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "signature_delta", signature: "sig" },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: "Reading." },
  },
  { type: "content_block_stop", index: 1 },
  {
    type: "content_block_start",
    index: 2,
    content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
  },
  {
    type: "content_block_delta",
    index: 2,
    delta: { type: "input_json_delta", partial_json: '{"path":' },
  },
  {
    type: "content_block_delta",
    index: 2,
    delta: { type: "input_json_delta", partial_json: '"a"}' },
  },
  { type: "content_block_stop", index: 2 },
  {
    type: "content_block_start",
    index: 3,
    content_block: { type: "tool_use", id: "toolu_2", name: "list", input: {} },
  },
  { type: "content_block_stop", index: 3 },
]

const info = {
  type: "model",
  id: model,
  display_name: "Claude Opus 5.5",
  created_at: "2026-09-01T00:00:00Z",
  max_input_tokens: 1000000,
  max_tokens: 128000,
  capabilities: {
    thinking: { supported: true, types: { adaptive: { supported: true } } },
    effort: { supported: true },
  },
}

// The SDK captures fetch at construction, so one stub delegates to whatever
// `serve` set last: model lookups get `info`; messages get the handler.
let respond: () => Response = () => new Response(null, { status: 500 })
const requests: Array<{ url: string; body: any; headers: Headers }> = []
beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      requests.push({
        url: String(url),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        headers: new Headers(init.headers),
      })
      if (String(url).includes("/v1/models"))
        return new Response(JSON.stringify(info), {
          headers: { "content-type": "application/json" },
        })
      return respond()
    })
  )
)
function serve(messages: () => Response) {
  respond = messages
  requests.length = 0
  return requests
}
const stream = (body: string) => () =>
  new Response(body, { headers: { "content-type": "text/event-stream" } })
const failure = (status: number, type: string, message: string) => () =>
  new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  })

async function collect(result: unknown) {
  const chunks: any[] = []
  for await (const chunk of result as AsyncIterable<any>) chunks.push(chunk)
  return chunks
}

afterEach(() => vi.unstubAllGlobals())

describe("translateRequest", () => {
  it("maps system, tools, images and parallel tool results", () => {
    const { params } = translateRequest(
      {
        model,
        max_tokens: 64000,
        tools: [tool("read")],
        tool_choice: "none",
        messages: [
          { role: "system", content: "Be brief." },
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,AAAA" },
              },
            ],
          },
          {
            role: "assistant",
            content: "",
            tool_calls: [call("t1", "a"), call("t2", "b")],
          },
          { role: "tool", tool_call_id: "t1", content: "A" },
          { role: "tool", tool_call_id: "t2", content: "B" },
          { role: "system", content: "Plan mode is on." },
        ],
      },
      info as any
    )
    expect(params.system).toEqual([
      { type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } },
    ])
    expect(params.tools).toEqual([
      {
        name: "read",
        description: "read tool",
        input_schema: tool("read").function.parameters,
      },
    ])
    expect(params.tool_choice).toEqual({ type: "none" })
    expect(params.messages[0].content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    })
    expect(params.messages[1].content.map((b: any) => b.id)).toEqual([
      "t1",
      "t2",
    ])
    // Both results, then the demoted mid-history system text, in ONE user message.
    expect(params.messages).toHaveLength(3)
    expect(params.messages[2].content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: [{ type: "text", text: "A" }],
      },
      {
        type: "tool_result",
        tool_use_id: "t2",
        content: [{ type: "text", text: "B" }],
      },
      {
        type: "text",
        text: "Plan mode is on.",
        cache_control: { type: "ephemeral" },
      },
    ])
    expect(params.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    })
    expect(params.betas).toEqual(["thinking-binding-controls-2026-08-01"])
    // No pick: medium, whatever the model's own default.
    expect(params.output_config).toEqual({ effort: "medium" })
    expect(JSON.stringify(params)).not.toContain("budget_tokens")
  })

  it("sends the composer's effort only when the model lists that level", () => {
    const levelled = {
      ...info,
      capabilities: {
        ...info.capabilities,
        effort: {
          supported: true,
          low: { supported: true },
          high: { supported: true },
          max: { supported: false },
        },
      },
    } as any
    expect(effortLevels(levelled)).toEqual(["low", "high"])
    // Level names come from the API, not a fixed list.
    expect(
      effortLevels({
        capabilities: {
          effort: {
            supported: true,
            medium: { supported: true },
            ultra: { supported: true },
          },
        },
      } as any)
    ).toEqual(["medium", "ultra"])
    const body = (reasoning_effort: string) => ({
      model,
      max_tokens: 64000,
      reasoning_effort,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(
      translateRequest(body("low"), levelled).params.output_config
    ).toEqual({ effort: "low" })
    // Unlisted for this model: falls back to the default.
    expect(
      translateRequest(body("max"), levelled).params.output_config
    ).toEqual({ effort: "high" })
  })

  it("never forces a tool and skips thinking where adaptive is unsupported", () => {
    const { params } = translateRequest(
      {
        model: "claude-haiku-4-5",
        max_tokens: 200,
        tools: [tool("read")],
        tool_choice: { type: "function", function: { name: "read" } },
        messages: [{ role: "user", content: "hi" }],
      },
      {
        ...info,
        capabilities: {
          thinking: {
            supported: true,
            types: { adaptive: { supported: false } },
          },
          effort: { supported: false },
        },
      } as any
    )
    expect(params.tool_choice).toBeUndefined()
    expect(params.thinking).toBeUndefined()
    expect(params.betas).toBeUndefined()
    expect(params.output_config).toBeUndefined()
  })
})

describe("thinking replay", () => {
  const first = {
    model,
    max_tokens: 64000,
    tools: [tool("read")],
    messages: [
      { role: "system", content: "S" },
      { role: "user", content: "go" },
    ],
  }
  const blocks = [
    { type: "thinking", thinking: "plan", signature: "sig" },
    { type: "text", text: "Reading." },
    { type: "tool_use", id: "t1", name: "read", input: { path: "a" } },
  ]
  const followUp = (body: typeof first) => {
    const carrier = {
      version: 1,
      provider: "anthropic",
      model,
      prefix: translateRequest(first, info as any).prefix,
      blocks,
    }
    return translateRequest(
      {
        ...body,
        messages: [
          ...body.messages,
          {
            role: "assistant",
            content: "Reading.",
            tool_calls: [call("t1", "a")],
            [nativeAssistant]: carrier,
          },
          { role: "tool", tool_call_id: "t1", content: "A" },
        ],
      },
      info as any
    ).params.messages[1].content
  }

  it("replays blocks verbatim over an unchanged prefix", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    expect(followUp(first)).toEqual(blocks)
    expect(info).not.toHaveBeenCalled()
    info.mockRestore()
  })

  it("strips thinking when system, tools or an earlier message changed", () => {
    const changed = [
      {
        ...first,
        messages: [{ role: "system", content: "S2" }, first.messages[1]],
      },
      { ...first, tools: [tool("read"), tool("list")] },
      {
        ...first,
        messages: [first.messages[0], { role: "user", content: "go!" }],
      },
    ]
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    for (const body of changed) expect(followUp(body)).toEqual(blocks.slice(1))
    expect(info).toHaveBeenCalledTimes(3)
    expect(info).toHaveBeenCalledWith("[anthropic] thinking not replayed", {
      model,
      prefix: 1,
    })
    info.mockRestore()
  })
})

describe("buildAnthropicClient", () => {
  const client = () =>
    buildAnthropicClient({ accountId: "acct", apiKey: "test", baseUrl: null })
  const body = {
    model,
    max_tokens: 64000,
    stream: true,
    tools: [tool("read"), tool("list")],
    messages: [
      { role: "system", content: "S" },
      { role: "user", content: "go" },
    ],
  }

  it("reports server-side tool-result clearing in usage (plan 118)", async () => {
    const cleared = round("end_turn").replace(
      '"delta":{"stop_reason":"end_turn","stop_sequence":null}',
      '"delta":{"stop_reason":"end_turn","stop_sequence":null},"context_management":{"applied_edits":[{"type":"clear_tool_uses_20250919","cleared_input_tokens":42000,"cleared_tool_uses":6}]}'
    )
    expect(cleared).toContain("applied_edits")
    serve(stream(cleared))
    const chunks = await collect(
      await client().chat.completions.create(body, undefined, {})
    )
    expect(chunks.at(-1).usage).toMatchObject({
      prompt_tokens: 105,
      context_cleared: { input_tokens: 42000, tool_uses: 6 },
    })
  })

  it("reports no clearing when none was applied", async () => {
    serve(stream(round("end_turn")))
    const chunks = await collect(
      await client().chat.completions.create(body, undefined, {})
    )
    expect(chunks.at(-1).usage.context_cleared).toBeUndefined()
  })

  it("maps a streamed round to chat-completion chunks with a replayable carrier", async () => {
    const requests = serve(stream(round("tool_use", thinkingTextTool)))
    const c = client()
    const chunks = await collect(
      await c.chat.completions.create(body, undefined, {})
    )
    const deltas = chunks.map((c) => c.choices[0].delta)
    expect(deltas.map((d) => d.content ?? "").join("")).toBe("Reading.")
    expect(deltas.map((d) => d.reasoning_content ?? "").join("")).toBe("plan")
    expect(
      accumulateToolCalls(deltas.flatMap((d) => d.tool_calls ?? []))
    ).toEqual([
      { id: "toolu_1", name: "read", arguments: '{"path":"a"}' },
      { id: "toolu_2", name: "list", arguments: "{}" },
    ])
    const last = chunks.at(-1)
    expect(last.choices[0].finish_reason).toBe("tool_calls")
    expect(last.usage).toEqual({
      prompt_tokens: 105,
      completion_tokens: 20,
      total_tokens: 125,
      prompt_tokens_details: { cached_tokens: 90, cache_creation_tokens: 5 },
    })
    const carrier = last.choices[0].delta[nativeAssistant]
    expect(carrier.provider).toBe("anthropic")
    expect(carrier.blocks[0]).toEqual({
      type: "thinking",
      thinking: "plan",
      signature: "sig",
    })

    const sent = requests.find((r) => r.url.includes("/v1/messages"))!
    expect(sent.headers.get("anthropic-beta")).toContain(
      "thinking-binding-controls-2026-08-01"
    )
    expect(sent.body.max_tokens).toBe(64000)
    expect(contextWindowFor("acct", model)).toBe(1000000)
  })

  it("replays the carrier on the following round's request", async () => {
    serve(stream(round("tool_use", thinkingTextTool)))
    const c = client()
    const chunks = await collect(
      await c.chat.completions.create(body, undefined, {})
    )
    const carrier = chunks.at(-1).choices[0].delta[nativeAssistant]
    const requests = serve(stream(round("end_turn")))
    await collect(
      await c.chat.completions.create(
        {
          ...body,
          messages: [
            ...body.messages,
            {
              role: "assistant",
              content: "Reading.",
              tool_calls: [
                call("toolu_1", "a"),
                {
                  id: "toolu_2",
                  type: "function",
                  function: { name: "list", arguments: "{}" },
                },
              ],
              [nativeAssistant]: carrier,
            },
            { role: "tool", tool_call_id: "toolu_1", content: "A" },
            { role: "tool", tool_call_id: "toolu_2", content: "B" },
          ],
        },
        undefined,
        {}
      )
    )
    const sent = requests.find((r) => r.url.includes("/v1/messages"))!.body
    expect(sent.messages[1].content[0]).toEqual({
      type: "thinking",
      thinking: "plan",
      signature: "sig",
    })
    // A rebuilt system prompt on the next turn drops thinking instead of 400ing.
    const rebuilt = serve(stream(round("end_turn")))
    await collect(
      await c.chat.completions.create(
        {
          ...body,
          messages: [
            { role: "system", content: "S, rebuilt" },
            ...body.messages.slice(1),
            {
              role: "assistant",
              content: "Reading.",
              tool_calls: [
                call("toolu_1", "a"),
                {
                  id: "toolu_2",
                  type: "function",
                  function: { name: "list", arguments: "{}" },
                },
              ],
              [nativeAssistant]: carrier,
            },
            { role: "tool", tool_call_id: "toolu_1", content: "A" },
            { role: "tool", tool_call_id: "toolu_2", content: "B" },
          ],
        },
        undefined,
        {}
      )
    )
    const resent = rebuilt.find((r) => r.url.includes("/v1/messages"))!.body
    expect(
      resent.messages[1].content.some((b: any) => b.type === "thinking")
    ).toBe(false)
  })

  it("maps stop reasons; overflow is never `length`", async () => {
    serve(stream(round("max_tokens")))
    let chunks = await collect(
      await client().chat.completions.create(body, undefined, {})
    )
    expect(chunks.at(-1).choices[0].finish_reason).toBe("length")

    serve(stream(round("refusal", [], { stop_details: null })))
    chunks = await collect(
      await client().chat.completions.create(body, undefined, {})
    )
    expect(chunks.at(-1).choices[0]).toMatchObject({
      finish_reason: "refusal",
      delta: { refusal: "Claude declined the request." },
    })

    serve(stream(round("model_context_window_exceeded")))
    await expect(
      collect(await client().chat.completions.create(body, undefined, {}))
    ).rejects.toBeInstanceOf(ContextOverflowError)

    serve(stream(round("pause_turn")))
    await expect(
      collect(await client().chat.completions.create(body, undefined, {}))
    ).rejects.toThrow(/pause_turn/)
  })

  it("returns a chat completion for non-streaming callers", async () => {
    serve(
      stream(
        round(
          "end_turn",
          thinkingTextTool.slice(4, 7).map((e) => ({ ...e, index: 0 }))
        )
      )
    )
    const res: any = await client().chat.completions.create(
      { ...body, stream: false },
      undefined,
      {}
    )
    expect(res.choices[0]).toMatchObject({
      finish_reason: "stop",
      message: { role: "assistant", content: "Reading." },
    })
  })

  it("classifies errors for the retry coordinator", async () => {
    const outcome = async (respond: () => Response) => {
      serve(respond)
      return (
        client().chat.completions.create(
          body,
          undefined,
          {}
        ) as Promise<unknown>
      )
        .then(collect)
        .then(
          () => "ok",
          (e: unknown) => e
        )
    }
    for (const [status, type] of [
      [429, "rate_limit_error"],
      [500, "api_error"],
      [529, "overloaded_error"],
    ] as const)
      expect(isTransientError(await outcome(failure(status, type, "x")))).toBe(
        true
      )
    const long = await outcome(
      failure(
        400,
        "invalid_request_error",
        "prompt is too long: 1200000 tokens > 1000000 maximum"
      )
    )
    expect(long).toBeInstanceOf(ContextOverflowError)
    expect(isTransientError(long)).toBe(false)
    expect(
      await outcome(
        failure(413, "request_too_large", "Request exceeds the maximum size")
      )
    ).toBeInstanceOf(ContextOverflowError)
    const auth = await outcome(
      failure(401, "authentication_error", "invalid x-api-key")
    )
    expect(auth).not.toBeInstanceOf(ContextOverflowError)
    expect(isTransientError(auth)).toBe(false)

    // A mid-stream overload event carries no HTTP status of its own.
    const midStream = await outcome(
      stream(
        sse([
          {
            type: "message_start",
            message: {
              id: "m",
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
          {
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
          },
        ])
      )
    )
    expect(isTransientError(midStream)).toBe(true)
  })

  it("imports models into the context-window catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                { ...info, id: "claude-sonnet-5-5", max_input_tokens: 500000 },
              ],
              has_more: false,
              first_id: "claude-sonnet-5-5",
              last_id: "claude-sonnet-5-5",
            }),
            { headers: { "content-type": "application/json" } }
          )
      )
    )
    const res = await buildAnthropicClient({
      accountId: "import",
      apiKey: "test",
      baseUrl: null,
    }).models.list()
    expect(res?.data?.map((m) => m.id)).toEqual(["claude-sonnet-5-5"])
    expect(contextWindowFor("import", "claude-sonnet-5-5")).toBe(500000)
  })
})

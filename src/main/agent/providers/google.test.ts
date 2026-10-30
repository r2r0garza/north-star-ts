import { afterEach, describe, expect, it, vi } from "vitest"
import {
  buildGoogleClient,
  chunks,
  googleContextWindowFor,
  sanitizeSchema,
  translateRequest,
} from "./google"
import { ContextOverflowError } from "./anthropic"
import { isTransientError } from "./index"
import { nativeAssistant } from "./native-carrier"
import { builtInTools } from "../tools"
import { withToolActivity } from "../../../shared/tool-activity"
import { accumulateToolCalls } from "../tool-stream"
import { retryAfterMs } from "../model-request-retry"

const model = "gemini-3-pro"
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

// Recorded-shape Interactions SSE events for one thought + text + call round.
function round(status = "requires_action", usage?: Record<string, number>) {
  return [
    { event_type: "interaction.created", interaction: { id: "i1" } },
    { event_type: "step.start", index: 0, step: { type: "thought" } },
    {
      event_type: "step.delta",
      index: 0,
      delta: {
        type: "thought_summary",
        content: { type: "text", text: "Plan." },
      },
    },
    {
      event_type: "step.delta",
      index: 0,
      delta: { type: "thought_signature", signature: "sig-1" },
    },
    { event_type: "step.stop", index: 0 },
    { event_type: "step.start", index: 1, step: { type: "model_output" } },
    {
      event_type: "step.delta",
      index: 1,
      delta: { type: "text", text: "Read" },
    },
    {
      event_type: "step.delta",
      index: 1,
      delta: { type: "text", text: "ing." },
    },
    { event_type: "step.stop", index: 1 },
    {
      event_type: "step.start",
      index: 2,
      step: { type: "function_call", id: "c1", name: "read", arguments: {} },
    },
    {
      event_type: "step.delta",
      index: 2,
      delta: { type: "arguments_delta", arguments: '{"path":' },
    },
    {
      event_type: "step.delta",
      index: 2,
      delta: { type: "arguments_delta", arguments: '"a.ts"}' },
    },
    { event_type: "step.stop", index: 2 },
    {
      event_type: "step.start",
      index: 3,
      step: {
        type: "function_call",
        id: "c2",
        name: "read",
        arguments: { path: "b.ts" },
      },
    },
    { event_type: "step.stop", index: 3 },
    {
      event_type: "interaction.completed",
      interaction: {
        id: "i1",
        status,
        usage: usage ?? {
          total_input_tokens: 100,
          total_output_tokens: 20,
          total_thought_tokens: 30,
          total_cached_tokens: 40,
          total_tokens: 150,
        },
      },
    },
  ]
}

async function collect(events: any[]) {
  async function* source() {
    yield* events
  }
  const out: any[] = []
  for await (const c of chunks(source(), model, "a".repeat(64))) out.push(c)
  return out
}

describe("translateRequest", () => {
  it("maps system, tools, images, parallel results and tool_choice none", () => {
    const { params } = translateRequest(
      {
        model,
        max_tokens: 8000,
        tool_choice: "none",
        tools: [tool("read")],
        messages: [
          { role: "system", content: "Be brief." },
          {
            role: "user",
            content: [
              { type: "text", text: "Look" },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,AAAA" },
              },
            ],
          },
          {
            role: "assistant",
            content: "",
            tool_calls: [call("c1", "a.ts"), call("c2", "b.ts")],
          },
          { role: "tool", tool_call_id: "c1", content: "A" },
          { role: "tool", tool_call_id: "c2", content: "B" },
        ],
      },
      { outputTokenLimit: 4000, thinking: true }
    )
    expect(params).toMatchObject({
      model,
      store: false,
      system_instruction: "Be brief.",
      tools: [{ type: "function", name: "read" }],
      generation_config: {
        max_output_tokens: 4000,
        tool_choice: "none",
        thinking_summaries: "auto",
      },
    })
    expect(params.input).toEqual([
      {
        type: "user_input",
        content: [
          { type: "text", text: "Look" },
          { type: "image", mime_type: "image/png", data: "AAAA" },
        ],
      },
      {
        type: "function_call",
        id: "c1",
        name: "read",
        arguments: { path: "a.ts" },
      },
      {
        type: "function_call",
        id: "c2",
        name: "read",
        arguments: { path: "b.ts" },
      },
      { type: "function_result", call_id: "c1", name: "read", result: "A" },
      { type: "function_result", call_id: "c2", name: "read", result: "B" },
    ])
  })

  it("thinks low on small auxiliary caps and omits tool_choice by default", () => {
    const { params } = translateRequest(
      { model, max_tokens: 64, messages: [{ role: "user", content: "t" }] },
      { thinking: true }
    )
    expect(params.generation_config).toEqual({
      max_output_tokens: 64,
      thinking_summaries: "auto",
      thinking_level: "low",
    })
  })
})

describe("sanitizeSchema", () => {
  const allowed = new Set([
    "type",
    "format",
    "description",
    "nullable",
    "enum",
    "items",
    "properties",
    "required",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
    "minLength",
    "maxLength",
    "pattern",
    "minimum",
    "maximum",
    "anyOf",
    "title",
    "default",
  ])
  const disallowed = (schema: any, path = "$"): string[] =>
    !schema || typeof schema !== "object"
      ? []
      : Object.entries(schema).flatMap(([k, v]) =>
          k === "properties"
            ? Object.entries(v as object).flatMap(([n, p]) =>
                disallowed(p, `${path}.${n}`)
              )
            : [
                ...(allowed.has(k) ? [] : [`${path}.${k}`]),
                ...(k === "items" ? disallowed(v, `${path}[]`) : []),
                ...(k === "anyOf"
                  ? (v as any[]).flatMap((s, i) =>
                      disallowed(s, `${path}|${i}`)
                    )
                  : []),
              ]
        )

  it("leaves every built-in tool schema inside Gemini's subset", () => {
    for (const t of builtInTools) {
      const definition = withToolActivity(t.definition)
      const out = sanitizeSchema(definition.function.parameters)
      expect(disallowed(out), definition.function.name).toEqual([])
      expect(out.type, definition.function.name).toBe("object")
    }
  })

  it("rewrites oneOf, const, nullable types and inlines local refs", () => {
    expect(
      sanitizeSchema({
        type: "object",
        additionalProperties: false,
        $defs: {
          Node: {
            type: "object",
            properties: { child: { $ref: "#/$defs/Node" } },
          },
        },
        properties: {
          mode: { oneOf: [{ const: "a" }, { type: ["string", "null"] }] },
          node: { $ref: "#/$defs/Node" },
          ids: { type: "array", uniqueItems: true, items: { type: "string" } },
        },
        required: ["mode", "missing"],
      })
    ).toEqual({
      type: "object",
      properties: {
        mode: { anyOf: [{ enum: ["a"] }, { nullable: true, type: "string" }] },
        node: {
          type: "object",
          properties: { child: { type: "object" } },
        },
        ids: { type: "array", items: { type: "string" } },
      },
      required: ["mode"],
    })
  })
})

describe("stream mapping", () => {
  it("maps thoughts, text, parallel calls and usage to chat chunks", async () => {
    const out = await collect(round())
    const deltas = out.map((c) => c.choices[0].delta)
    expect(deltas.map((d) => d.reasoning_content).filter(Boolean)).toEqual([
      "Plan.",
    ])
    expect(
      deltas
        .map((d) => d.content)
        .filter(Boolean)
        .join("")
    ).toBe("Reading.")
    const calls = accumulateToolCalls(deltas.flatMap((d) => d.tool_calls ?? []))
    expect(
      calls.map((c: any) => [c.id, c.name, JSON.parse(c.arguments)])
    ).toEqual([
      ["c1", "read", { path: "a.ts" }],
      ["c2", "read", { path: "b.ts" }],
    ])
    const last = out.at(-1)
    expect(last.choices[0].finish_reason).toBe("tool_calls")
    expect(last.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 40 },
    })
    expect(last.choices[0].delta[nativeAssistant].blocks).toEqual([
      { type: "thinking", thinking: "Plan.", signature: "sig-1" },
      { type: "text", text: "Reading." },
      { type: "tool_use", id: "c1", name: "read", input: { path: "a.ts" } },
      { type: "tool_use", id: "c2", name: "read", input: { path: "b.ts" } },
    ])
  })

  it("maps completion statuses; output caps are length, blocks are refusals", async () => {
    const finishOf = async (interaction: Record<string, any>) =>
      (
        await collect([
          {
            event_type: "interaction.completed",
            interaction: { id: "i", ...interaction },
          },
        ])
      ).at(-1).choices[0]
    expect((await finishOf({ status: "completed" })).finish_reason).toBe("stop")
    expect((await finishOf({ status: "incomplete" })).finish_reason).toBe(
      "length"
    )
    const refused = await finishOf({
      status: "failed",
      errors: [{ message: "Blocked for safety." }],
    })
    expect(refused.finish_reason).toBe("refusal")
    expect(refused.delta.refusal).toBe("Blocked for safety.")
    await expect(
      finishOf({ status: "failed", errors: [{ message: "boom" }] })
    ).rejects.toThrow(/failed: boom/)
  })

  it("classifies mid-stream error events for the retry coordinator", async () => {
    const fail = (error: Record<string, string>) =>
      collect([{ event_type: "error", error }]).catch((e) => e)
    expect(
      isTransientError(await fail({ code: "RESOURCE_EXHAUSTED", message: "x" }))
    ).toBe(true)
    expect(
      isTransientError(await fail({ code: "UNAVAILABLE", message: "x" }))
    ).toBe(true)
    expect(
      isTransientError(await fail({ code: "PERMISSION_DENIED", message: "x" }))
    ).toBe(false)
    expect(
      await fail({
        code: "INVALID_ARGUMENT",
        message:
          "The input token count (2000000) exceeds the maximum number of tokens allowed (1048576).",
      })
    ).toBeInstanceOf(ContextOverflowError)
  })
})

describe("thought replay", () => {
  it("replays stored thoughts byte-identical on the next round", async () => {
    const out = await collect(round())
    const carrier = out.at(-1).choices[0].delta[nativeAssistant]
    const assistant = {
      role: "assistant",
      content: "Reading.",
      tool_calls: [call("c1", "a.ts"), call("c2", "b.ts")],
      [nativeAssistant]: carrier,
    }
    // A different model and system prompt still replay: Google requires it.
    const { params } = translateRequest({
      model: "gemini-3-flash",
      max_tokens: 8000,
      messages: [
        { role: "system", content: "changed" },
        { role: "user", content: "go" },
        assistant,
      ],
    })
    expect(params.input.slice(1)).toEqual([
      {
        type: "thought",
        signature: "sig-1",
        summary: [{ type: "text", text: "Plan." }],
      },
      { type: "model_output", content: [{ type: "text", text: "Reading." }] },
      {
        type: "function_call",
        id: "c1",
        name: "read",
        arguments: { path: "a.ts" },
      },
      {
        type: "function_call",
        id: "c2",
        name: "read",
        arguments: { path: "b.ts" },
      },
    ])
    // Edited visible content falls back to canonical steps without thoughts.
    const edited = translateRequest({
      model,
      max_tokens: 8000,
      messages: [
        { role: "user", content: "go" },
        { ...assistant, content: "x" },
      ],
    })
    expect(edited.params.input.some((s: any) => s.type === "thought")).toBe(
      false
    )
  })
})

describe("buildGoogleClient", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("surfaces HTTP errors with a status the retry coordinator reads", async () => {
    const fetch = vi.fn(async (input: any) => {
      const url = String(input?.url ?? input)
      if (url.includes("/models/"))
        return Response.json({ name: `models/${model}`, thinking: true })
      return Response.json(
        {
          error: { code: 429, message: "Quota", status: "RESOURCE_EXHAUSTED" },
        },
        { status: 429 }
      )
    })
    vi.stubGlobal("fetch", fetch)
    const client = buildGoogleClient({
      accountId: "g1",
      apiKey: "test-key",
      baseUrl: null,
    })
    const error = await (
      client.chat.completions.create({
        model,
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }) as Promise<unknown>
    ).catch((e) => e)
    expect(isTransientError(error)).toBe(true)
    // One attempt only: the agent loop owns retries.
    expect(
      fetch.mock.calls.filter(([input]) =>
        String((input as any)?.url ?? input).includes("interactions")
      )
    ).toHaveLength(1)
  })

  it("waits the retry delay Gemini advises in the error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: 429,
              message: "Your project has exceeded a quota.",
              status: "RESOURCE_EXHAUSTED",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.RetryInfo",
                  retryDelay: "34s",
                },
              ],
            },
          },
          { status: 429 }
        )
      )
    )
    const client = buildGoogleClient({
      accountId: "g3",
      apiKey: "test-key",
      baseUrl: null,
    })
    const error = await (
      client.chat.completions.create({
        model,
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }) as Promise<unknown>
    ).catch((e) => e)
    expect(isTransientError(error)).toBe(true)
    expect(retryAfterMs(error)).toBe(34_000)
    expect((error as Error).message).toMatch(/exceeded a quota/)
  })

  it("imports generation models into the context-window catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          models: [
            {
              name: `models/${model}`,
              inputTokenLimit: 1048576,
              supportedGenerationMethods: ["generateContent"],
            },
            {
              name: "models/embedding-001",
              supportedGenerationMethods: ["embedContent"],
            },
          ],
        })
      )
    )
    const client = buildGoogleClient({
      accountId: "g2",
      apiKey: "test-key",
      baseUrl: null,
    })
    const listed = await client.models.list()
    expect(listed?.data?.map((m) => m.id)).toEqual([model])
    // The full model rides along for the dev "Log models response" button.
    expect(listed?.data?.[0]).toMatchObject({ inputTokenLimit: 1048576 })
    expect(googleContextWindowFor("g2", model)).toBe(1048576)
  })
})

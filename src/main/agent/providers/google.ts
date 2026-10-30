import { GoogleGenAI } from "@google/genai"
import {
  historyFingerprint,
  nativeAssistant,
  replayCarrier,
  validateCarrier,
} from "./native-carrier"
import { replayToolCallArguments } from "../tool-call-arguments"
import { ContextOverflowError } from "./anthropic"
import type { LlmClient } from "./index"

// The Google API provider (plan 123). The agent loop speaks chat-completions;
// this adapter translates each request into a stateless Interactions API call
// (`store: false`, GA since mid-2026) on the official SDK and maps the response
// and its SSE events back into chat-completion chunks.
//
// Thought replay: Google requires thought steps and their signatures to be
// resent unaltered in stateless mode, even after a model switch, so a stored
// carrier is replayed whenever the assistant's visible text and tool calls
// still match it. Its prefix fingerprint is kept for plan 118's compaction.

type Step = Record<string, any>
type Block = Record<string, any>
type ModelInfo = {
  inputTokenLimit?: number
  outputTokenLimit?: number
  thinking?: boolean
}

// Per-account model catalog, filled by models.list (import) and lazily by
// models.get on first use.
const catalogs = new Map<string, Map<string, ModelInfo>>()

export function googleContextWindowFor(
  accountId: string,
  modelId: string
): number | null {
  return catalogs.get(accountId)?.get(modelId)?.inputTokenLimit ?? null
}

function text(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("")
}

// Chat-completions content → Interactions content. Empty text is dropped;
// images become inline data or a URI.
function contents(content: unknown): Block[] {
  if (typeof content === "string")
    return content ? [{ type: "text", text: content }] : []
  if (!Array.isArray(content)) return []
  return content.flatMap((p): Block[] => {
    if (p?.type === "text" && typeof p.text === "string" && p.text)
      return [{ type: "text", text: p.text }]
    if (p?.type === "image_url" && typeof p.image_url?.url === "string") {
      const data = /^data:([^;]+);base64,(.*)$/s.exec(p.image_url.url)
      return [
        data
          ? { type: "image", mime_type: data[1], data: data[2] }
          : { type: "image", uri: p.image_url.url },
      ]
    }
    return []
  })
}

// Gemini accepts an OpenAPI-style subset of JSON Schema. Keep that subset,
// rewrite the close equivalents and inline local $refs (MCP servers emit them).
const SCHEMA_KEYS = new Set([
  "type",
  "format",
  "description",
  "nullable",
  "enum",
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
  "title",
  "default",
])

export function sanitizeSchema(
  schema: unknown,
  root: any = schema,
  expanding: ReadonlySet<string> = new Set()
): Record<string, any> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {}
  const s = schema as Record<string, any>
  if (typeof s.$ref === "string") {
    const ref = /^#\/(\$defs|definitions)\/(.+)$/.exec(s.$ref)
    // A recursive type stops at a plain object rather than expanding forever.
    if (!ref || expanding.has(s.$ref)) return { type: "object" }
    return sanitizeSchema(
      root?.[ref[1]]?.[ref[2]],
      root,
      new Set([...expanding, s.$ref])
    )
  }
  const nested = (value: unknown) => sanitizeSchema(value, root, expanding)
  const out: Record<string, any> = {}
  for (const [key, value] of Object.entries(s)) {
    if (key === "properties" && value && typeof value === "object")
      out.properties = Object.fromEntries(
        Object.entries(value).map(([name, v]) => [name, nested(v)])
      )
    else if (key === "items") out.items = nested(value)
    else if ((key === "anyOf" || key === "oneOf") && Array.isArray(value))
      out.anyOf = value.map(nested)
    else if (key === "const") out.enum = [value]
    else if (key === "type" && Array.isArray(value)) {
      const types = value.filter((t) => t !== "null")
      if (types.length < value.length) out.nullable = true
      if (types.length === 1) out.type = types[0]
      else if (types.length) out.anyOf = types.map((type) => ({ type }))
    } else if (SCHEMA_KEYS.has(key)) out[key] = value
  }
  if (Array.isArray(out.required))
    out.required = out.required.filter(
      (name: unknown) =>
        typeof name === "string" && name in (out.properties ?? {})
    )
  return out
}

// Carrier blocks (the shared vocabulary) ↔ Interactions steps.
function toStep(b: Block): Step {
  if (b.type === "tool_use")
    return { type: "function_call", id: b.id, name: b.name, arguments: b.input }
  if (b.type === "thinking")
    return {
      type: "thought",
      signature: b.signature,
      ...(b.thinking ? { summary: [{ type: "text", text: b.thinking }] } : {}),
    }
  return { type: "model_output", content: [{ type: "text", text: b.text }] }
}

function toBlocks(step: Step): Block[] {
  if (step.type === "function_call")
    return [
      {
        type: "tool_use",
        id: step.id,
        name: step.name,
        input:
          step.arguments && typeof step.arguments === "object"
            ? step.arguments
            : {},
      },
    ]
  // An unsigned thought cannot be replayed, so it is not kept.
  if (step.type === "thought")
    return typeof step.signature === "string" && step.signature
      ? [
          {
            type: "thinking",
            thinking: text(step.summary),
            signature: step.signature,
          },
        ]
      : []
  if (step.type === "model_output") {
    const t = text(step.content)
    return t ? [{ type: "text", text: t }] : []
  }
  return []
}

export function translateRequest(
  body: Record<string, any>,
  info?: ModelInfo
): { params: Record<string, any>; prefix: string } {
  const model = String(body.model)
  const tools = (Array.isArray(body.tools) ? body.tools : []).map((t: any) => ({
    type: "function",
    name: t.function.name,
    description: t.function.description ?? "",
    parameters: sanitizeSchema(t.function.parameters ?? { type: "object" }),
  }))
  const system: string[] = []
  const input: Step[] = []
  const names = new Map<string, string>()
  let skipped = 0

  for (const m of body.messages ?? []) {
    if (m.role === "system" || m.role === "developer") {
      // Leading instructions become the system instruction; later ones are
      // demoted to user input rather than rewriting the replayed prefix.
      if (!input.length) system.push(text(m.content))
      else {
        const content = contents(text(m.content))
        if (content.length) input.push({ type: "user_input", content })
      }
    } else if (m.role === "tool") {
      const content = contents(m.content)
      const name = names.get(m.tool_call_id)
      // Consecutive results stay adjacent, so one round's results go together.
      input.push({
        type: "function_result",
        call_id: m.tool_call_id,
        ...(name ? { name } : {}),
        result: content.some((c) => c.type === "image")
          ? content
          : text(m.content),
      })
    } else if (m.role === "user") {
      const content = contents(m.content)
      if (content.length) input.push({ type: "user_input", content })
    } else if (m.role === "assistant") {
      const canonical: Block[] = [
        ...(text(m.content) ? [{ type: "text", text: text(m.content) }] : []),
        ...(m.tool_calls ?? []).map((c: any) => {
          names.set(c.id, c.function.name)
          let args: unknown
          try {
            args = JSON.parse(replayToolCallArguments(c.function.arguments))
          } catch {
            args = undefined
          }
          return {
            type: "tool_use",
            id: c.id,
            name: c.function.name,
            input:
              args && typeof args === "object" && !Array.isArray(args)
                ? args
                : { _invalid_tool_arguments: c.function.arguments },
          }
        }),
      ]
      if (!canonical.length) continue
      const carrier = validateCarrier(m[nativeAssistant])
      // The carrier's own model and prefix: only the visible content must match.
      const replayed =
        carrier?.provider === "google"
          ? replayCarrier(
              carrier,
              "google",
              carrier.model,
              carrier.prefix,
              canonical
            )
          : undefined
      if (carrier?.provider === "google" && !replayed) skipped++
      input.push(...(replayed ?? canonical).map(toStep))
    }
  }
  if (skipped)
    console.info("[google] thoughts not replayed", { model, skipped })

  const maxTokens = Number(body.max_tokens ?? body.max_completion_tokens)
  const params: Record<string, any> = {
    model,
    input,
    // North Star owns the transcript; nothing is kept on Google's side.
    store: false,
    ...(system.length ? { system_instruction: system.join("\n\n") } : {}),
    ...(tools.length ? { tools } : {}),
    generation_config: {
      max_output_tokens: info?.outputTokenLimit
        ? Math.min(maxTokens, info.outputTokenLimit)
        : maxTokens,
      ...(body.tool_choice === "none" && tools.length
        ? { tool_choice: "none" }
        : {}),
      // Summaries feed the transcript's reasoning trace. Small caps are
      // auxiliary calls (titles, commit messages) that must not think them away.
      ...(info?.thinking
        ? {
            thinking_summaries: "auto",
            ...(maxTokens < 4096 ? { thinking_level: "low" } : {}),
          }
        : {}),
    },
  }
  return {
    params,
    prefix: historyFingerprint({
      system: params.system_instruction ?? "",
      tools,
      input,
    }),
  }
}

const GRPC_STATUS: Record<string, number> = {
  INVALID_ARGUMENT: 400,
  RESOURCE_EXHAUSTED: 429,
  INTERNAL: 500,
  UNAVAILABLE: 503,
  DEADLINE_EXCEEDED: 504,
}

export function mapError(error: unknown): unknown {
  const e = error as {
    status?: unknown
    message?: unknown
    error?: any
  } | null
  if (
    e?.status === 400 &&
    /input token count|exceeds the maximum number of tokens|context window|too many tokens/i.test(
      String(e.message ?? "")
    )
  )
    return new ContextOverflowError(String(e.message), 400, { cause: error })
  // Gemini advises its retry wait in the body (RetryInfo), not a Retry-After
  // header; surface it so the coordinator waits that long, or gives up at once
  // when the wait (a daily quota) exceeds the turn's retry budget.
  const details = (e?.error?.error ?? e?.error)?.details
  const delay = Array.isArray(details)
    ? /^(\d+(?:\.\d+)?)s$/.exec(
        details.find((d) => typeof d?.retryDelay === "string")?.retryDelay ?? ""
      )?.[1]
    : undefined
  if (delay)
    return Object.assign(new Error(String(e?.message), { cause: error }), {
      status: e?.status,
      headers: new Headers({ "retry-after": delay }),
    })
  return error
}

// A mid-stream `error` event carries a gRPC-style code, not an HTTP status;
// restore one so retry classification sees overload/server errors as transient.
function streamError(error?: { code?: string; message?: string }) {
  const status = Number(error?.code) || GRPC_STATUS[error?.code ?? ""]
  return mapError(
    Object.assign(new Error(error?.message || "Gemini stream error."), {
      ...(status ? { status } : {}),
    })
  )
}

const REFUSAL = /safety|blocked|prohibited|recitation|policy/i

export function finish(
  interaction: Record<string, any>,
  model: string,
  prefix: string
) {
  const steps: Step[] = interaction.steps ?? []
  const status = interaction.status
  const failure = [
    ...(interaction.errors ?? []),
    ...steps.map((s) => s.type === "model_output" && s.error),
  ]
    .map((e) => e?.message)
    .filter(Boolean)
    .join(" ")
  const refusal = REFUSAL.test(failure) ? failure : undefined
  if (!refusal && (status === "failed" || status === "cancelled"))
    throw new Error(
      `Gemini interaction ${status}${failure ? `: ${failure}` : "."}`
    )
  const blocks = steps.flatMap(toBlocks)
  const u = interaction.usage ?? {}
  const prompt = u.total_input_tokens ?? 0
  // Thought tokens count toward the output cap, so they count as output here.
  const output = (u.total_output_tokens ?? 0) + (u.total_thought_tokens ?? 0)
  return {
    blocks,
    // Only thoughts need replay; plain text/tool turns rebuild canonically.
    carrier: blocks.some((b) => b.type === "thinking")
      ? validateCarrier({
          version: 1,
          provider: "google",
          model,
          prefix,
          blocks,
        })
      : undefined,
    finishReason: refusal
      ? "refusal"
      : status === "incomplete"
        ? "length"
        : blocks.some((b) => b.type === "tool_use")
          ? "tool_calls"
          : "stop",
    refusal,
    usage: {
      prompt_tokens: prompt,
      completion_tokens: output,
      total_tokens: u.total_tokens ?? prompt + output,
      prompt_tokens_details: { cached_tokens: u.total_cached_tokens ?? 0 },
    },
  }
}

function completion(
  interaction: Record<string, any>,
  model: string,
  prefix: string
) {
  const done = finish(interaction, model, prefix)
  const toolCalls = done.blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: b.id,
      type: "function",
      function: { name: b.name, arguments: JSON.stringify(b.input) },
    }))
  return {
    id: interaction.id,
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          [nativeAssistant]: done.carrier,
          content: done.blocks
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join(""),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          ...(done.refusal ? { refusal: done.refusal } : {}),
        },
        finish_reason: done.finishReason,
      },
    ],
    usage: done.usage,
  }
}

export async function* chunks(
  stream: AsyncIterable<any>,
  model: string,
  prefix: string
) {
  const chunk = (delta: Record<string | symbol, unknown>) => ({
    choices: [{ index: 0, delta, finish_reason: null }],
  })
  try {
    // Steps rebuilt from events: lifecycle payloads may omit them at the end.
    const steps: Step[] = []
    // Step index → tool ordinal, and the argument JSON streamed so far.
    const tools = new Map<number, { index: number; args: string }>()
    let usage: unknown
    let completed: Record<string, any> | undefined
    for await (const event of stream) {
      if (event.event_type === "step.start") {
        const step: Step = structuredClone(event.step ?? {})
        steps[event.index] = step
        if (step.type === "function_call") {
          const index = tools.size
          tools.set(event.index, { index, args: "" })
          yield chunk({
            tool_calls: [
              {
                index,
                id: step.id,
                type: "function",
                function: { name: step.name, arguments: "" },
              },
            ],
          })
        } else if (step.type === "model_output" && text(step.content))
          yield chunk({ content: text(step.content) })
        else if (step.type === "thought" && text(step.summary))
          yield chunk({ reasoning_content: text(step.summary) })
      } else if (event.event_type === "step.delta") {
        const step = steps[event.index]
        const d = event.delta ?? {}
        usage = event.metadata?.total_usage ?? usage
        if (!step) continue
        if (d.type === "text" && d.text) {
          step.content = [
            ...(step.content ?? []),
            { type: "text", text: d.text },
          ]
          yield chunk({ content: d.text })
        } else if (d.type === "thought_summary" && d.content?.type === "text") {
          step.summary = [...(step.summary ?? []), d.content]
          if (d.content.text) yield chunk({ reasoning_content: d.content.text })
        } else if (d.type === "thought_signature" && d.signature) {
          step.signature = d.signature
        } else if (d.type === "arguments_delta" && d.arguments) {
          const tool = tools.get(event.index)
          if (!tool) continue
          tool.args += d.arguments
          yield chunk({
            tool_calls: [
              { index: tool.index, function: { arguments: d.arguments } },
            ],
          })
        }
      } else if (event.event_type === "step.stop") {
        usage = event.usage ?? usage
        const tool = tools.get(event.index)
        const step = steps[event.index]
        if (!tool || !step) continue
        if (!tool.args) {
          // Arguments arrived whole on step.start.
          yield chunk({
            tool_calls: [
              {
                index: tool.index,
                function: { arguments: JSON.stringify(step.arguments ?? {}) },
              },
            ],
          })
        } else {
          try {
            step.arguments = JSON.parse(tool.args)
          } catch {
            // The loop reports the malformed call from the streamed text.
          }
        }
      } else if (event.event_type === "interaction.completed") {
        completed = event.interaction
      } else if (event.event_type === "error") {
        throw streamError(event.error)
      }
    }
    if (!completed)
      throw new Error("The Gemini stream ended without completing.")
    const done = finish(
      {
        ...completed,
        steps: completed.steps?.length
          ? completed.steps
          : steps.filter(Boolean),
        usage: completed.usage ?? usage,
      },
      model,
      prefix
    )
    yield {
      id: completed.id,
      choices: [
        {
          index: 0,
          delta: {
            [nativeAssistant]: done.carrier,
            ...(done.refusal ? { refusal: done.refusal } : {}),
          },
          finish_reason: done.finishReason,
        },
      ],
      usage: done.usage,
    }
  } catch (error) {
    throw mapError(error)
  }
}

export function buildGoogleClient(options: {
  accountId: string
  apiKey: string
  baseUrl: string | null
}): LlmClient {
  // The generateContent-era client (models.*) retries only when retryOptions
  // is set; Interactions requests opt out per call below.
  const client = new GoogleGenAI({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { httpOptions: { baseUrl: options.baseUrl } } : {}),
  })
  const catalog = catalogs.get(options.accountId) ?? new Map()
  catalogs.set(options.accountId, catalog)
  const lookups = new Map<string, Promise<ModelInfo | undefined>>()
  const info = (model: string) => {
    if (catalog.has(model)) return Promise.resolve(catalog.get(model))
    let lookup = lookups.get(model)
    if (!lookup) {
      // A failed lookup is remembered too: limits are an optimization.
      lookup = client.models.get({ model }).then(
        (m) => (catalog.set(model, m), m),
        () => undefined
      )
      lookups.set(model, lookup)
    }
    return lookup
  }

  return {
    compatibilityProbes: false,
    chat: {
      completions: {
        create: async (body, ...rest) => {
          const signal = (rest[1] as { signal?: AbortSignal } | undefined)
            ?.signal
          const { params, prefix } = translateRequest(
            body,
            await info(String(body.model))
          )
          // The agent loop owns the retry budget.
          const request = { signal, retries: { strategy: "none" } } as any
          try {
            if (!body.stream)
              return completion(
                await client.interactions.create(params as any, request),
                params.model,
                prefix
              )
            const stream = await client.interactions.create(
              { ...params, stream: true } as any,
              request
            )
            return chunks(
              stream as unknown as AsyncIterable<any>,
              params.model,
              prefix
            )
          } catch (error) {
            throw mapError(error)
          }
        },
      },
    },
    models: {
      list: async () => {
        const data: Array<Record<string, unknown> & { id: string }> = []
        for await (const m of await client.models.list()) {
          if (!m.name || !m.supportedActions?.includes("generateContent"))
            continue
          const id = m.name.replace(/^models\//, "")
          catalog.set(id, m)
          data.push({ ...m, id })
        }
        return { data }
      },
    },
  }
}

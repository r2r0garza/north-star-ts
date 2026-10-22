import Anthropic from "@anthropic-ai/sdk"
import type { BetaMessageStream } from "@anthropic-ai/sdk/lib/BetaMessageStream"
import {
  historyFingerprint,
  nativeAssistant,
  replayCarrier,
  validateCarrier,
} from "./native-carrier"
import { replayToolCallArguments } from "../tool-call-arguments"
import type { LlmClient } from "./index"
import {
  effortOrDefault,
  REASONING_EFFORT_PATTERN,
  type ReasoningEffort,
} from "../../../shared/reasoning-effort"

// The Anthropic API provider (plan 122). The agent loop speaks chat-completions
// (`chat.completions.create`); this adapter translates each request into a
// Messages API request on the official SDK and maps the response back into
// chat-completion chunks, so the loop, retry coordinator and tool reassembly
// stay provider-agnostic.
//
// Thinking replay (plan option A + C): current models bind each thinking
// block's signature to the exact prefix that produced it (system, tools and
// every earlier message). The native carrier stores the response's blocks with
// a fingerprint of that prefix; a later request replays them only when the
// fingerprint still matches, and otherwise sends the canonical text/tool_use
// blocks. `drop_block` is the server-side safety net for any edit we miss, and
// every `input_transformations` entry is logged.

type Message = Anthropic.Beta.BetaMessageParam
type Block = Record<string, any>
type ModelInfo = Anthropic.Models.ModelInfo

const BINDING_BETA = "thinking-binding-controls-2026-08-01"

// A request the model cannot fit. Carries a 4xx status so isTransientError
// treats it as deterministic; never reported as a `length` finish.
export class ContextOverflowError extends Error {
  readonly code = "context_overflow"
  constructor(
    message: string,
    readonly status = 400,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = "ContextOverflowError"
  }
}

// Per-account model catalog, filled by models.list (import) and lazily by
// models.retrieve on first use, so context windows survive an app restart.
const catalogs = new Map<string, Map<string, ModelInfo>>()
// The effort levels the Models API says this model accepts, in its order
// (lowest first). Level names are the capability's keys, not a fixed list.
export function effortLevels(info?: ModelInfo): ReasoningEffort[] {
  const effort = info?.capabilities?.effort as
    | Record<string, { supported?: boolean } | boolean | undefined>
    | undefined
  if (!effort || effort.supported !== true) return []
  return Object.entries(effort)
    .filter(
      ([level, value]) =>
        level !== "supported" &&
        REASONING_EFFORT_PATTERN.test(level) &&
        typeof value === "object" &&
        value?.supported === true
    )
    .map(([level]) => level)
}

export function contextWindowFor(
  accountId: string,
  modelId: string
): number | null {
  return catalogs.get(accountId)?.get(modelId)?.max_input_tokens ?? null
}

function text(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("")
}

// Chat-completions content → Messages API blocks. Empty text is dropped (the
// API rejects it); images become base64 or URL image blocks.
function parts(content: unknown): Block[] {
  if (typeof content === "string")
    return content ? [{ type: "text", text: content }] : []
  if (!Array.isArray(content)) return []
  return content.flatMap((p): Block[] => {
    if (p?.type === "text" && typeof p.text === "string" && p.text)
      return [{ type: "text", text: p.text }]
    if (p?.type === "image_url" && typeof p.image_url?.url === "string") {
      const data = /^data:([^;]+);base64,(.*)$/s.exec(p.image_url.url)
      return [
        {
          type: "image",
          source: data
            ? { type: "base64", media_type: data[1], data: data[2] }
            : { type: "url", url: p.image_url.url },
        },
      ]
    }
    return []
  })
}

export function translateRequest(
  body: Record<string, any>,
  info?: ModelInfo
): { params: Record<string, any>; prefix: string } {
  const model = String(body.model)
  const tools = (Array.isArray(body.tools) ? body.tools : []).map((t: any) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    input_schema: t.function.parameters ?? { type: "object" },
  }))
  const system: string[] = []
  const messages: Message[] = []
  const push = (role: "user" | "assistant", blocks: Block[]) => {
    if (!blocks.length) return
    const last = messages.at(-1)
    // Merge same-role neighbors: one round's tool results must share one user
    // message, or parallel tool use degrades.
    if (last?.role === role) (last.content as Block[]).push(...blocks)
    else messages.push({ role, content: blocks as any })
  }
  const prefix = () =>
    historyFingerprint({ system: system.join("\n\n"), tools, messages })
  // Carriers sent without their thinking, by what no longer matched.
  const skipped: Record<string, number> = {}

  for (const m of body.messages ?? []) {
    if (m.role === "system" || m.role === "developer") {
      // Leading instructions become top-level system. Later ones are demoted
      // to user text rather than rewriting the (thinking-bound) prefix.
      if (!messages.length) system.push(text(m.content))
      else push("user", parts(text(m.content)))
    } else if (m.role === "tool") {
      const content = parts(m.content)
      push("user", [
        {
          type: "tool_result",
          tool_use_id: m.tool_call_id,
          ...(content.length ? { content } : {}),
        },
      ])
    } else if (m.role === "user") {
      push("user", parts(m.content))
    } else if (m.role === "assistant") {
      const canonical: Block[] = [
        ...parts(text(m.content)),
        ...(m.tool_calls ?? []).map((c: any) => {
          let input: unknown
          try {
            input = JSON.parse(replayToolCallArguments(c.function.arguments))
          } catch {
            input = undefined
          }
          return {
            type: "tool_use",
            id: c.id,
            name: c.function.name,
            input:
              input && typeof input === "object" && !Array.isArray(input)
                ? input
                : { _invalid_tool_arguments: c.function.arguments },
          }
        }),
      ]
      if (!canonical.length) continue
      // The Messages API requires a leading user turn.
      if (!messages.length)
        push("user", [{ type: "text", text: "(continued)" }])
      const at = prefix()
      const replayed = replayCarrier(
        m[nativeAssistant],
        "anthropic",
        model,
        at,
        canonical
      )
      const carrier = validateCarrier(m[nativeAssistant])
      if (!replayed && carrier?.provider === "anthropic") {
        const reason =
          carrier.model !== model
            ? "model"
            : carrier.prefix !== at
              ? "prefix"
              : "content"
        skipped[reason] = (skipped[reason] ?? 0) + 1
      }
      push("assistant", replayed ?? canonical)
    }
  }
  if (Object.keys(skipped).length)
    console.info("[anthropic] thinking not replayed", { model, ...skipped })
  // Fingerprint before cache breakpoints: they are not part of the binding.
  const responsePrefix = prefix()

  // Rolling breakpoint on the latest block; system carries the stable one.
  const last = messages.at(-1)?.content as Block[] | undefined
  if (last?.length)
    last[last.length - 1] = {
      ...last[last.length - 1],
      cache_control: { type: "ephemeral" },
    }

  const adaptive =
    info?.capabilities?.thinking?.types?.adaptive?.supported !== false
  const effort = info?.capabilities?.effort?.supported
  const levels = effortLevels(info)
  const maxTokens = Number(body.max_tokens ?? body.max_completion_tokens)
  const params: Record<string, any> = {
    model,
    max_tokens: info?.max_tokens
      ? Math.min(maxTokens, info.max_tokens)
      : maxTokens,
    messages,
    ...(system.length
      ? {
          system: [
            {
              type: "text",
              text: system.join("\n\n"),
              cache_control: { type: "ephemeral" },
            },
          ],
        }
      : {}),
    ...(tools.length ? { tools } : {}),
    // Only auto (the default) and none; forced choice is rejected by current models.
    ...(body.tool_choice === "none" && tools.length
      ? { tool_choice: { type: "none" } }
      : {}),
    ...(adaptive
      ? {
          thinking: {
            type: "adaptive",
            // Readable summaries for the transcript; the default returns none.
            display: "summarized",
            block_binding: { prefix_mismatch_behavior: "drop_block" },
          },
          betas: [BINDING_BETA],
        }
      : {}),
    // Defaults differ by model, so set effort explicitly: the composer's pick,
    // else medium. Small caps are auxiliary calls (titles, commit messages)
    // that must not think them away.
    ...(effort
      ? {
          output_config: {
            effort:
              !body.reasoning_effort &&
              maxTokens < 4096 &&
              levels.includes("low")
                ? "low"
                : (effortOrDefault(body.reasoning_effort, levels) ?? "medium"),
          },
        }
      : {}),
  }
  return { params, prefix: responsePrefix }
}

function mapError(error: unknown): unknown {
  if (!(error instanceof Anthropic.APIError)) return error
  if (
    error.status === 413 ||
    (error.status === 400 &&
      /prompt is too long|context window|too many (input )?tokens/i.test(
        error.message
      ))
  )
    return new ContextOverflowError(error.message, error.status, {
      cause: error,
    })
  // A mid-stream `error` event has no HTTP status; restore one so retry
  // classification sees overload/server errors as transient.
  if (error.status === undefined) {
    const type = (error.error as any)?.error?.type
    const status =
      type === "overloaded_error"
        ? 529
        : type === "api_error"
          ? 500
          : type === "rate_limit_error"
            ? 429
            : undefined
    if (status)
      return Object.assign(new Error(error.message, { cause: error }), {
        status,
      })
  }
  return error
}

function finish(
  message: Anthropic.Beta.BetaMessage,
  model: string,
  prefix: string
) {
  for (const entry of message.input_transformations ?? [])
    console.warn("[anthropic] input_transformation", {
      model: message.model,
      type: entry.type,
      reason: entry.reason,
      path: entry.path,
    })
  const stop = message.stop_reason
  if (stop === "model_context_window_exceeded")
    throw new ContextOverflowError(
      "The request exceeded the model's context window."
    )
  if (stop === "pause_turn")
    throw new Error(
      "Anthropic paused the turn (pause_turn), but North Star sends no server tools."
    )
  const blocks = message.content.flatMap((b): Block[] =>
    b.type === "text"
      ? [{ type: "text", text: b.text }]
      : b.type === "thinking"
        ? [{ type: "thinking", thinking: b.thinking, signature: b.signature }]
        : b.type === "redacted_thinking"
          ? [{ type: "redacted_thinking", data: b.data }]
          : b.type === "tool_use"
            ? [{ type: "tool_use", id: b.id, name: b.name, input: b.input }]
            : []
  )
  const usage = message.usage
  const prompt =
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  return {
    blocks,
    // Only thinking needs replay; plain text/tool turns rebuild canonically.
    carrier: blocks.some((b) => b.type.endsWith("thinking"))
      ? validateCarrier({
          version: 1,
          provider: "anthropic",
          model,
          prefix,
          blocks,
        })
      : undefined,
    finishReason:
      stop === "tool_use"
        ? "tool_calls"
        : stop === "max_tokens"
          ? "length"
          : stop === "refusal"
            ? "refusal"
            : "stop",
    refusal:
      stop === "refusal"
        ? message.stop_details?.explanation || "Claude declined the request."
        : undefined,
    usage: {
      prompt_tokens: prompt,
      completion_tokens: usage.output_tokens,
      total_tokens: prompt + usage.output_tokens,
      prompt_tokens_details: {
        cached_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
      },
    },
  }
}

function completion(
  message: Anthropic.Beta.BetaMessage,
  model: string,
  prefix: string
) {
  const done = finish(message, model, prefix)
  const toolCalls = done.blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: b.id,
      type: "function",
      function: { name: b.name, arguments: JSON.stringify(b.input) },
    }))
  return {
    id: message.id,
    object: "chat.completion",
    model: message.model,
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

async function* chunks(
  stream: BetaMessageStream<unknown>,
  model: string,
  prefix: string
) {
  const chunk = (delta: Record<string | symbol, unknown>) => ({
    choices: [{ index: 0, delta, finish_reason: null }],
  })
  try {
    // Block index → tool ordinal, and whether any argument JSON arrived.
    const tools = new Map<number, { index: number; args: boolean }>()
    for await (const event of stream) {
      if (
        event.type === "content_block_start" &&
        event.content_block.type === "tool_use"
      ) {
        const index = tools.size
        tools.set(event.index, { index, args: false })
        yield chunk({
          tool_calls: [
            {
              index,
              id: event.content_block.id,
              type: "function",
              function: { name: event.content_block.name, arguments: "" },
            },
          ],
        })
      } else if (event.type === "content_block_delta") {
        const d = event.delta
        if (d.type === "text_delta" && d.text) yield chunk({ content: d.text })
        else if (d.type === "thinking_delta" && d.thinking)
          yield chunk({ reasoning_content: d.thinking })
        else if (d.type === "input_json_delta" && d.partial_json) {
          const tool = tools.get(event.index)
          if (!tool) continue
          tool.args = true
          yield chunk({
            tool_calls: [
              { index: tool.index, function: { arguments: d.partial_json } },
            ],
          })
        }
      } else if (event.type === "content_block_stop") {
        const tool = tools.get(event.index)
        if (tool && !tool.args)
          yield chunk({
            tool_calls: [{ index: tool.index, function: { arguments: "{}" } }],
          })
      }
    }
    const message = await stream.finalMessage()
    const done = finish(message, model, prefix)
    yield {
      id: message.id,
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

export function buildAnthropicClient(options: {
  accountId: string
  apiKey: string
  baseUrl: string | null
}): LlmClient {
  // The agent loop owns the retry budget.
  const client = new Anthropic({
    apiKey: options.apiKey,
    baseURL: options.baseUrl ?? undefined,
    maxRetries: 0,
  })
  const catalog = catalogs.get(options.accountId) ?? new Map()
  catalogs.set(options.accountId, catalog)
  const lookups = new Map<string, Promise<ModelInfo | undefined>>()
  const info = (model: string) => {
    if (catalog.has(model)) return Promise.resolve(catalog.get(model))
    let lookup = lookups.get(model)
    if (!lookup) {
      // A failed lookup is remembered too: capabilities are an optimization.
      lookup = client.models.retrieve(model).then(
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
          const stream = client.beta.messages.stream(params as any, { signal })
          // Errors arrive through withResponse/iteration; don't also surface
          // them as unhandled stream events.
          stream.on("error", () => {})
          try {
            await stream.withResponse()
            if (!body.stream)
              return completion(
                await stream.finalMessage(),
                params.model,
                prefix
              )
          } catch (error) {
            throw mapError(error)
          }
          return chunks(stream, params.model, prefix)
        },
      },
    },
    effortLevels: async (model) => effortLevels(await info(model)),
    models: {
      list: async () => {
        const data: ModelInfo[] = []
        for await (const model of client.models.list()) {
          catalog.set(model.id, model)
          data.push(model)
        }
        return { data }
      },
    },
  }
}

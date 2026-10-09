import { object, protocol } from "./errors"

type Block = {
  type: string
  value: Record<string, any>
  json: string
  closed: boolean
}
const stops = new Set([
  "end_turn",
  "tool_use",
  "max_tokens",
  "stop_sequence",
  "refusal",
  "model_context_window_exceeded",
  "pause_turn",
])

export class ResponseCapture {
  private decoder = new TextDecoder("utf-8", { fatal: true })
  private pending = ""
  private blocks = new Map<number, Block>()
  private started = false
  private ended = false
  private delta = false
  private bytes = 0
  private usage: Record<string, number> = {}
  private stop = ""
  private id = ""
  constructor(
    private readonly emit: (
      kind: "text" | "reasoning",
      text: string
    ) => void = () => {}
  ) {}

  push(chunk: Uint8Array) {
    this.bytes += chunk.byteLength
    if (this.bytes > 32 * 1024 * 1024) protocol()
    try {
      this.pending += this.decoder.decode(chunk, { stream: true })
    } catch {
      protocol()
    }
    this.drain()
  }
  private drain() {
    let match: RegExpExecArray | null
    while ((match = /\r?\n\r?\n/.exec(this.pending))) {
      const frame = this.pending.slice(0, match.index)
      this.pending = this.pending.slice(match.index + match[0].length)
      if (Buffer.byteLength(frame) > 1024 * 1024) protocol()
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
      if (!data) continue
      let event: any
      try {
        event = JSON.parse(data)
      } catch {
        protocol()
      }
      this.event(event)
    }
    if (Buffer.byteLength(this.pending) > 1024 * 1024) protocol()
  }
  private readUsage(value: unknown, required: string[] = []) {
    if (!object(value)) protocol()
    for (const key of required) if (value[key] === undefined) protocol()
    for (const key of [
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
    ]) {
      if (value[key] !== undefined) {
        if (
          typeof value[key] !== "number" ||
          !Number.isSafeInteger(value[key]) ||
          value[key] < 0
        )
          protocol()
        this.usage[key] = value[key]
      }
    }
  }
  private event(event: any) {
    if (!object(event) || typeof event.type !== "string") protocol()
    if (event.type === "ping") return
    if (this.ended || event.type === "error") protocol()
    if (event.type === "message_start") {
      if (
        this.started ||
        !object(event.message) ||
        typeof event.message.id !== "string" ||
        event.message.role !== "assistant" ||
        !Array.isArray(event.message.content) ||
        event.message.content.length
      )
        protocol()
      this.started = true
      this.id = event.message.id
      this.readUsage(event.message.usage, ["input_tokens", "output_tokens"])
      return
    }
    if (!this.started) protocol()
    if (event.type === "content_block_start") {
      if (
        this.delta ||
        !Number.isSafeInteger(event.index) ||
        event.index !== this.blocks.size ||
        !object(event.content_block) ||
        !["text", "thinking", "redacted_thinking", "tool_use"].includes(
          event.content_block.type
        ) ||
        [...this.blocks.values()].some((block) => !block.closed)
      )
        protocol()
      const value = { ...event.content_block }
      if (value.type === "text" && typeof value.text !== "string") protocol()
      if (value.type === "thinking" && typeof value.thinking !== "string")
        protocol()
      if (
        value.type === "tool_use" &&
        (typeof value.id !== "string" ||
          !value.id ||
          typeof value.name !== "string" ||
          !object(value.input))
      )
        protocol()
      this.blocks.set(event.index, {
        type: value.type,
        value,
        json: "",
        closed: false,
      })
      if (value.type === "text") this.emit("text", value.text)
      if (value.type === "thinking") this.emit("reasoning", value.thinking)
      return
    }
    if (
      event.type === "content_block_delta" ||
      event.type === "content_block_stop"
    ) {
      const block = this.blocks.get(event.index)
      if (!block || block.closed || this.delta) protocol()
      if (event.type === "content_block_stop") {
        if (block.type === "tool_use" && block.json) {
          let input: unknown
          try {
            input = JSON.parse(block.json)
          } catch {
            protocol()
          }
          if (!object(input)) protocol()
          block.value.input = input
        }
        block.closed = true
        return
      }
      const d = event.delta
      if (!object(d)) protocol()
      if (
        d.type === "text_delta" &&
        block.type === "text" &&
        typeof d.text === "string"
      ) {
        block.value.text += d.text
        this.emit("text", d.text)
      } else if (
        d.type === "thinking_delta" &&
        block.type === "thinking" &&
        typeof d.thinking === "string"
      ) {
        block.value.thinking += d.thinking
        this.emit("reasoning", d.thinking)
      } else if (
        d.type === "signature_delta" &&
        block.type === "thinking" &&
        typeof d.signature === "string"
      ) {
        block.value.signature = (block.value.signature ?? "") + d.signature
      } else if (
        d.type === "input_json_delta" &&
        block.type === "tool_use" &&
        typeof d.partial_json === "string"
      ) {
        block.json += d.partial_json
        if (Buffer.byteLength(block.json) > 4 * 1024 * 1024) protocol()
      } else protocol()
      return
    }
    if (event.type === "message_delta") {
      if (
        this.delta ||
        [...this.blocks.values()].some((block) => !block.closed) ||
        !object(event.delta) ||
        !stops.has(event.delta.stop_reason)
      )
        protocol()
      this.delta = true
      this.stop = event.delta.stop_reason
      this.readUsage(event.usage, ["output_tokens"])
      return
    }
    if (event.type === "message_stop") {
      if (!this.delta) protocol()
      this.ended = true
      return
    }
    protocol()
  }
  finish() {
    try {
      this.pending += this.decoder.decode()
    } catch {
      protocol()
    }
    this.drain()
    if (this.pending.trim() || !this.ended) protocol()
    const blocks = [...this.blocks.values()].map((block) => block.value)
    const tools = blocks.filter((block) => block.type === "tool_use")
    if (
      new Set(tools.map((block) => block.id)).size !== tools.length ||
      (this.stop === "tool_use" && !tools.length)
    )
      protocol()
    const prompt =
      (this.usage.input_tokens ?? 0) +
      (this.usage.cache_read_input_tokens ?? 0) +
      (this.usage.cache_creation_input_tokens ?? 0)
    if (!Number.isSafeInteger(prompt)) protocol()
    return {
      id: this.id,
      stop: this.stop,
      text: blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(""),
      reasoning: blocks
        .filter((block) => block.type === "thinking")
        .map((block) => block.thinking)
        .join(""),
      tools: this.stop === "tool_use" ? tools : [],
      usage: {
        prompt_tokens: prompt,
        completion_tokens: this.usage.output_tokens,
        total_tokens: prompt + this.usage.output_tokens,
        prompt_tokens_details: {
          cached_tokens: this.usage.cache_read_input_tokens ?? 0,
          cache_creation_tokens: this.usage.cache_creation_input_tokens ?? 0,
        },
      },
    }
  }
}
export type CapturedResponse = ReturnType<ResponseCapture["finish"]>

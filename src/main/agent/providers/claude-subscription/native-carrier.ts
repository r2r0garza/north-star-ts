import { createHash } from "crypto"
import { isDeepStrictEqual } from "util"

// Symbols keep private replay metadata off foreign providers' JSON wires.
export const nativeAssistant = Symbol("nativeAssistant")
export const MAX_CARRIER_BYTES = 4 * 1024 * 1024
export interface NativeAssistantCarrier {
  version: 1
  provider: "claude_subscription"
  model: string
  prefix: string
  blocks: Record<string, any>[]
}

export function historyFingerprint(value: unknown): string {
  const frames = Array.isArray(value)
    ? value.map((f) => ({
        role: f.message.role,
        content:
          f.message.role === "assistant"
            ? projection(f.message.content)
            : f.message.content,
      }))
    : value
  return createHash("sha256").update(JSON.stringify(frames)).digest("hex")
}

function projection(blocks: Record<string, any>[]) {
  return {
    text: blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(""),
    tools: blocks
      .filter((b) => b.type === "tool_use")
      .map((b) => ({
        id: b.id,
        name: b.name,
        input: b.input,
      })),
  }
}

export function validateCarrier(
  value: unknown
): NativeAssistantCarrier | undefined {
  try {
    if (!value || typeof value !== "object") return
    const c = value as NativeAssistantCarrier
    if (
      c.version !== 1 ||
      c.provider !== "claude_subscription" ||
      typeof c.model !== "string" ||
      !/^(?:claude-[a-z0-9.-]+|(?:us|eu|apac|global)\.anthropic\.claude-[a-z0-9.:-]+)$/.test(
        c.model
      ) ||
      !/^[a-f0-9]{64}$/.test(c.prefix) ||
      !Array.isArray(c.blocks) ||
      !c.blocks.length ||
      Buffer.byteLength(JSON.stringify(c)) > MAX_CARRIER_BYTES
    )
      return
    for (const b of c.blocks) {
      if (!b || typeof b !== "object" || Array.isArray(b)) return
      const keys =
        b.type === "text"
          ? ["type", "text"]
          : b.type === "tool_use"
            ? ["type", "id", "name", "input"]
            : b.type === "thinking"
              ? ["type", "thinking", "signature"]
              : b.type === "redacted_thinking"
                ? ["type", "data"]
                : []
      if (!keys.length || Object.keys(b).some((k) => !keys.includes(k))) return
      if (b.type === "text" && typeof b.text !== "string") return
      if (
        b.type === "thinking" &&
        (typeof b.thinking !== "string" ||
          typeof b.signature !== "string" ||
          !b.signature)
      )
        return
      if (b.type === "redacted_thinking" && typeof b.data !== "string") return
      if (
        b.type === "tool_use" &&
        (typeof b.id !== "string" ||
          !b.id ||
          typeof b.name !== "string" ||
          !b.input ||
          typeof b.input !== "object" ||
          Array.isArray(b.input))
      )
        return
    }
    return JSON.parse(JSON.stringify(c))
  } catch {
    return
  }
}

export function replayCarrier(
  value: unknown,
  model: string,
  prefix: string,
  canonical: Record<string, any>[]
) {
  const c = validateCarrier(value)
  if (
    c?.model === model &&
    c.prefix === prefix &&
    isDeepStrictEqual(projection(c.blocks), projection(canonical))
  )
    return c.blocks
}

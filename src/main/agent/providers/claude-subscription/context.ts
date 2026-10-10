import { countTokens } from "gpt-tokenizer/encoding/o200k_base"
import { ClaudeSubscriptionError } from "./errors"
import type { ReplayFrame } from "./history"

export function supportsClaudeSubscriptionEffort(model: string): boolean {
  return /^claude-(?:sonnet-4-6|opus-4-[56])(?:-\d{8})?$/.test(model)
}

export function claudeSubscriptionContextLimit(model: string): number {
  // Standard CLI aliases retain native resolution, capped locally at 200k even
  // when their target supports more. Unknown/manual routes still get only 32k.
  return /^(?:sonnet|opus|haiku)$/.test(model) ||
    /^claude-(?:sonnet-4-[56]|opus-4-[56]|haiku-4-5)(?:-\d{8})?$/.test(model)
    ? 200000
    : 32000
}

export function checkClaudeSubscriptionContext(request: {
  model: string
  system: string
  frames: ReplayFrame[]
  extraBody: Record<string, unknown>
  maxTokens: number
}): void {
  // o200k is approximate for Claude; pad text counts by 25% for tokenizer
  // differences. Keep the byte bound if local tokenization fails.
  const textTokens = (text: string): number => {
    try {
      let tokens = 0
      // Bound tokenizer work on long unbroken strings, including base64 data.
      for (let start = 0; start < text.length; start += 4096) {
        tokens += countTokens(text.slice(start, start + 4096), {
          disallowedSpecial: new Set<string>(),
        })
      }
      return Math.ceil(tokens * 1.25)
    } catch {
      return Buffer.byteLength(text, "utf8")
    }
  }
  // Encoded image text alone cannot bound vision cost for compressed images.
  const imageReserve = (value: unknown): number => {
    if (Array.isArray(value))
      return value.reduce((sum, item) => sum + imageReserve(item), 0)
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>
      return (
        (record.type === "image" ? 8192 : 0) +
        Object.values(record).reduce<number>(
          (sum, item) => sum + imageReserve(item),
          0
        )
      )
    }
    return 0
  }
  const system = textTokens(request.system)
  const history = textTokens(JSON.stringify(request.frames))
  const inventory = textTokens(JSON.stringify(request.extraBody))
  const media = imageReserve(request.frames)
  const estimate =
    system + history + inventory + media + 16384 + request.maxTokens
  const limit = claudeSubscriptionContextLimit(request.model)
  if (estimate > limit)
    throw new ClaudeSubscriptionError(
      "claude_subscription_context_overflow",
      `Claude subscription context exceeds the conservative ${limit}-token route budget (estimated ${estimate} using o200k + 25% text safety margin, approximate for Claude: system ${system}, history ${history}, tools/request options ${inventory}, image reserve ${media}, native overhead 16384, output reserve ${request.maxTokens}).` +
        " Reduce the offered tool catalog or system context, attachments or output reserve. For history-heavy requests, let North Star's host summary finish or start a new conversation; summarizing or restarting cannot shrink the tool catalog or system prompt. No history was truncated and native compaction remains disabled.",
      400
    )
}

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
  // One token per UTF-8 byte is intentionally more conservative than chars/4,
  // including non-English text, JSON arguments and encoded attachment payloads.
  // Image bytes alone cannot bound vision cost for small compressed images.
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
  const system = Buffer.byteLength(request.system, "utf8")
  const history = Buffer.byteLength(JSON.stringify(request.frames), "utf8")
  const inventory = Buffer.byteLength(JSON.stringify(request.extraBody), "utf8")
  const media = imageReserve(request.frames)
  const estimate =
    system + history + inventory + media + 16384 + request.maxTokens
  const limit = claudeSubscriptionContextLimit(request.model)
  if (estimate > limit)
    throw new ClaudeSubscriptionError(
      "claude_subscription_context_overflow",
      `Claude subscription context exceeds the conservative ${limit}-token route budget (estimated ${estimate}: system ${system}, history ${history}, tools/request options ${inventory}, image reserve ${media}, native overhead 16384, output reserve ${request.maxTokens}).` +
        " Reduce the offered tool catalog or system context, attachments or output reserve. For history-heavy requests, let North Star's host summary finish or start a new conversation; summarizing or restarting cannot shrink the tool catalog or system prompt. No history was truncated and native compaction remains disabled.",
      400
    )
}

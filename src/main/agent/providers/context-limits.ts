import type { Provider } from "../../db/types"
import { contextWindowFor as anthropicContextWindow } from "./anthropic"
import { googleContextWindowFor as googleContextWindow } from "./google"

// Context-limit helpers for in-turn compaction (plan 118), kept out of the
// providers barrel so loop tests that mock the barrel still get them.

// Whether a request failed because its input exceeded the model's context
// window (plan 118). Anthropic and Google map theirs to ContextOverflowError;
// OpenAI-style accounts and Codex report `context_length_exceeded`.
export function isContextOverflow(err: unknown): boolean {
  let current: unknown = err
  for (
    let depth = 0;
    depth < 5 && current && typeof current === "object";
    depth++
  ) {
    const e = current as { code?: unknown; message?: unknown; cause?: unknown }
    if (e.code === "context_overflow" || e.code === "context_length_exceeded")
      return true
    if (
      typeof e.message === "string" &&
      /context_length_exceeded|maximum context length|exceeds the context window|prompt is too long/i.test(
        e.message
      )
    )
      return true
    current = e.cause
  }
  return false
}

// The model's input-token limit when its adapter has read it from the
// provider's model list; null otherwise.
export function contextWindowFor(
  provider: Provider,
  accountId: string,
  modelId: string
): number | null {
  if (provider === "anthropic")
    return anthropicContextWindow(accountId, modelId)
  if (provider === "google") return googleContextWindow(accountId, modelId)
  return null
}

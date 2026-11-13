import { countTokens, decode, encode } from "gpt-tokenizer/encoding/o200k_base"

// Prior step/column results for the next prompt: each capped at 16k tokens,
// and over 50k total the oldest are dropped whole (the latest matter most, and
// the JSON stays valid). o200k_base counts are an estimate for non-OpenAI
// models, as in agent/context/request-size.ts.
export function boundPriorResults<T extends { result: string | null }>(
  previous: T[]
): T[] {
  const bounded = previous.map((p) => ({
    ...p,
    result: p.result && decode(encode(p.result).slice(0, 16000)),
  }))
  while (bounded.length > 1 && countTokens(JSON.stringify(bounded)) > 50000)
    bounded.shift()
  return bounded
}

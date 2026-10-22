// Reasoning effort levels, lowest first. A model supports a subset; the
// provider adapters check the actual model before sending one.
export const REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

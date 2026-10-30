// Reasoning effort levels are named by the provider's model catalog (Anthropic's
// capabilities.effort keys, Codex's supported_reasoning_levels), lowest first.
export type ReasoningEffort = string

// What a stored effort may look like; anything else is dropped as untrusted.
export const REASONING_EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/

// The level a request uses: the pick when this model lists it, else medium,
// else the model's highest. Undefined when the model lists none.
export function effortOrDefault(
  picked: ReasoningEffort | null | undefined,
  levels: readonly ReasoningEffort[]
): ReasoningEffort | undefined {
  if (picked && levels.includes(picked)) return picked
  return levels.includes("medium") ? "medium" : levels.at(-1)
}

// Picker label for a provider-named reasoning effort.
export function effortLabel(effort: ReasoningEffort): string {
  return effort === "xhigh"
    ? "Extra high"
    : effort[0].toUpperCase() + effort.slice(1)
}

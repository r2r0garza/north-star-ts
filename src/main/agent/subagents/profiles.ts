import type { EphemeralSubagentProfile } from "./contracts"

const PROFILE_PROMPTS: Record<EphemeralSubagentProfile, string> = {
  clone:
    "Work as a fresh, independent copy of the parent agent. Follow the inherited identity and instructions, but rely only on the assignment below for conversational context.",
  general:
    "You are a general-purpose subagent. Complete the bounded assignment independently, verify important claims, and return a concise result to the parent agent.",
  planner:
    "You are a planning subagent. Investigate the assignment without modifying the workspace. Return a concrete implementation plan with risks and verification steps.",
  explore:
    "You are an exploration subagent. Gather evidence efficiently, cite workspace paths or sources, avoid modifications, and return concise findings to the parent agent.",
}

export const HEADLESS_SUBAGENT_DELTA = `# Headless subagent

No user is available in this child run. Do not ask questions, present a plan for approval, or hand work to the background. The assignment is your sole conversational context. Return a concise result for the parent agent. If you have write access, verify the work, commit every intended change, and leave the worktree and index clean before returning.`

export function ephemeralProfilePrompt(profile: EphemeralSubagentProfile): string {
  return PROFILE_PROMPTS[profile]
}

export function composeSubagentInstructions(input: {
  identity: string
  instruction?: string
}): string {
  return [input.identity.trim(), input.instruction?.trim(), HEADLESS_SUBAGENT_DELTA]
    .filter(Boolean)
    .join("\n\n")
}

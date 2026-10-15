import { OriginNotAllowedError } from "../../../browser/errors"
import { toolError } from "../output"
import type { ToolContext } from "../types"

// A failed browser call as a tool error. A Mission Control seat's origin
// guard (plan 109.04) gets its own code whichever tool tripped it.
export function browserFailure(code: string, err: unknown): string {
  if (err instanceof OriginNotAllowedError)
    return toolError("origin_not_allowed", err.message)
  return toolError(code, err instanceof Error ? err.message : String(err))
}

// The `save_evidence` parameter of browser_console / browser_network.
export const SAVE_EVIDENCE_PARAM = {
  type: "boolean",
  description:
    "Mission Control seats only: also save what this returns to the step's evidence directory, so a proof can cite it.",
} as const

// Append where an excerpt was saved, when the caller asked and the browser
// can save evidence (a seat's browser).
export async function withSavedEvidence(
  ctx: ToolContext,
  save: unknown,
  name: string,
  result: string
): Promise<string> {
  if (save !== true) return result
  if (!ctx.browser?.saveEvidence)
    return `${result}\n\n(Not saved: only a Mission Control seat's browser saves evidence.)`
  try {
    const path = await ctx.browser.saveEvidence(name, result)
    return `${result}\n\nSaved as evidence: ${path}`
  } catch (err) {
    return `${result}\n\n(Could not save evidence: ${err instanceof Error ? err.message : String(err)})`
  }
}

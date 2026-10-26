import { browserOrigin } from "../tools/browser/approval"
import type { ActionDecision, ToolAction } from "./types"

// Plan 130: what a browser/Electron-enabled workflow step may do with nobody
// watching. Workflow turns run in auto mode, which approves every approval tier,
// so this runs BEFORE that short-circuit and can only hard-block, never allow.
export interface UnattendedSurfaceGuard {
  // Normalized origins (see isWorkflowOrigin). Nothing is implicitly allowed.
  allowedOrigins: string[]
  allowEvaluate: boolean
  allowConsequential: boolean
}

export function unattendedSurfaceDecision(
  action: ToolAction,
  guard: UnattendedSurfaceGuard
): ActionDecision | null {
  if (action.kind !== "browser" && action.kind !== "electron") return null
  const url = typeof action.detail?.url === "string" ? action.detail.url : ""
  if (action.kind === "browser" && url && !originAllowed(url, guard)) {
    const allowed = guard.allowedOrigins.join(", ") || "none"
    return {
      level: "hard_block",
      reason: `${browserOrigin(url)} is not an allowed origin for this unattended workflow step (allowed: ${allowed}). Stay on an allowed origin, or report the blocker so the user can add it to the step.`,
    }
  }
  if (action.tool === "browser_evaluate")
    return guard.allowEvaluate
      ? null
      : {
          level: "hard_block",
          reason:
            "Page JavaScript (browser_evaluate) is not enabled for this workflow step.",
        }
  if (
    action.detail?.interactionKind === "consequential_commit" &&
    !guard.allowConsequential
  )
    return {
      level: "hard_block",
      reason:
        "Consequential actions (delete, submit, send, purchase…) are blocked in unattended workflow steps. Use a reversible path, or report the blocker so the user can allow consequential actions on this step.",
    }
  return null
}

export function originAllowed(
  url: string,
  guard: Pick<UnattendedSurfaceGuard, "allowedOrigins">
): boolean {
  try {
    return guard.allowedOrigins.includes(new URL(url).origin)
  } catch {
    return false
  }
}

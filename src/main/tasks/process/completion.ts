import { stat } from "fs/promises"
import { resolveInWorkspaceReal } from "../../agent/tools/workspace"
import { parseCompletionContract } from "../../process/completion-contract"
import type {
  PhaseCompletionContract,
  PhaseCompletionReceipt,
  PhaseOutcome,
  ProcessRun,
} from "../../db/types"

export function runCompletionContract(
  run: ProcessRun,
  phaseId: string
): PhaseCompletionContract {
  if (run.completionContracts == null) return { policy: "legacy" }
  if (!Object.hasOwn(run.completionContracts, phaseId))
    throw new Error(
      "Phase has no recorded completion contract. Start a new run for the edited definition."
    )
  return parseCompletionContract(run.completionContracts[phaseId])
}

export function completionInstruction(
  contract: PhaseCompletionContract,
  attemptId: string
): string {
  if (contract.policy === "legacy") return ""
  return `# Required phase outcome (v1)
Finish your work, then return ONLY one JSON object, without markdown fences.
Use version: 1, attemptId: ${JSON.stringify(attemptId)}, status: "completed", "blocked", or "failed",
output: a nonempty string describing the result, evidence: a nonempty string explaining what you verified.
For blocked/failed, also provide nonempty reason and nextAction strings describing the obstacle and how to resolve it.
A completed claim must satisfy these required workspace files: ${JSON.stringify(contract.requiredArtifacts)}.
Do not claim completion just because a turn ended. Recover from tool errors where possible; otherwise report blocked or failed.
This attemptId replaces any earlier attemptId in the conversation. File presence will be checked; semantic correctness may be reviewed separately.`
}

export function parsePhaseOutcome(
  content: string | undefined,
  attemptId: string
): PhaseOutcome {
  let value: unknown
  try {
    value = JSON.parse(content ?? "")
  } catch {
    throw new Error("Expected a phase outcome JSON object")
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a phase outcome JSON object")
  const o = value as Record<string, unknown>
  const nonempty = (v: unknown): v is string =>
    typeof v === "string" && v.trim().length > 0
  if (
    o.version !== 1 ||
    o.attemptId !== attemptId ||
    !["completed", "blocked", "failed"].includes(o.status as string) ||
    !nonempty(o.output) ||
    !nonempty(o.evidence) ||
    (o.status !== "completed" &&
      (!nonempty(o.reason) || !nonempty(o.nextAction)))
  )
    throw new Error("Missing, invalid, or stale phase outcome data")
  return {
    version: 1,
    attemptId,
    status: o.status as PhaseOutcome["status"],
    output: o.output,
    evidence: o.evidence,
    ...(nonempty(o.reason) ? { reason: o.reason } : {}),
    ...(nonempty(o.nextAction) ? { nextAction: o.nextAction } : {}),
  }
}

export async function checkPhaseOutcome(input: {
  contract: PhaseCompletionContract
  outcome: PhaseOutcome
  workspace?: string
}): Promise<PhaseCompletionReceipt> {
  const { contract, outcome, workspace } = input
  const checkedArtifacts: string[] = []
  if (contract.policy === "validated" && outcome.status === "completed") {
    for (const artifact of contract.requiredArtifacts) {
      if (!workspace)
        throw new Error(`Required file ${artifact}: no workspace selected`)
      try {
        const path = await resolveInWorkspaceReal(workspace, artifact)
        if (!(await stat(path)).isFile()) throw new Error("not a regular file")
      } catch (err) {
        throw new Error(
          `Required file ${artifact}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      checkedArtifacts.push(artifact)
    }
  }
  return { outcome, checkedArtifacts, checkedAt: Date.now() }
}

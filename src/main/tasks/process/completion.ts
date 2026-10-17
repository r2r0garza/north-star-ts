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
    value = undefined
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "Invalid phase outcome: the final message is not a single JSON object"
    )
  const o = value as Record<string, unknown>
  const nonempty = (v: unknown): v is string =>
    typeof v === "string" && v.trim().length > 0
  // Name every problem: the user (and the corrective retry) need to know
  // exactly what to fix, not that "something" was missing.
  const problems: string[] = []
  if (o.version !== 1) problems.push("`version` must be 1")
  if (o.attemptId !== attemptId)
    problems.push(
      `\`attemptId\` is stale or missing (expected ${JSON.stringify(attemptId)})`
    )
  if (!["completed", "blocked", "failed"].includes(o.status as string))
    problems.push("`status` must be completed, blocked, or failed")
  if (!nonempty(o.output)) problems.push("`output` is missing or empty")
  if (!nonempty(o.evidence)) problems.push("`evidence` is missing or empty")
  if (
    (o.status === "blocked" || o.status === "failed") &&
    (!nonempty(o.reason) || !nonempty(o.nextAction))
  )
    problems.push(
      `\`status: ${o.status}\` also needs \`reason\` and \`nextAction\``
    )
  if (problems.length > 0)
    throw new Error(`Invalid phase outcome: ${problems.join("; ")}`)
  return {
    version: 1,
    attemptId,
    status: o.status as PhaseOutcome["status"],
    output: o.output as string,
    evidence: o.evidence as string,
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

import type {
  PlaybookRun,
  ProofCriterionStatus,
  SeatBinding,
  SliceProof,
} from "../db/types"
import type { SliceCriterion } from "./slice-objective"

// Structured slice proofs (plan 106.3, decision 7). Pure rules only: the
// record_proof tool resolves the slice, criteria, seats, and playbook run from
// server-side context and hands them here, so nothing identity-bearing comes
// from model arguments.

export const DEFAULT_MAX_PROOF_REVISIONS = 2

const STATUSES: readonly ProofCriterionStatus[] = [
  "met",
  "not_met",
  "not_verifiable",
]

export interface ProofSubmission {
  criteria: Array<{
    id: string
    status: ProofCriterionStatus
    evidence: string
    artifacts?: string[]
    reason?: string
    // A deterministic command phase whose result is this criterion's evidence
    // (plan 104). Only such evidence lets a builder verify its own work.
    commandPhaseKey?: string
  }>
  verdict: "accepted" | "rejected"
}

export type ProofDecision =
  | { kind: "invalid"; message: string }
  | { kind: "already_accepted"; proof: SliceProof }
  | { kind: "revisions_exhausted"; proof: SliceProof | null; message: string }
  | {
      kind: "recorded"
      proof: SliceProof
      proofRevisions: number
      // True when this rejected record used the last allowed revision.
      exhausted: boolean
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Schema-validate raw tool arguments against the slice's criterion ids. Returns
// an error string (for the model) or the parsed submission.
export function parseProofSubmission(
  args: Record<string, unknown>,
  criteria: SliceCriterion[]
): ProofSubmission | string {
  if (args.verdict !== "accepted" && args.verdict !== "rejected")
    return "`verdict` must be \"accepted\" or \"rejected\"."
  if (!Array.isArray(args.criteria))
    return "`criteria` must be an array with one entry per acceptance criterion."
  const expected = new Map(criteria.map((c) => [c.id, c]))
  const seen = new Set<string>()
  const parsed: ProofSubmission["criteria"] = []
  for (const [index, raw] of args.criteria.entries()) {
    if (!isRecord(raw)) return `criteria[${index}] must be an object.`
    const id = typeof raw.id === "string" ? raw.id.trim().toUpperCase() : ""
    if (!expected.has(id))
      return `criteria[${index}].id "${String(raw.id)}" is not one of this slice's criteria (${[...expected.keys()].join(", ") || "none"}).`
    if (seen.has(id)) return `Criterion ${id} appears more than once.`
    seen.add(id)
    if (!STATUSES.includes(raw.status as ProofCriterionStatus))
      return `criteria[${index}].status must be one of ${STATUSES.join(", ")}.`
    const evidence = typeof raw.evidence === "string" ? raw.evidence.trim() : ""
    if (!evidence)
      return `Criterion ${id} needs concrete evidence (what you ran or inspected, and what you observed).`
    const artifacts = Array.isArray(raw.artifacts)
      ? raw.artifacts.filter(
          (a): a is string => typeof a === "string" && a.trim() !== ""
        )
      : undefined
    parsed.push({
      id,
      status: raw.status as ProofCriterionStatus,
      evidence,
      ...(artifacts?.length ? { artifacts } : {}),
      ...(typeof raw.reason === "string" && raw.reason.trim()
        ? { reason: raw.reason.trim() }
        : {}),
      ...(typeof raw.commandPhaseKey === "string" && raw.commandPhaseKey.trim()
        ? { commandPhaseKey: raw.commandPhaseKey.trim() }
        : {}),
    })
  }
  const missing = [...expected.keys()].filter((id) => !seen.has(id))
  if (missing.length)
    return `The proof must cover every criterion; missing: ${missing.join(", ")}.`
  // Keep the spec's order regardless of submission order.
  const order = new Map(criteria.map((c, i) => [c.id, i]))
  parsed.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
  return { criteria: parsed, verdict: args.verdict }
}

export function decideProof(input: {
  submission: ProofSubmission
  criteria: SliceCriterion[]
  verifier: SeatBinding
  builderAddresses: string[]
  isCommandPhase: (phaseKey: string) => boolean
  playbookRun: PlaybookRun
  processRunId: string
  maxProofRevisions: number
  now?: number
}): ProofDecision {
  const { submission, verifier, playbookRun } = input
  const current = playbookRun.proof

  // Anti recursive-proof-loop: an accepted proof is frozen.
  if (current?.verdict === "accepted")
    return { kind: "already_accepted", proof: current }

  // A rejected proof may be re-recorded at most maxProofRevisions times.
  const proofRevisions = current ? playbookRun.proofRevisions + 1 : 0
  if (proofRevisions > input.maxProofRevisions)
    return {
      kind: "revisions_exhausted",
      proof: current,
      message: `This slice's proof was already revised ${input.maxProofRevisions} times this attempt; the slice will fail with the last proof attached.`,
    }

  if (submission.criteria.length === 0)
    return {
      kind: "invalid",
      message:
        "This slice has no acceptance criteria, so it cannot be proven. Report that in your summary instead.",
    }

  const warnings: string[] = []
  if (submission.verdict === "accepted") {
    for (const criterion of submission.criteria) {
      if (criterion.status === "met") continue
      if (criterion.status === "not_met")
        return {
          kind: "invalid",
          message: `Criterion ${criterion.id} is not met, so the proof cannot be accepted. Record verdict "rejected" instead.`,
        }
      if (!verifier.decisionRights.includes("accept_proof"))
        return {
          kind: "invalid",
          message: `Criterion ${criterion.id} is not verifiable, and ${verifier.address} lacks the accept_proof right needed to accept it anyway. Record verdict "rejected", or verify it.`,
        }
      if (!criterion.reason)
        return {
          kind: "invalid",
          message: `Accepting unverifiable criterion ${criterion.id} requires a reason.`,
        }
      warnings.push(
        `${criterion.id} accepted as not verifiable by ${verifier.address}: ${criterion.reason}`
      )
    }
  }

  // Independence: the verifier must not be a builder of this slice, unless
  // every met criterion rests on deterministic command evidence.
  const metCriteria = submission.criteria.filter((c) => c.status === "met")
  const commandBacked =
    metCriteria.length > 0 &&
    metCriteria.every(
      (c) => !!c.commandPhaseKey && input.isCommandPhase(c.commandPhaseKey)
    )
  const verifierBuilt = input.builderAddresses.includes(verifier.address)
  if (verifierBuilt && !commandBacked)
    return {
      kind: "invalid",
      message: `${verifier.address} built this slice, so it cannot verify it. A proof needs an independent verifier, or every met criterion must cite a deterministic command phase's result.`,
    }

  const unknownCommand = submission.criteria.find(
    (c) => c.commandPhaseKey && !input.isCommandPhase(c.commandPhaseKey)
  )
  if (unknownCommand)
    return {
      kind: "invalid",
      message: `Criterion ${unknownCommand.id} cites "${unknownCommand.commandPhaseKey}", which is not a command phase in this run.`,
    }

  const accepted = submission.verdict === "accepted"
  const proof: SliceProof = {
    version: 1,
    criteria: submission.criteria.map(
      ({ commandPhaseKey: _commandPhaseKey, ...criterion }) => criterion
    ),
    verdict: submission.verdict,
    verifiedBy:
      verifierBuilt && commandBacked
        ? { kind: "command", phaseKey: metCriteria[0].commandPhaseKey! }
        : { kind: "seat", address: verifier.address },
    builderAddresses: [...input.builderAddresses].sort(),
    processRunId: input.processRunId,
    acceptedAt: accepted ? (input.now ?? Date.now()) : null,
    ...(warnings.length ? { warnings } : {}),
  }
  return {
    kind: "recorded",
    proof,
    proofRevisions,
    exhausted: !accepted && proofRevisions >= input.maxProofRevisions,
  }
}

import type {
  PlaybookRun,
  ProofCriterionStatus,
  ProofVerificationMethod,
  SeatBinding,
  UserStoryProof,
} from "../db/types"
import type { UserStoryCriterion } from "./user-story-objective"

// Structured user story proofs (plan 106.3, decision 7). Pure rules only: the
// record_proof tool resolves the user story, criteria, seats, and playbook run from
// server-side context and hands them here, so nothing identity-bearing comes
// from model arguments.

export const DEFAULT_MAX_PROOF_REVISIONS = 2

const STATUSES: readonly ProofCriterionStatus[] = [
  "met",
  "not_met",
  "not_verifiable",
]

export const PROOF_METHODS: readonly ProofVerificationMethod[] = [
  "app_exercised",
  "command",
  "builder_tests",
  "code_read",
]

export interface ProofSubmission {
  criteria: Array<{
    id: string
    status: ProofCriterionStatus
    evidence: string
    method: ProofVerificationMethod
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
  | { kind: "already_accepted"; proof: UserStoryProof }
  | {
      kind: "revisions_exhausted"
      proof: UserStoryProof | null
      message: string
    }
  | {
      kind: "recorded"
      proof: UserStoryProof
      proofRevisions: number
      // True when this rejected record used the last allowed revision.
      exhausted: boolean
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Schema-validate raw tool arguments against the user story's criterion ids. Returns
// an error string (for the model) or the parsed submission.
export function parseProofSubmission(
  args: Record<string, unknown>,
  criteria: UserStoryCriterion[]
): ProofSubmission | string {
  if (args.verdict !== "accepted" && args.verdict !== "rejected")
    return '`verdict` must be "accepted" or "rejected".'
  if (!Array.isArray(args.criteria))
    return "`criteria` must be an array with one entry per acceptance criterion."
  const expected = new Map(criteria.map((c) => [c.id, c]))
  const seen = new Set<string>()
  const parsed: ProofSubmission["criteria"] = []
  for (const [index, raw] of args.criteria.entries()) {
    if (!isRecord(raw)) return `criteria[${index}] must be an object.`
    const id = typeof raw.id === "string" ? raw.id.trim().toUpperCase() : ""
    if (!expected.has(id))
      return `criteria[${index}].id "${String(raw.id)}" is not one of this user story's criteria (${[...expected.keys()].join(", ") || "none"}).`
    if (seen.has(id)) return `Criterion ${id} appears more than once.`
    seen.add(id)
    if (!STATUSES.includes(raw.status as ProofCriterionStatus))
      return `criteria[${index}].status must be one of ${STATUSES.join(", ")}.`
    const evidence = typeof raw.evidence === "string" ? raw.evidence.trim() : ""
    if (!evidence)
      return `Criterion ${id} needs concrete evidence (what you ran or inspected, and what you observed).`
    if (!PROOF_METHODS.includes(raw.method as ProofVerificationMethod))
      return `criteria[${index}].method must be one of ${PROOF_METHODS.join(", ")}: how you verified ${id}.`
    const artifacts = Array.isArray(raw.artifacts)
      ? raw.artifacts.filter(
          (a): a is string => typeof a === "string" && a.trim() !== ""
        )
      : undefined
    parsed.push({
      id,
      status: raw.status as ProofCriterionStatus,
      evidence,
      method: raw.method as ProofVerificationMethod,
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

// What the harness knows about the proof step, resolved server-side (plan
// 112.4): the submitted artifacts that are files in this step's evidence
// directory. The model's description is never trusted for it.
export interface ProofVerification {
  evidence: ReadonlySet<string>
}

// Why the met criteria of an accepted proof fall short of the method rules,
// all at once so one resubmission fixes them. Empty when it may be accepted.
export function verificationProblems(
  submission: ProofSubmission,
  verification: ProofVerification
): string[] {
  const problems: string[] = []
  for (const { id, status, method, artifacts } of submission.criteria) {
    if (status !== "met") continue
    if (method === "code_read")
      problems.push(
        `${id}: reading the code doesn't verify a criterion. Verify it in the running app, or record it not_verifiable with a reason.`
      )
    else if (method === "builder_tests")
      problems.push(
        `${id}: the builder's tests alone don't verify a criterion. Exercise it in the running app ("app_exercised") or run a command yourself ("command"); the builder's tests may support it in the evidence.`
      )
    else if (
      method === "app_exercised" &&
      !(artifacts ?? []).some((a) => verification.evidence.has(a))
    )
      problems.push(
        `${id}: verifying in the app needs saved evidence. Take a browser_screenshot (or save console or network evidence) and list the path it returned in artifacts.`
      )
  }
  return problems
}

export function decideProof(input: {
  submission: ProofSubmission
  criteria: UserStoryCriterion[]
  verification: ProofVerification
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
      message: `This user story's proof was already revised ${input.maxProofRevisions} times this attempt; the user story will fail with the last proof attached.`,
    }

  if (submission.criteria.length === 0)
    return {
      kind: "invalid",
      message:
        "This user story has no acceptance criteria, so it cannot be proven. Report that in your summary instead.",
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
    const problems = verificationProblems(submission, input.verification)
    if (problems.length)
      return {
        kind: "invalid",
        message: `The proof can't be accepted yet:\n${problems.map((p) => `- ${p}`).join("\n")}`,
      }
  }

  // Independence: the verifier must not be a builder of this user story, unless
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
      message: `${verifier.address} built this user story, so it cannot verify it. A proof needs an independent verifier, or every met criterion must cite a deterministic command phase's result.`,
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
  const proof: UserStoryProof = {
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

// The met criteria of an accepted proof that rest only on the builder's tests,
// or that don't say how they were verified (proofs from before plan 112.4).
// Health flags them (weak_proof).
export function weakProofCriteria(
  proof: unknown
): Array<{ id: string; method: ProofVerificationMethod | null }> {
  if (!isRecord(proof) || proof.verdict !== "accepted") return []
  if (!Array.isArray(proof.criteria)) return []
  return (proof as unknown as UserStoryProof).criteria
    .filter(
      (c) => c.status === "met" && (!c.method || c.method === "builder_tests")
    )
    .map((c) => ({ id: c.id, method: c.method ?? null }))
}

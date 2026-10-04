import type {
  PlaybookRun,
  ProofCheckResult,
  ProofCriterionStatus,
  ProofVerificationMethod,
  SeatBinding,
  UserStoryProof,
  UserStoryProofCriterion,
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
  "qa_check",
  "app_exercised",
  "builder_tests",
  "command",
  "code_read",
]

export interface ProofSubmission {
  criteria: Array<{
    id: string
    status: ProofCriterionStatus
    evidence: string
    method: ProofVerificationMethod
    checkIds?: string[]
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
    const method = raw.method as ProofVerificationMethod
    const strings = (value: unknown) =>
      Array.isArray(value)
        ? [
            ...new Set(
              value
                .filter((a): a is string => typeof a === "string")
                .map((a) => a.trim())
                .filter(Boolean)
            ),
          ]
        : undefined
    const checkIds = strings(raw.checkIds)
    if (method === "qa_check" && !checkIds?.length)
      return `Criterion ${id} has method "qa_check", so it needs \`checkIds\`: the ids of the QA checks that verified it.`
    const artifacts = strings(raw.artifacts)
    parsed.push({
      id,
      status: raw.status as ProofCriterionStatus,
      evidence,
      method,
      ...(checkIds?.length ? { checkIds } : {}),
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

// What the harness knows about this test step, resolved server-side before
// the gate runs (plan 109.05). The model's description is never trusted for
// any of it.
export interface ProofVerification {
  // The story's check manifest per criterion id; null when there's no usable
  // manifest (the playbook has no checks step, or it's missing or invalid).
  coverage: Record<
    string,
    { automated: string[]; exploratory: string[] }
  > | null
  // This step's recorded check results for this story, by check id.
  checks: Record<string, ProofCheckResult & { criterionId: string }>
  // The submitted artifacts that are files in this step's evidence directory.
  evidence: ReadonlySet<string>
  // A user story's test step (plan 110.04): verified by exploring the
  // running app, with no QA checks to cite.
  exploratory?: boolean
}

export const NO_VERIFICATION: ProofVerification = {
  coverage: null,
  checks: {},
  evidence: new Set(),
}

// Collapse a check's recorded attempts into one result: the newest run of it
// decides (its first attempt, plus the retry when that failed). A failure
// that passed on retry is flaky.
export function checkOutcomes(
  results: ReadonlyArray<{
    checkId: string
    criterionId: string
    storyRef: string
    attempt: number
    passed: boolean
  }>,
  storyRef: string
): ProofVerification["checks"] {
  const out: ProofVerification["checks"] = {}
  for (const result of results) {
    if (result.storyRef !== storyRef) continue
    const current = out[result.checkId]
    if (result.attempt === 1 || !current)
      out[result.checkId] = {
        checkId: result.checkId,
        criterionId: result.criterionId,
        status: result.passed ? "passed" : "failed",
        attempts: 1,
      }
    else
      out[result.checkId] = {
        ...current,
        status:
          current.status === "failed" && result.passed
            ? "flaky"
            : current.status,
        attempts: current.attempts + 1,
      }
  }
  return out
}

// Why each met criterion of an accepted proof falls short of the verification
// method rules. Empty when the proof may be accepted.
export function verificationProblems(
  submission: ProofSubmission,
  verification: ProofVerification
): string[] {
  const problems: string[] = []
  for (const criterion of submission.criteria) {
    if (criterion.status !== "met") continue
    const { id, method } = criterion
    const covered = verification.coverage?.[id]
    const automated = covered?.automated ?? []
    const exploratory = (covered?.exploratory.length ?? 0) > 0
    if (method === "code_read") {
      problems.push(
        `${id}: reading the code doesn't verify a criterion. Verify it another way, or record it not_verifiable with a reason.`
      )
      continue
    }
    if (method === "qa_check" && verification.exploratory) {
      problems.push(
        `${id}: this step runs no QA checks (the acceptance gate does, after the merge). Verify it in the running app and use method "app_exercised" with saved evidence, or "command" for a command you ran.`
      )
      continue
    }
    if (
      automated.length &&
      method !== "qa_check" &&
      !(exploratory && method === "app_exercised")
    )
      problems.push(
        `${id}: the check manifest covers it with automated checks (${automated.join(", ")}), so it's verified by those: use method "qa_check" and list them in checkIds.`
      )
    if (automated.length) {
      const cited = new Set(criterion.checkIds ?? [])
      const uncited = automated.filter((checkId) => !cited.has(checkId))
      if (uncited.length)
        problems.push(
          `${id}: checkIds must name every automated check the manifest lists for it; missing ${uncited.join(", ")}.`
        )
    }
    const manual = new Set(covered?.exploratory ?? [])
    for (const checkId of new Set([
      ...(criterion.checkIds ?? []),
      ...automated,
    ])) {
      // Exploratory checks have no results: their evidence is the artifacts.
      if (manual.has(checkId)) continue
      const result = verification.checks[checkId]
      if (!result)
        problems.push(
          automated.includes(checkId) || !verification.coverage
            ? `${id}: check ${checkId} has no result in this step. Run it with run_checks.`
            : `${id}: ${checkId} isn't one of its checks in the manifest.`
        )
      else if (result.criterionId !== id)
        problems.push(
          `${id}: check ${checkId} belongs to ${result.criterionId} in the manifest, not ${id}.`
        )
      else if (result.status === "failed")
        problems.push(
          `${id}: check ${checkId} failed in this step, so ${id} isn't met.`
        )
    }
    if (exploratory && method !== "app_exercised")
      problems.push(
        `${id}: the manifest marks it exploratory, so verify it in the running app and use method "app_exercised".`
      )
    if (method === "app_exercised" || exploratory) {
      const saved = (criterion.artifacts ?? []).filter((a) =>
        verification.evidence.has(a)
      )
      const missing = (criterion.artifacts ?? []).filter(
        (a) => !verification.evidence.has(a)
      )
      if (missing.length)
        problems.push(
          `${id}: ${missing.map((a) => `"${a}"`).join(", ")} ${missing.length === 1 ? "isn't a file" : "aren't files"} in this step's evidence directory. Cite the paths browser_screenshot (or save_evidence) returned.`
        )
      else if (!saved.length)
        problems.push(
          `${id}: verifying in the app needs evidence. Take a browser_screenshot (or save console or network evidence) and list its path in artifacts.`
        )
    }
  }
  return problems
}

export function decideProof(input: {
  submission: ProofSubmission
  criteria: UserStoryCriterion[]
  verification?: ProofVerification
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
    const verification = input.verification ?? NO_VERIFICATION
    const problems = verificationProblems(submission, verification)
    if (problems.length)
      return {
        kind: "invalid",
        message: `The proof can't be accepted yet:\n${problems.map((p) => `- ${p}`).join("\n")}`,
      }
    for (const criterion of submission.criteria) {
      if (criterion.status !== "met") continue
      if (criterion.method === "builder_tests")
        warnings.push(
          `${criterion.id} rests only on the builder's tests: no independent check verified it.`
        )
      const flaky = (criterion.checkIds ?? []).filter(
        (checkId) => verification.checks[checkId]?.status === "flaky"
      )
      if (flaky.length)
        warnings.push(
          `${criterion.id}: ${flaky.join(", ")} failed, then passed on retry (flaky).`
        )
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
  const checks = (input.verification ?? NO_VERIFICATION).checks
  const proof: UserStoryProof = {
    version: 1,
    criteria: submission.criteria.map(
      ({
        commandPhaseKey: _commandPhaseKey,
        checkIds,
        ...criterion
      }): UserStoryProofCriterion => {
        // Snapshot what the harness recorded for the cited checks; a cited
        // check with no result stays visible as not run.
        const cited = (checkIds ?? []).map(
          (checkId): ProofCheckResult =>
            checks[checkId]
              ? {
                  checkId,
                  status: checks[checkId].status,
                  attempts: checks[checkId].attempts,
                }
              : { checkId, status: "not_run", attempts: 0 }
        )
        return { ...criterion, ...(cited.length ? { checks: cited } : {}) }
      }
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
// or that don't say how they were verified (proofs from before plan 109.05).
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

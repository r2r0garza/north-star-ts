import { describe, expect, it } from "vitest"
import type { PlaybookRun, SeatBinding } from "../db/types"
import { decideProof, parseProofSubmission } from "./proof"
import { sliceStatusPath } from "./work-state"

const criteria = [
  { id: "AC-1", text: "one" },
  { id: "AC-2", text: "two" },
]

const qa = {
  address: "qa@impl",
  decisionRights: [],
} as unknown as SeatBinding

const openRun = {
  id: "pr",
  proof: null,
  proofRevisions: 0,
} as unknown as PlaybookRun

function submission(
  statuses: string[],
  verdict = "accepted",
  extra: Record<string, unknown> = {}
) {
  const parsed = parseProofSubmission(
    {
      verdict,
      criteria: statuses.map((status, i) => ({
        id: `ac-${i + 1}`,
        status,
        evidence: "observed",
        ...extra,
      })),
    },
    criteria
  )
  if (typeof parsed === "string") throw new Error(parsed)
  return parsed
}

function decide(overrides: Partial<Parameters<typeof decideProof>[0]>) {
  return decideProof({
    submission: submission(["met", "met"]),
    criteria,
    verifier: qa,
    builderAddresses: ["builder@impl"],
    isCommandPhase: () => false,
    playbookRun: openRun,
    processRunId: "run",
    maxProofRevisions: 2,
    now: 42,
    ...overrides,
  })
}

describe("parseProofSubmission", () => {
  it("requires every criterion exactly once, with evidence", () => {
    expect(
      parseProofSubmission(
        { verdict: "accepted", criteria: [{ id: "AC-1", status: "met", evidence: "x" }] },
        criteria
      )
    ).toMatch(/missing: AC-2/)
    expect(
      parseProofSubmission(
        { verdict: "accepted", criteria: [{ id: "AC-9", status: "met", evidence: "x" }] },
        criteria
      )
    ).toMatch(/not one of this slice's criteria/)
    expect(
      parseProofSubmission(
        { verdict: "accepted", criteria: [{ id: "AC-1", status: "met", evidence: " " }] },
        criteria
      )
    ).toMatch(/needs concrete evidence/)
  })
})

describe("decideProof", () => {
  it("accepts an independent verifier's fully met proof", () => {
    const decision = decide({})
    expect(decision).toMatchObject({
      kind: "recorded",
      proof: {
        verdict: "accepted",
        verifiedBy: { kind: "seat", address: "qa@impl" },
        acceptedAt: 42,
      },
    })
  })

  it("refuses a builder as its own verifier", () => {
    expect(decide({ builderAddresses: ["qa@impl"] })).toMatchObject({
      kind: "invalid",
      message: expect.stringMatching(/built this slice/),
    })
  })

  it("allows a builder when every met criterion cites a command phase", () => {
    const decision = decide({
      submission: submission(["met", "met"], "accepted", {
        commandPhaseKey: "unit-tests",
      }),
      builderAddresses: ["qa@impl"],
      isCommandPhase: (key) => key === "unit-tests",
    })
    expect(decision).toMatchObject({
      kind: "recorded",
      proof: { verifiedBy: { kind: "command", phaseKey: "unit-tests" } },
    })
  })

  it("accepts not_verifiable only with accept_proof rights and a reason", () => {
    const partial = submission(["met", "not_verifiable"])
    expect(decide({ submission: partial })).toMatchObject({ kind: "invalid" })
    const rightsHolder = { ...qa, decisionRights: ["accept_proof"] } as SeatBinding
    expect(decide({ submission: partial, verifier: rightsHolder })).toMatchObject({
      kind: "invalid",
      message: expect.stringMatching(/requires a reason/),
    })
    const withReason = submission(["met", "not_verifiable"], "accepted", {
      reason: "needs production data",
    })
    expect(decide({ submission: withReason, verifier: rightsHolder })).toMatchObject({
      kind: "recorded",
      proof: { warnings: [expect.stringMatching(/AC-2 accepted as not verifiable/)] },
    })
  })

  it("freezes accepted proofs and caps rejected revisions", () => {
    const accepted = decide({})
    if (accepted.kind !== "recorded") throw new Error("expected recorded")
    expect(
      decide({ playbookRun: { ...openRun, proof: accepted.proof } })
    ).toMatchObject({ kind: "already_accepted" })

    const rejected = { ...accepted.proof, verdict: "rejected" as const }
    expect(
      decide({
        submission: submission(["met", "not_met"], "rejected"),
        playbookRun: { ...openRun, proof: rejected, proofRevisions: 1 },
      })
    ).toMatchObject({ kind: "recorded", proofRevisions: 2, exhausted: true })
    expect(
      decide({ playbookRun: { ...openRun, proof: rejected, proofRevisions: 2 } })
    ).toMatchObject({ kind: "revisions_exhausted" })
  })
})

describe("sliceStatusPath", () => {
  it("walks legal transitions only", () => {
    expect(sliceStatusPath("running", "done")).toEqual([
      "proving",
      "integrating",
      "done",
    ])
    expect(sliceStatusPath("failed", "running")).toEqual(["ready", "running"])
    expect(sliceStatusPath("done", "running")).toBeNull()
  })
})

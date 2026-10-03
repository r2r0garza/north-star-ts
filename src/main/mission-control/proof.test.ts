import { describe, expect, it } from "vitest"
import type { PlaybookRun, SeatBinding } from "../db/types"
import {
  checkOutcomes,
  decideProof,
  parseProofSubmission,
  weakProofCriteria,
  type ProofVerification,
} from "./proof"
import { userStoryStatusPath } from "./work-state"

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
        method: "command",
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
        {
          verdict: "accepted",
          criteria: [
            { id: "AC-1", status: "met", evidence: "x", method: "command" },
          ],
        },
        criteria
      )
    ).toMatch(/missing: AC-2/)
    expect(
      parseProofSubmission(
        {
          verdict: "accepted",
          criteria: [{ id: "AC-9", status: "met", evidence: "x" }],
        },
        criteria
      )
    ).toMatch(/not one of this user story's criteria/)
    expect(
      parseProofSubmission(
        {
          verdict: "accepted",
          criteria: [
            { id: "AC-1", status: "met", evidence: " ", method: "command" },
          ],
        },
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
      message: expect.stringMatching(/built this user story/),
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
    const rightsHolder = {
      ...qa,
      decisionRights: ["accept_proof"],
    } as SeatBinding
    expect(
      decide({ submission: partial, verifier: rightsHolder })
    ).toMatchObject({
      kind: "invalid",
      message: expect.stringMatching(/requires a reason/),
    })
    const withReason = submission(["met", "not_verifiable"], "accepted", {
      reason: "needs production data",
    })
    expect(
      decide({ submission: withReason, verifier: rightsHolder })
    ).toMatchObject({
      kind: "recorded",
      proof: {
        warnings: [expect.stringMatching(/AC-2 accepted as not verifiable/)],
      },
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
      decide({
        playbookRun: { ...openRun, proof: rejected, proofRevisions: 2 },
      })
    ).toMatchObject({ kind: "revisions_exhausted" })
  })
})

describe("verification methods (plan 109.05)", () => {
  // AC-1 is covered by automated checks; AC-2 is exploratory.
  const coverage = {
    "AC-1": { automated: ["ac1-a", "ac1-b"], exploratory: [] },
    "AC-2": { automated: [], exploratory: ["ac2-copy"] },
  }
  const shot = "/evidence/pr/screenshot-001.jpg"
  function verification(
    overrides: Partial<ProofVerification> = {}
  ): ProofVerification {
    return {
      coverage,
      checks: checkOutcomes(
        [
          {
            checkId: "ac1-a",
            criterionId: "AC-1",
            storyRef: "s",
            attempt: 1,
            passed: true,
          },
          {
            checkId: "ac1-b",
            criterionId: "AC-1",
            storyRef: "s",
            attempt: 1,
            passed: true,
          },
        ],
        "s"
      ),
      evidence: new Set([shot]),
      ...overrides,
    }
  }
  function proof(
    ac1: Record<string, unknown>,
    ac2: Record<string, unknown> = {
      method: "app_exercised",
      artifacts: [shot],
    }
  ) {
    const parsed = parseProofSubmission(
      {
        verdict: "accepted",
        criteria: [
          { id: "AC-1", status: "met", evidence: "observed", ...ac1 },
          { id: "AC-2", status: "met", evidence: "observed", ...ac2 },
        ],
      },
      criteria
    )
    if (typeof parsed === "string") throw new Error(parsed)
    return parsed
  }
  const qaCheck = { method: "qa_check", checkIds: ["ac1-a", "ac1-b"] }

  it("requires a known method, and checkIds for qa_check", () => {
    expect(
      parseProofSubmission(
        {
          verdict: "accepted",
          criteria: [
            { id: "AC-1", status: "met", evidence: "x" },
            { id: "AC-2", status: "met", evidence: "x", method: "command" },
          ],
        },
        criteria
      )
    ).toMatch(/criteria\[0\]\.method must be one of/)
    expect(
      parseProofSubmission(
        {
          verdict: "accepted",
          criteria: [
            { id: "AC-1", status: "met", evidence: "x", method: "qa_check" },
            { id: "AC-2", status: "met", evidence: "x", method: "command" },
          ],
        },
        criteria
      )
    ).toMatch(/AC-1 has method "qa_check", so it needs `checkIds`/)
  })

  it("accepts covered checks that passed here and exploratory evidence, snapshotting the results", () => {
    const decision = decide({
      submission: proof(qaCheck),
      verification: verification(),
    })
    expect(decision).toMatchObject({ kind: "recorded" })
    if (decision.kind !== "recorded") return
    expect(decision.proof.criteria[0]).toMatchObject({
      method: "qa_check",
      checks: [
        { checkId: "ac1-a", status: "passed", attempts: 1 },
        { checkId: "ac1-b", status: "passed", attempts: 1 },
      ],
    })
    expect(decision.proof.criteria[1]).toMatchObject({
      method: "app_exercised",
      artifacts: [shot],
    })
    expect(decision.proof.warnings).toBeUndefined()
  })

  it("refuses code_read as met", () => {
    const decision = decide({
      submission: submission(["met", "met"], "accepted", {
        method: "code_read",
      }),
    })
    expect(decision).toMatchObject({
      kind: "invalid",
      message: expect.stringMatching(/AC-1: reading the code doesn't verify/),
    })
  })

  it("refuses a covered criterion whose checks didn't run, failed, or aren't all cited", () => {
    const notRun = verification({
      checks: checkOutcomes(
        [
          {
            checkId: "ac1-a",
            criterionId: "AC-1",
            storyRef: "s",
            attempt: 1,
            passed: true,
          },
        ],
        "s"
      ),
    })
    expect(
      decide({ submission: proof(qaCheck), verification: notRun })
    ).toMatchObject({
      kind: "invalid",
      message: expect.stringMatching(/check ac1-b has no result in this step/),
    })

    const failed = verification({
      checks: checkOutcomes(
        [
          {
            checkId: "ac1-a",
            criterionId: "AC-1",
            storyRef: "s",
            attempt: 1,
            passed: true,
          },
          {
            checkId: "ac1-b",
            criterionId: "AC-1",
            storyRef: "s",
            attempt: 1,
            passed: false,
          },
          {
            checkId: "ac1-b",
            criterionId: "AC-1",
            storyRef: "s",
            attempt: 2,
            passed: false,
          },
        ],
        "s"
      ),
    })
    expect(
      decide({ submission: proof(qaCheck), verification: failed })
    ).toMatchObject({
      kind: "invalid",
      message: expect.stringMatching(/check ac1-b failed in this step/),
    })

    expect(
      decide({
        submission: proof({ method: "qa_check", checkIds: ["ac1-a"] }),
        verification: verification(),
      })
    ).toMatchObject({
      kind: "invalid",
      message: expect.stringMatching(
        /must name every automated check.*missing ac1-b/
      ),
    })

    // Describing the checks isn't enough: the covered criterion needs them.
    expect(
      decide({
        submission: proof({ method: "command" }),
        verification: verification(),
      })
    ).toMatchObject({
      kind: "invalid",
      message: expect.stringMatching(/use method "qa_check"/),
    })
  })

  it("refuses qa_check naming an unknown, unrun, or other criterion's check", () => {
    expect(
      decide({
        submission: proof({
          method: "qa_check",
          checkIds: ["ac1-a", "ac1-b", "made-up"],
        }),
        verification: verification(),
      })
    ).toMatchObject({
      kind: "invalid",
      message: expect.stringMatching(/made-up isn't one of its checks/),
    })
    // Without a manifest, a cited check still needs a result in this step.
    expect(
      decide({
        submission: proof(
          { method: "qa_check", checkIds: ["ghost"] },
          { method: "command" }
        ),
        verification: verification({ coverage: null }),
      })
    ).toMatchObject({
      kind: "invalid",
      message: expect.stringMatching(/check ghost has no result in this step/),
    })
    expect(
      decide({
        submission: proof(
          { method: "qa_check", checkIds: ["ac1-a"] },
          { method: "qa_check", checkIds: ["ac1-b"] }
        ),
        verification: verification({ coverage: null }),
      })
    ).toMatchObject({
      kind: "invalid",
      message: expect.stringMatching(
        /ac1-b belongs to AC-1 in the manifest, not AC-2/
      ),
    })
  })

  it("refuses an exploratory criterion without saved evidence", () => {
    expect(
      decide({
        submission: proof(qaCheck, { method: "app_exercised" }),
        verification: verification(),
      })
    ).toMatchObject({
      kind: "invalid",
      message: expect.stringMatching(
        /AC-2: verifying in the app needs evidence/
      ),
    })
    expect(
      decide({
        submission: proof(qaCheck, {
          method: "app_exercised",
          artifacts: ["/elsewhere/shot.jpg"],
        }),
        verification: verification(),
      })
    ).toMatchObject({
      kind: "invalid",
      message: expect.stringMatching(
        /"\/elsewhere\/shot.jpg" isn't a file in this step's evidence directory/
      ),
    })
    expect(
      decide({
        submission: proof(qaCheck, { method: "command", artifacts: [shot] }),
        verification: verification(),
      })
    ).toMatchObject({
      kind: "invalid",
      message: expect.stringMatching(/marks it exploratory.*"app_exercised"/),
    })
  })

  it("accepts builder_tests with a warning, and flags flaky checks", () => {
    const flaky = verification({
      coverage: null,
      checks: checkOutcomes(
        [
          {
            checkId: "ac1-a",
            criterionId: "AC-1",
            storyRef: "s",
            attempt: 1,
            passed: false,
          },
          {
            checkId: "ac1-a",
            criterionId: "AC-1",
            storyRef: "s",
            attempt: 2,
            passed: true,
          },
        ],
        "s"
      ),
    })
    const decision = decide({
      submission: proof(
        { method: "qa_check", checkIds: ["ac1-a"] },
        { method: "builder_tests" }
      ),
      verification: flaky,
    })
    expect(decision).toMatchObject({
      kind: "recorded",
      proof: {
        warnings: [
          expect.stringMatching(/AC-1: ac1-a failed, then passed on retry/),
          expect.stringMatching(/AC-2 rests only on the builder's tests/),
        ],
      },
    })
    if (decision.kind !== "recorded") return
    expect(weakProofCriteria(decision.proof)).toEqual([
      { id: "AC-2", method: "builder_tests" },
    ])
  })

  it("lets a rejected proof through whatever its methods", () => {
    const parsed = parseProofSubmission(
      {
        verdict: "rejected",
        criteria: [
          { id: "AC-1", status: "met", evidence: "x", method: "code_read" },
          {
            id: "AC-2",
            status: "not_met",
            evidence: "x",
            method: "app_exercised",
          },
        ],
      },
      criteria
    )
    if (typeof parsed === "string") throw new Error(parsed)
    expect(
      decide({ submission: parsed, verification: verification() })
    ).toMatchObject({ kind: "recorded", proof: { verdict: "rejected" } })
  })

  it("treats an old proof without methods as unspecified", () => {
    const old = {
      version: 1,
      verdict: "accepted",
      criteria: [
        { id: "AC-1", status: "met", evidence: "x" },
        { id: "AC-2", status: "met", evidence: "x", method: "qa_check" },
      ],
    }
    expect(weakProofCriteria(old)).toEqual([{ id: "AC-1", method: null }])
    expect(weakProofCriteria({ ...old, verdict: "rejected" })).toEqual([])
    expect(weakProofCriteria(null)).toEqual([])
  })
})

describe("userStoryStatusPath", () => {
  it("walks legal transitions only", () => {
    expect(userStoryStatusPath("running", "done")).toEqual([
      "proving",
      "integrating",
      "done",
    ])
    expect(userStoryStatusPath("failed", "running")).toEqual([
      "ready",
      "running",
    ])
    expect(userStoryStatusPath("done", "running")).toBeNull()
  })
})

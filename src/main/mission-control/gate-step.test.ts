import { describe, expect, it, vi } from "vitest"

vi.mock("../db/connection", () => ({ getDb: () => undefined }))

import type { UserStory, WaveGate } from "../db/types"
import { gateStepNote } from "./gate-step"
import type { GateChecks } from "./qa-checks"

describe("the gate's kickoff (plan 110)", () => {
  it("calls out criteria the story's QA deferred to the gate", () => {
    const userStory = {
      id: "s1",
      key: "polish",
      title: "Responsive polish",
      fixes: null,
      proof: {
        version: 1,
        verdict: "accepted",
        criteria: [
          {
            id: "AC-1",
            status: "met",
            method: "app_exercised",
            evidence: "ok",
          },
          {
            id: "AC-2",
            status: "deferred",
            method: "app_exercised",
            evidence: "Default size only.",
            reason: "The narrow viewport needs an automated check.",
          },
        ],
      },
    } as unknown as UserStory
    const gate: GateChecks = {
      checksDir: "e2e",
      recipe: { services: [] },
      gate: { id: "g1", round: 1 } as WaveGate,
      milestoneId: "m1",
      stories: new Map([
        [
          "ql.m1.polish",
          {
            userStory,
            storyRef: "ql.m1.polish",
            criteria: [
              { id: "AC-1", text: "Accessible names" },
              { id: "AC-2", text: "No overflow on narrow screens" },
            ],
            batch: true,
            waived: [],
          },
        ],
      ]),
    }
    const note = gateStepNote({
      gate,
      services: null,
      suite: { manifests: [], problems: [], invalid: {} },
    })
    expect(note).toContain(
      "- **AC-2**: No overflow on narrow screens _(deferred to this gate by the story's QA, so only this gate verifies it: The narrow viewport needs an automated check. Write an automated check for it.)_"
    )
    expect(note).toContain("- **AC-1**: Accessible names\n")
  })
})

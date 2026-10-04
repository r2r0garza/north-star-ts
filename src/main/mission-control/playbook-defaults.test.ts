import { describe, expect, it, vi } from "vitest"

vi.mock("../db/connection", () => ({ getDb: () => undefined }))
vi.mock("../db/repositories/playbooks", () => ({}))
vi.mock("../db/repositories/processes", () => ({}))

import { DEFAULT_PLAYBOOKS } from "./playbook-defaults"

describe("default playbooks", () => {
  const steps = Object.values(DEFAULT_PLAYBOOKS).flatMap((playbook) =>
    Object.values(playbook.hooks).flat()
  )

  it("gates proof steps with the proof tool alone, not a validator", () => {
    const proofSteps = steps.filter((step) => step!.proofStep)
    expect(proofSteps.map((step) => step!.key)).toEqual([
      "test",
      "reverify",
      "accept",
    ])
    for (const step of proofSteps) expect(step!.validator).toBeFalsy()
  })
})

describe("the default user story playbook", () => {
  it("builds, then has QA verify by exploration (plan 110.04)", () => {
    const steps = DEFAULT_PLAYBOOKS.user_story.hooks.run!
    expect(steps.map((step) => [step.key, step.role])).toEqual([
      ["spec", "builder"],
      ["build", "builder"],
      ["test", "qa"],
    ])
    expect(steps[2].proofStep).toBe(true)
    expect(steps[2].name).toMatch(/running app/)
    expect(steps[1].name).not.toMatch(/checks/)
  })
})

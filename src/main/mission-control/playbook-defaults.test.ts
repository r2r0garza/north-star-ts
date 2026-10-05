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
    expect(proofSteps.map((step) => step!.key)).toEqual(["test", "reverify"])
    for (const step of proofSteps) expect(step!.validator).toBeFalsy()
  })
})

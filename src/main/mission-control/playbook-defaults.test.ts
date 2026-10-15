import { describe, expect, it, vi } from "vitest"

vi.mock("../db/connection", () => ({ getDb: () => undefined }))
vi.mock("../db/repositories/playbooks", () => ({}))
vi.mock("../db/repositories/processes", () => ({}))

import {
  DEFAULT_PLAYBOOKS,
  diffSteps,
  type PlaybookStepSummary,
} from "./playbook-defaults"

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

describe("the default user story playbook", () => {
  it("checks the app between build and QA's proof (plan 112.4)", () => {
    const steps = DEFAULT_PLAYBOOKS.user_story.hooks.run!
    expect(steps.map((step) => [step.key, step.kind ?? step.role])).toEqual([
      ["spec", "builder"],
      ["build", "builder"],
      ["app-check", "app_check"],
      ["test", "qa"],
    ])
  })
})

describe("diffSteps (reset to default, plan 112.4)", () => {
  const step = (key: string, extra: Partial<PlaybookStepSummary> = {}) => ({
    key,
    name: key,
    kind: "agent" as const,
    role: "builder",
    proofStep: false,
    validator: false,
    contextScope: "user_story" as const,
    ...extra,
  })
  it("reports added, removed, changed, and unchanged steps", () => {
    const changes = diffSteps(
      [step("spec"), step("build"), step("test", { role: "qa" }), step("old")],
      [
        step("spec"),
        step("build", { name: "Build it" }),
        step("app-check", { kind: "app_check", role: null }),
        step("test", { role: "qa" }),
      ]
    )
    expect(changes.map((c) => [c.change, c.step.key])).toEqual([
      ["unchanged", "spec"],
      ["changed", "build"],
      ["added", "app-check"],
      ["unchanged", "test"],
      ["removed", "old"],
    ])
    expect(changes[1]).toMatchObject({ fields: ["name"] })
  })
})

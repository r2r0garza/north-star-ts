import { beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))

import * as playbooks from "../db/repositories/playbooks"
import * as processes from "../db/repositories/processes"
import {
  createDefaultPlaybook,
  DEFAULT_PLAYBOOKS,
  diffPlaybookWithDefault,
  diffSteps,
  resetPlaybookToDefault,
} from "./playbook-defaults"
import {
  createLegacyChecksPlaybook,
  LEGACY_PLAYBOOK_NAME,
} from "../test/legacy-playbook"

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

const step = (key: string, name = key) => ({
  key,
  name,
  role: "builder",
  proofStep: false,
  validator: false,
  contextScope: "user_story" as const,
})

describe("diffSteps", () => {
  it("reports added, removed, changed, and unchanged steps", () => {
    expect(
      diffSteps(
        [step("spec"), step("build", "Old build"), step("lint")],
        [step("spec"), step("checks"), step("build", "New build")]
      )
    ).toEqual([
      { change: "unchanged", step: step("spec") },
      { change: "added", step: step("checks") },
      {
        change: "changed",
        step: step("build", "New build"),
        from: step("build", "Old build"),
        fields: ["name"],
      },
      { change: "removed", step: step("lint") },
    ])
  })
})

describe.skipIf(!sqliteLoads)("Reset to default", () => {
  it("leaves an existing default untouched until reset, then replaces it in place", () => {
    const old = createLegacyChecksPlaybook()
    const diff = diffPlaybookWithDefault(old.id)
    expect(diff.differs).toBe(true)
    expect(diff.name).toEqual({
      current: LEGACY_PLAYBOOK_NAME,
      template: DEFAULT_PLAYBOOKS.user_story.name,
    })
    const run = diff.hooks.find((h) => h.hook === "run")!
    expect(
      run.steps.filter((s) => s.change === "removed").map((s) => s.step.key)
    ).toEqual(["checks"])
    expect(
      run.steps.filter((s) => s.change === "changed").map((s) => s.step.key)
    ).toEqual(["build", "test"])

    // Nothing changes until the user confirms.
    expect(
      processes.listPhases(old.hooks[0].processId).map((p) => p.key)
    ).toContain("checks")

    const reset = resetPlaybookToDefault(old.id)
    expect(reset.id).toBe(old.id)
    expect(reset.name).toBe(DEFAULT_PLAYBOOKS.user_story.name)
    const phases = processes
      .listPhases(reset.hooks[0].processId)
      .sort((a, b) => a.position - b.position)
    expect(phases.map((p) => p.key)).toEqual(["spec", "build", "test"])
    expect(diffPlaybookWithDefault(old.id).differs).toBe(false)
    // The replaced step group had no run history, so it's gone.
    expect(processes.getProcessDefinition(old.hooks[0].processId)).toBeFalsy()
  })
})

describe.skipIf(!sqliteLoads)("Create from default", () => {
  it("routes rework autonomously in the user story default only", () => {
    const flagApproval = (altitude: "user_story" | "milestone") =>
      createDefaultPlaybook(altitude).hooks.map(
        (hook) =>
          processes.getProcessGraph(hook.processId)!.definition
            .requireFlagApproval
      )
    expect(flagApproval("user_story")).toEqual([false])
    expect(flagApproval("milestone").every(Boolean)).toBe(true)
  })
})

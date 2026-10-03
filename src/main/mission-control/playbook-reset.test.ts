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

// The pre-109.02 user story default, as a workspace created it.
function createOldDefault() {
  const playbook = createDefaultPlaybook("user_story")
  const processId = playbook.hooks[0].processId
  const graph = processes.getProcessGraph(processId)!
  const checks = graph.phases.find((p) => p.key === "checks")!
  db.prepare("DELETE FROM process_edges WHERE process_id = ?").run(processId)
  db.prepare("DELETE FROM process_phases WHERE id = ?").run(checks.id)
  const phases = processes
    .listPhases(processId)
    .sort((a, b) => a.position - b.position)
  processes.createEdge({
    processId,
    fromPhaseId: phases[0].id,
    toPhaseId: phases[1].id,
  })
  processes.createEdge({
    processId,
    fromPhaseId: phases[1].id,
    toPhaseId: phases[2].id,
  })
  playbooks.updatePlaybook(playbook.id, { name: "Spec → Build → Test" })
  return playbooks.getPlaybook(playbook.id)!
}

describe.skipIf(!sqliteLoads)("Reset to default", () => {
  it("leaves an existing default untouched until reset, then replaces it in place", () => {
    const old = createOldDefault()
    const diff = diffPlaybookWithDefault(old.id)
    expect(diff.differs).toBe(true)
    expect(diff.name).toEqual({
      current: "Spec → Build → Test",
      template: DEFAULT_PLAYBOOKS.user_story.name,
    })
    const run = diff.hooks.find((h) => h.hook === "run")!
    expect(
      run.steps.filter((s) => s.change === "added").map((s) => s.step.key)
    ).toEqual(["checks"])

    // Nothing changes until the user confirms.
    expect(
      processes.listPhases(old.hooks[0].processId).map((p) => p.key)
    ).not.toContain("checks")

    const reset = resetPlaybookToDefault(old.id)
    expect(reset.id).toBe(old.id)
    expect(reset.name).toBe(DEFAULT_PLAYBOOKS.user_story.name)
    const phases = processes
      .listPhases(reset.hooks[0].processId)
      .sort((a, b) => a.position - b.position)
    expect(phases.map((p) => p.key)).toEqual([
      "spec",
      "checks",
      "build",
      "test",
    ])
    expect(diffPlaybookWithDefault(old.id).differs).toBe(false)
    // The replaced step group had no run history, so it's gone.
    expect(processes.getProcessDefinition(old.hooks[0].processId)).toBeFalsy()
  })
})

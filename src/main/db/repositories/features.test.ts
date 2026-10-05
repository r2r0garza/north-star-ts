import { beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { sqliteLoadsForTests } from "../../test/sqlite"
import { runMigrations } from "../migrations"

const sqliteLoads = sqliteLoadsForTests()
let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

import { createProject } from "./projects"
import { createPod, createRig, deleteRig } from "./rigs"
import {
  createPlaybook,
  createPlaybookRun,
  deletePlaybook,
  finishPlaybookRun,
} from "./playbooks"
import {
  createFeature,
  createMilestone,
  createUserStory,
  deleteFeature,
  deleteMilestone,
  deleteUserStory,
  getFeatureGraph,
  setUserStoryEdges,
  startFeature,
  updateFeature,
  updateMilestone,
  updateUserStory,
} from "./features"

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)("feature repository", () => {
  it("persists the billing hierarchy and cascades milestone work", () => {
    const rig = createRig({ name: "Factory" })
    const graph = createFeature({
      key: "billing-v1",
      name: "Billing v1",
      intent: "Ship billing",
      definitionOfDone: "Invoices and payments work",
      rigId: rig.id,
    })
    const first = graph.milestones[0]
    createUserStory({
      milestoneId: first.id,
      key: "model",
      title: "Invoice model",
      spec: { goal: "Store invoices", acceptance: ["Can create an invoice"] },
    })
    createUserStory({ milestoneId: first.id, key: "api", title: "Invoice API" })
    const paymentGraph = createMilestone({
      featureId: graph.feature.id,
      key: "payments",
      name: "Payments",
      outcome: "Accept payment",
    })
    expect(paymentGraph.milestones).toHaveLength(2)
    deleteMilestone(first.id)
    expect(getFeatureGraph(graph.feature.id)?.userStories).toHaveLength(0)
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM user_story_edges").get()
    ).toEqual({ count: 0 })
  })

  it("rejects cross-milestone edges and cycles with a useful path", () => {
    const graph = createFeature({
      key: "map",
      name: "Map",
      intent: "",
      definitionOfDone: "",
    })
    const first = graph.milestones[0]
    const a = createUserStory({ milestoneId: first.id, key: "a", title: "A" })
      .userStories[0]
    const b = createUserStory({
      milestoneId: first.id,
      key: "b",
      title: "B",
    }).userStories.find((userStory) => userStory.key === "b")!
    expect(() =>
      setUserStoryEdges(first.id, [
        { fromUserStoryId: a.id, toUserStoryId: b.id },
        { fromUserStoryId: b.id, toUserStoryId: a.id },
      ])
    ).toThrow(/a → b → a/)
    const secondGraph = createMilestone({
      featureId: graph.feature.id,
      key: "second",
      name: "Second",
      outcome: "",
    })
    const c = createUserStory({
      milestoneId: secondGraph.milestones[1].id,
      key: "c",
      title: "C",
    }).userStories.find((userStory) => userStory.key === "c")!
    expect(() =>
      setUserStoryEdges(first.id, [{ fromUserStoryId: a.id, toUserStoryId: c.id }])
    ).toThrow(/one milestone/)
  })

  it("snapshots the rig, detects drift, and audits later structural edits", () => {
    const rig = createRig({ name: "Factory" })
    createPod({ rigId: rig.id, key: "delivery", name: "Delivery" })
    const graph = createFeature({
      key: "release",
      name: "Release",
      intent: "",
      definitionOfDone: "",
      rigId: rig.id,
    })
    const started = startFeature(graph.feature.id)
    expect(started.feature.rigSnapshot?.pods).toHaveLength(1)
    createPod({ rigId: rig.id, key: "review", name: "Review" })
    expect(getFeatureGraph(graph.feature.id)?.rigDrifted).toBe(true)
    const updated = updateUserStory(
      createUserStory({
        milestoneId: graph.milestones[0].id,
        key: "ship",
        title: "Ship",
      }).userStories.find((userStory) => userStory.key === "ship")!.id,
      { title: "Ship safely" },
      "user",
      "Clarify scope"
    )
    expect(
      updated.revisions.some((revision) => revision.reason === "Clarify scope")
    ).toBe(true)
  })

  it("keeps features when their rig or project is deleted", () => {
    const now = Date.now()
    db.prepare(
      "INSERT INTO workspaces (id, path, name, created_at, updated_at) VALUES ('w', '/tmp/w', 'w', ?, ?)"
    ).run(now, now)
    db.prepare(
      "INSERT INTO projects (id, name, workspace_id, position, created_at, updated_at) VALUES ('p', 'P', 'w', 0, ?, ?)"
    ).run(now, now)
    const rig = createRig({ name: "Factory" })
    const graph = createFeature({
      key: "kept",
      name: "Kept",
      intent: "",
      definitionOfDone: "",
      rigId: rig.id,
      projectId: "p",
      workspaceId: "w",
    })
    db.prepare("DELETE FROM rigs WHERE id = ?").run(rig.id)
    db.prepare("DELETE FROM projects WHERE id = 'p'").run()
    expect(getFeatureGraph(graph.feature.id)?.feature).toMatchObject({
      rigId: null,
      projectId: null,
    })
  })

  it("assigns playbooks per altitude and clears them when a playbook is deleted", () => {
    const graph = createFeature({
      key: "pick",
      name: "Pick",
      intent: "",
      definitionOfDone: "",
    })
    const milestone = graph.milestones[0]
    const userStory = createUserStory({ milestoneId: milestone.id, key: "a", title: "A" })
      .userStories[0]
    const userStoryPlaybook = createPlaybook({ name: "Hotfix", altitude: "user_story" })
    const milestonePlaybook = createPlaybook({
      name: "Review only",
      altitude: "milestone",
    })
    const featurePlaybook = createPlaybook({
      name: "Release train",
      altitude: "feature",
    })

    expect(
      updateUserStory(userStory.id, { playbookId: userStoryPlaybook.id }).userStories[0]
        .playbookId
    ).toBe(userStoryPlaybook.id)
    expect(
      updateMilestone(milestone.id, { playbookId: milestonePlaybook.id }).milestones[0]
        .playbookId
    ).toBe(milestonePlaybook.id)
    expect(
      updateFeature(graph.feature.id, {
        playbookId: featurePlaybook.id,
      }).feature.playbookId
    ).toBe(featurePlaybook.id)
    expect(() =>
      updateUserStory(userStory.id, { playbookId: milestonePlaybook.id })
    ).toThrow("A milestone playbook can't be used for a user story.")
    expect(() => updateMilestone(milestone.id, { playbookId: "missing" })).toThrow(
      "Playbook not found"
    )

    deletePlaybook(userStoryPlaybook.id)
    const after = getFeatureGraph(graph.feature.id)!
    expect(after.userStories[0].playbookId).toBeNull()
    expect(after.milestones[0].playbookId).toBe(milestonePlaybook.id)
    expect(
      updateMilestone(milestone.id, { playbookId: null }).milestones[0].playbookId
    ).toBeNull()
  })

  it("refuses to delete work while a playbook run is in progress", () => {
    const graph = createFeature({
      key: "busy",
      name: "Busy",
      intent: "",
      definitionOfDone: "",
    })
    const milestone = graph.milestones[0]
    const userStory = createUserStory({ milestoneId: milestone.id, key: "a", title: "A" })
      .userStories[0]
    const run = createPlaybookRun({
      playbookId: null,
      hook: "run",
      featureId: graph.feature.id,
      userStoryId: userStory.id,
    })

    expect(() => deleteUserStory(userStory.id)).toThrow("Cancel it first")
    expect(() => deleteMilestone(milestone.id)).toThrow("Cancel it first")
    expect(() => deleteFeature(graph.feature.id)).toThrow(
      "Cancel it first"
    )

    finishPlaybookRun(run.id, "cancelled", null)
    expect(deleteUserStory(userStory.id).userStories).toHaveLength(0)
    deleteMilestone(milestone.id)
    deleteFeature(graph.feature.id)
    expect(getFeatureGraph(graph.feature.id)).toBeNull()
  })

  it("picks a free key when a derived key is already taken", () => {
    const base = { name: "Test", intent: "", definitionOfDone: "" }
    const first = createFeature({ ...base, key: "test" })
    const second = createFeature({ ...base, key: "test" })
    const third = createFeature({ ...base, key: "test" })
    expect(second.feature.key).toBe("test-2")
    expect(third.feature.key).toBe("test-3")
    const long = "a".repeat(31) + "b"
    createFeature({ ...base, key: long })
    expect(createFeature({ ...base, key: long }).feature.key).toBe(
      "a".repeat(30) + "-2"
    )

    const milestone = first.milestones[0]
    const withMilestone = createMilestone({
      featureId: first.feature.id,
      key: "milestone-1",
      name: "Again",
      outcome: "",
    })
    expect(withMilestone.milestones.map((m) => m.key)).toEqual([
      "milestone-1",
      "milestone-1-2",
    ])
    createUserStory({ milestoneId: milestone.id, key: "api", title: "API" })
    const userStories = createUserStory({
      milestoneId: milestone.id,
      key: "api",
      title: "API",
    })
    expect(userStories.userStories.map((s) => s.key).sort()).toEqual(["api", "api-2"])

    // A key freed by deletion can be reused.
    deleteFeature(first.feature.id)
    expect(createFeature({ ...base, key: "test" }).feature.key).toBe(
      "test"
    )
  })

  it("rejects renaming a key onto an existing one with a readable error", () => {
    const base = { name: "X", intent: "", definitionOfDone: "" }
    createFeature({ ...base, key: "alpha" })
    const beta = createFeature({ ...base, key: "beta" })
    expect(() =>
      updateFeature(beta.feature.id, { key: "alpha" })
    ).toThrow("Feature key “alpha” is already in use.")
    expect(
      updateFeature(beta.feature.id, { key: "beta" }).feature.key
    ).toBe("beta")
  })

  it("binds rig and workspace while draft and locks them at start", () => {
    const factory = createRig({ name: "Factory" })
    const other = createRig({ name: "Other" })
    const graph = createFeature({
      key: "late-rig",
      name: "Late rig",
      intent: "",
      definitionOfDone: "",
    })
    const id = graph.feature.id
    expect(updateFeature(id, { rigId: factory.id }).feature.rigId).toBe(
      factory.id
    )
    startFeature(id)
    expect(() => updateFeature(id, { rigId: other.id })).toThrow(
      /can't be changed after a feature has started/
    )
    expect(() => updateFeature(id, { workspaceId: null })).not.toThrow()
    // Resending the current binding alongside other edits is harmless.
    expect(
      updateFeature(id, { rigId: factory.id, name: "Renamed" }, "user", "r")
        .feature.name
    ).toBe("Renamed")
  })

  it("keeps the project editable after a feature has started", () => {
    const project = createProject({ name: "Project A" })
    const rig = createRig({ name: "Factory" })
    const graph = createFeature({
      key: "relabel",
      name: "Relabel",
      intent: "",
      definitionOfDone: "",
      rigId: rig.id,
    })
    const id = graph.feature.id
    startFeature(id)
    expect(
      updateFeature(id, { projectId: project.id }).feature.projectId
    ).toBe(project.id)
    expect(updateFeature(id, { projectId: null }).feature.projectId).toBe(
      null
    )
  })

  it("refuses to delete a rig used by a running feature", () => {
    const rig = createRig({ name: "Factory" })
    const base = { intent: "", definitionOfDone: "", rigId: rig.id }
    const draft = createFeature({ ...base, key: "draft", name: "Draft" })
    const running = createFeature({ ...base, key: "run", name: "Running" })
    startFeature(running.feature.id)
    expect(() => deleteRig(rig.id)).toThrow(/in use by “Running”/)

    db.prepare("UPDATE features SET status = 'completed' WHERE id = ?").run(
      running.feature.id
    )
    deleteRig(rig.id)
    expect(getFeatureGraph(draft.feature.id)?.feature.rigId).toBeNull()
    const finished = getFeatureGraph(running.feature.id)!
    // The snapshot survives, and a deleted rig is not reported as drift.
    expect(finished.feature.rigSnapshot?.rig.name).toBe("Factory")
    expect(finished.rigDrifted).toBe(false)
  })
})

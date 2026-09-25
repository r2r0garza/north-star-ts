import { beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { sqliteLoadsForTests } from "../../test/sqlite"
import { runMigrations } from "../migrations"

const sqliteLoads = sqliteLoadsForTests()
let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

import { createPod, createRig, deleteRig } from "./rigs"
import {
  createPlaybook,
  createPlaybookRun,
  deletePlaybook,
  finishPlaybookRun,
} from "./playbooks"
import {
  createInitiative,
  createMission,
  createSlice,
  deleteInitiative,
  deleteMission,
  deleteSlice,
  getInitiativeGraph,
  setSliceEdges,
  startInitiative,
  updateInitiative,
  updateMission,
  updateSlice,
} from "./initiatives"

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)("initiative repository", () => {
  it("persists the billing hierarchy and cascades mission work", () => {
    const rig = createRig({ name: "Factory" })
    const graph = createInitiative({
      key: "billing-v1",
      name: "Billing v1",
      intent: "Ship billing",
      definitionOfDone: "Invoices and payments work",
      rigId: rig.id,
    })
    const first = graph.missions[0]
    createSlice({
      missionId: first.id,
      key: "model",
      title: "Invoice model",
      spec: { goal: "Store invoices", acceptance: ["Can create an invoice"] },
    })
    createSlice({ missionId: first.id, key: "api", title: "Invoice API" })
    const paymentGraph = createMission({
      initiativeId: graph.initiative.id,
      key: "payments",
      name: "Payments",
      outcome: "Accept payment",
    })
    expect(paymentGraph.missions).toHaveLength(2)
    deleteMission(first.id)
    expect(getInitiativeGraph(graph.initiative.id)?.slices).toHaveLength(0)
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM slice_edges").get()
    ).toEqual({ count: 0 })
  })

  it("rejects cross-mission edges and cycles with a useful path", () => {
    const graph = createInitiative({
      key: "map",
      name: "Map",
      intent: "",
      definitionOfDone: "",
    })
    const first = graph.missions[0]
    const a = createSlice({ missionId: first.id, key: "a", title: "A" })
      .slices[0]
    const b = createSlice({
      missionId: first.id,
      key: "b",
      title: "B",
    }).slices.find((slice) => slice.key === "b")!
    expect(() =>
      setSliceEdges(first.id, [
        { fromSliceId: a.id, toSliceId: b.id },
        { fromSliceId: b.id, toSliceId: a.id },
      ])
    ).toThrow(/a → b → a/)
    const secondGraph = createMission({
      initiativeId: graph.initiative.id,
      key: "second",
      name: "Second",
      outcome: "",
    })
    const c = createSlice({
      missionId: secondGraph.missions[1].id,
      key: "c",
      title: "C",
    }).slices.find((slice) => slice.key === "c")!
    expect(() =>
      setSliceEdges(first.id, [{ fromSliceId: a.id, toSliceId: c.id }])
    ).toThrow(/one mission/)
  })

  it("snapshots the rig, detects drift, and audits later structural edits", () => {
    const rig = createRig({ name: "Factory" })
    createPod({ rigId: rig.id, key: "delivery", name: "Delivery" })
    const graph = createInitiative({
      key: "release",
      name: "Release",
      intent: "",
      definitionOfDone: "",
      rigId: rig.id,
    })
    const started = startInitiative(graph.initiative.id)
    expect(started.initiative.rigSnapshot?.pods).toHaveLength(1)
    createPod({ rigId: rig.id, key: "review", name: "Review" })
    expect(getInitiativeGraph(graph.initiative.id)?.rigDrifted).toBe(true)
    const updated = updateSlice(
      createSlice({
        missionId: graph.missions[0].id,
        key: "ship",
        title: "Ship",
      }).slices.find((slice) => slice.key === "ship")!.id,
      { title: "Ship safely" },
      "user",
      "Clarify scope"
    )
    expect(
      updated.revisions.some((revision) => revision.reason === "Clarify scope")
    ).toBe(true)
  })

  it("keeps initiatives when their rig or project is deleted", () => {
    const now = Date.now()
    db.prepare(
      "INSERT INTO workspaces (id, path, name, created_at, updated_at) VALUES ('w', '/tmp/w', 'w', ?, ?)"
    ).run(now, now)
    db.prepare(
      "INSERT INTO projects (id, name, workspace_id, position, created_at, updated_at) VALUES ('p', 'P', 'w', 0, ?, ?)"
    ).run(now, now)
    const rig = createRig({ name: "Factory" })
    const graph = createInitiative({
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
    expect(getInitiativeGraph(graph.initiative.id)?.initiative).toMatchObject({
      rigId: null,
      projectId: null,
    })
  })

  it("assigns playbooks per altitude and clears them when a playbook is deleted", () => {
    const graph = createInitiative({
      key: "pick",
      name: "Pick",
      intent: "",
      definitionOfDone: "",
    })
    const mission = graph.missions[0]
    const slice = createSlice({ missionId: mission.id, key: "a", title: "A" })
      .slices[0]
    const slicePlaybook = createPlaybook({ name: "Hotfix", altitude: "slice" })
    const missionPlaybook = createPlaybook({
      name: "Review only",
      altitude: "mission",
    })
    const initiativePlaybook = createPlaybook({
      name: "Release train",
      altitude: "initiative",
    })

    expect(
      updateSlice(slice.id, { playbookId: slicePlaybook.id }).slices[0]
        .playbookId
    ).toBe(slicePlaybook.id)
    expect(
      updateMission(mission.id, { playbookId: missionPlaybook.id }).missions[0]
        .playbookId
    ).toBe(missionPlaybook.id)
    expect(
      updateInitiative(graph.initiative.id, {
        playbookId: initiativePlaybook.id,
      }).initiative.playbookId
    ).toBe(initiativePlaybook.id)
    expect(() =>
      updateSlice(slice.id, { playbookId: missionPlaybook.id })
    ).toThrow("A mission playbook can't be used for a slice.")
    expect(() => updateMission(mission.id, { playbookId: "missing" })).toThrow(
      "Playbook not found"
    )

    deletePlaybook(slicePlaybook.id)
    const after = getInitiativeGraph(graph.initiative.id)!
    expect(after.slices[0].playbookId).toBeNull()
    expect(after.missions[0].playbookId).toBe(missionPlaybook.id)
    expect(
      updateMission(mission.id, { playbookId: null }).missions[0].playbookId
    ).toBeNull()
  })

  it("refuses to delete work while a playbook run is in progress", () => {
    const graph = createInitiative({
      key: "busy",
      name: "Busy",
      intent: "",
      definitionOfDone: "",
    })
    const mission = graph.missions[0]
    const slice = createSlice({ missionId: mission.id, key: "a", title: "A" })
      .slices[0]
    const run = createPlaybookRun({
      playbookId: null,
      hook: "run",
      initiativeId: graph.initiative.id,
      sliceId: slice.id,
    })

    expect(() => deleteSlice(slice.id)).toThrow("Cancel it first")
    expect(() => deleteMission(mission.id)).toThrow("Cancel it first")
    expect(() => deleteInitiative(graph.initiative.id)).toThrow(
      "Cancel it first"
    )

    finishPlaybookRun(run.id, "cancelled", null)
    expect(deleteSlice(slice.id).slices).toHaveLength(0)
    deleteMission(mission.id)
    deleteInitiative(graph.initiative.id)
    expect(getInitiativeGraph(graph.initiative.id)).toBeNull()
  })

  it("picks a free key when a derived key is already taken", () => {
    const base = { name: "Test", intent: "", definitionOfDone: "" }
    const first = createInitiative({ ...base, key: "test" })
    const second = createInitiative({ ...base, key: "test" })
    const third = createInitiative({ ...base, key: "test" })
    expect(second.initiative.key).toBe("test-2")
    expect(third.initiative.key).toBe("test-3")
    const long = "a".repeat(31) + "b"
    createInitiative({ ...base, key: long })
    expect(createInitiative({ ...base, key: long }).initiative.key).toBe(
      "a".repeat(30) + "-2"
    )

    const mission = first.missions[0]
    const withMission = createMission({
      initiativeId: first.initiative.id,
      key: "mission-1",
      name: "Again",
      outcome: "",
    })
    expect(withMission.missions.map((m) => m.key)).toEqual([
      "mission-1",
      "mission-1-2",
    ])
    createSlice({ missionId: mission.id, key: "api", title: "API" })
    const slices = createSlice({
      missionId: mission.id,
      key: "api",
      title: "API",
    })
    expect(slices.slices.map((s) => s.key).sort()).toEqual(["api", "api-2"])

    // A key freed by deletion can be reused.
    deleteInitiative(first.initiative.id)
    expect(createInitiative({ ...base, key: "test" }).initiative.key).toBe(
      "test"
    )
  })

  it("rejects renaming a key onto an existing one with a readable error", () => {
    const base = { name: "X", intent: "", definitionOfDone: "" }
    createInitiative({ ...base, key: "alpha" })
    const beta = createInitiative({ ...base, key: "beta" })
    expect(() =>
      updateInitiative(beta.initiative.id, { key: "alpha" })
    ).toThrow("Initiative key “alpha” is already in use.")
    expect(
      updateInitiative(beta.initiative.id, { key: "beta" }).initiative.key
    ).toBe("beta")
  })

  it("binds rig, workspace, and project while draft and locks them at start", () => {
    const factory = createRig({ name: "Factory" })
    const other = createRig({ name: "Other" })
    const graph = createInitiative({
      key: "late-rig",
      name: "Late rig",
      intent: "",
      definitionOfDone: "",
    })
    const id = graph.initiative.id
    expect(updateInitiative(id, { rigId: factory.id }).initiative.rigId).toBe(
      factory.id
    )
    startInitiative(id)
    expect(() => updateInitiative(id, { rigId: other.id })).toThrow(
      /can't be changed after an initiative has started/
    )
    expect(() => updateInitiative(id, { workspaceId: null })).not.toThrow()
    expect(() => updateInitiative(id, { projectId: null })).not.toThrow()
    // Resending the current binding alongside other edits is harmless.
    expect(
      updateInitiative(id, { rigId: factory.id, name: "Renamed" }, "user", "r")
        .initiative.name
    ).toBe("Renamed")
  })

  it("refuses to delete a rig used by a running initiative", () => {
    const rig = createRig({ name: "Factory" })
    const base = { intent: "", definitionOfDone: "", rigId: rig.id }
    const draft = createInitiative({ ...base, key: "draft", name: "Draft" })
    const running = createInitiative({ ...base, key: "run", name: "Running" })
    startInitiative(running.initiative.id)
    expect(() => deleteRig(rig.id)).toThrow(/in use by “Running”/)

    db.prepare("UPDATE initiatives SET status = 'completed' WHERE id = ?").run(
      running.initiative.id
    )
    deleteRig(rig.id)
    expect(getInitiativeGraph(draft.initiative.id)?.initiative.rigId).toBeNull()
    const finished = getInitiativeGraph(running.initiative.id)!
    // The snapshot survives, and a deleted rig is not reported as drift.
    expect(finished.initiative.rigSnapshot?.rig.name).toBe("Factory")
    expect(finished.rigDrifted).toBe(false)
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { sqliteLoadsForTests } from "../../test/sqlite"
import { runMigrations } from "../migrations"

const sqliteLoads = sqliteLoadsForTests()
let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

import { createPod, createRig } from "./rigs"
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
})

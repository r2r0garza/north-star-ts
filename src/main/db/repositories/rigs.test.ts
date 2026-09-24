import { beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { sqliteLoadsForTests } from "../../test/sqlite"
import { runMigrations } from "../migrations"

const sqliteLoads = sqliteLoadsForTests()
let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

import {
  RigValidationError,
  createPod,
  createRig,
  createSeat,
  deleteRig,
  diagnoseRig,
  duplicateRig,
  getRigGraph,
  listRigs,
  setOversight,
  updatePod,
  updateSeat,
} from "./rigs"

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)("rig repository", () => {
  it("persists a complete rig graph and cascades deletes", () => {
    const rig = createRig({ name: "Orchestrated", cultureMd: "Be clear." })
    const orchestration = createPod({
      rigId: rig.id,
      key: "orchestration",
      name: "Orchestration",
    })
    const implementation = createPod({
      rigId: rig.id,
      key: "implementation",
      name: "Implementation",
    })
    const lead = createSeat({
      podId: orchestration.id,
      key: "lead",
      role: "lead",
      decisionRights: ["assign_slice", "escalate_to_user"],
    })
    createSeat({ podId: implementation.id, key: "builder", role: "builder" })
    updatePod(orchestration.id, { leadSeatId: lead.id })
    setOversight(rig.id, [
      { overseerPodId: orchestration.id, overseenPodId: implementation.id },
    ])

    const graph = getRigGraph(rig.id)!
    expect(graph.pods).toHaveLength(2)
    expect(graph.seats).toHaveLength(2)
    expect(graph.oversight).toHaveLength(1)
    expect(graph.pods[0].leadSeatId).toBe(lead.id)

    deleteRig(rig.id)
    expect(listRigs()).toHaveLength(0)
    expect(db.prepare("SELECT COUNT(*) AS n FROM rig_seats").get()).toEqual({ n: 0 })
  })

  it("rejects invalid keys, foreign leads, and cyclic oversight", () => {
    const rig = createRig({ name: "Rig" })
    expect(() => createPod({ rigId: rig.id, key: "system", name: "Bad" })).toThrow(
      RigValidationError
    )
    const a = createPod({ rigId: rig.id, key: "a", name: "A" })
    const b = createPod({ rigId: rig.id, key: "b", name: "B" })
    const seat = createSeat({ podId: b.id, key: "lead", role: "lead" })
    expect(() => updatePod(a.id, { leadSeatId: seat.id })).toThrow(
      /must be a seat in that pod/
    )
    expect(() =>
      setOversight(rig.id, [
        { overseerPodId: a.id, overseenPodId: b.id },
        { overseerPodId: b.id, overseenPodId: a.id },
      ])
    ).toThrow(/acyclic/)
    expect(() =>
      setOversight(rig.id, [{ overseerPodId: a.id, overseenPodId: a.id }])
    ).toThrow(/^A pod cannot oversee itself\.$/)
  })

  it("reports duplicate seat addresses as domain validation errors", () => {
    const rig = createRig({ name: "Rig" })
    const pod = createPod({ rigId: rig.id, key: "build", name: "Build" })
    const seat = createSeat({ podId: pod.id, key: "builder", role: "builder" })

    expect(() => createSeat({ podId: pod.id, key: "builder", role: "qa" })).toThrow(
      /seat address builder@build is already in use/
    )
    const qa = createSeat({ podId: pod.id, key: "qa", role: "qa" })
    expect(() => updateSeat(qa.id, { key: seat.key })).toThrow(
      /seat address builder@build is already in use/
    )
  })

  it("warns about duplicate-looking seats", () => {
    const rig = createRig({ name: "Rig" })
    const pod = createPod({ rigId: rig.id, key: "build", name: "Build" })
    createSeat({ podId: pod.id, key: "one", role: "builder", agentRefId: "agentref:v1:x" })
    createSeat({ podId: pod.id, key: "two", role: "builder", agentRefId: "agentref:v1:x" })
    expect(diagnoseRig(getRigGraph(rig.id)!)).toContainEqual(
      expect.objectContaining({ severity: "warning", code: "redundant_seats" })
    )
  })

  it("duplicates with fresh ids and equivalent topology", () => {
    const rig = createRig({ name: "Solo" })
    const pod = createPod({ rigId: rig.id, key: "delivery", name: "Delivery" })
    createSeat({ podId: pod.id, key: "builder", role: "builder" })
    const copy = duplicateRig(rig.id)
    expect(copy.rig.id).not.toBe(rig.id)
    expect(copy.pods[0].id).not.toBe(pod.id)
    expect(copy.seats[0].key).toBe("builder")
  })
})

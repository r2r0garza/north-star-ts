import { beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { sqliteLoadsForTests } from "../test/sqlite"
import { runMigrations } from "../db/migrations"
import {
  createPod,
  createRig,
  createSeat,
  getRigGraph,
  setOversight,
  updatePod,
} from "../db/repositories/rigs"

const sqliteLoads = sqliteLoadsForTests()
let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))

import { buildRigExport, importRigExport } from "./io"

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)("rig import/export", () => {
  it("round-trips topology with fresh ids and no local account ids", () => {
    db.prepare(
      `INSERT INTO provider_accounts
       (id, provider, display_name, base_url, encrypted_key, api_mode, enabled, position, created_at, last_used_at)
       VALUES ('local-account', 'openai', 'OpenAI', NULL, NULL, 'responses', 1, 0, 0, NULL)`
    ).run()
    const rig = createRig({ name: "Orchestrated", cultureMd: "Stay aligned." })
    const leadPod = createPod({ rigId: rig.id, key: "orchestration", name: "Orchestration" })
    const buildPod = createPod({ rigId: rig.id, key: "implementation", name: "Implementation" })
    const lead = createSeat({ podId: leadPod.id, key: "lead", role: "lead" })
    createSeat({
      podId: buildPod.id,
      key: "builder",
      role: "builder",
      agentRefId: 'agentref:v1:{"sourceKind":"github","scope":"workspace","definitionPath":"/private/path","nativeName":"builder"}',
      agentLabel: "GitHub: builder",
      runtimeConfig: { worker: { accountId: "local-account", modelId: "gpt-5" } },
    })
    updatePod(leadPod.id, { leadSeatId: lead.id })
    setOversight(rig.id, [{ overseerPodId: leadPod.id, overseenPodId: buildPod.id }])

    const exported = buildRigExport(getRigGraph(rig.id)!)
    expect(JSON.stringify(exported)).not.toContain("local-account")
    expect(JSON.stringify(exported)).not.toContain("/private/path")
    expect(exported.seats[1].runtimeConfig?.worker?.provider).toBe("openai")

    const imported = importRigExport(exported)
    const copy = getRigGraph(imported.rigId)!
    expect(copy.rig.id).not.toBe(rig.id)
    expect(copy.pods.map((pod) => pod.key)).toEqual(["orchestration", "implementation"])
    expect(copy.oversight).toHaveLength(1)
    expect(copy.seats[1].runtimeConfig?.worker?.accountId).toBe("local-account")
    expect(imported.warnings).toContain("builder@implementation references an unavailable agent.")
  })
})

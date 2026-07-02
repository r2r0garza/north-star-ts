import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../migrations"

let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

let sqliteLoads = true
try {
  new Database(":memory:").close()
} catch {
  sqliteLoads = false
}

import { createAccount } from "./provider-accounts"
import {
  addModel,
  listModels,
  updateModel,
  deleteModel,
  mergeGatewayModels,
} from "./models"

let accountId: string

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
  accountId = createAccount({ provider: "portkey", displayName: "A" }).id
})

describe.skipIf(!sqliteLoads)("models repo", () => {
  it("adds a model with default origin manual", () => {
    const m = addModel({ accountId, modelId: "gpt-x" })
    expect(m.origin).toBe("manual")
    expect(m.modelName).toBeNull()
  })

  it("stores a custom display name", () => {
    const m = addModel({ accountId, modelId: "@p/long-id", modelName: "Fast" })
    expect(m.modelName).toBe("Fast")
  })

  it("adding a duplicate (account, model_id) is a no-op returning the existing row", () => {
    const a = addModel({ accountId, modelId: "dup", modelName: "First" })
    const b = addModel({ accountId, modelId: "dup", modelName: "Second" })
    expect(b.id).toBe(a.id)
    expect(b.modelName).toBe("First")
    expect(listModels(accountId)).toHaveLength(1)
  })

  it("updates id and name; deletes", () => {
    const m = addModel({ accountId, modelId: "old" })
    updateModel(m.id, { modelId: "new", modelName: "Renamed" })
    expect(getOnly(accountId).modelId).toBe("new")
    expect(getOnly(accountId).modelName).toBe("Renamed")
    deleteModel(m.id)
    expect(listModels(accountId)).toHaveLength(0)
  })

  it("merges gateway ids without clobbering existing rows", () => {
    addModel({
      accountId,
      modelId: "manual-1",
      modelName: "Mine",
      origin: "manual",
    })
    mergeGatewayModels(accountId, ["manual-1", "gw-1", "gw-2"])
    const models = listModels(accountId)
    // manual-1 kept its custom name + manual origin; two new gateway rows added.
    const manual = models.find((m) => m.modelId === "manual-1")!
    expect(manual.origin).toBe("manual")
    expect(manual.modelName).toBe("Mine")
    expect(
      models
        .filter((m) => m.origin === "gateway")
        .map((m) => m.modelId)
        .sort()
    ).toEqual(["gw-1", "gw-2"])
  })

  it("a second merge dedupes already-imported gateway ids", () => {
    mergeGatewayModels(accountId, ["gw-1"])
    mergeGatewayModels(accountId, ["gw-1", "gw-2"])
    expect(listModels(accountId)).toHaveLength(2)
  })
})

function getOnly(accountId: string) {
  const list = listModels(accountId)
  expect(list).toHaveLength(1)
  return list[0]
}

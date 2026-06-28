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

import {
  createAccount,
  getAccount,
  listAccounts,
  updateAccount,
  deleteAccount,
  setEncryptedKey,
  getEncryptedKey,
  clearKey,
} from "./provider-accounts"
import { addModel, listModels } from "./models"

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)("provider-accounts repo", () => {
  it("creates an account with no key (hasKey false)", () => {
    const a = createAccount({ provider: "portkey", displayName: "Work", baseUrl: "https://x/v1" })
    expect(a.provider).toBe("portkey")
    expect(a.hasKey).toBe(false)
    expect(getAccount(a.id)?.baseUrl).toBe("https://x/v1")
  })

  it("stores ciphertext as a BLOB and reflects hasKey, never leaking the blob", () => {
    const a = createAccount({ provider: "portkey", displayName: "Work" })
    setEncryptedKey(a.id, Buffer.from([1, 2, 3, 4]))
    // The public shape exposes only hasKey, not the ciphertext.
    expect(getAccount(a.id)?.hasKey).toBe(true)
    expect(getAccount(a.id) as unknown as Record<string, unknown>).not.toHaveProperty(
      "encrypted_key"
    )
    // The raw blob is only reachable via the dedicated accessor.
    expect(getEncryptedKey(a.id)).toEqual(Buffer.from([1, 2, 3, 4]))
  })

  it("clearKey removes the blob", () => {
    const a = createAccount({ provider: "portkey", displayName: "Work" })
    setEncryptedKey(a.id, Buffer.from([9]))
    clearKey(a.id)
    expect(getAccount(a.id)?.hasKey).toBe(false)
    expect(getEncryptedKey(a.id)).toBeUndefined()
  })

  it("updates non-secret fields and lists in creation order", () => {
    const a = createAccount({ provider: "portkey", displayName: "A" })
    createAccount({ provider: "openai_compatible", displayName: "B" })
    updateAccount(a.id, { displayName: "A2", baseUrl: "https://y/v1" })
    const list = listAccounts()
    expect(list.map((x) => x.displayName)).toEqual(["A2", "B"])
    expect(list[0].baseUrl).toBe("https://y/v1")
  })

  it("deleting an account cascades to its models", () => {
    const a = createAccount({ provider: "portkey", displayName: "A" })
    addModel({ accountId: a.id, modelId: "m1" })
    expect(listModels(a.id)).toHaveLength(1)
    deleteAccount(a.id)
    expect(getAccount(a.id)).toBeUndefined()
    expect(listModels(a.id)).toHaveLength(0)
  })
})

import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

import {
  createAccount,
  getAccount,
  listAccounts,
  updateAccount,
  deleteAccount,
  setEncryptedKey,
  getEncryptedKey,
  clearKey,
  reorderAccounts,
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
    const a = createAccount({
      provider: "portkey",
      displayName: "Work",
      baseUrl: "https://x/v1",
    })
    expect(a.provider).toBe("portkey")
    expect(a.hasKey).toBe(false)
    expect(a.enabled).toBe(true)
    expect(a.position).toBe(0)
    expect(getAccount(a.id)?.baseUrl).toBe("https://x/v1")
  })

  it("accepts the Claude Code CLI provider without credentials", () => {
    const account = createAccount({
      provider: "claude_code",
      displayName: "Claude Code CLI",
    })
    expect(account.provider).toBe("claude_code")
    expect(account.hasKey).toBe(false)
    addModel({ accountId: account.id, modelId: "claude-code" })
    expect(listModels(account.id).map((model) => model.modelId)).toEqual([
      "claude-code",
    ])
  })

  it("accepts the Codex CLI provider without credentials", () => {
    const account = createAccount({
      provider: "codex_cli",
      displayName: "Codex CLI",
    })
    expect(account.provider).toBe("codex_cli")
    expect(account.hasKey).toBe(false)
    addModel({ accountId: account.id, modelId: "gpt-5.3-codex" })
    expect(listModels(account.id).map((model) => model.modelId)).toEqual([
      "gpt-5.3-codex",
    ])
  })

  it("stores ciphertext as a BLOB and reflects hasKey, never leaking the blob", () => {
    const a = createAccount({ provider: "portkey", displayName: "Work" })
    setEncryptedKey(a.id, Buffer.from([1, 2, 3, 4]))
    // The public shape exposes only hasKey, not the ciphertext.
    expect(getAccount(a.id)?.hasKey).toBe(true)
    expect(
      getAccount(a.id) as unknown as Record<string, unknown>
    ).not.toHaveProperty("encrypted_key")
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

  it("persists an atomic authored provider order", () => {
    const a = createAccount({ provider: "portkey", displayName: "A" })
    const b = createAccount({ provider: "openai", displayName: "B" })
    const c = createAccount({ provider: "claude_code", displayName: "C" })
    expect([a.position, b.position, c.position]).toEqual([0, 1, 2])
    expect(reorderAccounts([c.id, a.id, b.id]).map((row) => row.id)).toEqual([
      c.id,
      a.id,
      b.id,
    ])
    expect(() => reorderAccounts([a.id, b.id])).toThrow(/stale/i)
  })

  it("updates the enabled flag", () => {
    const a = createAccount({ provider: "portkey", displayName: "A" })
    updateAccount(a.id, { enabled: false })
    expect(getAccount(a.id)?.enabled).toBe(false)
    updateAccount(a.id, { enabled: true })
    expect(getAccount(a.id)?.enabled).toBe(true)
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

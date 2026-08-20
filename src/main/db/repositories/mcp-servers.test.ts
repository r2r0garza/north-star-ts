import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../migrations"

// A real in-memory SQLite DB, migrated to the latest schema, wired in behind the
// connection singleton — the repo under test calls getDb() per query.
let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

import * as repo from "./mcp-servers"

// better-sqlite3 is compiled against Electron's ABI, so it may not load under the
// node-based vitest runner. Skip the DB-backed suite when the native module can't
// load (mirrors migrations.test.ts / index service.test.ts).
let sqliteLoads = true
try {
  new Database(":memory:").close()
} catch {
  sqliteLoads = false
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

afterEach(() => {
  if (!sqliteLoads) return
  db.close()
})

describe.skipIf(!sqliteLoads)("mcp server state side-store", () => {
  it("defaults a never-touched server to enabled (no row)", () => {
    expect(repo.isEnabled("brand-new")).toBe(true)
    expect(repo.hasOauth("brand-new")).toBe(false)
  })

  it("records an explicit disable and re-enable", () => {
    repo.setEnabled("srv", false)
    expect(repo.isEnabled("srv")).toBe(false)
    repo.setEnabled("srv", true)
    expect(repo.isEnabled("srv")).toBe(true)
  })

  it("resolves an enabled map with default-on for absent names", () => {
    repo.setEnabled("off-one", false)
    const map = repo.enabledMap(["off-one", "never-seen"])
    expect(map.get("off-one")).toBe(false)
    expect(map.get("never-seen")).toBe(true)
  })

  it("stores + reads oauth blobs and reflects hasOauth, then clears", () => {
    expect(repo.hasOauth("oauth-srv")).toBe(false)
    repo.setOauthTokens("oauth-srv", Buffer.from("cipher-tokens"))
    repo.setOauthClient("oauth-srv", Buffer.from("cipher-client"))
    expect(repo.hasOauth("oauth-srv")).toBe(true)
    expect(repo.getOauthTokens("oauth-srv")?.toString()).toBe("cipher-tokens")
    expect(repo.getOauthClient("oauth-srv")?.toString()).toBe("cipher-client")
    expect(repo.oauthNameSet().has("oauth-srv")).toBe(true)

    repo.clearOauth("oauth-srv")
    expect(repo.hasOauth("oauth-srv")).toBe(false)
    expect(repo.getOauthTokens("oauth-srv")).toBeUndefined()
    // Clearing OAuth must not disturb an unrelated enabled override.
    expect(repo.isEnabled("oauth-srv")).toBe(true)
  })

  it("preserves the enabled flag when only oauth changes and vice-versa", () => {
    repo.setEnabled("mix", false)
    repo.setOauthTokens("mix", Buffer.from("x"))
    // enable override survived the oauth write:
    expect(repo.isEnabled("mix")).toBe(false)
    expect(repo.hasOauth("mix")).toBe(true)
    // toggling enabled doesn't wipe oauth:
    repo.setEnabled("mix", true)
    expect(repo.hasOauth("mix")).toBe(true)
  })
})

import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../migrations"

// Mock the connection so the repo talks to an in-memory DB (mirrors todos.test).
let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

let sqliteLoads = true
try {
  new Database(":memory:").close()
} catch {
  sqliteLoads = false
}

import { getSetting, setSetting, getAll } from "./settings"

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)("migrations", () => {
  it("brings a fresh DB to the latest user_version", () => {
    expect(db.pragma("user_version", { simple: true })).toBe(30)
  })
})

describe.skipIf(!sqliteLoads)("settings repo", () => {
  it("returns undefined for an unset key", () => {
    expect(getSetting("nope")).toBeUndefined()
  })

  it("round-trips a value", () => {
    setSetting("execution", '{"backend":"docker"}')
    expect(getSetting("execution")).toBe('{"backend":"docker"}')
  })

  it("upserts: a second set replaces the value", () => {
    setSetting("k", "first")
    setSetting("k", "second")
    expect(getSetting("k")).toBe("second")
  })

  it("getAll returns every key/value", () => {
    setSetting("a", "1")
    setSetting("b", "2")
    expect(getAll()).toEqual({ a: "1", b: "2" })
  })
})

import { describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { mkdtempSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runMigrations } from "./migrations"
import { ORCHESTRATION_TABLES } from "./retire-orchestration"
import { sqliteLoadsForTests } from "../test/sqlite"

describe.skipIf(!sqliteLoadsForTests())("orchestration retirement", () => {
  it("preserves shared rows, cancels only retired work, and does not resurrect tables", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db, { through: 70 })
    db.exec(`INSERT INTO conversations (id, mode, created_at, updated_at) VALUES ('chat', 'chat', 1, 1);
      INSERT INTO tasks (id, conversation_id, status, input, created_at, updated_at) VALUES
      ('old', 'chat', 'running', '{"kind":"process_run"}', 1, 1),
      ('wake', 'chat', 'paused', '{"kind":"seat_wake"}', 1, 1),
      ('keep', 'chat', 'queued', '{"kind":"agent_chat"}', 1, 1);
      INSERT INTO messages (id, conversation_id, seq, role, content, created_at) VALUES ('m', 'chat', 1, 'user', 'keep me', 1);`)
    runMigrations(db)
    runMigrations(db)
    db.pragma("user_version = 999")
    runMigrations(db)
    for (const table of ORCHESTRATION_TABLES)
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(table)
      ).toBeUndefined()
    expect(
      db.prepare("SELECT id, status FROM tasks ORDER BY id").all()
    ).toEqual([
      { id: "keep", status: "queued" },
      { id: "old", status: "cancelled" },
      { id: "wake", status: "cancelled" },
    ])
    expect(db.prepare("SELECT content FROM messages").pluck().get()).toBe(
      "keep me"
    )
    expect(db.pragma("foreign_key_check")).toEqual([])
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok")
    db.close()
  })

  it("leaves the old schema intact when backup creation fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "north-star-backup-failure-"))
    const db = new Database(join(dir, "test.db"))
    try {
      runMigrations(db, { through: 70 })
      const prepare = db.prepare.bind(db)
      const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
        if (sql === "VACUUM INTO ?") throw new Error("backup unavailable")
        return prepare(sql)
      }) as typeof db.prepare)
      expect(() => runMigrations(db)).toThrow("backup unavailable")
      spy.mockRestore()
      expect(db.pragma("user_version", { simple: true })).toBe(70)
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name = 'process_definitions'"
          )
          .get()
      ).toBeTruthy()
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("backs up a file database before deleting orchestration data", () => {
    const dir = mkdtempSync(join(tmpdir(), "north-star-retirement-"))
    const file = join(dir, "test.db")
    const db = new Database(file)
    try {
      runMigrations(db, { through: 70 })
      db.exec(
        "INSERT INTO process_definitions (id, name, created_at, updated_at) VALUES ('saved', 'Saved workflow', 1, 1)"
      )
      runMigrations(db)
      const backup = `${file}.before-orchestration-retirement.bak`
      expect(existsSync(backup)).toBe(true)
      const saved = new Database(backup, { readonly: true })
      expect(
        saved
          .prepare(
            "SELECT name FROM sqlite_master WHERE name = 'process_definitions'"
          )
          .get()
      ).toBeTruthy()
      expect(
        saved
          .prepare("SELECT name FROM process_definitions WHERE id = 'saved'")
          .pluck()
          .get()
      ).toBe("Saved workflow")
      expect(saved.pragma("integrity_check", { simple: true })).toBe("ok")
      saved.close()
      runMigrations(db)
      const original = new Database(backup, { readonly: true })
      expect(original.pragma("user_version", { simple: true })).toBe(70)
      original.close()
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

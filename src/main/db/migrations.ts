import type Database from "better-sqlite3"
import {
  SCHEMA_V1,
  SCHEMA_V2,
  SCHEMA_V3,
  SCHEMA_V4,
  SCHEMA_V5,
  SCHEMA_V6,
  SCHEMA_V7,
  SCHEMA_V8,
  SCHEMA_V9,
  SCHEMA_V10,
} from "./schema"

// Ordered migrations. Index 0 runs to reach user_version 1, index 1 to reach 2,
// and so on. Add a new entry to evolve the schema (e.g. future repo-indexing
// tables) — never edit a shipped migration, append a new one.
const MIGRATIONS: Array<(db: Database.Database) => void> = [
  (db) => db.exec(SCHEMA_V1),
  (db) => db.exec(SCHEMA_V2),
  (db) => db.exec(SCHEMA_V3),
  (db) => db.exec(SCHEMA_V4),
  (db) => db.exec(SCHEMA_V5),
  (db) => db.exec(SCHEMA_V6),
  (db) => db.exec(SCHEMA_V7),
  (db) => db.exec(SCHEMA_V8),
  (db) => db.exec(SCHEMA_V9),
  (db) => db.exec(SCHEMA_V10),
]

// Apply every migration newer than the database's current user_version, each in
// its own transaction, then stamp the new version. Synchronous (better-sqlite3).
//
// foreign_keys is disabled for the duration of the loop: v8 rebuilds the tasks
// table (DROP + rename to widen a CHECK constraint), and with enforcement on the
// DROP would cascade-delete task_events/approvals/task_checkpoints. The
// foreign_key_check after re-enabling verifies the rebuild left no dangling refs.
// PRAGMA foreign_keys is a no-op inside a transaction, so it's toggled outside
// the per-migration transactions.
export function runMigrations(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number
  if (current >= MIGRATIONS.length) return
  const fkWasOn = db.pragma("foreign_keys", { simple: true }) === 1
  if (fkWasOn) db.pragma("foreign_keys = OFF")
  try {
    for (let version = current; version < MIGRATIONS.length; version++) {
      const migrate = MIGRATIONS[version]
      const apply = db.transaction(() => {
        migrate(db)
        // PRAGMA can't be parameterized; version is a controlled integer.
        db.pragma(`user_version = ${version + 1}`)
      })
      apply()
    }
  } finally {
    if (fkWasOn) db.pragma("foreign_keys = ON")
  }
}

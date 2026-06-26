import type Database from "better-sqlite3"
import { SCHEMA_V1, SCHEMA_V2 } from "./schema"

// Ordered migrations. Index 0 runs to reach user_version 1, index 1 to reach 2,
// and so on. Add a new entry to evolve the schema (e.g. future repo-indexing
// tables) — never edit a shipped migration, append a new one.
const MIGRATIONS: Array<(db: Database.Database) => void> = [
  (db) => db.exec(SCHEMA_V1),
  (db) => db.exec(SCHEMA_V2),
]

// Apply every migration newer than the database's current user_version, each in
// its own transaction, then stamp the new version. Synchronous (better-sqlite3).
export function runMigrations(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number
  for (let version = current; version < MIGRATIONS.length; version++) {
    const migrate = MIGRATIONS[version]
    const apply = db.transaction(() => {
      migrate(db)
      // PRAGMA can't be parameterized; version is a controlled integer.
      db.pragma(`user_version = ${version + 1}`)
    })
    apply()
  }
}

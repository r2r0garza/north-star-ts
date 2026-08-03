import Database from "better-sqlite3"
import { app } from "electron"
import { join } from "path"
import { runMigrations } from "./migrations"
import { systemSlug } from "../config/system-name"

// Singleton connection. Opened lazily on first access so it reads
// app.getPath("userData") after the app is ready.
let db: Database.Database | undefined

export function getDb(): Database.Database {
  if (!db) {
    const file = join(app.getPath("userData"), `${systemSlug()}.db`)
    db = new Database(file)
    // WAL for concurrent reads + crash resilience; foreign_keys is OFF by
    // default per-connection in SQLite and must be enabled for cascades;
    // busy_timeout avoids SQLITE_BUSY under brief write contention.
    db.pragma("journal_mode = WAL")
    db.pragma("foreign_keys = ON")
    db.pragma("busy_timeout = 5000")
    runMigrations(db)
  }
  return db
}

// Close the connection on shutdown (flushes WAL). Safe to call when unopened.
export function closeDb(): void {
  if (db) {
    db.close()
    db = undefined
  }
}

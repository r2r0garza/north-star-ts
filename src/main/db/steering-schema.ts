import type Database from "better-sqlite3"

export function ensureSteeringMessages(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS steering_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued', 'returned', 'delivered', 'cancelled')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_steering_pending ON steering_messages(conversation_id, status);`)
}

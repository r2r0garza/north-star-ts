import type Database from "better-sqlite3"

export function ensureConversationArtifacts(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_artifact_revisions (
      artifact_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      invocation_id TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK(byte_length <= 262144),
      PRIMARY KEY(artifact_id, revision),
      UNIQUE(conversation_id, invocation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_conversation
      ON conversation_artifact_revisions(conversation_id);
    CREATE TABLE IF NOT EXISTS tool_result_artifacts (
      lifecycle_id TEXT PRIMARY KEY REFERENCES tool_call_lifecycle(id) ON DELETE CASCADE,
      artifact_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      FOREIGN KEY(artifact_id, revision) REFERENCES conversation_artifact_revisions(artifact_id, revision) ON DELETE CASCADE
    );
  `)
}

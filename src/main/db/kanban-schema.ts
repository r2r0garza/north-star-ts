import type Database from "better-sqlite3"

// Plan 136.1: kanban boards fed by external trackers. Runs and upstream-action
// tables arrive with 136.2/136.3 as their own additive migrations. Statuses are
// bare TEXT validated in repositories/kanban.ts; JSON blobs are TEXT.
export function ensureKanban(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS kanban_boards (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  workspace        TEXT,
  source           TEXT,
  filter           TEXT NOT NULL,
  approved_hash    TEXT,
  sync_interval_ms INTEGER NOT NULL,
  last_sync_at     INTEGER,
  last_sync_error  TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kanban_columns (
  id       TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES kanban_boards(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kanban_columns_board ON kanban_columns(board_id, position);
CREATE TABLE IF NOT EXISTS kanban_cards (
  id          TEXT PRIMARY KEY,
  board_id    TEXT NOT NULL REFERENCES kanban_boards(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  item        TEXT NOT NULL,
  column_id   TEXT REFERENCES kanban_columns(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(board_id, external_id)
);
`)
}

// Plan 136.2: columns run an agent; cards carry run state and their worktree;
// kanban_card_runs records each column attempt. Bare TEXT statuses.
export function ensureKanbanRuns(db: Database.Database): void {
  // Idempotent: migrations can be replayed when user_version is repaired.
  const add = (table: string, column: string, definition: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string
    }>
    if (!cols.some((c) => c.name === column))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`)
  }
  add("kanban_columns", "agent_name", "TEXT")
  add("kanban_columns", "instructions", "TEXT NOT NULL DEFAULT ''")
  add("kanban_columns", "gate", "TEXT NOT NULL DEFAULT 'agent'")
  add("kanban_cards", "run_state", "TEXT NOT NULL DEFAULT 'idle'")
  add("kanban_cards", "run_error", "TEXT")
  add("kanban_cards", "worktree", "TEXT")
  add("kanban_cards", "branch", "TEXT")
  db.exec(`
CREATE TABLE IF NOT EXISTS kanban_card_runs (
  id              TEXT PRIMARY KEY,
  card_id         TEXT NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
  column_id       TEXT REFERENCES kanban_columns(id) ON DELETE SET NULL,
  column_name     TEXT NOT NULL,
  task_id         TEXT,
  conversation_id TEXT,
  status          TEXT NOT NULL,
  result          TEXT,
  error           TEXT,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kanban_card_runs_card ON kanban_card_runs(card_id, started_at);
`)
}

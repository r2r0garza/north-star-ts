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

// Plan 136.3: column outcomes and upstream actions. Columns carry outcomes and
// action recipes (JSON); boards their write-approval level; cards the reported
// outcome, per-column visit/return counts, and a move parked on an action.
// kanban_upstream_actions is the audit log; `key` makes each action idempotent.
export function ensureKanbanActions(db: Database.Database): void {
  const add = (table: string, column: string, definition: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string
    }>
    if (!cols.some((c) => c.name === column))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`)
  }
  add("kanban_columns", "outcomes", "TEXT NOT NULL DEFAULT '[]'")
  add("kanban_columns", "actions", "TEXT NOT NULL DEFAULT '[]'")
  add(
    "kanban_boards",
    "write_approval",
    "TEXT NOT NULL DEFAULT 'once_per_action'"
  )
  add("kanban_boards", "approved_actions", "TEXT NOT NULL DEFAULT '[]'")
  add("kanban_boards", "actions_paused", "INTEGER NOT NULL DEFAULT 0")
  add("kanban_cards", "outcome", "TEXT")
  add("kanban_cards", "visits", "TEXT NOT NULL DEFAULT '{}'")
  add("kanban_cards", "returns", "TEXT NOT NULL DEFAULT '{}'")
  add("kanban_cards", "continuation", "TEXT")
  add("kanban_card_runs", "outcome", "TEXT")
  db.exec(`
CREATE TABLE IF NOT EXISTS kanban_upstream_actions (
  id          TEXT PRIMARY KEY,
  card_id     TEXT NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
  column_id   TEXT REFERENCES kanban_columns(id) ON DELETE SET NULL,
  column_name TEXT NOT NULL,
  action_name TEXT NOT NULL,
  phase       TEXT NOT NULL,
  outcome     TEXT,
  key         TEXT NOT NULL UNIQUE,
  recipe_hash TEXT NOT NULL,
  call        TEXT NOT NULL,
  status      TEXT NOT NULL,
  approved    INTEGER NOT NULL DEFAULT 0,
  output      TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kanban_upstream_actions_card ON kanban_upstream_actions(card_id, created_at);
`)
}

// A column worked by the user instead of an agent.
export function ensureKanbanColumnOwner(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(kanban_columns)").all() as Array<{
    name: string
  }>
  if (!cols.some((c) => c.name === "owner"))
    db.exec(
      "ALTER TABLE kanban_columns ADD COLUMN owner TEXT NOT NULL DEFAULT 'agent';"
    )
}

// Plan 136.5: a user column's own command and its time limit (null = off), and
// which runs are commands rather than agent turns.
export function ensureKanbanColumnCommands(db: Database.Database): void {
  const add = (table: string, column: string, definition: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string
    }>
    if (!cols.some((c) => c.name === column))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`)
  }
  add("kanban_columns", "command", "TEXT")
  add("kanban_columns", "command_timeout_ms", "INTEGER")
  add("kanban_card_runs", "kind", "TEXT NOT NULL DEFAULT 'agent'")
}

// Plan 136.6: worktrees on/off per board (default on: today's behavior) and per
// card (null = follow the board), parallel command runs, and the repos a card
// in a folder of repos has opened (JSON list of { path, branch, base }).
export function ensureKanbanWorktreeChoices(db: Database.Database): void {
  const add = (table: string, column: string, definition: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string
    }>
    if (!cols.some((c) => c.name === column))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`)
  }
  add("kanban_boards", "worktrees", "INTEGER NOT NULL DEFAULT 1")
  add("kanban_boards", "parallel_commands", "INTEGER NOT NULL DEFAULT 0")
  add("kanban_cards", "own_worktree", "INTEGER")
  add("kanban_cards", "repos", "TEXT NOT NULL DEFAULT '[]'")
}

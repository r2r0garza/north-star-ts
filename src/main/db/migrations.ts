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
  SCHEMA_V11,
  SCHEMA_V12,
  SCHEMA_V13,
  SCHEMA_V14,
  SCHEMA_V15,
  SCHEMA_V16,
  SCHEMA_V17,
  SCHEMA_V18,
  SCHEMA_V19,
  SCHEMA_V20,
  SCHEMA_V21,
  SCHEMA_V22,
  SCHEMA_V23,
  SCHEMA_V24,
  SCHEMA_V25,
  SCHEMA_V26,
  SCHEMA_V27,
  SCHEMA_V28,
  SCHEMA_V29,
  SCHEMA_V30,
  SCHEMA_V31,
  SCHEMA_V32,
  SCHEMA_V33,
  SCHEMA_V34,
  SCHEMA_V35,
  SCHEMA_V36,
  SCHEMA_V37,
  SCHEMA_V38,
  SCHEMA_V39,
  SCHEMA_V40,
  SCHEMA_V41,
  SCHEMA_V43,
  SCHEMA_V44,
  SCHEMA_V45,
  SCHEMA_V46,
  SCHEMA_V47,
  SCHEMA_V49_PHASE_AGENTS,
  SCHEMA_V50_TABLES,
  SCHEMA_V51_SEAT_SESSIONS,
  SCHEMA_V51_CONTEXT_SCOPES,
  SCHEMA_V49_TABLES,
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
  (db) => db.exec(SCHEMA_V11),
  (db) => db.exec(SCHEMA_V12),
  (db) => db.exec(SCHEMA_V13),
  (db) => db.exec(SCHEMA_V14),
  (db) => db.exec(SCHEMA_V15),
  (db) => db.exec(SCHEMA_V16),
  (db) => db.exec(SCHEMA_V17),
  (db) => db.exec(SCHEMA_V18),
  (db) => db.exec(SCHEMA_V19),
  (db) => db.exec(SCHEMA_V20),
  (db) => db.exec(SCHEMA_V21),
  (db) => db.exec(SCHEMA_V22),
  (db) => db.exec(SCHEMA_V23),
  (db) => db.exec(SCHEMA_V24),
  (db) => db.exec(SCHEMA_V25),
  (db) => db.exec(SCHEMA_V26),
  (db) => db.exec(SCHEMA_V27),
  (db) => db.exec(SCHEMA_V28),
  (db) => db.exec(SCHEMA_V29),
  (db) => db.exec(SCHEMA_V30),
  (db) => db.exec(SCHEMA_V31),
  (db) => db.exec(SCHEMA_V32),
  (db) => db.exec(SCHEMA_V33),
  (db) => db.exec(SCHEMA_V34),
  (db) => db.exec(SCHEMA_V35),
  (db) => db.exec(SCHEMA_V36),
  (db) => db.exec(SCHEMA_V37),
  (db) => db.exec(SCHEMA_V38),
  (db) => db.exec(SCHEMA_V39),
  (db) => db.exec(SCHEMA_V40),
  (db) => db.exec(SCHEMA_V41),
  ensureProcessRuntimeProfileColumns,
  (db) => db.exec(SCHEMA_V43),
  (db) => db.exec(SCHEMA_V44),
  (db) => db.exec(SCHEMA_V45),
  (db) => db.exec(SCHEMA_V46),
  (db) => db.exec(SCHEMA_V47),
  ensureProcessResultContentColumn,
  ensureMissionControlPlaybooks,
  ensureMissionControlComms,
  ensureContextScopes,
]

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get(table)
  )
}

function columnExists(
  db: Database.Database,
  table: string,
  column: string
): boolean {
  if (!tableExists(db, table)) return false
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).some(
    (info) => info.name === column
  )
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definition: string
): void {
  if (!tableExists(db, table) || columnExists(db, table, column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`)
}

function ensureProcessResultContentColumn(db: Database.Database): void {
  addColumnIfMissing(db, "process_phase_runs", "result_content", "TEXT")
}

// v49 (plan 106.3). Idempotent so the prerelease self-heal pass can re-run it.
function ensureMissionControlPlaybooks(db: Database.Database): void {
  if (tableExists(db, "initiatives")) db.exec(SCHEMA_V49_TABLES)
  if (tableExists(db, "process_phase_agents")) {
    const agentName = (
      db.pragma("table_info(process_phase_agents)") as Array<{
        name: string
        notnull: number
      }>
    ).find((column) => column.name === "agent_name")
    if (agentName?.notnull === 1) {
      addColumnIfMissing(db, "process_phase_agents", "runtime_config", "TEXT")
      db.exec(SCHEMA_V49_PHASE_AGENTS)
    }
  }
  addColumnIfMissing(db, "process_phase_agents", "seat_role", "TEXT")
  addColumnIfMissing(
    db,
    "process_phases",
    "proof_step",
    "INTEGER NOT NULL DEFAULT 0"
  )
  addColumnIfMissing(db, "process_runs", "seat_bindings", "TEXT")
  addColumnIfMissing(db, "process_runs", "mission_control", "TEXT")
  addColumnIfMissing(db, "process_phase_runs", "seat_address", "TEXT")
}

// v50 (plan 106.4). Idempotent so the prerelease self-heal pass can re-run it.
function ensureMissionControlComms(db: Database.Database): void {
  if (tableExists(db, "initiatives")) db.exec(SCHEMA_V50_TABLES)
  addColumnIfMissing(
    db,
    "process_phases",
    "context_mode",
    "TEXT NOT NULL DEFAULT 'step'"
  )
}

// v51 (plan 106.4 context scopes). Idempotent for the self-heal pass.
function ensureContextScopes(db: Database.Database): void {
  if (tableExists(db, "seat_sessions") && !columnExists(db, "seat_sessions", "scope_key"))
    db.exec(SCHEMA_V51_SEAT_SESSIONS)
  if (columnExists(db, "process_phases", "context_mode"))
    db.exec(SCHEMA_V51_CONTEXT_SCOPES)
}

function ensureProcessRuntimeProfileColumns(db: Database.Database): void {
  addColumnIfMissing(db, "process_phases", "runtime_config", "TEXT")
  addColumnIfMissing(db, "process_phase_agents", "runtime_config", "TEXT")
  addColumnIfMissing(db, "process_runs", "runtime_config", "TEXT")
  addColumnIfMissing(db, "process_phase_runs", "runtime_snapshot", "TEXT")
}

function ensureSubagentArtifactsTable(db: Database.Database): void {
  db.exec(SCHEMA_V45)
}

function ensureProjectPositionColumn(db: Database.Database): void {
  if (!tableExists(db, "projects")) return
  const hadPosition = columnExists(db, "projects", "position")
  addColumnIfMissing(db, "projects", "position", "INTEGER NOT NULL DEFAULT 0")
  if (!hadPosition) {
    db.exec(`
      WITH ordered AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY updated_at DESC) - 1 AS pos
        FROM projects
      )
      UPDATE projects
      SET position = (SELECT pos FROM ordered WHERE ordered.id = projects.id);
    `)
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_projects_position ON projects(position, updated_at DESC);"
  )
}

function ensureCodexSubscriptionProviderConstraints(
  db: Database.Database
): void {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'provider_accounts'"
    )
    .get() as { sql?: string } | undefined
  const sql = row?.sql ?? ""
  if (sql.includes("codex_subscription") && sql.includes("codex_responses")) {
    return
  }
  db.exec(SCHEMA_V43)
}

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
  const fkWasOn = db.pragma("foreign_keys", { simple: true }) === 1
  if (fkWasOn) db.pragma("foreign_keys = OFF")
  try {
    const startVersion = Math.min(current, MIGRATIONS.length)
    for (let version = startVersion; version < MIGRATIONS.length; version++) {
      const migrate = MIGRATIONS[version]
      const apply = db.transaction(() => {
        migrate(db)
        // PRAGMA can't be parameterized; version is a controlled integer.
        db.pragma(`user_version = ${version + 1}`)
      })
      apply()
    }

    // Development and prerelease databases can have a user_version stamped ahead
    // of this source tree after migration history is rebased or a build is run
    // against an experimental schema. The normal loop correctly skips those DBs,
    // so keep prerelease schema drift self-healing instead of making users repair
    // SQLite by hand.
    db.transaction(() => {
      ensureProcessRuntimeProfileColumns(db)
      ensureProcessResultContentColumn(db)
      ensureMissionControlPlaybooks(db)
      ensureMissionControlComms(db)
      ensureContextScopes(db)
      ensureCodexSubscriptionProviderConstraints(db)
      ensureProjectPositionColumn(db)
      ensureSubagentArtifactsTable(db)
    })()
  } finally {
    if (fkWasOn) db.pragma("foreign_keys = ON")
  }
}

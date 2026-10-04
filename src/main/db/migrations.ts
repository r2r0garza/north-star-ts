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
  SCHEMA_V52_MERGE_QUEUE,
  SCHEMA_V53_NAVIGATOR,
  SCHEMA_V49_TABLES,
} from "./schema"
import { renameWorkTerms } from "./work-terms-migration"

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
  // Skipped once v54 has renamed its tables, so re-running history on a current
  // database (a rewound user_version) doesn't recreate the old ones.
  (db) => {
    if (!tableExists(db, "features")) db.exec(SCHEMA_V47)
  },
  ensureProcessResultContentColumn,
  ensureMissionControlPlaybooks,
  ensureMissionControlComms,
  ensureContextScopes,
  ensureMissionIntegration,
  ensureNavigator,
  healAndRenameWorkTerms,
  ensurePhaseReviewColumn,
  // v56: the Python extractor. Re-indexing re-extracts only new or changed
  // files, so without this, Python files indexed before it existed would keep
  // their empty symbol lists forever. Mark them dirty once; the next index run
  // (every feature start triggers one) extracts them.
  (db) =>
    db.exec(
      "UPDATE index_files SET indexed_stage = 'file_map' WHERE ext IN ('.py', '.pyi')"
    ),
  retireMissionControlWorktreeWorkspaces,
  ensureGeneratedFilesColumn,
  ensureWorktreeSetupColumn,
  ensureConversationNotes,
  ensureSeatMemory,
  ensureHealth,
  ensurePlaybookHookOwnership,
  ensureWorkspaceAnalyses,
  ensureWorkspaceMissionControlColumn,
  ensurePhaseRunQaChecksColumn,
  ensureWorkspaceAppLaunchColumn,
  ensureWaveGates,
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

// v60: notes delivered to a running agent before its next model round (a
// user's nudge, or Mission Control telling a long phase to wrap up).
function ensureConversationNotes(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS conversation_notes (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  source          TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  delivered_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_conversation_notes_pending ON conversation_notes(conversation_id, delivered_at);
`)
}

// v61 (plan 106.7): seat memory with provenance and contact tracing, and the
// follow-up payload on plan proposals. Idempotent for the self-heal pass.
function ensureSeatMemory(db: Database.Database): void {
  if (tableExists(db, "plan_proposals"))
    addColumnIfMissing(db, "plan_proposals", "followup", "TEXT")
  if (!tableExists(db, "rigs")) return
  db.exec(`
CREATE TABLE IF NOT EXISTS seat_memories (
  id                     TEXT PRIMARY KEY,
  rig_id                 TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
  seat_address           TEXT NOT NULL,
  content                TEXT NOT NULL,
  kind                   TEXT NOT NULL,
  status                 TEXT NOT NULL,
  source                 TEXT NOT NULL DEFAULT 'learned',
  origin_feature_id      TEXT,
  origin_conversation_id TEXT,
  origin_session_id      TEXT,
  origin_user_story_id   TEXT,
  origin_message_id      TEXT,
  derived_from           TEXT REFERENCES seat_memories(id) ON DELETE SET NULL,
  use_count              INTEGER NOT NULL DEFAULT 0,
  last_used_at           INTEGER,
  created_at             INTEGER NOT NULL,
  reviewed_at            INTEGER,
  retracted_at           INTEGER,
  retract_reason         TEXT
);
CREATE INDEX IF NOT EXISTS idx_seat_memories_seat ON seat_memories(rig_id, seat_address, status);
CREATE INDEX IF NOT EXISTS idx_seat_memories_derived ON seat_memories(derived_from);

CREATE TABLE IF NOT EXISTS seat_memory_exposures (
  memory_id       TEXT NOT NULL REFERENCES seat_memories(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  feature_id      TEXT,
  seat_address    TEXT NOT NULL,
  injected_at     INTEGER NOT NULL,
  PRIMARY KEY (memory_id, conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_seat_memory_exposures_conversation ON seat_memory_exposures(conversation_id);
`)
}

// v63 (plan 106.9): whether a playbook hook owns its Process definition. Hooks
// created in Mission Control own theirs (deleting the playbook deletes it); a
// Process imported as a playbook stays the user's (0), so deleting the playbook
// leaves it alone and the legacy Processes list keeps showing it.
function ensurePlaybookHookOwnership(db: Database.Database): void {
  addColumnIfMissing(
    db,
    "playbook_hooks",
    "owns_process",
    "INTEGER NOT NULL DEFAULT 1"
  )
}

// v64 (plan 106.11): a Feature's workspace setup analysis (findings, the
// user's dismissals, results of checks that ran project code, and the exact
// commands the user approved). One row per Feature; JSON columns.
function ensureWorkspaceAnalyses(db: Database.Database): void {
  if (!tableExists(db, "features")) return
  // A prerelease build (the first 106.11 attempt) created this table with
  // another shape. Its rows are derived analysis results, recomputed by the
  // next Analyze, so replace the table rather than migrate them.
  const expected = [
    "feature_id",
    "workspace_id",
    "data",
    "dismissals",
    "check_results",
    "approvals",
    "updated_at",
  ]
  if (
    tableExists(db, "workspace_analyses") &&
    expected.some((column) => !columnExists(db, "workspace_analyses", column))
  )
    db.exec("DROP TABLE workspace_analyses;")
  db.exec(`
CREATE TABLE IF NOT EXISTS workspace_analyses (
  feature_id     TEXT PRIMARY KEY REFERENCES features(id) ON DELETE CASCADE,
  workspace_id   TEXT NOT NULL,
  data           TEXT NOT NULL,
  dismissals     TEXT NOT NULL DEFAULT '{}',
  check_results  TEXT NOT NULL DEFAULT '{}',
  approvals      TEXT NOT NULL DEFAULT '[]',
  updated_at     INTEGER NOT NULL
);
`)
}

// v62 (plan 106.8): the progress/ceremony event stream and the health
// signals detectors raise over it. Idempotent for the self-heal pass.
function ensureHealth(db: Database.Database): void {
  if (!tableExists(db, "features")) return
  db.exec(`
CREATE TABLE IF NOT EXISTS mc_events (
  id            TEXT PRIMARY KEY,
  feature_id    TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  milestone_id  TEXT,
  user_story_id TEXT,
  seat_address  TEXT,
  class         TEXT NOT NULL,
  type          TEXT NOT NULL,
  weight        REAL NOT NULL,
  ref_id        TEXT,
  detail        TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mc_events_feature_created ON mc_events(feature_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mc_events_ref ON mc_events(type, ref_id) WHERE ref_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS health_signals (
  id                    TEXT PRIMARY KEY,
  feature_id            TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  detector              TEXT NOT NULL,
  anchor_kind           TEXT NOT NULL,
  anchor_id             TEXT NOT NULL,
  anchor_label          TEXT NOT NULL DEFAULT '',
  severity              TEXT NOT NULL,
  status                TEXT NOT NULL,
  summary               TEXT NOT NULL,
  evidence              TEXT NOT NULL DEFAULT '[]',
  fire_count            INTEGER NOT NULL DEFAULT 1,
  first_seen_at         INTEGER NOT NULL,
  last_seen_at          INTEGER NOT NULL,
  alerted_at            INTEGER,
  alerted_to            TEXT,
  critical_at           INTEGER,
  acknowledged_at       INTEGER,
  resolved_at           INTEGER,
  refocus_count         INTEGER NOT NULL DEFAULT 0,
  last_refocus_at       INTEGER,
  refocus_conversations TEXT NOT NULL DEFAULT '[]',
  ignored_count         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_health_signals_feature ON health_signals(feature_id, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_health_signals_anchor ON health_signals(feature_id, detector, anchor_kind, anchor_id);
`)
}

// v59: how a workspace's Mission Control worktrees get an environment (JSON
// WorktreeSetup: paths linked from the main checkout and a setup command).
function ensureWorktreeSetupColumn(db: Database.Database): void {
  addColumnIfMissing(db, "workspaces", "worktree_setup", "TEXT")
}

// v65 (plan 109.01): a workspace's Mission Control settings (JSON
// WorkspaceMissionControlSettings: where QA seats write acceptance checks).
function ensureWorkspaceMissionControlColumn(db: Database.Database): void {
  addColumnIfMissing(db, "workspaces", "mission_control", "TEXT")
}

// v66 (plan 109.02): a QA step's acceptance checks state on its phase run
// (JSON PhaseRunQaChecks: freeze, drift, run_checks results).
function ensurePhaseRunQaChecksColumn(db: Database.Database): void {
  addColumnIfMissing(db, "process_phase_runs", "qa_checks", "TEXT")
}

// v67 (plan 109.03): how a workspace's app is started for Mission Control
// seats (JSON AppLaunch: services, ports, readiness, dependencies).
function ensureWorkspaceAppLaunchColumn(db: Database.Database): void {
  addColumnIfMissing(db, "workspaces", "app_launch", "TEXT")
}

// v68 (plan 110.01): wave acceptance gates, one row per gate a milestone ran
// over its merged user stories. Idempotent for the self-heal pass.
function ensureWaveGates(db: Database.Database): void {
  if (!tableExists(db, "milestones")) return
  db.exec(`
CREATE TABLE IF NOT EXISTS wave_gates (
  id              TEXT PRIMARY KEY,
  milestone_id    TEXT NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  round           INTEGER NOT NULL,
  story_ids       TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL,
  playbook_run_id TEXT,
  report          TEXT,
  checks_commit   TEXT,
  created_at      INTEGER NOT NULL,
  finished_at     INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wave_gates_round ON wave_gates(milestone_id, round);
CREATE INDEX IF NOT EXISTS idx_wave_gates_run ON wave_gates(playbook_run_id);
`)
}

// v58: a workspace's generated files and the command that rebuilds them
// (JSON GeneratedFilesRule[]), so merges regenerate rather than hand-merge them.
function ensureGeneratedFilesColumn(db: Database.Database): void {
  addColumnIfMissing(db, "workspaces", "generated_files", "TEXT")
}

// v55: when a phase run's validator review started (null when none is in
// flight), so the UI can show "Reviewing" instead of "Running" after the worker
// has finished.
function ensurePhaseReviewColumn(db: Database.Database): void {
  addColumnIfMissing(db, "process_phase_runs", "review_started_at", "INTEGER")
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
  if (
    tableExists(db, "seat_sessions") &&
    !columnExists(db, "seat_sessions", "scope_key")
  )
    db.exec(SCHEMA_V51_SEAT_SESSIONS)
  if (columnExists(db, "process_phases", "context_mode"))
    db.exec(SCHEMA_V51_CONTEXT_SCOPES)
}

// v52 (plan 106.5). Idempotent for the self-heal pass.
function ensureMissionIntegration(db: Database.Database): void {
  addColumnIfMissing(db, "missions", "base_ref", "TEXT")
  addColumnIfMissing(db, "missions", "base_oid", "TEXT")
  addColumnIfMissing(db, "missions", "repo_root", "TEXT")
  addColumnIfMissing(db, "missions", "landing", "TEXT")
  addColumnIfMissing(db, "slices", "worktree_path", "TEXT")
  addColumnIfMissing(db, "slices", "base_oid", "TEXT")
  addColumnIfMissing(db, "playbook_runs", "worktree_path", "TEXT")
  addColumnIfMissing(db, "workspaces", "hidden", "INTEGER NOT NULL DEFAULT 0")
  if (tableExists(db, "missions")) db.exec(SCHEMA_V52_MERGE_QUEUE)
}

// v53 (plan 106.6). Idempotent for the self-heal pass.
function ensureNavigator(db: Database.Database): void {
  if (!tableExists(db, "initiatives")) return
  addColumnIfMissing(db, "initiatives", "drive", "TEXT NOT NULL DEFAULT '{}'")
  addColumnIfMissing(db, "missions", "dod_review", "TEXT")
  db.exec(SCHEMA_V53_NAVIGATOR)
}

// v54. Heal the Mission Control schema under its old names first, so a drifted
// prerelease database is complete before its tables and columns are renamed.
function healAndRenameWorkTerms(db: Database.Database): void {
  if (tableExists(db, "initiatives")) {
    ensureMissionControlPlaybooks(db)
    ensureMissionControlComms(db)
    ensureContextScopes(db)
    ensureMissionIntegration(db)
    ensureNavigator(db)
  }
  renameWorkTerms(db)
}

// A Mission Control worktree: <userData>/mission-control/worktrees/<featureId>/…
const MISSION_CONTROL_WORKTREE =
  /[\\/]mission-control[\\/]worktrees[\\/]([^\\/]+)[\\/]/

// v57: a conversation or run keeps the directory it works in on its own row
// (working_directory), so a Mission Control user story's worktree no longer
// needs a workspace of its own. Idempotent for the self-heal pass.
function ensureWorkingDirectoryColumns(db: Database.Database): void {
  addColumnIfMissing(db, "conversations", "working_directory", "TEXT")
  addColumnIfMissing(db, "process_runs", "working_directory", "TEXT")
}

// v57: every user story attempt used to register its worktree as a workspace,
// leaving a permanent, never-indexed row behind once the worktree was removed.
// Move each such workspace's conversations and runs onto their feature's
// workspace (keeping the worktree as their working directory), then delete it
// unless a project or feature still points at it.
function retireMissionControlWorktreeWorkspaces(db: Database.Database): void {
  ensureWorkingDirectoryColumns(db)
  const worktrees = (
    db.prepare("SELECT id, path FROM workspaces").all() as Array<{
      id: string
      path: string
    }>
  ).flatMap((row) => {
    const match = MISSION_CONTROL_WORKTREE.exec(row.path)
    return match ? [{ ...row, featureId: match[1] }] : []
  })
  if (!worktrees.length) return
  const worktreeIds = new Set(worktrees.map((w) => w.id))
  const featureWorkspace = tableExists(db, "features")
    ? db.prepare("SELECT workspace_id FROM features WHERE id = ?").pluck()
    : null
  const referencedBy = ["projects", "features"]
    .filter((table) => columnExists(db, table, "workspace_id"))
    .map((table) =>
      db
        .prepare(`SELECT 1 FROM ${table} WHERE workspace_id = ? LIMIT 1`)
        .pluck()
    )
  const indexTables = [
    "index_symbols",
    "index_metadata",
    "index_files",
    "index_runs",
  ].filter((table) => tableExists(db, table))
  for (const worktree of worktrees) {
    const found = featureWorkspace?.get(worktree.featureId) as
      | string
      | null
      | undefined
    const target = found && !worktreeIds.has(found) ? found : null
    for (const table of ["conversations", "process_runs"])
      db.prepare(
        `UPDATE ${table} SET working_directory = COALESCE(working_directory, ?), workspace_id = ? WHERE workspace_id = ?`
      ).run(worktree.path, target, worktree.id)
    if (referencedBy.some((stmt) => stmt.get(worktree.id))) continue
    // Foreign keys are off while migrating, so cascades don't fire.
    for (const table of indexTables)
      db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(worktree.id)
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(worktree.id)
  }
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
// `through` stops at that version and skips the self-heal pass, so tests can
// build a database exactly as an older build left it.
export function runMigrations(
  db: Database.Database,
  options: { through?: number } = {}
): void {
  const current = db.pragma("user_version", { simple: true }) as number
  const fkWasOn = db.pragma("foreign_keys", { simple: true }) === 1
  if (fkWasOn) db.pragma("foreign_keys = OFF")
  try {
    const target = Math.min(
      options.through ?? MIGRATIONS.length,
      MIGRATIONS.length
    )
    const startVersion = Math.min(current, target)
    for (let version = startVersion; version < target; version++) {
      const migrate = MIGRATIONS[version]
      const apply = db.transaction(() => {
        migrate(db)
        // PRAGMA can't be parameterized; version is a controlled integer.
        db.pragma(`user_version = ${version + 1}`)
      })
      apply()
    }
    if (options.through !== undefined) return

    // Development and prerelease databases can have a user_version stamped ahead
    // of this source tree after migration history is rebased or a build is run
    // against an experimental schema. The normal loop correctly skips those DBs,
    // so keep prerelease schema drift self-healing instead of making users repair
    // SQLite by hand.
    db.transaction(() => {
      ensureProcessRuntimeProfileColumns(db)
      ensureProcessResultContentColumn(db)
      ensurePhaseReviewColumn(db)
      ensureGeneratedFilesColumn(db)
      ensureWorktreeSetupColumn(db)
      ensureWorkspaceMissionControlColumn(db)
      ensurePhaseRunQaChecksColumn(db)
      ensureWorkspaceAppLaunchColumn(db)
      ensureWaveGates(db)
      ensureConversationNotes(db)
      ensureSeatMemory(db)
      ensureHealth(db)
      ensureWorkspaceAnalyses(db)
      ensureMissionControlPlaybooks(db)
      ensurePlaybookHookOwnership(db)
      ensureMissionControlComms(db)
      ensureContextScopes(db)
      ensureMissionIntegration(db)
      ensureNavigator(db)
      healAndRenameWorkTerms(db)
      ensureCodexSubscriptionProviderConstraints(db)
      ensureProjectPositionColumn(db)
      ensureSubagentArtifactsTable(db)
      ensureWorkingDirectoryColumns(db)
    })()
  } finally {
    if (fkWasOn) db.pragma("foreign_keys = ON")
  }
}

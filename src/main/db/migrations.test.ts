import * as schema from "./schema"
import { describe, it, expect } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "./migrations"
import {
  SCHEMA_V1,
  SCHEMA_V2,
  SCHEMA_V3,
  SCHEMA_V4,
  SCHEMA_V5,
  SCHEMA_V6,
  SCHEMA_V7,
  SCHEMA_V8,
  SCHEMA_V30,
  SCHEMA_V31,
  SCHEMA_V32,
  SCHEMA_V33,
  SCHEMA_V34,
  SCHEMA_V38,
} from "./schema"
import { sqliteLoadsForTests } from "../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

// Bring a DB to user_version 8 WITHOUT running V9, so a test can seed pre-V9
// orphans and then apply V9 via runMigrations. Mirrors runMigrations' FK-off loop.
function migrateTo8(db: Database.Database): void {
  db.pragma("foreign_keys = OFF")
  const upto = [
    SCHEMA_V1,
    SCHEMA_V2,
    SCHEMA_V3,
    SCHEMA_V4,
    SCHEMA_V5,
    SCHEMA_V6,
    SCHEMA_V7,
    SCHEMA_V8,
  ]
  for (const sql of upto) db.exec(sql)
  db.pragma("user_version = 8")
  db.pragma("foreign_keys = ON")
}

function seedConversation(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO conversations (id, mode, created_at, updated_at) VALUES (?, 'interactive', 0, 0)"
  ).run(id)
}

// A durable task with a forked worker conversation and one row in each child
// table. `source` null models an orphan (SET NULL left by a deleted session).
function seedTask(
  db: Database.Database,
  opts: {
    id: string
    workerConv: string
    source: string | null
    kind: string
  }
): void {
  seedConversation(db, opts.workerConv)
  db.prepare(
    "INSERT INTO tasks (id, conversation_id, source_conversation_id, status, input, created_at, updated_at) VALUES (?, ?, ?, 'interrupted', ?, 0, 0)"
  ).run(
    opts.id,
    opts.workerConv,
    opts.source,
    JSON.stringify({ kind: opts.kind })
  )
  db.prepare(
    "INSERT INTO messages (id, conversation_id, seq, role, created_at) VALUES (?, ?, 0, 'user', 0)"
  ).run(`${opts.id}-msg`, opts.workerConv)
  db.prepare(
    "INSERT INTO task_events (task_id, type, created_at) VALUES (?, 'note', 0)"
  ).run(opts.id)
  db.prepare(
    "INSERT INTO approvals (id, task_id, status, requested_at) VALUES (?, ?, 'pending', 0)"
  ).run(`${opts.id}-appr`, opts.id)
  db.prepare(
    "INSERT INTO task_checkpoints (id, task_id, state, created_at) VALUES (?, ?, '{}', 0)"
  ).run(`${opts.id}-cp`, opts.id)
}

function count(db: Database.Database, table: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  ).n
}

describe.skipIf(!sqliteLoads)("runMigrations", () => {
  it("brings a fresh DB to the latest user_version", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    expect(db.pragma("user_version", { simple: true })).toBe(66)
    expect(db.pragma("foreign_key_check")).toHaveLength(0)
    db.close()
  })

  it("adds durable tool-call lifecycle records in v38", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    seedConversation(db, "conversation")
    db.prepare(
      "INSERT INTO messages (id, conversation_id, seq, role, tool_calls, created_at) VALUES ('assistant', 'conversation', 1, 'assistant', '[]', 0)"
    ).run()
    db.prepare(
      `INSERT INTO tool_call_lifecycle
        (id, conversation_id, assistant_message_id, logical_round_id,
         tool_call_id, tool_name, arguments, invocation_id, identity, state,
         prepared_at, updated_at)
       VALUES ('life', 'conversation', 'assistant', 'after-seq:1',
         'call-1', 'read_file_tool', '{}', 'toolinv_test', '{}',
         'prepared', 0, 0)`
    ).run()
    expect(
      db
        .prepare("SELECT state FROM tool_call_lifecycle WHERE id = 'life'")
        .pluck()
        .get()
    ).toBe("prepared")
    expect(SCHEMA_V38).toContain("tool_call_lifecycle")
    db.close()
  })

  it("adds durable linked model request retry budgets through v37", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    seedConversation(db, "conversation")
    db.prepare(
      `INSERT INTO model_request_retry_budgets
        (id, conversation_id, logical_round_id, status, attempts_consumed,
         max_attempts, first_attempt_at, deadline_at, created_at, updated_at)
       VALUES ('budget', 'conversation', 'after-seq:1', 'in_progress', 1, 3, 1000, 121000, 1000, 1000)`
    ).run()
    expect(
      db
        .prepare(
          "SELECT deadline_at FROM model_request_retry_budgets WHERE id = 'budget'"
        )
        .pluck()
        .get()
    ).toBe(121000)
    expect(
      db
        .prepare(
          "SELECT retry_sequence, source, parent_budget_id FROM model_request_retry_budgets WHERE id = 'budget'"
        )
        .get()
    ).toEqual({
      retry_sequence: 0,
      source: "automatic",
      parent_budget_id: null,
    })
    db.close()
  })

  it("adds external agent model mappings in v33", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    db.prepare(
      `INSERT INTO provider_accounts
        (id, provider, display_name, api_mode, enabled, position, created_at)
       VALUES ('account', 'openai', 'OpenAI', 'completions', 1, 0, 0)`
    ).run()
    db.prepare(
      `INSERT INTO external_agent_model_mappings
        (source_kind, source_model, normalized_source_model,
         destination_account_id, destination_model_id, created_at, updated_at)
       VALUES ('claude', 'Haiku', 'haiku', 'account', 'anthropic/haiku', 0, 0)`
    ).run()
    expect(
      db
        .prepare(
          "SELECT destination_model_id FROM external_agent_model_mappings"
        )
        .pluck()
        .get()
    ).toBe("anthropic/haiku")
    db.close()
  })

  it("adds message FTS recall index in v34", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    seedConversation(db, "conversation")
    db.prepare(
      "INSERT INTO messages (id, conversation_id, seq, role, content, created_at) VALUES ('m1', 'conversation', 1, 'user', 'remember the red adapter', 0)"
    ).run()
    expect(
      db
        .prepare(
          "SELECT message_id FROM message_fts WHERE message_fts MATCH 'red'"
        )
        .pluck()
        .all()
    ).toEqual(["m1"])
    db.prepare("DELETE FROM conversations WHERE id = 'conversation'").run()
    expect(count(db, "message_fts")).toBe(0)
    db.close()
  })

  it("widens external agent model mappings for Copilot in v35", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    db.prepare(
      `INSERT INTO provider_accounts
        (id, provider, display_name, api_mode, enabled, position, created_at)
       VALUES ('account', 'openai', 'OpenAI', 'completions', 1, 0, 0)`
    ).run()
    db.prepare(
      `INSERT INTO external_agent_model_mappings
        (source_kind, source_model, normalized_source_model,
         destination_account_id, destination_model_id, created_at, updated_at)
       VALUES ('copilot', 'GPT-5', 'gpt-5', 'account', 'openai/gpt-5', 0, 0)`
    ).run()
    expect(
      db
        .prepare("SELECT source_kind FROM external_agent_model_mappings")
        .pluck()
        .get()
    ).toBe("copilot")
    db.close()
  })

  it("widens provider and CLI session constraints for Codex CLI (v31)", () => {
    const db = new Database(":memory:")
    db.exec(`
      CREATE TABLE provider_accounts (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, display_name TEXT NOT NULL,
        base_url TEXT, encrypted_key BLOB, api_mode TEXT NOT NULL DEFAULT 'completions',
        enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
        last_used_at INTEGER, position INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, mode TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE cli_sessions (
        conversation_id TEXT NOT NULL, provider TEXT NOT NULL, session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, provider), UNIQUE (provider, session_id)
      );
      INSERT INTO provider_accounts
        (id, provider, display_name, created_at)
      VALUES ('claude', 'claude_code', 'Claude Code CLI', 0);
      INSERT INTO conversations VALUES ('conversation', 'chat', 0, 0);
      INSERT INTO cli_sessions VALUES ('conversation', 'claude_code', 'session', 0, 0);
    `)
    db.exec(SCHEMA_V31)

    db.prepare(
      "INSERT INTO provider_accounts (id, provider, display_name, created_at) VALUES ('codex', 'codex_cli', 'Codex CLI', 0)"
    ).run()
    db.prepare(
      "INSERT INTO cli_sessions VALUES ('conversation', 'codex_cli', 'thread', 0, 0)"
    ).run()
    expect(
      db
        .prepare("SELECT provider FROM provider_accounts ORDER BY id")
        .pluck()
        .all()
    ).toEqual(["claude_code", "codex_cli"])
    db.close()
  })

  it("widens provider and api_mode constraints for Codex subscription (v43)", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)

    db.prepare(
      `INSERT INTO provider_accounts
        (id, provider, display_name, api_mode, enabled, position, created_at)
       VALUES ('codex-sub', 'codex_subscription', 'Codex Subscription', 'codex_responses', 1, 0, 0)`
    ).run()
    db.prepare(
      `INSERT INTO models
        (id, account_id, model_id, model_name, origin, favorite, created_at, updated_at)
       VALUES ('model', 'codex-sub', 'gpt-5.5', 'GPT-5.5', 'seeded', 1, 0, 0)`
    ).run()

    expect(
      db
        .prepare(
          "SELECT provider, api_mode FROM provider_accounts WHERE id = 'codex-sub'"
        )
        .get()
    ).toEqual({
      provider: "codex_subscription",
      api_mode: "codex_responses",
    })
    expect(db.pragma("foreign_key_check")).toHaveLength(0)
    db.close()
  })

  it("repairs stale provider constraints when user_version is already current", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    db.exec(`
      CREATE TABLE provider_accounts_without_codex_subscription (
        id            TEXT PRIMARY KEY,
        provider      TEXT NOT NULL CHECK (provider IN
                    ('portkey','openai_compatible','openai','claude_code','codex_cli','anthropic','google','azure_openai')),
        display_name  TEXT NOT NULL,
        base_url      TEXT,
        encrypted_key BLOB,
        api_mode      TEXT NOT NULL DEFAULT 'completions'
                    CHECK (api_mode IN ('completions','responses')),
        enabled       INTEGER NOT NULL DEFAULT 1,
        created_at    INTEGER NOT NULL,
        last_used_at  INTEGER,
        position      INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO provider_accounts_without_codex_subscription
        (id, provider, display_name, base_url, encrypted_key, api_mode, enabled, created_at, last_used_at, position)
      SELECT id, provider, display_name, base_url, encrypted_key, api_mode, enabled, created_at, last_used_at, position
      FROM provider_accounts;
      DROP TABLE provider_accounts;
      ALTER TABLE provider_accounts_without_codex_subscription RENAME TO provider_accounts;
      PRAGMA user_version = 44;
    `)

    runMigrations(db)

    db.prepare(
      `INSERT INTO provider_accounts
        (id, provider, display_name, api_mode, enabled, position, created_at)
       VALUES ('codex-sub', 'codex_subscription', 'Codex Subscription', 'codex_responses', 1, 0, 0)`
    ).run()
    expect(db.pragma("foreign_key_check")).toHaveLength(0)
    db.close()
  })

  it("repairs missing project positions when user_version is already current", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    db.exec(`
      INSERT INTO projects
        (id, name, workspace_id, position, created_at, updated_at)
      VALUES
        ('older', 'Older', NULL, 0, 0, 100),
        ('newer', 'Newer', NULL, 1, 0, 200);

      CREATE TABLE projects_without_position AS
        SELECT id, name, workspace_id, created_at, updated_at
        FROM projects;
      DROP TABLE projects;
      ALTER TABLE projects_without_position RENAME TO projects;
      PRAGMA user_version = 44;
    `)

    runMigrations(db)

    const rows = db
      .prepare("SELECT id, position FROM projects ORDER BY position ASC")
      .all() as Array<{ id: string; position: number }>
    expect(rows).toEqual([
      { id: "newer", position: 0 },
      { id: "older", position: 1 },
    ])
    db.close()
  })

  it("repairs a missing subagent artifacts table when user_version is ahead", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    db.exec(`
      DROP TABLE subagent_artifacts;
      PRAGMA user_version = 99;
    `)

    runMigrations(db)

    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'subagent_artifacts'"
      )
      .get()
    expect(table).toBeTruthy()
    expect(db.pragma("user_version", { simple: true })).toBe(99)
    db.close()
  })

  it("replaces a prerelease-shaped workspace_analyses table (plan 106.11)", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    db.exec(`
      DROP TABLE workspace_analyses;
      CREATE TABLE workspace_analyses (feature_id TEXT PRIMARY KEY, result TEXT);
      INSERT INTO workspace_analyses VALUES ('f', '{}');
    `)

    runMigrations(db)

    const columns = (
      db.pragma("table_info(workspace_analyses)") as Array<{ name: string }>
    ).map((c) => c.name)
    expect(columns).toEqual(
      expect.arrayContaining([
        "data",
        "dismissals",
        "check_results",
        "approvals",
      ])
    )
    db.close()
  })

  it("migrates Codex CLI aliases and legacy defaults (v32)", () => {
    const db = new Database(":memory:")
    db.exec(`
      CREATE TABLE provider_accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL);
      CREATE TABLE conversations (id TEXT PRIMARY KEY, account_id TEXT, model_id TEXT);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE models (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, model_id TEXT NOT NULL,
        model_name TEXT, origin TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (account_id, model_id)
      );
      INSERT INTO provider_accounts VALUES ('codex', 'codex_cli');
      INSERT INTO conversations VALUES ('conversation', 'codex', 'codex-cli');
      INSERT INTO settings VALUES (
        'llm', '{"activeAccountId":"codex","activeModelId":"codex-cli"}', 0
      );
      INSERT INTO models VALUES (
        'legacy', 'codex', 'codex-cli', 'Codex CLI', 'seeded', 0, 0, 0
      );
    `)
    db.exec(SCHEMA_V32)

    const aliases = db
      .prepare(
        "SELECT model_id FROM models WHERE account_id = 'codex' ORDER BY favorite DESC, created_at ASC"
      )
      .all() as Array<{ model_id: string }>
    expect(aliases.map((row) => row.model_id)).toEqual([
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ])
    expect(db.prepare("SELECT model_id FROM conversations").pluck().get()).toBe(
      "gpt-5.3-codex"
    )
    expect(
      JSON.parse(
        db
          .prepare("SELECT value FROM settings WHERE key = 'llm'")
          .pluck()
          .get() as string
      ).activeModelId
    ).toBe("gpt-5.3-codex")
    db.close()
  })

  it("migrates Claude Code aliases and legacy defaults (v30)", () => {
    const db = new Database(":memory:")
    db.exec(`
      CREATE TABLE provider_accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL);
      CREATE TABLE conversations (id TEXT PRIMARY KEY, account_id TEXT, model_id TEXT);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE models (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, model_id TEXT NOT NULL,
        model_name TEXT, origin TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (account_id, model_id)
      );
      INSERT INTO provider_accounts VALUES ('claude', 'claude_code');
      INSERT INTO conversations VALUES ('conversation', 'claude', 'claude-code');
      INSERT INTO settings VALUES (
        'llm', '{"activeAccountId":"claude","activeModelId":"claude-code"}', 0
      );
      INSERT INTO models VALUES (
        'legacy', 'claude', 'claude-code', 'Claude Code', 'seeded', 0, 0, 0
      );
    `)
    db.exec(SCHEMA_V30)

    const aliases = db
      .prepare(
        "SELECT model_id FROM models WHERE account_id = 'claude' ORDER BY favorite DESC, created_at ASC"
      )
      .all() as Array<{ model_id: string }>
    expect(aliases.map((row) => row.model_id)).toEqual([
      "sonnet",
      "haiku",
      "opus",
      "fable",
    ])
    expect(db.prepare("SELECT model_id FROM conversations").pluck().get()).toBe(
      "sonnet"
    )
    expect(
      JSON.parse(
        db
          .prepare("SELECT value FROM settings WHERE key = 'llm'")
          .pluck()
          .get() as string
      ).activeModelId
    ).toBe("sonnet")
    db.close()
  })

  it("adds the process_runs.title column (v18)", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    const cols = (
      db.pragma("table_info(process_runs)") as Array<{ name: string }>
    ).map((c) => c.name)
    expect(cols).toContain("title")
    db.close()
  })

  it("adds the rework columns (v19, plan 029)", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    const phaseRunCols = db.pragma("table_info(process_phase_runs)") as Array<{
      name: string
      dflt_value: unknown
    }>
    const prNames = phaseRunCols.map((c) => c.name)
    expect(prNames).toContain("rework_note")
    expect(prNames).toContain("rework_round")
    // SQLite reports the declared default verbatim as a string.
    expect(
      String(phaseRunCols.find((c) => c.name === "rework_round")?.dflt_value)
    ).toBe("0")

    const phaseCols = db.pragma("table_info(process_phases)") as Array<{
      name: string
      dflt_value: unknown
    }>
    expect(phaseCols.map((c) => c.name)).toContain("max_rework_rounds")
    expect(
      String(phaseCols.find((c) => c.name === "max_rework_rounds")?.dflt_value)
    ).toBe("0")
    db.close()
  })

  it("adds the process_phases.dot_folder column (v20, plan 030)", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    const phaseCols = db.pragma("table_info(process_phases)") as Array<{
      name: string
      dflt_value: unknown
    }>
    expect(phaseCols.map((c) => c.name)).toContain("dot_folder")
    // SQLite reports the declared default verbatim as a string.
    expect(
      String(phaseCols.find((c) => c.name === "dot_folder")?.dflt_value)
    ).toBe("0")
    db.close()
  })

  it("adds the validator columns (v21, plan 031.1)", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    const phaseCols = db.pragma("table_info(process_phases)") as Array<{
      name: string
      dflt_value: unknown
    }>
    const phaseNames = phaseCols.map((c) => c.name)
    expect(phaseNames).toContain("validator")
    expect(phaseNames).toContain("validator_max_iterations")
    expect(phaseNames).toContain("validator_agent")
    // SQLite reports the declared default verbatim as a string.
    expect(
      String(phaseCols.find((c) => c.name === "validator")?.dflt_value)
    ).toBe("0")
    expect(
      String(
        phaseCols.find((c) => c.name === "validator_max_iterations")?.dflt_value
      )
    ).toBe("0")

    const phaseRunCols = db.pragma("table_info(process_phase_runs)") as Array<{
      name: string
      dflt_value: unknown
    }>
    expect(phaseRunCols.map((c) => c.name)).toContain("validator_round")
    expect(
      String(phaseRunCols.find((c) => c.name === "validator_round")?.dflt_value)
    ).toBe("0")
    db.close()
  })

  it("adds the phase output identity column (v39, debug 085)", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    const phaseRunCols = (
      db.pragma("table_info(process_phase_runs)") as Array<{ name: string }>
    ).map((c) => c.name)
    expect(phaseRunCols).toContain("output_identity")
    db.close()
  })

  it("adds process runtime config/snapshot columns", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    const phaseCols = (
      db.pragma("table_info(process_phases)") as Array<{ name: string }>
    ).map((c) => c.name)
    expect(phaseCols).toContain("runtime_config")
    const agentCols = (
      db.pragma("table_info(process_phase_agents)") as Array<{ name: string }>
    ).map((c) => c.name)
    expect(agentCols).toContain("runtime_config")
    const runCols = (
      db.pragma("table_info(process_runs)") as Array<{ name: string }>
    ).map((c) => c.name)
    expect(runCols).toContain("runtime_config")
    const phaseRunCols = (
      db.pragma("table_info(process_phase_runs)") as Array<{ name: string }>
    ).map((c) => c.name)
    expect(phaseRunCols).toContain("runtime_snapshot")
    db.close()
  })

  it("repairs missing process runtime columns even when user_version is already current or newer", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    db.pragma("foreign_keys = OFF")
    db.exec(`
      CREATE TABLE process_phases_without_runtime AS
        SELECT id, process_id, key, name, routing, gate_policy, fan_out,
               position, max_rework_rounds, dot_folder, validator,
               validator_max_iterations, validator_agent, subprocess_id,
               completion_contract
        FROM process_phases;
      DROP TABLE process_phases;
      ALTER TABLE process_phases_without_runtime RENAME TO process_phases;

      CREATE TABLE process_phase_agents_without_runtime AS
        SELECT id, phase_id, agent_name, skills, tools, position
        FROM process_phase_agents;
      DROP TABLE process_phase_agents;
      ALTER TABLE process_phase_agents_without_runtime RENAME TO process_phase_agents;

      CREATE TABLE process_runs_without_runtime AS
        SELECT id, process_id, source_conversation_id, task_id, objective,
               status, started_at, finished_at, created_at, workspace_id,
               title, parent_phase_run_id, completion_contracts
        FROM process_runs;
      DROP TABLE process_runs;
      ALTER TABLE process_runs_without_runtime RENAME TO process_runs;

      CREATE TABLE process_phase_runs_without_runtime AS
        SELECT id, run_id, phase_id, parent_id, status, task_id, agent_name,
               iteration, error, started_at, finished_at, title, rework_note,
               rework_round, validator_round, source_child_run_id,
               output_identity, failure, completion_receipt
        FROM process_phase_runs;
      DROP TABLE process_phase_runs;
      ALTER TABLE process_phase_runs_without_runtime RENAME TO process_phase_runs;
      PRAGMA user_version = 45;
    `)

    runMigrations(db)

    expect(db.pragma("user_version", { simple: true })).toBe(66)
    expect(
      (db.pragma("table_info(process_phases)") as Array<{ name: string }>).map(
        (c) => c.name
      )
    ).toContain("runtime_config")
    expect(
      (
        db.pragma("table_info(process_phase_agents)") as Array<{ name: string }>
      ).map((c) => c.name)
    ).toContain("runtime_config")
    expect(
      (db.pragma("table_info(process_runs)") as Array<{ name: string }>).map(
        (c) => c.name
      )
    ).toContain("runtime_config")
    expect(
      (
        db.pragma("table_info(process_phase_runs)") as Array<{ name: string }>
      ).map((c) => c.name)
    ).toContain("runtime_snapshot")
    db.close()
  })

  it("adds process failure context columns and attempt audit table (v40, debug 069)", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    const phaseRunCols = (
      db.pragma("table_info(process_phase_runs)") as Array<{ name: string }>
    ).map((c) => c.name)
    expect(phaseRunCols).toContain("failure")
    const attemptsTable = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='process_phase_attempts'"
      )
      .get()
    expect(attemptsTable).toBeTruthy()
    const attemptCols = (
      db.pragma("table_info(process_phase_attempts)") as Array<{ name: string }>
    ).map((c) => c.name)
    expect(attemptCols).toEqual(
      expect.arrayContaining([
        "phase_run_id",
        "worker_task_id",
        "stage",
        "attempt",
        "max_attempts",
        "failure",
      ])
    )
    db.close()
  })

  it("adds the flag-back schema (v22, plan 031.2)", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)

    // process_definitions.require_flag_approval, default 1.
    const defCols = db.pragma("table_info(process_definitions)") as Array<{
      name: string
      dflt_value: unknown
    }>
    expect(defCols.map((c) => c.name)).toContain("require_flag_approval")
    expect(
      String(
        defCols.find((c) => c.name === "require_flag_approval")?.dflt_value
      )
    ).toBe("1")

    // process_phase_runs.source_child_run_id.
    const prCols = (
      db.pragma("table_info(process_phase_runs)") as Array<{ name: string }>
    ).map((c) => c.name)
    expect(prCols).toContain("source_child_run_id")

    // process_flags table + its index.
    const flagsTable = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='process_flags'"
      )
      .get()
    expect(flagsTable).toBeTruthy()
    const flagCols = (
      db.pragma("table_info(process_flags)") as Array<{ name: string }>
    ).map((c) => c.name)
    expect(flagCols).toEqual(
      expect.arrayContaining([
        "id",
        "run_id",
        "flagging_phase_run_id",
        "target_phase_id",
        "target_child_run_id",
        "reason",
        "status",
        "created_at",
      ])
    )
    db.close()
  })

  it("a flag survives its flagging instance's deletion (v23, plan 031.2 follow-up)", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)

    // Minimal graph + run + a flagging phase-run + a flag pointing at it.
    db.prepare(
      "INSERT INTO process_definitions (id, name, require_flag_approval, created_at, updated_at) VALUES ('def','D',1,0,0)"
    ).run()
    db.prepare(
      "INSERT INTO process_phases (id, process_id, key, name, position) VALUES ('ph','def','k','K',0)"
    ).run()
    db.prepare(
      "INSERT INTO process_runs (id, process_id, status, created_at) VALUES ('run','def','running',0)"
    ).run()
    db.prepare(
      "INSERT INTO process_phase_runs (id, run_id, phase_id, status) VALUES ('pr','run','ph','completed')"
    ).run()
    db.prepare(
      "INSERT INTO process_flags (id, run_id, flagging_phase_run_id, target_phase_id, reason, status, created_at) VALUES ('flag','run','pr','ph','r','applied',0)"
    ).run()

    // Deleting the flagging phase-run must NOT cascade the flag away — the flag
    // survives with flagging_phase_run_id nulled (the durable audit record).
    db.prepare("DELETE FROM process_phase_runs WHERE id = 'pr'").run()
    const flag = db
      .prepare(
        "SELECT id, flagging_phase_run_id FROM process_flags WHERE id = 'flag'"
      )
      .get() as { id: string; flagging_phase_run_id: string | null } | undefined
    expect(flag).toBeTruthy()
    expect(flag!.flagging_phase_run_id).toBeNull()
    db.close()
  })

  it("adds subprocess_id / parent_phase_run_id columns (v24, plan 038.1)", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    const phaseCols = (
      db.pragma("table_info(process_phases)") as Array<{ name: string }>
    ).map((c) => c.name)
    expect(phaseCols).toContain("subprocess_id")
    const runCols = (
      db.pragma("table_info(process_runs)") as Array<{ name: string }>
    ).map((c) => c.name)
    expect(runCols).toContain("parent_phase_run_id")
    expect(db.pragma("foreign_key_check")).toHaveLength(0)
    db.close()
  })

  it("adds the dashboards tables (v26, plan 033)", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((t) => t.name)
    expect(tables).toContain("dashboards")
    expect(tables).toContain("dashboard_widgets")
    expect(tables).toContain("dashboard_widget_data")
    const widgetCols = (
      db.pragma("table_info(dashboard_widgets)") as Array<{ name: string }>
    ).map((c) => c.name)
    expect(widgetCols).toEqual(
      expect.arrayContaining(["type", "config", "recipe", "pos", "position"])
    )
    expect(db.pragma("foreign_key_check")).toHaveLength(0)
    db.close()
  })
})

describe.skipIf(!sqliteLoads)("SCHEMA_V9 — orphan reap (plan 022)", () => {
  it("reaps source-less tasks + workers + children, keeps live and workspace_index", () => {
    const db = new Database(":memory:")
    migrateTo8(db)

    // A live conversation with a healthy sourced task (must survive).
    const live = "conv-live"
    seedConversation(db, live)
    seedTask(db, {
      id: "task-live",
      workerConv: "wc-live",
      source: live,
      kind: "agent_chat",
    })

    // An orphaned agent_chat (source null) — must be reaped.
    seedTask(db, {
      id: "task-orphan",
      workerConv: "wc-orphan",
      source: null,
      kind: "agent_chat",
    })

    // A nested task sourced from the orphan's worker conversation — reaped transitively.
    seedTask(db, {
      id: "task-nested",
      workerConv: "wc-nested",
      source: "wc-orphan",
      kind: "todo_run",
    })

    // A source-less workspace_index (born source-less, observable) — must survive.
    seedTask(db, {
      id: "task-index",
      workerConv: "wc-index",
      source: null,
      kind: "workspace_index",
    })

    // Apply V9 (the reaper) and any later migrations, up to the latest version.
    runMigrations(db)

    expect(db.pragma("user_version", { simple: true })).toBe(66)

    // Reaped: orphan + its nested descendant, and all their state.
    const taskIds = (
      db.prepare("SELECT id FROM tasks").all() as { id: string }[]
    ).map((r) => r.id)
    expect(taskIds.sort()).toEqual(["task-index", "task-live"])

    const convIds = (
      db.prepare("SELECT id FROM conversations").all() as { id: string }[]
    ).map((r) => r.id)
    expect(convIds.sort()).toEqual(["conv-live", "wc-index", "wc-live"].sort())

    // Children of reaped tasks are gone (2 reaped → each had 1 of each child row).
    // Survivors: 2 tasks × (1 event, 1 approval, 1 checkpoint, 1 message).
    expect(count(db, "task_events")).toBe(2)
    expect(count(db, "approvals")).toBe(2)
    expect(count(db, "task_checkpoints")).toBe(2)
    expect(count(db, "messages")).toBe(2)

    // No dangling references after FKs are re-enabled.
    expect(db.pragma("foreign_key_check")).toHaveLength(0)
    db.close()
  })
})

describe.skipIf(!sqliteLoads)("result content migration", () => {
  it("adds a nullable result_content snapshot to phase runs", () => {
    const db = new Database(":memory:")
    runMigrations(db)
    const columns = (
      db.pragma("table_info(process_phase_runs)") as Array<{ name: string }>
    ).map((column) => column.name)
    expect(columns).toContain("result_content")
    db.close()
  })
})

describe.skipIf(!sqliteLoads)("completion policy migration", () => {
  it("keeps existing phases and in-flight runs explicitly legacy", () => {
    const db = new Database(":memory:")
    for (let n = 1; n <= 40; n++)
      db.exec((schema as Record<string, string>)[`SCHEMA_V${n}`])
    db.pragma("user_version = 40")
    db.exec(`
      INSERT INTO process_definitions (id, name, created_at, updated_at) VALUES ('p', 'Existing', 1, 1);
      INSERT INTO process_phases (id, process_id, key, name, position) VALUES ('phase', 'p', 'work', 'Work', 0);
      INSERT INTO process_runs (id, process_id, status, created_at) VALUES ('run', 'p', 'running', 1);
      INSERT INTO process_phase_runs (id, run_id, phase_id, status) VALUES ('pr', 'run', 'phase', 'running');
    `)
    runMigrations(db)
    expect(
      db.prepare("SELECT completion_contract FROM process_phases").get()
    ).toEqual({ completion_contract: '{"policy":"legacy"}' })
    expect(
      db.prepare("SELECT completion_contracts FROM process_runs").get()
    ).toEqual({ completion_contracts: null })
    expect(
      db
        .prepare("SELECT status, completion_receipt FROM process_phase_runs")
        .get()
    ).toEqual({ status: "running", completion_receipt: null })
    db.close()
  })
})

describe.skipIf(!sqliteLoads)(
  "mission control playbooks migration (v49)",
  () => {
    it("rebuilds phase agents with a nullable agent name and keeps their rows", () => {
      const db = new Database(":memory:")
      db.pragma("foreign_keys = ON")
      runMigrations(db)
      db.pragma("foreign_keys = OFF")
      db.exec(`
      DROP TABLE process_phase_agents;
      CREATE TABLE process_phase_agents (
        id TEXT PRIMARY KEY,
        phase_id TEXT NOT NULL REFERENCES process_phases(id) ON DELETE CASCADE,
        agent_name TEXT NOT NULL,
        skills TEXT,
        tools TEXT,
        position INTEGER NOT NULL
      );
      INSERT INTO process_definitions (id, name, created_at, updated_at) VALUES ('d', 'D', 0, 0);
      INSERT INTO process_phases (id, process_id, key, name, position) VALUES ('p', 'd', 'k', 'K', 0);
      INSERT INTO process_phase_agents (id, phase_id, agent_name, skills, tools, position)
        VALUES ('a', 'p', 'coder', '["x"]', NULL, 0);
      PRAGMA user_version = 48;
    `)
      db.pragma("foreign_keys = ON")

      runMigrations(db)

      expect(db.pragma("user_version", { simple: true })).toBe(66)
      const columns = db.pragma("table_info(process_phase_agents)") as Array<{
        name: string
        notnull: number
      }>
      expect(columns.find((c) => c.name === "agent_name")?.notnull).toBe(0)
      expect(columns.map((c) => c.name)).toEqual(
        expect.arrayContaining(["seat_role", "runtime_config"])
      )
      expect(
        db.prepare("SELECT agent_name, skills FROM process_phase_agents").get()
      ).toEqual({ agent_name: "coder", skills: '["x"]' })
      for (const [table, column] of [
        ["process_phases", "proof_step"],
        ["process_runs", "seat_bindings"],
        ["process_runs", "mission_control"],
        ["process_phase_runs", "seat_address"],
      ])
        expect(
          (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(
            (c) => c.name
          )
        ).toContain(column)
      for (const table of ["playbooks", "playbook_hooks", "playbook_runs"])
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
            )
            .get(table)
        ).toBeTruthy()
      expect(db.pragma("foreign_key_check")).toHaveLength(0)
      db.close()
    })
  }
)

describe.skipIf(!sqliteLoads)("mission control comms migration (v50)", () => {
  it("adds seat sessions, threads, messages, and the phase context mode", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    for (const table of ["seat_sessions", "seat_threads", "seat_messages"])
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
          )
          .get(table)
      ).toBeTruthy()
    db.exec(
      "INSERT INTO process_definitions (id, name, created_at, updated_at) VALUES ('d', 'D', 0, 0); INSERT INTO process_phases (id, process_id, key, name, position) VALUES ('p', 'd', 'k', 'K', 0);"
    )
    expect(
      db
        .prepare("SELECT context_mode FROM process_phases WHERE id = 'p'")
        .pluck()
        .get()
    ).toBe("step")
    db.close()
  })

  it("self-heals a database stamped at v50 without the comms tables", () => {
    const db = new Database(":memory:")
    runMigrations(db, { through: 50 })
    db.exec(
      "DROP TABLE seat_messages; DROP TABLE seat_threads; DROP TABLE seat_sessions;"
    )
    runMigrations(db)
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='seat_messages'"
        )
        .get()
    ).toBeTruthy()
    db.close()
  })
})

describe.skipIf(!sqliteLoads)("context scopes migration (v51)", () => {
  it("remaps step scopes and gives existing seat sessions the feature scope", () => {
    const db = new Database(":memory:")
    runMigrations(db, { through: 50 })
    // A v50 database shaped like the first 106.4 build.
    db.exec(`
      DROP TABLE seat_sessions;
      CREATE TABLE seat_sessions (
        id TEXT PRIMARY KEY, initiative_id TEXT NOT NULL, seat_address TEXT NOT NULL,
        generation INTEGER NOT NULL, conversation_id TEXT, status TEXT NOT NULL,
        handoff_summary TEXT, rotation_reason TEXT, failure_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, last_activity_at INTEGER, rotated_at INTEGER,
        UNIQUE (initiative_id, seat_address, generation)
      );
      INSERT INTO initiatives (id, key, name, intent, definition_of_done, status, budgets, created_at, updated_at)
        VALUES ('i', 'k', 'I', '', '', 'active', '{}', 0, 0);
      INSERT INTO seat_sessions (id, initiative_id, seat_address, generation, status, created_at)
        VALUES ('s', 'i', 'qa@implementation', 1, 'idle', 0);
      INSERT INTO process_definitions (id, name, created_at, updated_at) VALUES ('d', 'D', 0, 0);
      INSERT INTO process_phases (id, process_id, key, name, position, context_mode) VALUES
        ('a', 'd', 'a', 'A', 0, 'fresh'), ('b', 'd', 'b', 'B', 1, 'seat_session');
    `)
    runMigrations(db)
    expect(db.pragma("user_version", { simple: true })).toBe(66)
    // v51 moved them to the initiative scope; v54 renamed it to feature.
    expect(
      db
        .prepare("SELECT context_mode FROM process_phases ORDER BY position")
        .pluck()
        .all()
    ).toEqual(["step", "feature"])
    expect(
      db
        .prepare(
          "SELECT feature_id, scope, scope_key, playbook_run_id FROM seat_sessions"
        )
        .get()
    ).toEqual({
      feature_id: "i",
      scope: "feature",
      scope_key: "feature",
      playbook_run_id: null,
    })
    expect(db.pragma("foreign_key_check")).toHaveLength(0)
    db.close()
  })
})

describe.skipIf(!sqliteLoads)("navigator migration (v53)", () => {
  it("adds drive state, DoD reviews, proposals, and ticks to a v52 database", () => {
    const db = new Database(":memory:")
    runMigrations(db, { through: 52 })
    db.exec(`
      INSERT INTO initiatives (id, key, name, intent, definition_of_done, status, budgets, created_at, updated_at)
        VALUES ('i', 'k', 'I', '', '', 'active', '{"maxConcurrentSlices":2}', 0, 0);
      INSERT INTO missions (id, initiative_id, key, name, outcome, status, position)
        VALUES ('m', 'i', 'm', 'M', '', 'planned', 0);
    `)
    runMigrations(db, { through: 53 })
    expect(db.pragma("user_version", { simple: true })).toBe(53)
    expect(db.prepare("SELECT drive, budgets FROM initiatives").get()).toEqual({
      drive: "{}",
      budgets: '{"maxConcurrentSlices":2}',
    })
    expect(
      db.prepare("SELECT dod_review FROM missions").pluck().get()
    ).toBeNull()
    db.prepare(
      "INSERT INTO plan_proposals (id, initiative_id, mission_id, kind, changes, proposer, created_at) VALUES ('p', 'i', 'm', 'slice', '[]', 'lead@orch', 0)"
    ).run()
    db.prepare(
      "INSERT INTO navigator_ticks (id, initiative_id, position_hash, summary, created_at) VALUES ('t', 'i', 'h', 's', 0)"
    ).run()
    // Both belong to the initiative and go with it.
    db.pragma("foreign_keys = ON")
    db.prepare("DELETE FROM initiatives").run()
    expect(
      db.prepare("SELECT COUNT(*) FROM plan_proposals").pluck().get()
    ).toBe(0)
    expect(
      db.prepare("SELECT COUNT(*) FROM navigator_ticks").pluck().get()
    ).toBe(0)
    db.close()
  })
})

describe.skipIf(!sqliteLoads)("work terms migration (v54)", () => {
  it("renames initiatives, missions, and slices, their columns, and stored terms", () => {
    const db = new Database(":memory:")
    runMigrations(db, { through: 53 })
    db.exec(`
      INSERT INTO initiatives (id, key, name, intent, definition_of_done, status, budgets, rig_snapshot, created_at, updated_at)
        VALUES ('i', 'billing', 'Billing', 'Slice the invoices', '', 'active',
          '{"maxConcurrentSlices":2,"maxPlanRevisionsPerMission":3}',
          '{"seats":[{"decisionRights":["assign_slice","accept_proof"]}]}', 0, 0);
      INSERT INTO missions (id, initiative_id, key, name, outcome, status, position)
        VALUES ('m', 'i', 'mission-1', 'First mission', '', 'active', 0);
      INSERT INTO slices (id, mission_id, key, title, spec, status, position)
        VALUES ('a', 'm', 'invoice-api', 'Invoice API', '{"goal":"a slice of work"}', 'ready', 0),
               ('b', 'm', 'invoice-ui', 'Invoice UI', '{}', 'draft', 1);
      INSERT INTO slice_edges (id, mission_id, from_slice_id, to_slice_id) VALUES ('e', 'm', 'a', 'b');
      INSERT INTO work_revisions (id, initiative_id, target_kind, target_id, actor, change, created_at)
        VALUES ('r', 'i', 'slice', 'a', 'user',
          '{"op":"add_slice","mission":"mission-1","slice":{"key":"invoice-api","title":"Invoice API"}}', 0);
      INSERT INTO plan_proposals (id, initiative_id, mission_id, kind, changes, proposer, created_at)
        VALUES ('p', 'i', 'm', 'slice', '[{"op":"split_slice","slice":"invoice-api","into":[]}]', 'lead@orch', 0);
      INSERT INTO navigator_ticks (id, initiative_id, position_hash, summary, decision_keys, created_at)
        VALUES ('t', 'i', 'h', 'Slice a failed.', '["slice_failed:a:2"]', 0);
      INSERT INTO playbooks (id, name, altitude, created_at, updated_at) VALUES ('pb', 'P', 'mission', 0, 0);
      INSERT INTO playbook_runs (id, playbook_id, hook, initiative_id, mission_id, slice_id, status, created_at)
        VALUES ('run', 'pb', 'after_all_slices', 'i', 'm', 'a', 'running', 0);
      INSERT INTO seat_sessions (id, initiative_id, seat_address, scope, scope_key, generation, status, created_at)
        VALUES ('s1', 'i', 'lead@orch', 'initiative', 'initiative', 1, 'idle', 0),
               ('s2', 'i', 'qa@impl', 'slice', 'run', 1, 'idle', 0);
      INSERT INTO seat_threads (id, initiative_id, anchor_kind, anchor_id, subject, created_at)
        VALUES ('th', 'i', 'slice', 'a', 'About the slice', 0);
      INSERT INTO merge_queue (id, mission_id, slice_id, status, slice_head, proof_accepted_at, created_at, updated_at)
        VALUES ('q', 'm', 'a', 'queued', 'abc', 0, 0, 0);
    `)

    runMigrations(db)

    expect(db.pragma("user_version", { simple: true })).toBe(66)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .pluck()
      .all() as string[]
    expect(tables).toEqual(
      expect.arrayContaining([
        "features",
        "milestones",
        "user_stories",
        "user_story_edges",
      ])
    )
    for (const old of ["initiatives", "missions", "slices", "slice_edges"])
      expect(tables).not.toContain(old)
    const oldNames = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL")
      .all()
      .filter((row) =>
        /initiative|slice|\bmissions?\b|mission_id/i.test(
          (row as { sql: string }).sql
        )
      )
    expect(oldNames).toEqual([])

    expect(
      db.prepare("SELECT intent, budgets, rig_snapshot FROM features").get()
    ).toEqual({
      intent: "Slice the invoices",
      budgets:
        '{"maxConcurrentUserStories":2,"maxPlanRevisionsPerMilestone":3}',
      rig_snapshot:
        '{"seats":[{"decisionRights":["assign_user_story","accept_proof"]}]}',
    })
    expect(
      db.prepare("SELECT feature_id, key, name FROM milestones").get()
    ).toEqual({
      feature_id: "i",
      key: "mission-1",
      name: "First mission",
    })
    expect(
      db
        .prepare("SELECT milestone_id, spec FROM user_stories WHERE id = 'a'")
        .get()
    ).toEqual({
      milestone_id: "m",
      spec: '{"goal":"a slice of work"}',
    })
    expect(
      db
        .prepare(
          "SELECT from_user_story_id, to_user_story_id FROM user_story_edges"
        )
        .get()
    ).toEqual({
      from_user_story_id: "a",
      to_user_story_id: "b",
    })
    expect(
      db.prepare("SELECT target_kind, change FROM work_revisions").get()
    ).toEqual({
      target_kind: "user_story",
      change:
        '{"op":"add_user_story","milestone":"mission-1","userStory":{"key":"invoice-api","title":"Invoice API"}}',
    })
    expect(
      db.prepare("SELECT kind, changes FROM plan_proposals").get()
    ).toEqual({
      kind: "user_story",
      changes:
        '[{"op":"split_user_story","userStory":"invoice-api","into":[]}]',
    })
    expect(
      db.prepare("SELECT summary, decision_keys FROM navigator_ticks").get()
    ).toEqual({
      summary: "Slice a failed.",
      decision_keys: '["user_story_failed:a:2"]',
    })
    expect(db.prepare("SELECT altitude FROM playbooks").pluck().get()).toBe(
      "milestone"
    )
    expect(
      db
        .prepare(
          "SELECT hook, feature_id, milestone_id, user_story_id FROM playbook_runs"
        )
        .get()
    ).toEqual({
      hook: "after_all_user_stories",
      feature_id: "i",
      milestone_id: "m",
      user_story_id: "a",
    })
    expect(
      db.prepare("SELECT scope, scope_key FROM seat_sessions ORDER BY id").all()
    ).toEqual([
      { scope: "feature", scope_key: "feature" },
      { scope: "user_story", scope_key: "run" },
    ])
    expect(
      db.prepare("SELECT anchor_kind, subject FROM seat_threads").get()
    ).toEqual({
      anchor_kind: "user_story",
      subject: "About the slice",
    })
    expect(
      db
        .prepare(
          "SELECT milestone_id, user_story_id, user_story_head FROM merge_queue"
        )
        .get()
    ).toEqual({
      milestone_id: "m",
      user_story_id: "a",
      user_story_head: "abc",
    })
    expect(db.pragma("foreign_key_check")).toHaveLength(0)

    // Cascades still follow the renamed references.
    db.pragma("foreign_keys = ON")
    db.prepare("DELETE FROM features").run()
    for (const table of [
      "milestones",
      "user_stories",
      "user_story_edges",
      "seat_sessions",
      "merge_queue",
    ])
      expect(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(0)

    // Running it again changes nothing.
    runMigrations(db)
    expect(db.pragma("user_version", { simple: true })).toBe(66)
    db.close()
  })
})

describe("python extractor migration (v56)", () => {
  it("marks already-indexed Python files for re-extraction, and nothing else", () => {
    const db = new Database(":memory:")
    runMigrations(db, { through: 55 })
    const now = Date.now()
    db.prepare(
      "INSERT INTO workspaces (id, path, name, created_at, updated_at) VALUES ('w', '/w', 'w', ?, ?)"
    ).run(now, now)
    const file = db.prepare(
      "INSERT INTO index_files (id, workspace_id, path, ext, size, mtime, hash, indexed_stage, updated_at) VALUES (?, 'w', ?, ?, 1, 1, 'h', 'symbols', ?)"
    )
    file.run("py", "src/runtime.py", ".py", now)
    file.run("pyi", "src/stubs.pyi", ".pyi", now)
    file.run("ts", "web/app.ts", ".ts", now)

    runMigrations(db)

    const stages = Object.fromEntries(
      (
        db.prepare("SELECT id, indexed_stage FROM index_files").all() as Array<{
          id: string
          indexed_stage: string
        }>
      ).map((row) => [row.id, row.indexed_stage])
    )
    expect(stages).toEqual({ py: "file_map", pyi: "file_map", ts: "symbols" })
  })
})

describe.skipIf(!sqliteLoads)(
  "Mission Control worktree workspaces migration (v57)",
  () => {
    it("moves worktree conversations and runs onto their feature's workspace and deletes the rows", () => {
      const db = new Database(":memory:")
      runMigrations(db, { through: 56 })
      const now = Date.now()
      const worktrees = "/Users/me/Library/App/mission-control/worktrees"
      const workspace = db.prepare(
        "INSERT INTO workspaces (id, path, name, created_at, updated_at, hidden) VALUES (?, ?, ?, ?, ?, ?)"
      )
      workspace.run("main", "/code/app", "app", now, now, 0)
      workspace.run("story", `${worktrees}/f1/us-1-1-abc`, "us-1", now, now, 1)
      workspace.run(
        "sub",
        `${worktrees}/f1/us-2-1-def/web`,
        "us-2",
        now,
        now,
        0
      )
      workspace.run(
        "orphan",
        `${worktrees}/gone/us-3-1-ghi`,
        "us-3",
        now,
        now,
        1
      )
      workspace.run("pinned", `${worktrees}/f1/us-4-1-jkl`, "us-4", now, now, 1)
      db.prepare(
        "INSERT INTO features (id, key, name, intent, definition_of_done, workspace_id, status, created_at, updated_at) VALUES ('f1', 'app', 'App', '', '', 'main', 'active', ?, ?)"
      ).run(now, now)
      // A project pointed at a worktree keeps it.
      db.prepare(
        "INSERT INTO projects (id, name, workspace_id, created_at, updated_at) VALUES ('p', 'P', 'pinned', ?, ?)"
      ).run(now, now)
      const conversation = db.prepare(
        "INSERT INTO conversations (id, mode, workspace_id, created_at, updated_at) VALUES (?, 'interactive', ?, ?, ?)"
      )
      conversation.run("c-story", "story", now, now)
      conversation.run("c-sub", "sub", now, now)
      conversation.run("c-orphan", "orphan", now, now)
      conversation.run("c-main", "main", now, now)
      const run = db.prepare(
        "INSERT INTO process_runs (id, workspace_id, status, created_at) VALUES (?, ?, 'completed', ?)"
      )
      run.run("r-story", "story", now)
      run.run("r-orphan", "orphan", now)
      db.prepare(
        "INSERT INTO index_runs (id, workspace_id, enabled, stage, priority, files_scanned, files_total, created_at, updated_at) VALUES ('ir', 'story', 1, 'file_map', 'low', 0, 0, ?, ?)"
      ).run(now, now)

      runMigrations(db)

      expect(
        db.prepare("SELECT id FROM workspaces ORDER BY id").pluck().all()
      ).toEqual(["main", "pinned"])
      const place = (table: string, id: string) =>
        db
          .prepare(
            `SELECT workspace_id, working_directory FROM ${table} WHERE id = ?`
          )
          .get(id)
      expect(place("conversations", "c-story")).toEqual({
        workspace_id: "main",
        working_directory: `${worktrees}/f1/us-1-1-abc`,
      })
      expect(place("conversations", "c-sub")).toEqual({
        workspace_id: "main",
        working_directory: `${worktrees}/f1/us-2-1-def/web`,
      })
      // Its feature is gone: no workspace to move to, but it keeps its folder.
      expect(place("conversations", "c-orphan")).toEqual({
        workspace_id: null,
        working_directory: `${worktrees}/gone/us-3-1-ghi`,
      })
      expect(place("conversations", "c-main")).toEqual({
        workspace_id: "main",
        working_directory: null,
      })
      expect(place("process_runs", "r-story")).toEqual({
        workspace_id: "main",
        working_directory: `${worktrees}/f1/us-1-1-abc`,
      })
      expect(place("process_runs", "r-orphan")).toEqual({
        workspace_id: null,
        working_directory: `${worktrees}/gone/us-3-1-ghi`,
      })
      expect(db.prepare("SELECT COUNT(*) FROM index_runs").pluck().get()).toBe(
        0
      )
      db.pragma("foreign_keys = ON")
      expect(db.pragma("foreign_key_check")).toEqual([])
      db.close()
    })
  }
)

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
    expect(db.pragma("user_version", { simple: true })).toBe(38)
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

    expect(db.pragma("user_version", { simple: true })).toBe(38)

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

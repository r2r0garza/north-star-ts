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
} from "./schema"

let sqliteLoads = true
try {
  new Database(":memory:").close()
} catch {
  sqliteLoads = false
}

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
    expect(db.pragma("user_version", { simple: true })).toBe(26)
    expect(db.pragma("foreign_key_check")).toHaveLength(0)
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
    const phaseRunCols = db.pragma(
      "table_info(process_phase_runs)"
    ) as Array<{ name: string; dflt_value: unknown }>
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
      String(
        phaseRunCols.find((c) => c.name === "validator_round")?.dflt_value
      )
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
      String(defCols.find((c) => c.name === "require_flag_approval")?.dflt_value)
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
      .prepare("SELECT id, flagging_phase_run_id FROM process_flags WHERE id = 'flag'")
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

    expect(db.pragma("user_version", { simple: true })).toBe(26)

    // Reaped: orphan + its nested descendant, and all their state.
    const taskIds = (
      db.prepare("SELECT id FROM tasks").all() as { id: string }[]
    ).map((r) => r.id)
    expect(taskIds.sort()).toEqual(["task-index", "task-live"])

    const convIds = (
      db.prepare("SELECT id FROM conversations").all() as { id: string }[]
    ).map((r) => r.id)
    expect(convIds.sort()).toEqual(
      ["conv-live", "wc-index", "wc-live"].sort()
    )

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

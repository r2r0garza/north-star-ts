import type Database from "better-sqlite3"

// v54: Mission Control's work hierarchy was renamed. Initiatives are Features,
// Missions are Milestones, and Slices are User stories — in the UI, the code,
// the agent tools, and here. This renames the tables, columns, and indexes, then
// rewrites the stored enum values and JSON (plan changes, decision rights,
// hooks, budgets, Navigator state) so no old term survives in the database.
//
// Idempotent: it does nothing once the old tables are gone, so the prerelease
// self-heal pass can run it again.

const WORDS: Record<string, { one: string[]; many: string[] }> = {
  initiative: { one: ["feature"], many: ["features"] },
  mission: { one: ["milestone"], many: ["milestones"] },
  slice: { one: ["user", "story"], many: ["user", "stories"] },
}

// "mission" stays when it is part of Mission Control or a pod's mission statement.
const KEEP_AFTER_MISSION = new Set(["control", "statement"])

// Old words become their lowercase replacements; other words pass through.
function renameWords(words: string[]): string[] {
  const out: string[] = []
  words.forEach((word, i) => {
    const lower = word.toLowerCase()
    const next = words[i + 1]?.toLowerCase()
    if (lower.startsWith("mission") && next && KEEP_AFTER_MISSION.has(next)) {
      out.push(word)
      return
    }
    const replacement =
      WORDS[lower]?.one ??
      (lower.endsWith("s") ? WORDS[lower.slice(0, -1)]?.many : undefined)
    out.push(...(replacement ?? [word]))
  })
  return out
}

const capitalize = (word: string) => word[0].toUpperCase() + word.slice(1)

// Rename an identifier in its own style: snake_case stays snake_case
// (assign_slice → assign_user_story), camelCase stays camelCase
// (maxConcurrentSlices → maxConcurrentUserStories). A bare word follows
// `bare`: "user_story" for stored enum values, "userStory" for object keys.
export function renameTermIdentifier(
  token: string,
  bare: "snake" | "camel"
): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(token)) return token
  if (token.includes("_") || (bare === "snake" && /^[a-z]+$/.test(token))) {
    const upper = token.length > 1 && token === token.toUpperCase()
    const words = renameWords(token.split("_")).join("_")
    return upper ? words.toUpperCase() : words.toLowerCase()
  }
  const words = token.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+/g) ?? [token]
  if (words.join("") !== token) return token
  const renamed = renameWords(words).map(capitalize).join("")
  return token[0] === token[0].toLowerCase()
    ? renamed[0].toLowerCase() + renamed.slice(1)
    : renamed
}

// Values under these keys are the user's words or work keys, never enums.
const FREE_TEXT = new Set([
  "title",
  "name",
  "goal",
  "notes",
  "note",
  "outcome",
  "intent",
  "definitionOfDone",
  "definition_of_done",
  "summary",
  "reason",
  "body",
  "content",
  "text",
  "description",
  "charter",
  "subject",
  "message",
  "label",
  "acceptance",
  "outOfScope",
  "touchHints",
  "dependsOn",
  "order",
  "from",
  "to",
  "branch",
  "integrationBranch",
  "baseRef",
  "worktreePath",
  "path",
  "address",
  "objective",
  "prompt",
  "evidence",
  "detail",
  "culture",
  "cultureMd",
  "missionStatement",
])

// An enum value, or a colon-joined decision key such as
// "slice_failed:<id>:2" or "budget:maxPlanRevisionsPerMission:soft".
export function renameTermValue(value: string): string {
  if (!/^[A-Za-z0-9_:.-]+$/.test(value)) return value
  return value
    .split(":")
    .map((segment) =>
      /^[A-Za-z][A-Za-z0-9_]*$/.test(segment)
        ? renameTermIdentifier(segment, "snake")
        : segment
    )
    .join(":")
}

export function renameTermsInJson(value: unknown, key?: string): unknown {
  if (Array.isArray(value))
    return value.map((item) => renameTermsInJson(item, key))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value))
      out[renameTermIdentifier(k, "camel")] = renameTermsInJson(v, k)
    return out
  }
  if (typeof value !== "string" || (key && FREE_TEXT.has(key))) return value
  // A work key ("invoice-api", "mission-1") is the user's; a budget key is ours.
  if (key === "key" && !/[A-Z]/.test(value)) return value
  return renameTermValue(value)
}

const TABLES: Array<[string, string]> = [
  ["initiatives", "features"],
  ["missions", "milestones"],
  ["slices", "user_stories"],
  ["slice_edges", "user_story_edges"],
]

const COLUMNS: Array<[string, string, string]> = [
  ["milestones", "initiative_id", "feature_id"],
  ["user_stories", "mission_id", "milestone_id"],
  ["user_story_edges", "mission_id", "milestone_id"],
  ["user_story_edges", "from_slice_id", "from_user_story_id"],
  ["user_story_edges", "to_slice_id", "to_user_story_id"],
  ["work_revisions", "initiative_id", "feature_id"],
  ["playbook_runs", "initiative_id", "feature_id"],
  ["playbook_runs", "mission_id", "milestone_id"],
  ["playbook_runs", "slice_id", "user_story_id"],
  ["seat_threads", "initiative_id", "feature_id"],
  ["seat_messages", "initiative_id", "feature_id"],
  ["merge_queue", "mission_id", "milestone_id"],
  ["merge_queue", "slice_id", "user_story_id"],
  ["merge_queue", "slice_head", "user_story_head"],
  ["plan_proposals", "initiative_id", "feature_id"],
  ["plan_proposals", "mission_id", "milestone_id"],
  ["navigator_ticks", "initiative_id", "feature_id"],
]

const INDEXES: Array<[string, string]> = [
  [
    "idx_initiatives_updated",
    "CREATE INDEX IF NOT EXISTS idx_features_updated ON features(updated_at DESC)",
  ],
  [
    "idx_initiatives_project",
    "CREATE INDEX IF NOT EXISTS idx_features_project ON features(project_id)",
  ],
  [
    "idx_missions_initiative_position",
    "CREATE INDEX IF NOT EXISTS idx_milestones_feature_position ON milestones(feature_id, position)",
  ],
  [
    "idx_slices_mission_position",
    "CREATE INDEX IF NOT EXISTS idx_user_stories_milestone_position ON user_stories(milestone_id, position)",
  ],
  [
    "idx_slice_edges_mission",
    "CREATE INDEX IF NOT EXISTS idx_user_story_edges_milestone ON user_story_edges(milestone_id)",
  ],
  [
    "idx_work_revisions_initiative_created",
    "CREATE INDEX IF NOT EXISTS idx_work_revisions_feature_created ON work_revisions(feature_id, created_at DESC)",
  ],
  [
    "idx_playbook_runs_initiative",
    "CREATE INDEX IF NOT EXISTS idx_playbook_runs_feature ON playbook_runs(feature_id, created_at DESC)",
  ],
  [
    "idx_playbook_runs_slice",
    "CREATE INDEX IF NOT EXISTS idx_playbook_runs_user_story ON playbook_runs(user_story_id, created_at DESC)",
  ],
  [
    "idx_seat_threads_initiative",
    "CREATE INDEX IF NOT EXISTS idx_seat_threads_feature ON seat_threads(feature_id, created_at)",
  ],
  [
    "idx_seat_messages_to",
    "CREATE INDEX IF NOT EXISTS idx_seat_messages_to ON seat_messages(feature_id, to_address, status)",
  ],
  [
    "idx_merge_queue_mission",
    "CREATE INDEX IF NOT EXISTS idx_merge_queue_milestone ON merge_queue(milestone_id, status)",
  ],
  [
    "idx_merge_queue_slice",
    "CREATE INDEX IF NOT EXISTS idx_merge_queue_user_story ON merge_queue(user_story_id)",
  ],
  [
    "idx_plan_proposals_initiative",
    "CREATE INDEX IF NOT EXISTS idx_plan_proposals_feature ON plan_proposals(feature_id, status, created_at)",
  ],
  [
    "idx_navigator_ticks_initiative",
    "CREATE INDEX IF NOT EXISTS idx_navigator_ticks_feature ON navigator_ticks(feature_id, created_at DESC)",
  ],
]

// seat_sessions is rebuilt rather than altered: its scope defaults were
// 'initiative', and SQLite can't change a column default in place.
const SEAT_SESSIONS = `
CREATE TABLE seat_sessions_v54 (
  id               TEXT PRIMARY KEY,
  feature_id       TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  seat_address     TEXT NOT NULL,
  scope            TEXT NOT NULL DEFAULT 'feature',
  scope_key        TEXT NOT NULL DEFAULT 'feature',
  playbook_run_id  TEXT REFERENCES playbook_runs(id) ON DELETE SET NULL,
  generation       INTEGER NOT NULL,
  conversation_id  TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  status           TEXT NOT NULL,
  handoff_summary  TEXT,
  rotation_reason  TEXT,
  failure_count    INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  last_activity_at INTEGER,
  rotated_at       INTEGER,
  UNIQUE (feature_id, seat_address, scope_key, generation)
);
INSERT INTO seat_sessions_v54
  (id, feature_id, seat_address, scope, scope_key, playbook_run_id, generation, conversation_id, status, handoff_summary, rotation_reason, failure_count, created_at, last_activity_at, rotated_at)
SELECT id, initiative_id, seat_address, scope, scope_key, playbook_run_id, generation, conversation_id, status, handoff_summary, rotation_reason, failure_count, created_at, last_activity_at, rotated_at
FROM seat_sessions;
DROP TABLE seat_sessions;
ALTER TABLE seat_sessions_v54 RENAME TO seat_sessions;
`

// Stored enum values.
const ENUM_COLUMNS: Array<[string, string]> = [
  ["work_revisions", "target_kind"],
  ["plan_proposals", "kind"],
  ["playbook_runs", "hook"],
  ["playbook_hooks", "hook"],
  ["playbooks", "altitude"],
  ["seat_sessions", "scope"],
  ["seat_sessions", "scope_key"],
  ["seat_threads", "anchor_kind"],
  ["seat_messages", "kind"],
  ["process_phases", "context_mode"],
]

// Stored JSON whose keys and enum values follow the code.
const JSON_COLUMNS: Array<[string, string, string?]> = [
  ["features", "rig_snapshot"],
  ["features", "budgets"],
  ["features", "drive"],
  ["milestones", "merge_policy"],
  ["milestones", "landing"],
  ["milestones", "dod_review"],
  ["user_stories", "spec"],
  ["user_stories", "proof"],
  ["work_revisions", "change"],
  ["plan_proposals", "changes"],
  ["playbook_runs", "proof"],
  ["navigator_ticks", "actions"],
  ["navigator_ticks", "decision_keys"],
  ["navigator_ticks", "state"],
  ["seat_messages", "needs_decision"],
  ["rig_seats", "decision_rights"],
  ["process_runs", "mission_control"],
  ["process_runs", "seat_bindings"],
  // Only Mission Control's own tasks (seat wakes) carry work ids.
  [
    "tasks",
    "input",
    "input LIKE '%initiativeId%' OR input LIKE '%missionId%' OR input LIKE '%sliceId%'",
  ],
]

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
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

function rewriteColumn(
  db: Database.Database,
  table: string,
  column: string,
  rewrite: (value: string) => string,
  where?: string
): void {
  if (!columnExists(db, table, column)) return
  const rows = db
    .prepare(
      `SELECT rowid AS rid, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL${where ? ` AND (${where})` : ""}`
    )
    .all() as Array<{ rid: number; value: string }>
  const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`)
  for (const row of rows) {
    const next = rewrite(row.value)
    if (next !== row.value) update.run(next, row.rid)
  }
}

function rewriteJson(value: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return value
  }
  return JSON.stringify(renameTermsInJson(parsed))
}

export function renameWorkTerms(db: Database.Database): void {
  if (!tableExists(db, "initiatives")) return

  for (const [from, to] of TABLES)
    if (tableExists(db, from)) db.exec(`ALTER TABLE ${from} RENAME TO ${to}`)
  for (const [table, from, to] of COLUMNS)
    if (columnExists(db, table, from))
      db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`)
  if (columnExists(db, "seat_sessions", "initiative_id")) db.exec(SEAT_SESSIONS)
  for (const [old, create] of INDEXES) {
    db.exec(`DROP INDEX IF EXISTS ${old}`)
    db.exec(create)
  }

  for (const [table, column] of ENUM_COLUMNS)
    rewriteColumn(db, table, column, renameTermValue)
  for (const [table, column, where] of JSON_COLUMNS)
    rewriteColumn(db, table, column, rewriteJson, where)
}

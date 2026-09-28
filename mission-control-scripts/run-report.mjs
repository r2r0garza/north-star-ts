#!/usr/bin/env node
// A timing and health report for one Mission Control feature run, read from
// the app's SQLite database. See README.md in this folder.
//
//   node mission-control-scripts/run-report.mjs [feature-key] [--db <path>]
//   node mission-control-scripts/run-report.mjs --list
//
// Reads a copy of the database, so it's safe while the app is running.
import { DatabaseSync } from "node:sqlite"
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  overlappingPairs,
  scheduleSteps,
  withRunsLastEdges,
} from "../src/shared/mission-control/waves.ts"

// ── arguments ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args.splice(i, 2)[1] : undefined
}
const list = args.includes("--list")
const dbPath =
  flag("--db") ??
  process.env.MC_DB ??
  join(homedir(), "Library/Application Support/north-star/mission-control.db")
const featureKey = args.find((a) => !a.startsWith("--"))

if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Pass --db <path> or set MC_DB.`)
  process.exit(1)
}

// ── database (a copy, so the running app is never touched) ──────────────────

const dir = mkdtempSync(join(tmpdir(), "mc-report-"))
for (const ext of ["", "-wal", "-shm"])
  if (existsSync(dbPath + ext)) copyFileSync(dbPath + ext, join(dir, "mc.db" + ext))
const db = new DatabaseSync(join(dir, "mc.db"))
process.on("exit", () => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const all = (sql, ...params) => db.prepare(sql).all(...params)
const one = (sql, ...params) => db.prepare(sql).get(...params)

// ── formatting ──────────────────────────────────────────────────────────────

const mins = (ms) => (ms == null ? "" : (ms / 60000).toFixed(1))
const when = (ms) => (ms == null ? "—" : new Date(ms).toLocaleString())
const cut = (text, n) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

function table(rows, columns) {
  if (!rows.length) return console.log("  (none)")
  const widths = columns.map(([label, get]) =>
    Math.max(label.length, ...rows.map((r) => String(get(r) ?? "").length))
  )
  const line = (cells) =>
    "  " + cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ").trimEnd()
  console.log(line(columns.map(([label]) => label)))
  console.log(line(widths.map((w) => "-".repeat(w))))
  for (const row of rows) console.log(line(columns.map(([, get]) => get(row))))
}

function section(title, body) {
  console.log(`\n## ${title}`)
  try {
    body()
  } catch (error) {
    console.log(`  (unavailable: ${error.message})`)
  }
}

// ── --list ──────────────────────────────────────────────────────────────────

if (list || !featureKey) {
  const features = all(
    `SELECT key, status, drive_mode, drive, created_at FROM features ORDER BY created_at DESC LIMIT 20`
  )
  console.log(`Features in ${dbPath}:\n`)
  table(features, [
    ["key", (f) => f.key],
    ["status", (f) => f.status],
    ["drive", (f) => f.drive_mode],
    ["overlap", (f) => JSON.parse(f.drive || "{}").overlapPolicy ?? "wait"],
    ["created", (f) => when(f.created_at)],
  ])
  if (!featureKey) console.log("\nPass a feature key for its report.")
  process.exit(0)
}

// ── the feature ─────────────────────────────────────────────────────────────

const feature = one(`SELECT * FROM features WHERE key = ?`, featureKey)
if (!feature) {
  console.error(`No feature "${featureKey}". Run with --list to see them.`)
  process.exit(1)
}
const F = feature.id
const drive = JSON.parse(feature.drive || "{}")
const budgets = JSON.parse(feature.budgets || "{}")
const plan = one(
  `SELECT resolved_at FROM plan_proposals WHERE feature_id = ? AND kind = 'plan' ORDER BY created_at LIMIT 1`,
  F
)
// Times are minutes from when the plan was applied (else from the start),
// so time spent reviewing the proposal doesn't count.
const t0 = plan?.resolved_at ?? feature.started_at
const rel = (ms) => (ms == null || t0 == null ? "" : mins(ms - t0))

const runs = all(
  `SELECT r.*, u.key AS story FROM playbook_runs r LEFT JOIN user_stories u ON u.id = r.user_story_id
   WHERE r.feature_id = ? ORDER BY r.created_at`,
  F
)
const stories = all(
  `SELECT s.* FROM user_stories s JOIN milestones m ON m.id = s.milestone_id
   WHERE m.feature_id = ? ORDER BY m.position, s.position`,
  F
)
const milestones = all(`SELECT * FROM milestones WHERE feature_id = ? ORDER BY position`, F)
const lastWork = Math.max(0, ...runs.map((r) => r.finished_at ?? 0)) || null
const finishedAt =
  feature.finished_at ?? (Math.max(0, ...milestones.map((m) => m.finished_at ?? 0)) || null)

// Conversations that belong to this feature: phase workers and seat sessions.
const conversations = all(
  `SELECT DISTINCT t.conversation_id AS id FROM playbook_runs r
     JOIN process_phase_runs pr ON pr.run_id = r.process_run_id
     JOIN tasks t ON t.id = pr.task_id
   WHERE r.feature_id = ?
   UNION SELECT conversation_id FROM seat_sessions WHERE feature_id = ?`,
  F,
  F
).map((c) => c.id).filter(Boolean)
const inConversations = `(${conversations.map(() => "?").join(",") || "NULL"})`

console.log(`# ${feature.key} — ${feature.name}`)
console.log(`Database: ${dbPath}`)

section("Summary", () => {
  const done = stories.filter((s) => s.status === "done").length
  const cancelled = stories.filter((s) => s.status === "cancelled").length
  const storyRuns = runs.filter((r) => r.hook === "run")
  const failedRuns = storyRuns.filter((r) => r.status === "failed").length
  const lines = [
    ["Status", `${feature.status}${drive.pauseReason ? ` (${drive.pauseReason})` : ""}`],
    ["Drive", `${feature.drive_mode}, overlapping stories: ${drive.overlapPolicy ?? "wait"}`],
    ["Drive time used", `${((drive.activeMs ?? 0) / 3600000).toFixed(2)} h of ${budgets.maxActiveHours ?? 8} h`],
    ["Plan applied", when(t0)],
    ["Work finished", `${when(lastWork)} (${rel(lastWork)} min after the plan was applied)`],
    ...(finishedAt && lastWork && finishedAt > lastWork
      ? [["Then waited on you", `${mins(finishedAt - lastWork)} min, until ${when(finishedAt)}`]]
      : []),
    ["User stories", `${done} done, ${cancelled} cancelled, ${stories.length - done - cancelled} other`],
    ["Story attempts", `${storyRuns.length} (${failedRuns} failed)`],
  ]
  for (const [label, value] of lines) console.log(`  ${label.padEnd(20)} ${value}`)
})

section("Runs (minutes from the plan being applied)", () =>
  table(runs, [
    ["run", (r) => r.story ?? r.hook],
    ["hook", (r) => r.hook],
    ["status", (r) => r.status],
    ["start", (r) => rel(r.created_at)],
    ["minutes", (r) => mins(r.finished_at && r.finished_at - r.created_at)],
    ["outcome", (r) => cut(r.outcome_reason, 70)],
  ])
)

section("Phases", () =>
  table(
    all(
      `SELECT pp.name AS phase, COUNT(*) AS n, SUM(pr.status = 'failed') AS failed,
              SUM(pr.finished_at - pr.started_at) AS total, AVG(pr.finished_at - pr.started_at) AS avg
       FROM playbook_runs r JOIN process_phase_runs pr ON pr.run_id = r.process_run_id
       LEFT JOIN process_phases pp ON pp.id = pr.phase_id
       WHERE r.feature_id = ? AND pr.started_at IS NOT NULL
       GROUP BY pp.name ORDER BY total DESC`,
      F
    ),
    [
      ["phase", (p) => cut(p.phase, 44)],
      ["runs", (p) => p.n],
      ["failed", (p) => p.failed],
      ["total min", (p) => mins(p.total)],
      ["avg min", (p) => mins(p.avg)],
    ]
  )
)

section("Failures", () =>
  table(
    all(
      `SELECT pp.name AS phase, pr.error AS error, COUNT(*) AS n
       FROM playbook_runs r JOIN process_phase_runs pr ON pr.run_id = r.process_run_id
       LEFT JOIN process_phases pp ON pp.id = pr.phase_id
       WHERE r.feature_id = ? AND pr.status = 'failed'
       GROUP BY pp.name, pr.error ORDER BY n DESC`,
      F
    ),
    [
      ["phase", (f) => cut(f.phase, 30)],
      ["times", (f) => f.n],
      ["error", (f) => cut(f.error, 90)],
    ]
  )
)

section("Merges", () =>
  table(
    all(
      `SELECT q.*, u.key AS story FROM merge_queue q JOIN user_stories u ON u.id = q.user_story_id
       JOIN milestones m ON m.id = q.milestone_id WHERE m.feature_id = ? ORDER BY q.created_at`,
      F
    ),
    [
      ["story", (q) => q.story],
      ["status", (q) => q.status],
      ["conflicts", (q) => JSON.parse(q.conflict_files || "[]").length],
      ["resolutions", (q) => q.resolution_attempts],
      ["proof→merged min", (q) => mins(q.finished_at && q.finished_at - q.proof_accepted_at)],
      ["note", (q) => cut(q.note, 70)],
    ]
  )
)

section("Concurrency", () => {
  const storyRuns = runs.filter((r) => r.hook === "run")
  const peak = Math.max(
    0,
    ...storyRuns.map(
      (x) =>
        storyRuns.filter(
          (y) => y.created_at <= x.created_at && (y.finished_at ?? Infinity) > x.created_at
        ).length
    )
  )
  console.log(`  Most user stories running at once: ${peak}`)
})

section("Models and tools", () => {
  const models = all(
    `SELECT json_extract(pr.runtime_snapshot, '$.worker.modelId') AS model, COUNT(*) AS n
     FROM playbook_runs r JOIN process_phase_runs pr ON pr.run_id = r.process_run_id
     WHERE r.feature_id = ? GROUP BY 1 ORDER BY 2 DESC`,
    F
  )
  console.log(
    `  Models (phases): ${models.map((m) => `${m.model ?? "unrecorded"} ×${m.n}`).join(", ") || "none"}`
  )
  const escalations = one(
    `SELECT COUNT(*) AS n FROM model_request_retry_budgets
     WHERE logical_round_id LIKE '%:cap-%' AND conversation_id IN ${inConversations}`,
    ...conversations
  ).n
  console.log(`  Output-cap escalations: ${escalations}`)
  const tools = all(
    `SELECT tool_name, COUNT(*) AS n FROM messages
     WHERE role = 'tool' AND conversation_id IN ${inConversations}
     GROUP BY tool_name ORDER BY n DESC LIMIT 10`,
    ...conversations
  )
  console.log(`  Top tools: ${tools.map((t) => `${t.tool_name} ×${t.n}`).join(", ") || "none"}`)
  const index = tools.find((t) => t.tool_name === "index_query_tool")?.n ?? 0
  console.log(`  index_query_tool calls: ${index}`)
})

section("Seat messages", () => {
  const rows = all(
    `SELECT status, COUNT(*) AS n, MAX(hop) AS hop FROM seat_messages
     WHERE feature_id = ? AND from_address NOT LIKE '%@rig' GROUP BY status`,
    F
  )
  const navigator = one(
    `SELECT COUNT(*) AS n FROM seat_messages WHERE feature_id = ? AND from_address LIKE '%@rig'`,
    F
  ).n
  console.log(
    `  Seat to seat: ${rows.map((r) => `${r.status} ${r.n}`).join(", ") || "none"}; from the Navigator/user: ${navigator}`
  )
})

section("Plan shape (as it ran)", () => {
  const cap = Math.max(1, budgets.maxConcurrentUserStories ?? 3)
  for (const m of milestones) {
    const live = stories.filter((s) => s.milestone_id === m.id && s.status !== "cancelled")
    if (!live.length) continue
    const items = live.map((s) => ({
      id: s.id,
      key: s.key,
      touchHints: JSON.parse(s.spec || "{}").touchHints ?? [],
      runsLast: JSON.parse(s.spec || "{}").runsLast === true,
      position: s.position,
    }))
    const explicit = all(
      `SELECT from_user_story_id AS fromUserStoryId, to_user_story_id AS toUserStoryId
       FROM user_story_edges WHERE milestone_id = ?`,
      m.id
    )
    const edges = withRunsLastEdges(items, explicit)
    const keyOf = new Map(items.map((s) => [s.id, s.key]))
    const wait = scheduleSteps(items, edges, { maxConcurrent: cap, overlap: "wait" })
    const parallel = scheduleSteps(items, edges, { maxConcurrent: cap, overlap: "parallel" })
    const pairs = overlappingPairs(items, edges).map(([a, b]) => `${keyOf.get(a)} ↔ ${keyOf.get(b)}`)
    console.log(`  ${m.key}: ${items.length} stories; ${wait.length} steps if overlapping stories wait, ${parallel.length} in parallel (cap ${cap})`)
    wait.forEach((step, i) => console.log(`    wait ${i + 1}: ${step.map((id) => keyOf.get(id)).join(", ")}`))
    if (pairs.length) console.log(`    overlapping: ${pairs.join(", ")}`)
  }
})

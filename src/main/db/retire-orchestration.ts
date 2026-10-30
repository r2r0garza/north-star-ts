import type Database from "better-sqlite3"

export const ORCHESTRATION_TABLES = [
  "process_phase_attempts",
  "process_flags",
  "process_phase_runs",
  "process_runs",
  "process_edges",
  "process_phase_agents",
  "process_phases",
  "process_definitions",
  "workspace_analyses",
  "health_signals",
  "mc_events",
  "seat_memory_exposures",
  "seat_memories",
  "navigator_ticks",
  "plan_proposals",
  "merge_queue",
  "seat_messages",
  "seat_threads",
  "seat_sessions",
  "playbook_runs",
  "playbook_hooks",
  "playbooks",
  "work_revisions",
  "user_story_edges",
  "user_stories",
  "milestones",
  "features",
  "slice_edges",
  "slices",
  "missions",
  "initiatives",
  "rig_oversight",
  "rig_seats",
  "rig_pods",
  "rigs",
] as const

export function retireOrchestration(db: Database.Database): void {
  // Keep task history, but never resume executors that no longer exist.
  db.prepare(
    `UPDATE tasks SET status = 'cancelled', updated_at = ?
    WHERE CASE WHEN json_valid(input) THEN json_extract(input, '$.kind') END IN ('process_run', 'seat_wake')
    AND status IN ('queued', 'running', 'waiting_for_approval', 'paused', 'interrupted')`
  ).run(Date.now())
  for (const table of ORCHESTRATION_TABLES)
    db.exec(`DROP TABLE IF EXISTS ${table}`)
}

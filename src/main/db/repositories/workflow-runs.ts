import { getDb } from "../connection"
import type { WorkflowRun } from "../../../shared/workflow-runs"

export function saveWorkflowRun(run: WorkflowRun): void {
  getDb()
    .prepare(
      `INSERT INTO workflow_runs (id, data) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data`
    )
    .run(run.id, JSON.stringify(run))
}

export function getWorkflowRun(id: string): WorkflowRun | undefined {
  const row = getDb()
    .prepare("SELECT data FROM workflow_runs WHERE id = ?")
    .get(id) as { data: string } | undefined
  return row ? JSON.parse(row.data) : undefined
}

export function listWorkflowRuns(): WorkflowRun[] {
  const rows = getDb()
    .prepare(
      "SELECT data FROM workflow_runs ORDER BY json_extract(data, '$.createdAt') DESC"
    )
    .all() as { data: string }[]
  return rows.map((row) => JSON.parse(row.data))
}

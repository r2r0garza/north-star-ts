import { beforeEach, afterEach, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"
import {
  getWorkflowRun,
  listWorkflowRuns,
  saveWorkflowRun,
} from "./workflow-runs"
import { listWorkflows, deleteWorkflow, updateWorkflow } from "./workflows"
import { createConversation, listConversations } from "./conversations"
import type { WorkflowRun } from "../../../shared/workflow-runs"
const sqliteLoads = sqliteLoadsForTests()
let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))
beforeEach(() => {
  if (sqliteLoads) {
    db = new Database(":memory:")
    runMigrations(db)
  }
})
afterEach(() => {
  if (sqliteLoads) db.close()
})
it.skipIf(!sqliteLoads)(
  "keeps snapshots after library edits/deletion and hides private step transcripts",
  () => {
    const workflow = listWorkflows()[0]
    const conversation = createConversation({ mode: "north_star" })
    const run = {
      id: "run",
      createdAt: 1,
      workflow,
      steps: [{ ...workflow.steps[0], conversationId: conversation.id }],
    } as WorkflowRun
    saveWorkflowRun(run)
    updateWorkflow({ ...workflow, name: "Changed", steps: [] })
    deleteWorkflow(workflow.id)
    expect(getWorkflowRun("run")?.workflow).toEqual(workflow)
    expect(listWorkflowRuns()).toHaveLength(1)
    expect(listConversations().map((item) => item.id)).not.toContain(
      conversation.id
    )
    run.createdAt = 2
    saveWorkflowRun(run)
    runMigrations(db)
    expect(listWorkflowRuns()).toHaveLength(1)
    expect(getWorkflowRun("run")?.createdAt).toBe(2)
  }
)

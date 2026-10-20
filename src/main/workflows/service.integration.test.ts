import { beforeEach, afterEach, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"
import { upsertWorkspace } from "../db/repositories/workspaces"
import { createProject } from "../db/repositories/projects"
import { createConversation } from "../db/repositories/conversations"
import { appendMessage, listMessages } from "../db/repositories/messages"
import { createTask, listTasks } from "../db/repositories/tasks"
import { listWorkflows, updateWorkflow } from "../db/repositories/workflows"
import type { TaskRunner } from "../tasks/runner"
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock("../db/connection", () => ({ getDb: () => db }))
vi.mock("../agent/providers", () => ({
  resolveLlmTarget: () => ({ account: { id: "account" }, model: "model" }),
}))
vi.mock("../agent", () => ({ runAgentLoop: vi.fn() }))
vi.mock("../agent/repair", () => ({ unknownSideEffectingToolCalls: () => [] }))
vi.mock("../index/auto-index", () => ({ autoIndexWorkspace: vi.fn() }))
vi.mock("../index/indexed-workspace", () => ({ indexedWorkspaceFor: vi.fn() }))
import { WorkflowService } from "./service"
const sqliteLoads = sqliteLoadsForTests()
let db: Database.Database
let directory: string
beforeEach(() => {
  if (!sqliteLoads) return
  directory = mkdtempSync(join(tmpdir(), "sidebar-workflow-"))
  db = new Database(":memory:")
  runMigrations(db)
})
afterEach(() => {
  if (sqliteLoads) {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
it.skipIf(!sqliteLoads)(
  "persists a normal workflow run and durable task without changing the origin conversation",
  () => {
    const workspace = upsertWorkspace(directory)
    const project = createProject({
      name: "Project",
      workspaceId: workspace.id,
    })
    const origin = createConversation({
      mode: "north_star",
      workspaceId: workspace.id,
      projectId: project.id,
    })
    appendMessage({
      conversationId: origin.id,
      role: "user",
      content: "Keep this conversation",
    })
    const before = listMessages(origin.id)
    const workflow = {
      ...listWorkflows()[0],
      defaultObjective: "Review this project",
      viewInConversationSidebar: true,
    }
    updateWorkflow(workflow)
    const enqueueKind = vi.fn(
      (input: {
        kind: string
        title: string
        input: { workspaceId: string; runId: string }
      }) => {
        const worker = createConversation({
          mode: "interactive",
          workspaceId: input.input.workspaceId,
        })
        return createTask({
          conversationId: worker.id,
          title: input.title,
          status: "queued",
          input: { kind: input.kind, ...input.input },
        })
      }
    )
    const service = new WorkflowService({
      enqueueKind,
    } as unknown as TaskRunner)
    const run = service.start({
      workflowId: workflow.id,
      objective: workflow.defaultObjective,
      workspaceId: workspace.id,
      projectId: project.id,
    })
    expect(run.objective).toBe(workflow.defaultObjective)
    expect(run.workflow).toEqual(workflow)
    expect(run.workspacePath).toBe(directory)
    expect(run.projectId).toBe(project.id)
    expect(service.list()).toEqual([run])
    expect(listTasks()).toHaveLength(1)
    expect(listTasks()[0].input).toEqual({
      kind: "workflow_run",
      workspaceId: workspace.id,
      runId: run.id,
    })
    expect(listMessages(origin.id)).toEqual(before)
    expect(enqueueKind).toHaveBeenCalledTimes(1)
    const absent = upsertWorkspace(join(directory, "missing"))
    expect(() =>
      service.start({
        workflowId: workflow.id,
        objective: workflow.defaultObjective,
        workspaceId: absent.id,
      })
    ).toThrow()
    expect(() =>
      service.start({
        workflowId: workflow.id,
        objective: workflow.defaultObjective,
        workspaceId: workspace.id,
        projectId: "deleted",
      })
    ).toThrow("Project does not match")
    expect(service.list()).toHaveLength(1)
    expect(listTasks()).toHaveLength(1)
  }
)

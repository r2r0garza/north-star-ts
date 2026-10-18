import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runMigrations } from "../migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"
import {
  createWorkflow,
  deleteWorkflow,
  listWorkflows,
  updateWorkflow,
} from "./workflows"

const sqliteLoads = sqliteLoadsForTests()
let db: Database.Database
let directory: string
vi.mock("../connection", () => ({ getDb: () => db }))

beforeEach(() => {
  if (!sqliteLoads) return
  directory = mkdtempSync(join(tmpdir(), "workflows-test-"))
  db = new Database(join(directory, "app.db"))
  runMigrations(db)
})
afterEach(() => {
  if (!sqliteLoads) return
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

describe.skipIf(!sqliteLoads)("workflow storage", () => {
  it("adds an empty default objective to existing workflows without changing their content", () => {
    const original = listWorkflows()
    db.exec("ALTER TABLE workflows DROP COLUMN default_objective")
    db.pragma("user_version = 72")
    runMigrations(db)
    expect(listWorkflows()).toEqual(original)
    runMigrations(db)
    expect(listWorkflows()).toEqual(original)
  })

  it("deletes only the selected workflow and does not reseed it on restart", () => {
    const original = listWorkflows()
    deleteWorkflow(original[1].id)
    db.close()
    db = new Database(join(directory, "app.db"))
    runMigrations(db)
    expect(listWorkflows()).toEqual([original[0], original[2]])
    expect(() => deleteWorkflow("unknown")).not.toThrow()
    expect(() => deleteWorkflow(null as never)).toThrow("Invalid workflow id")
  })

  it("creates unique workflows, saves edits, and preserves them after reopening", () => {
    const first = createWorkflow()
    const second = createWorkflow()
    expect(first).toEqual({
      id: expect.any(String),
      name: "New workflow",
      description: "",
      defaultObjective: "",
      steps: [],
    })
    expect(second.id).not.toBe(first.id)
    expect(listWorkflows().slice(-2)).toEqual([first, second])
    const edited = {
      ...first,
      name: "My workflow",
      description: "My description",
      defaultObjective: "My default objective",
      steps: [{ id: "step", title: "First step", instructions: "Do the work" }],
    }
    updateWorkflow(edited)
    db.close()
    db = new Database(join(directory, "app.db"))
    runMigrations(db)
    expect(listWorkflows().slice(-2)).toEqual([edited, second])
    db.prepare("DELETE FROM workflows").run()
    expect(listWorkflows()).toEqual([])
    expect(listWorkflows().length).toBe(0)
    const only = createWorkflow()
    expect(listWorkflows()).toEqual([only])
  })

  it("seeds examples once and preserves edits, order, additions, and deletions after reopening", () => {
    expect(listWorkflows().map((workflow) => workflow.name)).toEqual([
      "Code review",
      "Project health check",
      "Release preparation",
    ])
    const workflow = listWorkflows()[0]
    workflow.name = "My review"
    workflow.description = "Custom instructions"
    workflow.steps = [
      workflow.steps[2],
      { id: "new", title: "New title", instructions: "New instructions" },
      workflow.steps[0],
    ]
    workflow.steps[2].instructions = "Edited instructions"
    updateWorkflow(workflow)
    db.close()
    db = new Database(join(directory, "app.db"))
    runMigrations(db)
    expect(listWorkflows()[0]).toEqual(workflow)
    workflow.steps = []
    updateWorkflow(workflow)
    runMigrations(db)
    expect(listWorkflows()[0].steps).toEqual([])
    db.prepare("DELETE FROM workflows").run()
    runMigrations(db)
    expect(listWorkflows()).toEqual([])
  })

  it("rejects malformed steps and unknown workflows without changing saved data", () => {
    const original = listWorkflows()
    expect(() =>
      updateWorkflow({
        ...original[0],
        steps: [original[0].steps[0], original[0].steps[0]],
      })
    ).toThrow("Invalid workflow")
    expect(() =>
      updateWorkflow({ ...original[0], steps: [{ id: "bad" }] } as never)
    ).toThrow("Invalid workflow")
    expect(() =>
      updateWorkflow({ ...original[0], defaultObjective: null } as never)
    ).toThrow("Invalid workflow")
    expect(() => updateWorkflow({ ...original[0], id: "unknown" })).toThrow(
      "Workflow not found"
    )
    expect(listWorkflows()).toEqual(original)
  })
})

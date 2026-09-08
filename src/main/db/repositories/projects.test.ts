import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

import {
  createProject,
  getProject,
  listProjects,
  updateProject,
  deleteProject,
  reorderProjects,
} from "./projects"
import { upsertWorkspace, deleteWorkspace } from "./workspaces"
import { createConversation, getConversation } from "./conversations"

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)("projects", () => {
  it("creates a project with no directory by default", () => {
    const p = createProject({ name: "Project A" })
    expect(p.name).toBe("Project A")
    expect(p.workspaceId).toBeNull()
    expect(getProject(p.id)?.name).toBe("Project A")
  })

  it("persists a directory (workspace_id) at create time", () => {
    const ws = upsertWorkspace("/tmp/proj-a")
    const p = createProject({ name: "Project A", workspaceId: ws.id })
    expect(getProject(p.id)?.workspaceId).toBe(ws.id)
  })

  it("updates the name and can set / clear the directory", () => {
    const ws = upsertWorkspace("/tmp/proj-b")
    const p = createProject({ name: "Old" })
    updateProject(p.id, { name: "New", workspaceId: ws.id })
    const updated = getProject(p.id)!
    expect(updated.name).toBe("New")
    expect(updated.workspaceId).toBe(ws.id)
    // Clearing the directory makes the project Chat-only again.
    updateProject(p.id, { workspaceId: null })
    expect(getProject(p.id)?.workspaceId).toBeNull()
  })

  it("lists projects by explicit position", () => {
    const a = createProject({ name: "A" })
    const b = createProject({ name: "B" })
    reorderProjects([a.id, b.id])
    updateProject(b.id, { name: "B2" })
    const names = listProjects().map((p) => p.name)
    expect(names).toEqual(["A", "B2"])
  })

  it("places newly-created projects at the top until manually reordered", () => {
    createProject({ name: "A" })
    createProject({ name: "B" })
    expect(listProjects().map((p) => p.name)).toEqual(["B", "A"])
  })

  it("reorders projects", () => {
    const a = createProject({ name: "A" })
    const b = createProject({ name: "B" })
    const c = createProject({ name: "C" })
    const reordered = reorderProjects([b.id, c.id, a.id])
    expect(reordered.map((p) => p.name)).toEqual(["B", "C", "A"])
    expect(listProjects().map((p) => p.position)).toEqual([0, 1, 2])
  })

  it("rejects incomplete project reorders", () => {
    const a = createProject({ name: "A" })
    createProject({ name: "B" })
    expect(() => reorderProjects([a.id])).toThrow(
      "Project reorder must include every project exactly once"
    )
  })

  it("keeps conversations but nulls their project_id when a project is deleted", () => {
    const p = createProject({ name: "Doomed" })
    const c = createConversation({ mode: "chat", projectId: p.id })
    expect(getConversation(c.id)?.projectId).toBe(p.id)
    deleteProject(p.id)
    // ON DELETE SET NULL: the conversation survives and falls back to "No Project".
    const after = getConversation(c.id)
    expect(after).toBeDefined()
    expect(after?.projectId).toBeNull()
  })

  it("nulls a project's workspace_id when the workspace is deleted", () => {
    const ws = upsertWorkspace("/tmp/proj-c")
    const p = createProject({ name: "C", workspaceId: ws.id })
    deleteWorkspace(ws.id)
    expect(getProject(p.id)?.workspaceId).toBeNull()
  })
})

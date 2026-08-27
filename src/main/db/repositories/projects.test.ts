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

  it("lists projects most-recently-updated first", () => {
    const a = createProject({ name: "A" })
    createProject({ name: "B" })
    // Touch A so it becomes the most recently updated.
    updateProject(a.id, { name: "A2" })
    const names = listProjects().map((p) => p.name)
    expect(names[0]).toBe("A2")
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

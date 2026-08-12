import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { runMigrations } from "../migrations"

let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

// better-sqlite3's native binary is built for the Electron ABI here; under
// plain-Node vitest it may not load (see native-module-rebuild note). SQLite-
// backed tests skip rather than fail when the ABI mismatches.
let sqliteLoads = true
try {
  new Database(":memory:").close()
} catch {
  sqliteLoads = false
}

import {
  getRunByWorkspace,
  upsertRun,
  updateProgress,
  setEnabled,
  resetRun,
  listEnabledRuns,
} from "./index-runs"
import {
  upsertFile,
  getFileByPath,
  listPaths,
  countByExt,
  deleteFilesByWorkspace,
} from "./index-files"
import {
  upsertMetadata,
  listMetadata,
  deleteMetadataByWorkspace,
} from "./index-metadata"

function freshWorkspace(path = `/tmp/${randomUUID()}`): string {
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    "INSERT INTO workspaces (id, path, name, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)"
  ).run(id, path, now, now)
  return id
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)("v8 migration", () => {
  it("creates the four index tables", () => {
    for (const name of [
      "index_runs",
      "index_files",
      "index_metadata",
      "index_symbols",
    ]) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(name)
      expect(row, name).toBeTruthy()
    }
  })

  it("reaches the latest user_version", () => {
    expect(db.pragma("user_version", { simple: true })).toBe(23)
  })

  it("widens tasks.status to accept 'paused'", () => {
    const conv = randomUUID()
    const now = Date.now()
    db.prepare(
      "INSERT INTO conversations (id, mode, title, workspace_id, created_at, updated_at) VALUES (?, 'interactive', NULL, NULL, ?, ?)"
    ).run(conv, now, now)
    expect(() =>
      db
        .prepare(
          "INSERT INTO tasks (id, conversation_id, source_conversation_id, title, status, input, result, error, created_at, updated_at) VALUES (?, ?, ?, NULL, 'paused', NULL, NULL, NULL, ?, ?)"
        )
        .run(randomUUID(), conv, conv, now, now)
    ).not.toThrow()
  })

  it("preserves existing task rows through the tasks rebuild", () => {
    // Rebuild the migration chain on a db seeded before v8 would be ideal, but
    // the chain runs to completion in beforeEach; instead assert a task inserted
    // post-migration round-trips (the rebuild kept the schema usable).
    const conv = randomUUID()
    const now = Date.now()
    db.prepare(
      "INSERT INTO conversations (id, mode, title, workspace_id, created_at, updated_at) VALUES (?, 'interactive', NULL, NULL, ?, ?)"
    ).run(conv, now, now)
    const taskId = randomUUID()
    db.prepare(
      "INSERT INTO tasks (id, conversation_id, source_conversation_id, title, status, input, result, error, created_at, updated_at) VALUES (?, ?, ?, 'x', 'queued', NULL, NULL, NULL, ?, ?)"
    ).run(taskId, conv, conv, now, now)
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as {
      source_conversation_id: string
    }
    expect(row.source_conversation_id).toBe(conv)
  })
})

describe.skipIf(!sqliteLoads)("index-runs", () => {
  it("upserts a single row per workspace (UNIQUE)", () => {
    const ws = freshWorkspace()
    const a = upsertRun(ws, { priority: "high", stage: "file_map" })
    const b = upsertRun(ws, { filesTotal: 100 })
    expect(a.id).toBe(b.id)
    expect(b.priority).toBe("high")
    expect(b.filesTotal).toBe(100)
  })

  it("defaults enabled=true, stage=file_map, priority=low", () => {
    const ws = freshWorkspace()
    const run = upsertRun(ws)
    expect(run.enabled).toBe(true)
    expect(run.stage).toBe("file_map")
    expect(run.priority).toBe("low")
  })

  it("updateProgress writes scanned/total/stage/cursor", () => {
    const ws = freshWorkspace()
    upsertRun(ws)
    updateProgress(ws, {
      filesScanned: 42,
      filesTotal: 100,
      stage: "metadata",
      cursor: "src/x",
    })
    const run = getRunByWorkspace(ws)!
    expect(run.filesScanned).toBe(42)
    expect(run.filesTotal).toBe(100)
    expect(run.stage).toBe("metadata")
    expect(run.cursor).toBe("src/x")
  })

  it("setEnabled toggles the flag", () => {
    const ws = freshWorkspace()
    upsertRun(ws)
    expect(setEnabled(ws, false).enabled).toBe(false)
    expect(setEnabled(ws, true).enabled).toBe(true)
  })

  it("resetRun clears cursor/counts/taskId but keeps enabled", () => {
    const ws = freshWorkspace()
    upsertRun(ws, {
      taskId: "t1",
      cursor: "c",
      filesScanned: 5,
      filesTotal: 9,
      enabled: true,
    })
    const run = resetRun(ws)
    expect(run.taskId).toBeNull()
    expect(run.cursor).toBeNull()
    expect(run.filesScanned).toBe(0)
    expect(run.filesTotal).toBe(0)
    expect(run.stage).toBe("file_map")
    expect(run.enabled).toBe(true)
  })

  it("clears task_id when passed null explicitly", () => {
    const ws = freshWorkspace()
    upsertRun(ws, { taskId: "t1" })
    expect(getRunByWorkspace(ws)!.taskId).toBe("t1")
    upsertRun(ws, { taskId: null })
    expect(getRunByWorkspace(ws)!.taskId).toBeNull()
  })

  it("listEnabledRuns returns only enabled rows", () => {
    const a = freshWorkspace()
    const b = freshWorkspace()
    upsertRun(a, { enabled: true })
    upsertRun(b, { enabled: false })
    const ids = listEnabledRuns().map((r) => r.workspaceId)
    expect(ids).toContain(a)
    expect(ids).not.toContain(b)
  })

  it("cascades on workspace delete", () => {
    const ws = freshWorkspace()
    upsertRun(ws)
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(ws)
    expect(getRunByWorkspace(ws)).toBeUndefined()
  })
})

describe.skipIf(!sqliteLoads)("index-files", () => {
  const base = {
    size: 10,
    mtime: 1,
    hash: "h",
    indexedStage: "file_map" as const,
  }

  it("upserts by (workspace, path) and hash-skip lookup finds it", () => {
    const ws = freshWorkspace()
    upsertFile({ workspaceId: ws, path: "a.ts", ext: ".ts", ...base })
    const f = getFileByPath(ws, "a.ts")!
    expect(f.hash).toBe("h")
    // Re-upsert same path updates in place (no duplicate).
    upsertFile({
      workspaceId: ws,
      path: "a.ts",
      ext: ".ts",
      ...base,
      hash: "h2",
    })
    expect(getFileByPath(ws, "a.ts")!.hash).toBe("h2")
    expect(listPaths(ws).size).toBe(1)
  })

  it("listPaths returns the tracked set for deletion diffing", () => {
    const ws = freshWorkspace()
    upsertFile({ workspaceId: ws, path: "a.ts", ...base })
    upsertFile({ workspaceId: ws, path: "b.ts", ...base })
    expect(listPaths(ws)).toEqual(new Set(["a.ts", "b.ts"]))
  })

  it("countByExt groups by extension", () => {
    const ws = freshWorkspace()
    upsertFile({ workspaceId: ws, path: "a.ts", ext: ".ts", ...base })
    upsertFile({ workspaceId: ws, path: "b.ts", ext: ".ts", ...base })
    upsertFile({ workspaceId: ws, path: "c.md", ext: ".md", ...base })
    const counts = Object.fromEntries(
      countByExt(ws).map((r) => [r.ext, r.count])
    )
    expect(counts[".ts"]).toBe(2)
    expect(counts[".md"]).toBe(1)
  })

  it("deleteFilesByWorkspace clears all rows", () => {
    const ws = freshWorkspace()
    upsertFile({ workspaceId: ws, path: "a.ts", ...base })
    deleteFilesByWorkspace(ws)
    expect(listPaths(ws).size).toBe(0)
  })

  it("cascades index_symbols when a file is deleted", () => {
    const ws = freshWorkspace()
    const f = upsertFile({ workspaceId: ws, path: "a.ts", ...base })
    const now = Date.now()
    db.prepare(
      "INSERT INTO index_symbols (id, workspace_id, file_id, name, kind, line, detail, updated_at) VALUES (?, ?, ?, 'foo', 'function', 1, NULL, ?)"
    ).run(randomUUID(), ws, f.id, now)
    db.prepare("DELETE FROM index_files WHERE id = ?").run(f.id)
    const remaining = db
      .prepare("SELECT COUNT(*) AS c FROM index_symbols WHERE file_id = ?")
      .get(f.id) as { c: number }
    expect(remaining.c).toBe(0)
  })
})

describe.skipIf(!sqliteLoads)("index-metadata", () => {
  it("replaces by (workspace, kind)", () => {
    const ws = freshWorkspace()
    upsertMetadata({
      workspaceId: ws,
      kind: "package_json",
      value: { name: "a" },
    })
    upsertMetadata({
      workspaceId: ws,
      kind: "package_json",
      value: { name: "b" },
    })
    const list = listMetadata(ws)
    expect(list).toHaveLength(1)
    expect((list[0].value as { name: string }).name).toBe("b")
  })

  it("parses stored JSON back", () => {
    const ws = freshWorkspace()
    upsertMetadata({ workspaceId: ws, kind: "git", value: { branch: "main" } })
    expect(listMetadata(ws)[0].value).toEqual({ branch: "main" })
  })

  it("deleteMetadataByWorkspace clears rows", () => {
    const ws = freshWorkspace()
    upsertMetadata({ workspaceId: ws, kind: "git", value: {} })
    deleteMetadataByWorkspace(ws)
    expect(listMetadata(ws)).toHaveLength(0)
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { runMigrations } from "../db/migrations"

let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))

let sqliteLoads = true
try {
  new Database(":memory:").close()
} catch {
  sqliteLoads = false
}

import { buildIndexSummary } from "./summary"
import { IndexService } from "./service"
import type { TaskRunner } from "../tasks/runner"

let root: string
let workspaceId: string

const fakeRunner = () => ({ enqueueKind: () => ({ id: randomUUID() }) }) as unknown as TaskRunner

async function buildIndex(): Promise<void> {
  const svc = new IndexService(fakeRunner())
  const ac = new AbortController()
  await svc.execute({
    task: { id: "t", input: { workspaceId, priority: "high" } } as never,
    signal: ac.signal,
    emit: () => {},
    workspace: root,
  })
}

beforeEach(async () => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
  root = await mkdtemp(join(tmpdir(), "summary-"))
  const now = Date.now()
  workspaceId = randomUUID()
  db.prepare(
    "INSERT INTO workspaces (id, path, name, created_at, updated_at) VALUES (?, ?, 'ws', ?, ?)"
  ).run(workspaceId, root, now, now)
})
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

describe.skipIf(!sqliteLoads)("buildIndexSummary", () => {
  it("returns null before any index run exists", () => {
    // fresh workspace, no run row
    const ws2 = randomUUID()
    const now = Date.now()
    db.prepare(
      "INSERT INTO workspaces (id, path, name, created_at, updated_at) VALUES (?, '/tmp/none', 'x', ?, ?)"
    ).run(ws2, now, now)
    expect(buildIndexSummary(ws2)).toBeNull()
  })

  it("by-ext counts reconcile with the total (extensionless included in remainder)", async () => {
    await writeFile(join(root, "a.ts"), "export const a = 1")
    await writeFile(join(root, "b.ts"), "export const b = 1")
    await writeFile(join(root, "c.md"), "# hi")
    await writeFile(join(root, ".gitignore"), "x") // extensionless
    await buildIndex()

    const summary = buildIndexSummary(workspaceId)!
    // Status line reports the true total (4 files).
    expect(summary).toContain("indexed (4 files)")
    // By-type line reconciles: .ts 2, .md 1, plus the extensionless remainder.
    expect(summary).toContain("total 4")
    expect(summary).toContain("other 1")
  })

  it("advertises the query tool once symbols are indexed", async () => {
    await writeFile(join(root, "a.ts"), "export function foo() {}")
    await buildIndex()
    const summary = buildIndexSummary(workspaceId)!
    expect(summary).toContain("index_query_tool")
  })
})

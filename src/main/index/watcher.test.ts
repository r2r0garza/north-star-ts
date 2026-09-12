import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()
let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))

import { upsertRun } from "../db/repositories/index-runs"
import { listMetadata } from "../db/repositories/index-metadata"
import type { TaskStatus } from "../db/types"
import type { TaskEventPayload, TaskRunner } from "../tasks/runner"
import { IndexWatcher } from "./watcher"

let root: string
let workspaceId: string
let watchers: IndexWatcher[]

type Listener = (
  taskId: string,
  event: TaskEventPayload,
  eventId: number
) => void

function fakeRunner() {
  const listeners = new Set<Listener>()
  const runner = {
    calls: 0,
    subscribe(listener: Listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    enqueueKind() {
      this.calls += 1
      const id = randomUUID()
      const conversationId = randomUUID()
      const now = Date.now()
      db.prepare(
        "INSERT INTO conversations (id, mode, workspace_id, created_at, updated_at) VALUES (?, 'interactive', ?, ?, ?)"
      ).run(conversationId, workspaceId, now, now)
      db.prepare(
        "INSERT INTO tasks (id, conversation_id, title, status, created_at, updated_at) VALUES (?, ?, 'index', 'queued', ?, ?)"
      ).run(id, conversationId, now, now)
      return { id }
    },
    emit(taskId: string, from: TaskStatus, to: TaskStatus) {
      db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(to, taskId)
      for (const listener of listeners) {
        listener(taskId, { type: "status_change", from, to }, 0)
      }
    },
  }
  return runner
}

beforeEach(async () => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
  root = await mkdtemp(join(tmpdir(), "index-watcher-"))
  workspaceId = randomUUID()
  const now = Date.now()
  db.prepare(
    "INSERT INTO workspaces (id, path, name, created_at, updated_at) VALUES (?, ?, 'watch', ?, ?)"
  ).run(workspaceId, root, now, now)
  upsertRun(workspaceId, { enabled: true })
  watchers = []
})

afterEach(async () => {
  await Promise.all((watchers ?? []).map((watcher) => watcher.stopAll()))
  if (root) await rm(root, { recursive: true, force: true })
  db?.close()
})

describe.skipIf(!sqliteLoads)("IndexWatcher", () => {
  it("coalesces workspace changes and ignores skipped directories", async () => {
    const runner = fakeRunner()
    const service = {
      ensureRunning: vi.fn(() => {
        runner.calls += 1
      }),
      refreshMetadata: vi.fn(),
    }
    const watcher = new IndexWatcher(
      runner as unknown as TaskRunner,
      service as never
    )
    watchers.push(watcher)
    await watcher.start(workspaceId)
    await new Promise((resolve) => setTimeout(resolve, 150))

    await writeFile(join(root, "a.ts"), "a")
    await writeFile(join(root, "b.ts"), "b")
    await mkdir(join(root, "dist"))
    await writeFile(join(root, "dist", "ignored.js"), "x")

    await vi.waitFor(
      () => expect(service.ensureRunning).toHaveBeenCalledTimes(1),
      {
        timeout: 3_000,
      }
    )
  })

  it("refreshes Git metadata after an identical-tree branch switch", async () => {
    execFileSync("git", ["init", "-b", "main"], { cwd: root })
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
    })
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root })
    await writeFile(join(root, "tracked.txt"), "same\n")
    execFileSync("git", ["add", "."], { cwd: root })
    execFileSync("git", ["commit", "-m", "initial"], { cwd: root })
    execFileSync("git", ["branch", "other"], { cwd: root })

    const runner = fakeRunner()
    const service = {
      ensureRunning: vi.fn(),
      refreshMetadata: vi.fn(async () => {
        const branch = execFileSync("git", ["branch", "--show-current"], {
          cwd: root,
        })
          .toString()
          .trim()
        db.prepare(
          "DELETE FROM index_metadata WHERE workspace_id = ? AND kind = 'git'"
        ).run(workspaceId)
        db.prepare(
          "INSERT INTO index_metadata (id, workspace_id, kind, path, value, updated_at) VALUES (?, ?, 'git', 'git', ?, ?)"
        ).run(randomUUID(), workspaceId, JSON.stringify({ branch }), Date.now())
      }),
    }
    const watcher = new IndexWatcher(
      runner as unknown as TaskRunner,
      service as never
    )
    watchers.push(watcher)
    await watcher.start(workspaceId)
    await new Promise((resolve) => setTimeout(resolve, 150))
    execFileSync("git", ["switch", "other"], { cwd: root })

    await vi.waitFor(() => expect(service.refreshMetadata).toHaveBeenCalled(), {
      timeout: 3_000,
    })
    const git = listMetadata(workspaceId).find((row) => row.kind === "git")
    expect((git?.value as { branch?: string }).branch).toBe("other")
  })

  it("queues one follow-up when files change during a live index", async () => {
    const runner = fakeRunner()
    const task = runner.enqueueKind()
    upsertRun(workspaceId, { taskId: task.id })
    const service = { ensureRunning: vi.fn(), refreshMetadata: vi.fn() }
    const watcher = new IndexWatcher(
      runner as unknown as TaskRunner,
      service as never
    )
    watchers.push(watcher)
    await watcher.start(workspaceId)
    await new Promise((resolve) => setTimeout(resolve, 150))
    await writeFile(join(root, "during.ts"), "changed")
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(service.ensureRunning).not.toHaveBeenCalled()

    runner.emit(task.id, "queued", "completed")
    expect(service.ensureRunning).toHaveBeenCalledTimes(1)
  })
})

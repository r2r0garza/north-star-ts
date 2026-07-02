import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises"
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

import { IndexService } from "./service"
import {
  listFiles,
  listPaths,
  getFileByPath,
} from "../db/repositories/index-files"
import { listMetadata } from "../db/repositories/index-metadata"
import {
  findSymbolsByName,
  findImportsOf,
  countSymbols,
} from "../db/repositories/index-symbols"
import { getRunByWorkspace, upsertRun } from "../db/repositories/index-runs"
import type { TaskRunner } from "../tasks/runner"

let root: string
let workspaceId: string

// A minimal fake runner: the service only calls enqueueKind (in ensureRunning).
// The executor itself is invoked directly in these tests.
// A fake runner that records enqueue calls and creates a real task row (so
// ensureRunning's "is a build already live?" check can read it back).
interface FakeRunner extends TaskRunner {
  calls: number
  lastTaskId: string | null
}
function fakeRunner(): FakeRunner {
  const obj = {
    calls: 0,
    lastTaskId: null as string | null,
    enqueueKind(input: { input: { workspaceId?: string } }) {
      this.calls++
      const id = randomUUID()
      this.lastTaskId = id
      const now = Date.now()
      // Mirror the real enqueueKind: create a conversation + a queued task row.
      const convId = randomUUID()
      db.prepare(
        "INSERT INTO conversations (id, mode, title, workspace_id, created_at, updated_at) VALUES (?, 'interactive', NULL, ?, ?, ?)"
      ).run(convId, input.input.workspaceId ?? null, now, now)
      db.prepare(
        "INSERT INTO tasks (id, conversation_id, source_conversation_id, title, status, input, result, error, created_at, updated_at) VALUES (?, ?, NULL, NULL, 'queued', NULL, NULL, NULL, ?, ?)"
      ).run(id, convId, now, now)
      return { id }
    },
  }
  return obj as unknown as FakeRunner
}

function makeWorkspace(): string {
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    "INSERT INTO workspaces (id, path, name, created_at, updated_at) VALUES (?, ?, 'ws', ?, ?)"
  ).run(id, root, now, now)
  return id
}

// Run the executor against the workspace with a never-aborting signal.
async function runIndex(svc: IndexService, taskInput: unknown): Promise<void> {
  const ac = new AbortController()
  await svc.execute({
    task: { id: "t1", input: taskInput } as never,
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
  root = await mkdtemp(join(tmpdir(), "index-svc-"))
  workspaceId = makeWorkspace()
})
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

describe.skipIf(!sqliteLoads)("IndexService stage 1 (file map)", () => {
  it("indexes files in the workspace", async () => {
    await mkdir(join(root, "src"))
    await writeFile(join(root, "src", "a.ts"), "export const a = 1")
    await writeFile(join(root, "b.md"), "# hi")
    const svc = new IndexService(fakeRunner())
    await runIndex(svc, { workspaceId, priority: "high" })
    expect(listPaths(workspaceId)).toEqual(new Set(["src/a.ts", "b.md"]))
  })

  it("prunes node_modules and .git", async () => {
    await mkdir(join(root, "node_modules"))
    await writeFile(join(root, "node_modules", "dep.js"), "x")
    await writeFile(join(root, "keep.ts"), "x")
    const svc = new IndexService(fakeRunner())
    await runIndex(svc, { workspaceId, priority: "high" })
    expect(listPaths(workspaceId)).toEqual(new Set(["keep.ts"]))
  })

  it("respects .gitignore", async () => {
    await writeFile(join(root, ".gitignore"), "secret.txt\n")
    await writeFile(join(root, "secret.txt"), "x")
    await writeFile(join(root, "public.ts"), "x")
    const svc = new IndexService(fakeRunner())
    await runIndex(svc, { workspaceId, priority: "high" })
    const paths = listPaths(workspaceId)
    expect(paths.has("secret.txt")).toBe(false)
    expect(paths.has("public.ts")).toBe(true)
  })

  it("incremental: unchanged files are not re-hashed/updated", async () => {
    await writeFile(join(root, "a.ts"), "x")
    const svc = new IndexService(fakeRunner())
    await runIndex(svc, { workspaceId, priority: "high" })
    const first = listFiles(workspaceId)[0]
    await runIndex(svc, { workspaceId, priority: "high" })
    const second = listFiles(workspaceId)[0]
    // Same row (updated_at unchanged because the fast path skipped the upsert).
    expect(second.updatedAt).toBe(first.updatedAt)
  })

  it("incremental: an edited file is re-indexed with a new hash", async () => {
    const p = join(root, "a.ts")
    await writeFile(p, "one")
    const svc = new IndexService(fakeRunner())
    await runIndex(svc, { workspaceId, priority: "high" })
    const before = listFiles(workspaceId)[0]
    // Bump mtime + content so both stat and hash change.
    await new Promise((r) => setTimeout(r, 10))
    await writeFile(p, "two different content")
    await runIndex(svc, { workspaceId, priority: "high" })
    const after = listFiles(workspaceId)[0]
    expect(after.hash).not.toBe(before.hash)
  })

  it("incremental: a deleted file's row is removed", async () => {
    await writeFile(join(root, "a.ts"), "x")
    await writeFile(join(root, "b.ts"), "x")
    const svc = new IndexService(fakeRunner())
    await runIndex(svc, { workspaceId, priority: "high" })
    expect(listPaths(workspaceId).size).toBe(2)
    await rm(join(root, "b.ts"))
    await runIndex(svc, { workspaceId, priority: "high" })
    expect(listPaths(workspaceId)).toEqual(new Set(["a.ts"]))
  })
})

describe.skipIf(!sqliteLoads)("IndexService stage 2 (metadata)", () => {
  it("parses package.json and records a git branch", async () => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "demo", scripts: { build: "vite" } })
    )
    await mkdir(join(root, ".git"))
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/feat/x\n")
    const svc = new IndexService(fakeRunner())
    await runIndex(svc, { workspaceId, priority: "high" })
    const meta = Object.fromEntries(
      listMetadata(workspaceId).map((m) => [m.kind, m.value])
    )
    expect((meta.package_json as { name: string }).name).toBe("demo")
    expect((meta.git as { branch: string }).branch).toBe("feat/x")
  })

  it("advances the run through to the symbols stage on completion", async () => {
    await writeFile(join(root, "a.ts"), "x")
    const svc = new IndexService(fakeRunner())
    await runIndex(svc, { workspaceId, priority: "high" })
    expect(getRunByWorkspace(workspaceId)!.stage).toBe("symbols")
  })
})

describe.skipIf(!sqliteLoads)("IndexService stage 3 (symbols)", () => {
  it("extracts symbols and imports from TS files", async () => {
    await mkdir(join(root, "src"))
    await writeFile(
      join(root, "src", "a.ts"),
      `import { helper } from "./util"\nexport function doThing() {}\nexport class Widget {}`
    )
    const svc = new IndexService(fakeRunner())
    await runIndex(svc, { workspaceId, priority: "high" })

    expect(countSymbols(workspaceId)).toBeGreaterThan(0)
    const fn = findSymbolsByName(workspaceId, "doThing")
    expect(fn).toHaveLength(1)
    expect(fn[0].kind).toBe("function")
    const cls = findSymbolsByName(workspaceId, "Widget")
    expect(cls[0].kind).toBe("class")
  })

  it("findSymbolsByName excludes imports by default", async () => {
    await writeFile(join(root, "a.ts"), `import { foo } from "./x"`)
    const svc = new IndexService(fakeRunner())
    await runIndex(svc, { workspaceId, priority: "high" })
    expect(findSymbolsByName(workspaceId, "foo")).toHaveLength(0)
    expect(
      findSymbolsByName(workspaceId, "foo", { includeImports: true })
    ).toHaveLength(1)
  })

  it("findImportsOf returns files importing a module", async () => {
    await writeFile(join(root, "a.ts"), `import { x } from "lodash"`)
    await writeFile(join(root, "b.ts"), `import { y } from "lodash"`)
    await writeFile(join(root, "c.ts"), `import { z } from "react"`)
    const svc = new IndexService(fakeRunner())
    await runIndex(svc, { workspaceId, priority: "high" })
    const importers = findImportsOf(workspaceId, "lodash")
    expect(importers.map((i) => i.path).sort()).toEqual(["a.ts", "b.ts"])
  })

  it("re-extracts only changed files (dirty tracking) and marks files symbols-done", async () => {
    await writeFile(join(root, "a.ts"), `export function original() {}`)
    const svc = new IndexService(fakeRunner())
    await runIndex(svc, { workspaceId, priority: "high" })
    expect(getFileByPath(workspaceId, "a.ts")!.indexedStage).toBe("symbols")

    // Edit the file: it goes dirty (file_map) and re-extracts to the new symbol.
    await new Promise((r) => setTimeout(r, 10))
    await writeFile(join(root, "a.ts"), `export function renamed() {}`)
    await runIndex(svc, { workspaceId, priority: "high" })
    expect(findSymbolsByName(workspaceId, "original")).toHaveLength(0)
    expect(findSymbolsByName(workspaceId, "renamed")).toHaveLength(1)
  })

  it("drops a deleted file's symbols (cascade)", async () => {
    await writeFile(join(root, "a.ts"), `export function gone() {}`)
    const svc = new IndexService(fakeRunner())
    await runIndex(svc, { workspaceId, priority: "high" })
    expect(findSymbolsByName(workspaceId, "gone")).toHaveLength(1)
    await rm(join(root, "a.ts"))
    await runIndex(svc, { workspaceId, priority: "high" })
    expect(findSymbolsByName(workspaceId, "gone")).toHaveLength(0)
  })
})

describe.skipIf(!sqliteLoads)("IndexService.clear", () => {
  it("drops index rows and resets the run", async () => {
    await writeFile(join(root, "a.ts"), "x")
    await writeFile(join(root, "package.json"), "{}")
    const svc = new IndexService(fakeRunner())
    await runIndex(svc, { workspaceId, priority: "high" })
    svc.clear(workspaceId)
    expect(listPaths(workspaceId).size).toBe(0)
    expect(listMetadata(workspaceId)).toHaveLength(0)
    const run = getRunByWorkspace(workspaceId)!
    expect(run.filesScanned).toBe(0)
    expect(run.stage).toBe("file_map")
  })
})

describe.skipIf(!sqliteLoads)(
  "IndexService.ensureRunning (manual (re)start)",
  () => {
    it("enqueues a task and links it to the run", () => {
      const runner = fakeRunner()
      const svc = new IndexService(runner)
      svc.ensureRunning(workspaceId, "low")
      expect(runner.calls).toBe(1)
      expect(getRunByWorkspace(workspaceId)!.taskId).toBe(runner.lastTaskId)
    })

    it("is a no-op while a build is already live (queued/running)", () => {
      const runner = fakeRunner()
      const svc = new IndexService(runner)
      svc.ensureRunning(workspaceId, "low") // enqueues; task is 'queued' (live)
      svc.ensureRunning(workspaceId, "low") // no duplicate
      expect(runner.calls).toBe(1)
    })

    it("restarts after the previous task was cancelled", () => {
      const runner = fakeRunner()
      const svc = new IndexService(runner)
      svc.ensureRunning(workspaceId, "low")
      // Simulate the user cancelling: flip the linked task to terminal.
      const taskId = getRunByWorkspace(workspaceId)!.taskId!
      db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(
        taskId
      )
      svc.ensureRunning(workspaceId, "low")
      expect(runner.calls).toBe(2) // a fresh build was enqueued
    })

    it("restarts after a clear (run reset, task_id null)", () => {
      const runner = fakeRunner()
      const svc = new IndexService(runner)
      svc.ensureRunning(workspaceId, "low")
      svc.clear(workspaceId) // resetRun nulls task_id
      svc.ensureRunning(workspaceId, "low")
      expect(runner.calls).toBe(2)
    })

    it("does not restart when the workspace is disabled", () => {
      const runner = fakeRunner()
      const svc = new IndexService(runner)
      upsertRun(workspaceId, { enabled: false })
      svc.ensureRunning(workspaceId, "low")
      expect(runner.calls).toBe(0)
    })
  }
)

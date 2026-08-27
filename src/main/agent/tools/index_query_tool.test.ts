import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { runMigrations } from "../../db/migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../../db/connection", () => ({ getDb: () => db }))

import { indexQueryTool } from "./index_query_tool"
import { IndexService } from "../../index/service"
import * as indexFilesRepo from "../../db/repositories/index-files"
import * as indexSymbolsRepo from "../../db/repositories/index-symbols"
import type { ToolContext } from "./types"
import type { TaskRunner } from "../../tasks/runner"

let root: string

function makeWorkspace(): void {
  const now = Date.now()
  db.prepare(
    "INSERT INTO workspaces (id, path, name, created_at, updated_at) VALUES (?, ?, 'ws', ?, ?)"
  ).run(randomUUID(), root, now, now)
}

const fakeRunner = () =>
  ({ enqueueKind: () => ({ id: randomUUID() }) }) as unknown as TaskRunner

// Build a real index over the temp workspace, then query through the tool.
async function buildIndex(): Promise<void> {
  const svc = new IndexService(fakeRunner())
  const ac = new AbortController()
  await svc.execute({
    task: {
      id: "t",
      input: { workspaceId: currentWsId(), priority: "high" },
    } as never,
    signal: ac.signal,
    emit: () => {},
    workspace: root,
  })
}
function currentWsId(): string {
  return (
    db.prepare("SELECT id FROM workspaces WHERE path = ?").get(root) as {
      id: string
    }
  ).id
}

function ctx(): ToolContext {
  return { workspace: root, conversationId: "c1" }
}
const run = (args: Record<string, unknown>) =>
  indexQueryTool.execute(args, ctx())

beforeEach(async () => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
  root = await mkdtemp(join(tmpdir(), "idxq-"))
  makeWorkspace()
})
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

describe.skipIf(!sqliteLoads)("index_query_tool", () => {
  it("find_symbol locates a declaration with file:line", async () => {
    await mkdir(join(root, "src"))
    await writeFile(join(root, "src", "widget.ts"), `\nexport class Widget {}`)
    await buildIndex()
    const out = await run({ op: "find_symbol", query: "Widget" })
    expect(out).toContain("class Widget")
    expect(out).toContain("src/widget.ts:2")
  })

  it("find_symbol filters by kind", async () => {
    await writeFile(
      join(root, "a.ts"),
      `export function foo() {}\nexport const foo2 = 1`
    )
    await buildIndex()
    const fns = await run({ op: "find_symbol", query: "foo", kind: "function" })
    expect(fns).toContain("function foo")
    const miss = await run({ op: "find_symbol", query: "foo", kind: "class" })
    expect(miss).toContain("No indexed symbol")
  })

  it("what_imports lists importing files", async () => {
    await writeFile(join(root, "a.ts"), `import { x } from "lodash"`)
    await writeFile(join(root, "b.ts"), `import { y } from "lodash"`)
    await buildIndex()
    const out = await run({ op: "what_imports", query: "lodash" })
    expect(out).toContain("a.ts")
    expect(out).toContain("b.ts")
  })

  it("list_files matches by substring", async () => {
    await mkdir(join(root, "components"))
    await writeFile(join(root, "components", "Btn.tsx"), "export const Btn = 1")
    await writeFile(join(root, "readme.md"), "# hi")
    await buildIndex()
    const out = await run({ op: "list_files", query: ".tsx" })
    expect(out).toContain("components/Btn.tsx")
    expect(out).not.toContain("readme.md")
  })

  it("list_files with no query summarizes by extension with an honest total", async () => {
    await writeFile(join(root, "a.ts"), "export const a = 1")
    await writeFile(join(root, "b.ts"), "export const b = 1")
    await writeFile(join(root, ".gitignore"), "node_modules\n") // extensionless
    await buildIndex()
    const out = await run({ op: "list_files" })
    expect(out).toContain(".ts: 2")
    // The extensionless .gitignore is counted in the total + remainder, so the
    // numbers reconcile (was the source of the 237-vs-246 confusion).
    expect(out).toContain("total: 3")
    expect(out).toContain("other, incl. extensionless: 1")
  })

  it("list_files caps large results with a truncation banner", async () => {
    for (let i = 0; i < 12; i++) {
      await writeFile(join(root, `f${i}.ts`), "export const x = 1")
    }
    await buildIndex()
    // limit=5 forces a cap over the 12 .ts files.
    const out = await run({ op: "list_files", query: ".ts", limit: 5 })
    expect(out).toContain("stopped at 5 files")
    // Exactly 5 paths shown (+ the banner line).
    expect(out.split("\n").filter((l) => l.endsWith(".ts"))).toHaveLength(5)
  })

  it("clamps every limited repository query before execution", async () => {
    await writeFile(
      join(root, "a.ts"),
      `import { thing } from "pkg"\nexport const Target = 1`
    )
    await buildIndex()

    const symbolSpy = vi.spyOn(indexSymbolsRepo, "findSymbolsByName")
    const importsSpy = vi.spyOn(indexSymbolsRepo, "findImportsOf")
    const filesSpy = vi.spyOn(indexFilesRepo, "listFilesMatching")

    const cases = [
      { input: 1_000_000, symbol: 101, imports: 101, files: 1001 },
      { input: Infinity, symbol: 51, imports: 51, files: 501 },
      { input: 5.8, symbol: 6, imports: 6, files: 6 },
      { input: -1, symbol: 51, imports: 51, files: 501 },
      { input: 7, symbol: 8, imports: 8, files: 8 },
    ]

    for (const c of cases) {
      await run({ op: "find_symbol", query: "Target", limit: c.input })
      expect(
        symbolSpy.mock.calls.at(-1)?.[2] as { limit?: number } | undefined
      ).toMatchObject({ limit: c.symbol })

      await run({ op: "what_imports", query: "pkg", limit: c.input })
      expect(importsSpy.mock.calls.at(-1)?.[2]).toBe(c.imports)

      await run({ op: "list_files", query: ".ts", limit: c.input })
      expect(filesSpy.mock.calls.at(-1)?.[2]).toBe(c.files)
    }
  })

  it("reports when capped symbol and import results may have more matches", async () => {
    for (let i = 0; i < 105; i++) {
      await writeFile(
        join(root, `f${String(i).padStart(3, "0")}.ts`),
        `import { thing } from "pkg"\nexport const Target = ${i}`
      )
    }
    await buildIndex()

    const symbols = await run({
      op: "find_symbol",
      query: "Target",
      limit: 1_000_000,
    })
    expect(symbols).toContain("stopped at 100 symbols — more matches may exist")
    expect(
      symbols.split("\n").filter((l) => l.includes("const Target"))
    ).toHaveLength(100)

    const importers = await run({
      op: "what_imports",
      query: "pkg",
      limit: 1_000_000,
    })
    expect(importers).toContain(
      "stopped at 100 imports — more matches may exist"
    )
    expect(
      importers.split("\n").filter((l) => l.includes("imports thing"))
    ).toHaveLength(100)
  })

  it("metadata renders a compact digest, not raw JSON", async () => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "demo",
        scripts: { build: "vite", test: "vitest" },
        dependencies: { react: "^19", clsx: "^2" },
      })
    )
    await mkdir(join(root, ".git"))
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n")
    await buildIndex()
    const out = await run({ op: "metadata" })
    expect(out).toContain("package.json: name demo")
    expect(out).toContain("scripts: build, test")
    expect(out).toContain("dependencies (2)")
    expect(out).toContain("git: branch main")
    // Not a raw JSON dump.
    expect(out).not.toContain('"dependencies":')
  })

  it("metadata caps a huge dependency list", async () => {
    const deps: Record<string, string> = {}
    for (let i = 0; i < 60; i++) deps[`dep${i}`] = "^1"
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "big", dependencies: deps })
    )
    await buildIndex()
    const out = await run({ op: "metadata" })
    expect(out).toContain("dependencies (60)")
    expect(out).toContain("more")
  })

  it("a miss steers back to the real tools (advisory)", async () => {
    await writeFile(join(root, "a.ts"), "export const a = 1")
    await buildIndex()
    const out = await run({ op: "find_symbol", query: "NoSuchThing" })
    expect(out).toContain("advisory")
    expect(out.toLowerCase()).toContain("search_tool")
  })

  it("reports not-indexed when the workspace has no run", async () => {
    // No buildIndex() call — the workspace row exists but was never indexed.
    const out = await run({ op: "find_symbol", query: "anything" })
    expect(out).toContain("not been indexed")
  })

  it("errors on an unknown op", async () => {
    await writeFile(join(root, "a.ts"), "export const a = 1")
    await buildIndex()
    const out = await run({ op: "frobnicate" })
    expect(out).toContain("ERROR[bad_args]")
  })
})

import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))

import { KanbanService, approvalHash, type RunCall } from "./service"
import * as kanban from "../db/repositories/kanban"
import type { TaskRunner } from "../tasks/runner"
import type { KanbanSource } from "../../shared/kanban"

const source: KanbanSource = {
  tool: "mcp__github__search_issues",
  args: { q: "label:agent-go assignee:@me" },
  fields: {
    id: "number",
    title: "title",
    tags: "labels.*.name",
    assignee: "assignees.*.login",
  },
  whoami: { tool: "mcp__github__get_me", path: "login" },
}

const issue = (n: number, login: string, labels = ["agent-go"]) => ({
  number: n,
  title: `Issue ${n}`,
  labels: labels.map((name) => ({ name })),
  assignees: [{ login }],
})

describe.skipIf(!sqliteLoads)("KanbanService sync", () => {
  let output: unknown[]
  const runCall: RunCall = async (call) =>
    call.tool === "mcp__github__get_me"
      ? JSON.stringify({ login: "me" })
      : JSON.stringify(output)
  const service = new KanbanService({} as TaskRunner, runCall)
  const run = (boardId: string) =>
    service.execute({
      task: { input: { boardId } },
      signal: new AbortController().signal,
      emit: () => {},
    } as unknown as Parameters<typeof service.execute>[0])

  beforeEach(() => {
    db = new Database(":memory:")
    runMigrations(db)
    output = []
  })

  const board = () =>
    kanban.saveBoard({
      name: "B",
      workspace: null,
      source,
      filter: {
        tags: ["agent-go"],
        match: "any",
        excludeTags: [],
        assignee: { mode: "me" },
      },
      columns: [{ name: "Plan" }, { name: "Build" }],
    })

  it("refuses to run an unapproved recipe", async () => {
    const b = board()
    expect(await run(b.id)).toMatchObject({
      error: expect.stringContaining("needs approval"),
    })
    expect(kanban.getBoard(b.id)!.lastSyncError).toContain("needs approval")
  })

  it("fills the inbox with only my matching items, then drops ones that stop matching", async () => {
    const b = board()
    kanban.setApprovedHash(b.id, approvalHash(b)!)
    output = [issue(1, "me"), issue(2, "teammate"), issue(3, "me", ["bug"])]
    expect(await run(b.id)).toMatchObject({ content: "synced 1 items" })
    expect(kanban.listCards(b.id).map((c) => c.externalId)).toEqual(["1"])

    output = [issue(1, "teammate")]
    await run(b.id)
    expect(kanban.listCards(b.id)).toEqual([])
  })

  it("runs the compiled query and re-asks when a filter edit changes it", async () => {
    const calls: unknown[] = []
    const recording = new KanbanService({} as TaskRunner, async (call) => {
      calls.push(call.args)
      return call.tool === "mcp__github__get_me"
        ? JSON.stringify({ login: "me" })
        : "[]"
    })
    const filter = {
      tags: ["agent-go"],
      match: "any" as const,
      excludeTags: [],
      assignee: { mode: "me" as const },
    }
    const b = kanban.saveBoard({
      name: "B",
      workspace: null,
      source: { ...source, tracker: "github", args: { q: "{{query}}" } },
      filter,
      columns: [],
    })
    kanban.setApprovedHash(b.id, approvalHash(b)!)
    await recording.execute({
      task: { input: { boardId: b.id } },
      signal: new AbortController().signal,
      emit: () => {},
    } as never)
    expect(calls).toContainEqual({
      q: 'is:issue is:open label:"agent-go" assignee:@me',
    })

    const edited = kanban.saveBoard({
      id: b.id,
      name: "B",
      workspace: null,
      source: b.source!,
      filter: { ...filter, tags: ["other"] },
      columns: [],
    })
    expect(recording.graph(edited.id)!.approved).toBe(false)
  })

  it("re-asks for approval when the recipe changes", async () => {
    const b = board()
    kanban.setApprovedHash(b.id, approvalHash(b)!)
    kanban.saveBoard({
      id: b.id,
      name: "B",
      workspace: null,
      source: { ...source, args: { q: "x" } },
      filter: b.filter,
      columns: [{ name: "Plan" }, { name: "Build" }],
    })
    expect(service.graph(b.id)!.approved).toBe(false)
    expect(service.approveSource(b.id, "stale-hash")).toMatchObject({
      ok: false,
    })
  })
})

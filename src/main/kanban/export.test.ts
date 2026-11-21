import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))

import { copyName, exportBoard, importBoard } from "./export"
import * as kanban from "../db/repositories/kanban"
import { createAccount } from "../db/repositories/provider-accounts"
import { addModel } from "../db/repositories/models"

it("names a clashing import Copy, then Copy 2, Copy 3", () => {
  expect(copyName("B", ["A"])).toBe("B")
  expect(copyName("B", ["B"])).toBe("B - Copy")
  expect(copyName("B", ["B", "B - Copy"])).toBe("B - Copy 2")
  expect(copyName("B", ["B", "B - Copy", "B - Copy 2"])).toBe("B - Copy 3")
})

describe.skipIf(!sqliteLoads)("board export/import", () => {
  beforeEach(() => {
    db = new Database(":memory:")
    runMigrations(db)
  })

  let accountId: string
  function original() {
    const account = createAccount({ provider: "openai", displayName: "A" })
    accountId = account.id
    addModel({ accountId: account.id, modelId: "model-a" })
    const b = kanban.saveBoard({
      name: "Team",
      workspace: "/mine",
      source: {
        tracker: "github",
        command: "gh issue list --search {{query}} --json number,title",
        fields: { id: "number", title: "title" },
      },
      filter: {
        tags: ["agent-go"],
        match: "any",
        excludeTags: [],
        types: [],
        states: [],
        assignee: { mode: "user", user: "alice" },
      },
      syncIntervalMs: 10 * 60_000,
      columns: [
        {
          name: "Dev",
          instructions: "Build it",
          accountId: account.id,
          modelId: "model-a",
          outcomes: [{ name: "done", next: "advance" }],
        },
        {
          name: "Review",
          instructions: "Review it",
          outcomes: [{ name: "failed", next: "goto", target: "Dev" }],
          notify: true,
        },
        { name: "Deploy", owner: "user", command: "./deploy.sh" },
      ],
    })
    kanban.setApprovedHash(b.id, "approved-here")
    kanban.setActionSettings(b.id, {
      writeApproval: "always",
      actionsPaused: true,
    })
    kanban.setNotifications(b.id, false)
    return kanban.getBoard(b.id)!
  }

  it("round-trips the recipe, settings and columns, not approvals or workspace", () => {
    const b = original()
    const file = JSON.parse(
      JSON.stringify(exportBoard(b, kanban.listColumns(b.id)))
    )
    expect(JSON.stringify(file)).not.toContain("/mine")
    expect(JSON.stringify(file)).not.toContain("approved-here")

    file.columns[1].accountId = accountId
    file.columns[1].modelId = "missing-model"
    const copy = importBoard(file, "/theirs")
    expect(copy.name).toBe("Team - Copy")
    expect(copy.workspace).toBe("/theirs")
    expect(copy.approvedHash).toBeNull()
    expect(copy.actionsPaused).toBe(false)
    expect(copy.writeApproval).toBe("always")
    expect(copy.notifications).toBe(false)
    expect(copy.syncIntervalMs).toBe(10 * 60_000)
    expect(copy.filter.assignee).toEqual({ mode: "user", user: "alice" })
    const cols = kanban.listColumns(copy.id)
    expect(cols.map((c) => c.name)).toEqual(["Dev", "Review", "Deploy"])
    expect(cols[1].outcomes[0].target).toBe(cols[0].id) // goto by new id
    expect(cols[1].notify).toBe(true)
    expect(cols[1]).toMatchObject({
      accountId,
      modelId: "missing-model",
    })
    expect(cols[0]).toMatchObject({ accountId, modelId: "model-a" })
    expect(cols[2]).toMatchObject({ owner: "user", command: "./deploy.sh" })

    expect(importBoard(file, "/theirs").name).toBe("Team - Copy 2")
  })

  it("refuses a file that isn't an exported board", () => {
    expect(() => importBoard({ name: "x" }, "/w")).toThrow(/exported board/)
    expect(kanban.listBoards()).toEqual([])
  })
})

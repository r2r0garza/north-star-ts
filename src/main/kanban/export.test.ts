import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))

import { copyName, duplicateBoard, exportBoard, importBoard } from "./export"
import { boardDraftFromBoard } from "../../shared/kanban"
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
          agentName: "builder",
          gate: "human",
          wipLimit: 2,
          entryGate: { tags: ["ready"], states: ["Active"] },
          actions: [
            {
              name: "label",
              phase: "exit",
              command: "gh issue edit {{id}} --add-label done",
            },
          ],
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
        {
          name: "Deploy",
          owner: "user",
          command: "./deploy.sh",
          commandTimeoutMs: 300000,
        },
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

  it("duplicates the complete definition with fresh IDs and no approvals or runtime", () => {
    const b = original()
    kanban.setRunSettings(b.id, { worktrees: false, parallelCommands: true })
    kanban.setAutoPromote(b.id, { tags: ["ready"], states: ["Open"] })
    kanban.setDependencyLinks(b.id, ["System.LinkTypes.Dependency-Forward"])
    kanban.addApprovedAction(b.id, "old-action")
    kanban.setSyncResult(b.id, "old error")
    const columns = kanban.listColumns(b.id)
    db.prepare(
      "INSERT INTO kanban_cards (id, board_id, external_id, item, column_id, created_at, updated_at) VALUES ('card', ?, '54', '{}', ?, 1, 1)"
    ).run(b.id, columns[0].id)
    kanban.updateCard("card", {
      worktree: "/old",
      branch: "old",
      runState: "waiting",
      visits: { [columns[0].id]: 2 },
    })
    kanban.createRun({
      cardId: "card",
      columnId: columns[0].id,
      columnName: "Dev",
    })
    const before = kanban.getBoard(b.id)!
    const cards = kanban.listCards(b.id)
    const copy = duplicateBoard(b.id, "Custom copy")
    expect(copy.id).not.toBe(b.id)
    expect(copy).toMatchObject({
      ...before,
      id: copy.id,
      name: "Custom copy",
      approvedHash: null,
      approvedActions: [],
      actionsPaused: false,
      lastSyncAt: null,
      lastSyncError: null,
      createdAt: copy.createdAt,
      updatedAt: copy.updatedAt,
    })
    expect(exportBoard(copy, kanban.listColumns(copy.id))).toEqual({
      ...exportBoard(before, columns),
      name: "Custom copy",
    })
    expect(
      kanban
        .listColumns(copy.id)
        .every((c) => !columns.some((old) => old.id === c.id))
    ).toBe(true)
    expect(kanban.listCards(copy.id)).toEqual([])
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM kanban_card_runs").get()
    ).toEqual({ n: 1 })
    expect(kanban.getBoard(b.id)).toEqual(before)
    expect(kanban.listCards(b.id)).toEqual(cards)
    expect(kanban.listColumns(b.id)).toEqual(columns)
  })

  it("applies edited intake without changing columns or advanced settings", () => {
    const b = original()
    const draft = boardDraftFromBoard(b)
    draft.target = { tracker: "ado", org: "example", project: "Team's project" }
    draft.workspace = "/other"
    draft.filter = {
      ...draft.filter,
      tags: ["changed"],
      states: ["Active"],
      fields: [{ field: "Custom.QA", values: ["Pat"] }],
    }
    const copy = duplicateBoard(b.id, "Edited copy", draft)
    expect(copy.workspace).toBe("/other")
    expect(copy.filter).toEqual(draft.filter)
    expect(copy.source?.fields.custom).toEqual({
      "Custom.QA": ["fields", "Custom.QA"],
    })
    expect(boardDraftFromBoard(copy).target).toEqual({
      tracker: "ado",
      org: "https://dev.azure.com/example",
      project: "Team's project",
    })
    expect(exportBoard(copy, kanban.listColumns(copy.id)).columns).toEqual(
      exportBoard(b, kanban.listColumns(b.id)).columns
    )
    expect(copy.approvedHash).toBeNull()
  })

  it("preserves custom recipes and unavailable model references when editing only filters", () => {
    const b = original()
    const columns = kanban.listColumns(b.id)
    kanban.saveColumns(
      b.id,
      columns.map((c) => ({ ...c, modelId: c.accountId ? "missing" : null })),
      true
    )
    const draft = boardDraftFromBoard(b)
    draft.filter = { ...draft.filter, tags: ["new"] }
    const copy = duplicateBoard(b.id, "Copy", draft)
    expect(copy.source).toEqual(b.source)
    expect(kanban.listColumns(copy.id)[0].modelId).toBe("missing")
  })

  it("rejects bad names, intake and columns without leaving a partial copy", () => {
    const b = original()
    const draft = boardDraftFromBoard(b)
    expect(() => duplicateBoard(b.id, "  ")).toThrow(/name/)
    expect(() =>
      duplicateBoard(b.id, "Bad", {
        ...draft,
        target: { tracker: "github", repo: "invalid" },
      })
    ).toThrow(/repository/)
    expect(() =>
      duplicateBoard(b.id, "Bad", { ...draft, workspace: "" })
    ).toThrow(/workspace/)
    db.prepare(
      "UPDATE kanban_columns SET wip_limit = -1 WHERE board_id = ?"
    ).run(b.id)
    expect(() => duplicateBoard(b.id, "Bad")).toThrow(/WIP/i)
    expect(kanban.listBoards()).toEqual([b])
  })

  it("rolls back the entire duplicate if saving advanced settings fails", () => {
    const b = original()
    db.exec(
      "CREATE TRIGGER fail_duplicate BEFORE UPDATE OF notifications ON kanban_boards BEGIN SELECT RAISE(ABORT, 'persistence failed'); END"
    )
    expect(() => duplicateBoard(b.id, "Copy")).toThrow(/persistence failed/)
    expect(kanban.listBoards()).toEqual([b])
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM kanban_columns").get()
    ).toEqual({ n: 3 })
  })

  it("refuses a file that isn't an exported board", () => {
    expect(() => importBoard({ name: "x" }, "/w")).toThrow(/exported board/)
    expect(kanban.listBoards()).toEqual([])
  })
})

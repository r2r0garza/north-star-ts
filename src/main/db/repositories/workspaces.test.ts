import { beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

import { getWorkspace, updateWorkspace, upsertWorkspace } from "./workspaces"

describe.skipIf(!sqliteLoads)("workspace generated files", () => {
  beforeEach(() => {
    db = new Database(":memory:")
    runMigrations(db)
  })

  it("defaults to none and keeps only well-formed rules", () => {
    const ws = upsertWorkspace("/repo")
    expect(ws.generatedFiles).toEqual([])
    updateWorkspace(ws.id, {
      generatedFiles: [
        {
          paths: ["./.code-index/**", " "],
          command: "  codex-agentic-os index pre-commit ",
        },
        { paths: [], command: "npm install" },
        { paths: ["**/package-lock.json"], command: "" },
      ],
    })
    expect(getWorkspace(ws.id)!.generatedFiles).toEqual([
      {
        paths: [".code-index/**"],
        command: "codex-agentic-os index pre-commit",
      },
    ])
  })
})

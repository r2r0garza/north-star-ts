import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../migrations"

// Mock the connection so the repo talks to an in-memory DB (mirrors settings.test).
let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

let sqliteLoads = true
try {
  new Database(":memory:").close()
} catch {
  sqliteLoads = false
}

import { addRule, findMatch, listRules } from "./action-allowlist"

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)("action-allowlist listRules (plan 021)", () => {
  it("returns global rules regardless of scope context", () => {
    addRule({ tool: "run_shell", kind: "shell", identity: "ls", scope: "global" })
    const rules = listRules({})
    expect(rules).toHaveLength(1)
    expect(rules[0].scope).toBe("global")
  })

  it("returns a workspace rule only when the path matches", () => {
    addRule({
      tool: "run_shell",
      kind: "shell",
      identity: "ls",
      scope: "workspace",
      workspacePath: "/ws",
    })
    expect(listRules({ workspacePath: "/ws" })).toHaveLength(1)
    expect(listRules({ workspacePath: "/other" })).toHaveLength(0)
    expect(listRules({})).toHaveLength(0)
  })

  it("returns a conversation rule only when the id matches", () => {
    addRule({
      tool: "run_shell",
      kind: "shell",
      identity: "ls",
      scope: "conversation",
      conversationId: "c1",
    })
    expect(listRules({ conversationId: "c1" })).toHaveLength(1)
    expect(listRules({ conversationId: "c2" })).toHaveLength(0)
    expect(listRules({})).toHaveLength(0)
  })

  it("excludes once and agent scopes", () => {
    addRule({ tool: "t", kind: "shell", identity: "a", scope: "once" })
    addRule({
      tool: "t",
      kind: "shell",
      identity: "b",
      scope: "agent",
      agentId: "ag1",
    })
    expect(listRules({ workspacePath: "/ws", conversationId: "c1" })).toHaveLength(
      0
    )
  })

  it("returns global + matching workspace + matching conversation together", () => {
    addRule({ tool: "t", kind: "shell", identity: "g", scope: "global" })
    addRule({
      tool: "t",
      kind: "shell",
      identity: "w",
      scope: "workspace",
      workspacePath: "/ws",
    })
    addRule({
      tool: "t",
      kind: "shell",
      identity: "wOther",
      scope: "workspace",
      workspacePath: "/other",
    })
    addRule({
      tool: "t",
      kind: "shell",
      identity: "c",
      scope: "conversation",
      conversationId: "c1",
    })
    const identities = listRules({ workspacePath: "/ws", conversationId: "c1" })
      .map((r) => r.identity)
      .sort()
    expect(identities).toEqual(["c", "g", "w"])
  })

  it("does not touch last_used_at (unlike findMatch)", () => {
    addRule({ tool: "t", kind: "shell", identity: "ls", scope: "global" })

    listRules({})
    expect(listRules({})[0].lastUsedAt).toBeNull()

    // findMatch, by contrast, DOES touch it — confirms the two reads differ.
    findMatch("shell", "ls", {})
    expect(listRules({})[0].lastUsedAt).not.toBeNull()
  })
})

import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { runMigrations } from "../migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

// Back the repo with an in-memory SQLite DB (real schema, real migrations)
// instead of the app's on-disk connection, which needs an Electron context.
let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

// better-sqlite3 ships a native binary built for ONE Node ABI. This repo builds
// it for Electron (see the native-module-rebuild note), so under plain-Node
// vitest the binary may fail to load (NODE_MODULE_VERSION mismatch). The pure
// normalizeItems tests need no binary and always run; the CRUD/migration tests
// require SQLite, so they skip (rather than fail) when it can't load. They run
// wherever the ABI matches (e.g. a Node-ABI CI build of better-sqlite3).

import {
  listTodos,
  replaceTodos,
  mergeTodos,
  normalizeItems,
  isTodoListFinished,
  subscribeTodoChanges,
  MAX_TODO_ITEMS,
  MAX_TODO_CONTENT_CHARS,
} from "./todos"
import type { Todo, TodoStatus } from "../types"

// Build a minimal Todo with the given statuses (only `status` matters here).
function todosWith(...statuses: TodoStatus[]): Todo[] {
  return statuses.map((status, i) => ({
    conversationId: "c",
    itemId: `item_${i + 1}`,
    seq: i,
    content: `task ${i + 1}`,
    status,
    createdAt: 0,
    updatedAt: 0,
  }))
}

// A conversation row is required by the todos FK; create one per test.
function freshConversation(): string {
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    "INSERT INTO conversations (id, mode, title, workspace_id, created_at, updated_at) VALUES (?, 'north_star', NULL, NULL, ?, ?)"
  ).run(id, now, now)
  return id
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe("isTodoListFinished", () => {
  it("is false for an empty list (nothing to clear)", () => {
    expect(isTodoListFinished([])).toBe(false)
  })
  it("is true when every item is completed", () => {
    expect(isTodoListFinished(todosWith("completed", "completed"))).toBe(true)
  })
  it("is true when items are completed or cancelled", () => {
    expect(isTodoListFinished(todosWith("completed", "cancelled"))).toBe(true)
  })
  it("is false when any item is still pending", () => {
    expect(isTodoListFinished(todosWith("completed", "pending"))).toBe(false)
  })
  it("is false when any item is in_progress", () => {
    expect(isTodoListFinished(todosWith("in_progress", "completed"))).toBe(
      false
    )
  })
})

describe.skipIf(!sqliteLoads)("migrations", () => {
  it("creates the todos table (reached by the full migration chain)", () => {
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='todos'"
      )
      .get()
    expect(row).toBeTruthy()
  })
})

describe("normalizeItems", () => {
  it("coerces an invalid status to pending", () => {
    const [item] = normalizeItems([{ id: "1", content: "x", status: "bogus" }])
    expect(item.status).toBe("pending")
  })

  it("drops items with blank content", () => {
    expect(
      normalizeItems([{ id: "1", content: "  ", status: "pending" }])
    ).toHaveLength(0)
  })

  it("truncates oversized content with a marker", () => {
    const [item] = normalizeItems([
      {
        id: "1",
        content: "a".repeat(MAX_TODO_CONTENT_CHARS + 500),
        status: "pending",
      },
    ])
    expect(item.content.length).toBe(MAX_TODO_CONTENT_CHARS)
    expect(item.content.endsWith("[truncated]")).toBe(true)
  })

  it("dedupes by id, last write wins in its position", () => {
    const items = normalizeItems([
      { id: "1", content: "first", status: "pending" },
      { id: "1", content: "second", status: "completed" },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ content: "second", status: "completed" })
  })

  it("caps the list at MAX_TODO_ITEMS", () => {
    const many = Array.from({ length: MAX_TODO_ITEMS + 10 }, (_, i) => ({
      id: String(i),
      content: `task ${i}`,
      status: "pending" as const,
    }))
    expect(normalizeItems(many)).toHaveLength(MAX_TODO_ITEMS)
  })

  it("gives id-less items a synthetic id rather than dropping them", () => {
    const [item] = normalizeItems([{ content: "no id", status: "pending" }])
    expect(item.itemId).toBeTruthy()
    expect(item.content).toBe("no id")
  })
})

describe.skipIf(!sqliteLoads)("replaceTodos", () => {
  it("inserts items in array order (seq = priority)", () => {
    const c = freshConversation()
    replaceTodos(c, [
      { id: "a", content: "first", status: "pending" },
      { id: "b", content: "second", status: "pending" },
    ])
    const list = listTodos(c)
    expect(list.map((t) => t.itemId)).toEqual(["a", "b"])
    expect(list.map((t) => t.seq)).toEqual([0, 1])
  })

  it("replaces the whole list (a removed item is gone)", () => {
    const c = freshConversation()
    replaceTodos(c, [
      { id: "a", content: "a", status: "pending" },
      { id: "b", content: "b", status: "pending" },
    ])
    replaceTodos(c, [{ id: "a", content: "a", status: "completed" }])
    const list = listTodos(c)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ itemId: "a", status: "completed" })
  })

  it("clears the list with an empty array", () => {
    const c = freshConversation()
    replaceTodos(c, [{ id: "a", content: "a", status: "pending" }])
    replaceTodos(c, [])
    expect(listTodos(c)).toHaveLength(0)
  })

  it("publishes the committed snapshot after replace and clear", () => {
    const c = freshConversation()
    const listener = vi.fn()
    const unsubscribe = subscribeTodoChanges(listener)

    replaceTodos(c, [{ id: "a", content: "a", status: "pending" }])
    replaceTodos(c, [])
    unsubscribe()

    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener.mock.calls[0][0]).toMatchObject({
      conversationId: c,
      todos: [{ itemId: "a", status: "pending" }],
    })
    expect(listener.mock.calls[1][0]).toMatchObject({
      conversationId: c,
      todos: [],
    })
  })

  it("scopes todos to their conversation", () => {
    const c1 = freshConversation()
    const c2 = freshConversation()
    replaceTodos(c1, [{ id: "a", content: "c1 task", status: "pending" }])
    replaceTodos(c2, [{ id: "a", content: "c2 task", status: "pending" }])
    expect(listTodos(c1)[0].content).toBe("c1 task")
    expect(listTodos(c2)[0].content).toBe("c2 task")
  })

  it("cascades deletes when the conversation is removed", () => {
    const c = freshConversation()
    replaceTodos(c, [{ id: "a", content: "a", status: "pending" }])
    db.prepare("DELETE FROM conversations WHERE id = ?").run(c)
    expect(listTodos(c)).toHaveLength(0)
  })
})

describe.skipIf(!sqliteLoads)("mergeTodos", () => {
  it("updates an existing item by id without dropping the others", () => {
    const c = freshConversation()
    replaceTodos(c, [
      { id: "a", content: "a", status: "pending" },
      { id: "b", content: "b", status: "pending" },
    ])
    mergeTodos(c, [{ id: "a", content: "a", status: "in_progress" }])
    const list = listTodos(c)
    expect(list).toHaveLength(2)
    expect(list.find((t) => t.itemId === "a")?.status).toBe("in_progress")
    expect(list.find((t) => t.itemId === "b")?.status).toBe("pending")
  })

  it("publishes the committed snapshot after merge", () => {
    const c = freshConversation()
    replaceTodos(c, [{ id: "a", content: "a", status: "pending" }])
    const listener = vi.fn()
    const unsubscribe = subscribeTodoChanges(listener)

    mergeTodos(c, [{ id: "a", content: "a", status: "completed" }])
    unsubscribe()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0]).toMatchObject({
      conversationId: c,
      todos: [{ itemId: "a", status: "completed" }],
    })
  })

  it("appends new items to the end", () => {
    const c = freshConversation()
    replaceTodos(c, [{ id: "a", content: "a", status: "pending" }])
    mergeTodos(c, [{ id: "c", content: "c", status: "pending" }])
    expect(listTodos(c).map((t) => t.itemId)).toEqual(["a", "c"])
  })
})

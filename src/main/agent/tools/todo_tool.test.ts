import { describe, it, expect, beforeEach, vi } from "vitest"
import type { Todo } from "../../db/types"

// Mock the repo so the tool test exercises arg handling and read/write routing
// without a database. The mock keeps a tiny in-memory list per call sequence.
const listTodos = vi.fn<(c: string) => Todo[]>()
const replaceTodos = vi.fn<(c: string, items: unknown[]) => Todo[]>()
const mergeTodos = vi.fn<(c: string, items: unknown[]) => Todo[]>()

vi.mock("../../db/repositories/todos", () => ({
  listTodos: (c: string) => listTodos(c),
  replaceTodos: (c: string, i: unknown[]) => replaceTodos(c, i),
  mergeTodos: (c: string, i: unknown[]) => mergeTodos(c, i),
}))

import { todoWriteTool } from "./todo_tool"
import type { ToolContext } from "./types"

const ctx: ToolContext = { workspace: "", conversationId: "conv-1" }

function todo(itemId: string, status: Todo["status"], content = "x"): Todo {
  return {
    conversationId: "conv-1",
    itemId,
    seq: 0,
    content,
    status,
    createdAt: 0,
    updatedAt: 0,
  }
}

beforeEach(() => {
  listTodos.mockReset()
  replaceTodos.mockReset()
  mergeTodos.mockReset()
})

describe("todo_write", () => {
  it("fails closed without a conversation", async () => {
    const result = await todoWriteTool.execute({}, { workspace: "" })
    expect(result).toContain("ERROR[no_conversation]")
  })

  it("reads the current list when no todos are given", async () => {
    listTodos.mockReturnValue([todo("1", "pending")])
    const result = await todoWriteTool.execute({}, ctx)
    expect(listTodos).toHaveBeenCalledWith("conv-1")
    expect(replaceTodos).not.toHaveBeenCalled()
    const parsed = JSON.parse(result)
    expect(parsed.todos).toEqual([{ id: "1", content: "x", status: "pending" }])
    expect(parsed.summary).toMatchObject({ total: 1, pending: 1 })
  })

  it("replaces the list by default", async () => {
    replaceTodos.mockReturnValue([todo("1", "in_progress")])
    const items = [{ id: "1", content: "x", status: "in_progress" }]
    await todoWriteTool.execute({ todos: items }, ctx)
    expect(replaceTodos).toHaveBeenCalledWith("conv-1", items)
    expect(mergeTodos).not.toHaveBeenCalled()
  })

  it("merges when merge:true", async () => {
    mergeTodos.mockReturnValue([todo("1", "completed")])
    const items = [{ id: "1", content: "x", status: "completed" }]
    await todoWriteTool.execute({ todos: items, merge: true }, ctx)
    expect(mergeTodos).toHaveBeenCalledWith("conv-1", items)
    expect(replaceTodos).not.toHaveBeenCalled()
  })

  it("parses a JSON-string todos arg (LLMs sometimes stringify it)", async () => {
    replaceTodos.mockReturnValue([])
    await todoWriteTool.execute(
      { todos: '[{"id":"1","content":"x","status":"pending"}]' },
      ctx
    )
    expect(replaceTodos).toHaveBeenCalledWith("conv-1", [
      { id: "1", content: "x", status: "pending" },
    ])
  })

  it("rejects an unparseable string todos arg", async () => {
    const result = await todoWriteTool.execute({ todos: "not json" }, ctx)
    expect(result).toContain("ERROR[bad_args]")
    expect(replaceTodos).not.toHaveBeenCalled()
  })

  it("rejects a non-array todos arg", async () => {
    const result = await todoWriteTool.execute({ todos: { id: "1" } }, ctx)
    expect(result).toContain("ERROR[bad_args]")
  })

  it("reports summary counts across statuses", async () => {
    replaceTodos.mockReturnValue([
      todo("1", "pending"),
      todo("2", "in_progress"),
      todo("3", "completed"),
      todo("4", "cancelled"),
    ])
    const result = await todoWriteTool.execute({ todos: [] }, ctx)
    expect(JSON.parse(result).summary).toEqual({
      total: 4,
      pending: 1,
      in_progress: 1,
      completed: 1,
      cancelled: 1,
    })
  })
})

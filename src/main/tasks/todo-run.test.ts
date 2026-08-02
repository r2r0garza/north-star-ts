import { describe, it, expect } from "vitest"
import {
  actionableTodos,
  todoRunTitle,
  finishedTodoTitle,
  todoSeed,
} from "./todo-run"
import type { Todo, TodoStatus } from "../db/types"

// Build minimal Todos; only content + status matter to these pure helpers.
function todos(...items: Array<[string, TodoStatus]>): Todo[] {
  return items.map(([content, status], i) => ({
    conversationId: "c",
    itemId: `item_${i + 1}`,
    seq: i,
    content,
    status,
    createdAt: 0,
    updatedAt: 0,
  }))
}

describe("actionableTodos", () => {
  it("keeps only pending / in_progress items", () => {
    const list = todos(
      ["a", "pending"],
      ["b", "in_progress"],
      ["c", "completed"],
      ["d", "cancelled"]
    )
    expect(actionableTodos(list).map((t) => t.content)).toEqual(["a", "b"])
  })
})

describe("todoRunTitle", () => {
  it("counts actionable items and quotes the first", () => {
    expect(todoRunTitle(todos(["Write tests", "pending"]))).toBe(
      "1 task: Write tests"
    )
    expect(
      todoRunTitle(todos(["First", "pending"], ["Second", "pending"]))
    ).toBe("2 tasks: First")
  })
})

describe("finishedTodoTitle", () => {
  it("counts the whole finished list and quotes the first item", () => {
    expect(
      finishedTodoTitle(todos(["Ship it", "completed"]))
    ).toBe("1 task: Ship it")
    expect(
      finishedTodoTitle(
        todos(["Alpha", "completed"], ["Beta", "cancelled"])
      )
    ).toBe("2 tasks: Alpha")
  })
  it("truncates a long first item to 50 chars", () => {
    const long = "x".repeat(80)
    const title = finishedTodoTitle(todos([long, "completed"]))
    expect(title).toBe(`1 task: ${"x".repeat(50)}`)
  })
})

describe("todoSeed", () => {
  it("maps to the {itemId, content, status} snapshot shape", () => {
    expect(todoSeed(todos(["a", "completed"]))).toEqual([
      { itemId: "item_1", content: "a", status: "completed" },
    ])
  })
})

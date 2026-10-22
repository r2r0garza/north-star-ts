import { describe, expect, it } from "vitest"
import type { Message } from "../db/types"
import { todoListInHistory } from "./todo-prompt"

const tool = (toolName: string, content: string) =>
  ({ role: "tool", toolName, content }) as Message

describe("todoListInHistory", () => {
  it("finds a successful todo_write result", () => {
    expect(
      todoListInHistory([
        { role: "user", content: "go" } as Message,
        tool(
          "todo_write",
          JSON.stringify({ todos: [{ id: "1", content: "a" }], summary: {} })
        ),
      ])
    ).toBe(true)
  })

  it("ignores errors, other tools, and an empty history (seeded or summarized)", () => {
    expect(todoListInHistory([])).toBe(false)
    expect(
      todoListInHistory([
        tool("todo_write", JSON.stringify({ error: "bad_args" })),
        tool("todo_write", "not json"),
        tool("read_file", JSON.stringify({ todos: [] })),
      ])
    ).toBe(false)
  })
})

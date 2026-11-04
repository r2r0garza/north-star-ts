// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { Todo } from "@/types"
import { ActiveTodoIndicator } from "./active-todo-indicator"

let container: HTMLDivElement
let root: Root
let todoListener: (event: { conversationId: string; todos: Todo[] }) => void
let rows: Record<string, Todo[]>
const unsubscribe = vi.fn()

function todo(
  itemId: string,
  status: Todo["status"],
  content = `Item ${itemId}`,
  conversationId = "a"
): Todo {
  return {
    conversationId,
    itemId,
    seq: Number(itemId),
    content,
    status,
    createdAt: 1,
    updatedAt: 1,
  }
}
async function render(conversationId = "a") {
  await act(async () => {
    root.render(
      <ActiveTodoIndicator
        key={conversationId}
        conversationId={conversationId}
      />
    )
  })
}
function publish(todos: Todo[], conversationId = "a") {
  act(() => todoListener({ conversationId, todos }))
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  rows = {}
  Object.defineProperty(window, "cowork", {
    configurable: true,
    value: {
      db: {
        tasks: { list: async () => [] },
        todos: {
          list: async (id: string) => rows[id] ?? [],
          onChange: (cb: typeof todoListener) => {
            todoListener = cb
            return unsubscribe
          },
        },
      },
      tasks: { onEvent: () => () => undefined },
    },
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe("ActiveTodoIndicator", () => {
  it("shows the in-progress item with the running shimmer and full text", async () => {
    const long = "x".repeat(300)
    rows.a = [
      todo("1", "completed"),
      todo("2", "in_progress", long),
      todo("3", "pending"),
    ]
    await render()
    const label = container.querySelector("span")!
    expect(label.textContent).toBe(long)
    expect(label.title).toBe(long)
    expect(label.className.split(/\s+/)).toEqual(
      expect.arrayContaining([
        "trace-shimmer",
        "motion-reduce:trace-shimmer-none",
        "truncate",
      ])
    )
  })

  it("renders nothing without an in-progress item", async () => {
    rows.a = [todo("1", "pending"), todo("2", "completed")]
    await render()
    expect(container.innerHTML).toBe("")
  })

  it("picks the first item when several are in progress", async () => {
    rows.a = [todo("1", "in_progress"), todo("2", "in_progress")]
    await render()
    expect(container.textContent).toBe("Item 1")
  })

  it("follows todo updates without a reload", async () => {
    await render()
    expect(container.innerHTML).toBe("")
    publish([todo("1", "in_progress", "First")])
    expect(container.textContent).toBe("First")
    publish([todo("1", "in_progress", "Renamed")])
    expect(container.textContent).toBe("Renamed")
    publish([todo("1", "completed", "Renamed")])
    expect(container.innerHTML).toBe("")
    publish([todo("1", "in_progress", "Again")])
    publish([])
    expect(container.innerHTML).toBe("")
  })

  it("ignores other conversations and never shows the previous one's item", async () => {
    rows.a = [todo("1", "in_progress", "From A")]
    await render("a")
    publish([todo("1", "in_progress", "From B", "b")], "b")
    expect(container.textContent).toBe("From A")

    let release!: () => void
    const pending = new Promise<void>((resolve) => (release = resolve))
    const list = window.cowork.db.todos.list
    window.cowork.db.todos.list = (async (id: string) => {
      await pending
      return list(id)
    }) as typeof list
    rows.b = [todo("1", "in_progress", "From B", "b")]
    await render("b")
    expect(container.innerHTML).toBe("")
    await act(async () => release())
    expect(container.textContent).toBe("From B")
  })
})

// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { TodoTraceList } from "./todo-trace-list"

it("keeps full multiline content, semantic read-only lists and distinct statuses in both consumers", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const container = document.createElement("div")
  const root = createRoot(container)
  const todos = (
    ["pending", "in_progress", "completed", "cancelled"] as const
  ).map((status) => ({
    itemId: status,
    status,
    content: `${status}\n${"Long prose ".repeat(100)}`,
  }))
  try {
    await act(async () => root.render(<TodoTraceList todos={todos} />))
    expect(container.querySelectorAll("ul > li")).toHaveLength(4)
    expect(container.querySelector("button,input")).toBeNull()
    const lines = container.querySelectorAll('[data-slot="trace-line"]')
    expect([...lines].map((line) => line.getAttribute("data-status"))).toEqual([
      "pending",
      "running",
      null,
      null,
    ])
    for (const label of ["Pending", "In progress", "Completed", "Cancelled"])
      expect(container.textContent).toContain(label)
    const titles = container.querySelectorAll('[data-slot="trace-title"]')
    todos.forEach((todo, index) => {
      expect(titles[index].textContent).toBe(todo.content)
      expect(titles[index].className).toContain("whitespace-pre-wrap")
      expect(titles[index].className).not.toContain("truncate")
    })
    expect(titles[2].className).toContain("line-through")
    expect(titles[3].className).toContain("line-through")
    await act(async () =>
      root.render(<TodoTraceList todos={todos} strikeCompleted={false} />)
    )
    expect(
      container.querySelectorAll('[data-slot="trace-title"]')[2].className
    ).not.toContain("line-through")
    expect(
      container.querySelectorAll('[data-slot="trace-title"]')[3].className
    ).toContain("line-through")
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})

// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import type { Task } from "@/types"
import { TaskTranscriptSheet } from "./task-transcript-sheet"

it("renders historical todo snapshots with shared read-only rows and never fetches messages", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const list = vi.fn(async () => [])
  vi.stubGlobal("cowork", { db: { messages: { list } } })
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const task = {
    title: "Historical tasks",
    input: {
      kind: "inline_todos",
      todos: [
        { itemId: "done", content: "Finished work", status: "completed" },
        { itemId: "cancelled", content: "Cancelled work", status: "cancelled" },
      ],
    },
  } as Task
  try {
    await act(async () =>
      root.render(
        <TaskTranscriptSheet task={task} open onOpenChange={() => {}} />
      )
    )
    expect(list).not.toHaveBeenCalled()
    const titles = document.querySelectorAll('[data-slot="trace-title"]')
    expect(titles).toHaveLength(2)
    expect(titles[0].textContent).toBe("Finished work")
    expect(titles[0].className).not.toContain("line-through")
    expect(titles[1].className).toContain("line-through")
    expect(document.querySelectorAll("ul > li")).toHaveLength(2)
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

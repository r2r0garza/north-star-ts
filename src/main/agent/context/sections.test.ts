import { describe, it, expect, vi } from "vitest"
import type { Task, TaskStatus } from "../../db/types"

let tasks: Task[] = []
vi.mock("../../db/repositories/tasks", () => ({
  listTasks: (opts?: { sourceConversationId?: string }) =>
    tasks.filter(
      (t) =>
        !opts?.sourceConversationId ||
        t.sourceConversationId === opts.sourceConversationId
    ),
}))

import { taskStateSection } from "./sections"
import { SECTION_PRIORITY } from "./context-builder"

function task(title: string, status: TaskStatus): Task {
  return {
    id: title,
    conversationId: "worker",
    sourceConversationId: "c1",
    title,
    status,
    input: null,
    result: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe("taskStateSection", () => {
  it("returns null when there are no active tasks", () => {
    tasks = [task("done", "completed"), task("nope", "cancelled")]
    expect(taskStateSection("c1")).toBeNull()
  })

  it("lists active tasks with their status", () => {
    tasks = [
      task("Indexing", "running"),
      task("Refactor", "paused"),
      task("old", "completed"),
    ]
    const section = taskStateSection("c1")
    expect(section).not.toBeNull()
    expect(section!.priority).toBe(SECTION_PRIORITY.taskState)
    expect(section!.content).toContain("Indexing — running")
    expect(section!.content).toContain("Refactor — paused")
    expect(section!.content).not.toContain("old")
  })

  it("only counts tasks sourced from this conversation", () => {
    tasks = [
      { ...task("mine", "running") },
      { ...task("theirs", "running"), sourceConversationId: "other" },
    ]
    const section = taskStateSection("c1")
    expect(section!.content).toContain("mine")
    expect(section!.content).not.toContain("theirs")
  })
})

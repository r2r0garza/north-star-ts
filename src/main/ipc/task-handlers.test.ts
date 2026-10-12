import { beforeEach, describe, expect, it, vi } from "vitest"

const { handlers, enqueue } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  enqueue: vi.fn((_input: Record<string, unknown>) => ({
    id: "task",
    status: "queued",
  })),
}))
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: any[]) => any) =>
      handlers.set(name, handler),
  },
}))
vi.mock("../agent", () => ({
  generateTitle: vi.fn(),
  resolveApproval: vi.fn(),
  resolveQuestion: vi.fn(),
}))
vi.mock("../db/repositories/conversations", () => ({
  getConversation: () => ({ title: "Existing" }),
  setConversationTitleIfUntitled: vi.fn(),
}))
vi.mock("../db/repositories/todos", () => ({
  listTodos: () => [{ itemId: "one", content: "Work", status: "pending" }],
}))
import { registerTaskHandlers } from "./task-handlers"
import type { TaskRunner } from "../tasks/runner"

beforeEach(() => {
  handlers.clear()
  enqueue.mockClear()
  registerTaskHandlers({ enqueue } as unknown as TaskRunner)
})

describe("chat task IPC policy boundary", () => {
  it("keeps generic renderer overrides out of the trusted snapshot argument", () => {
    handlers.get("task:start")!(
      {},
      {
        conversationId: "source",
        message: "Work",
        conversationSubagentsEnabled: true,
      }
    )
    expect(enqueue.mock.calls[0]).toHaveLength(1)
    expect(enqueue.mock.calls[0][0]).not.toHaveProperty(
      "conversationSubagentsEnabled"
    )
  })
  it("cannot evade chat policy by selecting an independent task kind", () => {
    expect(() =>
      handlers.get("task:start")!(
        {},
        { conversationId: "source", message: "Work", kind: "process_run" }
      )
    ).toThrow(/does not accept kind "process_run"/)
    expect(enqueue).not.toHaveBeenCalled()
  })
  it("Todos handoff uses the server snapshot seam, not renderer permission", () => {
    handlers.get("task:start-todos")!({}, "source", {
      autoMode: true,
      conversationSubagentsEnabled: true,
    })
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "source",
        kind: "todo_run",
        autoMode: true,
      })
    )
    expect(enqueue.mock.calls[0]).toHaveLength(1)
    expect(enqueue.mock.calls[0][0]).not.toHaveProperty(
      "conversationSubagentsEnabled"
    )
  })
})

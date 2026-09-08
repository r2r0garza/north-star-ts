import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  generateTitle: vi.fn(),
  getConversation: vi.fn(),
  updateConversation: vi.fn(),
  listTodos: vi.fn(() => []),
  subscribeTodoChanges: vi.fn(() => vi.fn()),
}))

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) => {
      mocks.handlers.set(channel, handler)
    },
  },
}))

vi.mock("../agent", () => ({
  generateTitle: mocks.generateTitle,
  resolveApproval: vi.fn(),
  resolveQuestion: vi.fn(),
}))

vi.mock("../db/repositories/conversations", () => ({
  getConversation: mocks.getConversation,
  updateConversation: mocks.updateConversation,
}))

vi.mock("../db/repositories/todos", () => ({
  listTodos: mocks.listTodos,
}))

vi.mock("../db/repositories", () => ({
  conversations: {},
  messages: {},
  workspaces: {},
  projects: {},
  tasks: {},
  taskEvents: {},
  checkpoints: {},
  approvals: {},
  todos: {
    listTodos: mocks.listTodos,
    subscribeTodoChanges: mocks.subscribeTodoChanges,
  },
  processes: {},
  dashboards: {},
}))

vi.mock("../tasks/todo-run", () => ({
  TODO_RUN_KICKOFF: "kickoff",
  actionableTodos: vi.fn(() => []),
  todoRunTitle: vi.fn(() => "Todos"),
  todoSeed: vi.fn(() => []),
}))

import { registerTaskHandlers } from "./task-handlers"
import { registerTerminalHandlers } from "./terminal-handlers"
import { registerDbHandlers } from "./db-handlers"

class FakeWebContents extends EventEmitter {
  destroyed = false
  send = vi.fn()

  isDestroyed(): boolean {
    return this.destroyed
  }
}

beforeEach(() => {
  mocks.handlers.clear()
  mocks.generateTitle.mockReset().mockResolvedValue("Generated title")
  mocks.getConversation.mockReset()
  mocks.updateConversation.mockReset()
  mocks.subscribeTodoChanges.mockReset().mockReturnValue(vi.fn())
})

describe("WebContents subscription lifecycle", () => {
  it("removes terminal destroyed listeners on every explicit unsubscribe", () => {
    const terminals = new EventEmitter() as any
    terminals.profiles = vi.fn()
    terminals.list = vi.fn()
    terminals.create = vi.fn()
    terminals.write = vi.fn()
    terminals.resize = vi.fn()
    terminals.kill = vi.fn()
    registerTerminalHandlers(terminals)

    const sender = new FakeWebContents()
    const subscribe = mocks.handlers.get("terminal:subscribe")!
    const unsubscribe = mocks.handlers.get("terminal:unsubscribe")!

    for (let i = 0; i < 15; i += 1) {
      subscribe({ sender })
      expect(sender.listenerCount("destroyed")).toBe(1)
      expect(terminals.listenerCount("data")).toBe(1)
      unsubscribe({ sender })
      expect(sender.listenerCount("destroyed")).toBe(0)
      expect(terminals.listenerCount("data")).toBe(0)
    }
  })

  it("removes task destroyed listeners on every explicit unsubscribe", () => {
    const stop = vi.fn()
    const runner = {
      subscribe: vi.fn(() => stop),
      enqueue: vi.fn(),
    } as any
    registerTaskHandlers(runner)

    const sender = new FakeWebContents()
    const subscribe = mocks.handlers.get("task:subscribe")!
    const unsubscribe = mocks.handlers.get("task:unsubscribe")!

    for (let i = 0; i < 15; i += 1) {
      subscribe({ sender })
      expect(sender.listenerCount("destroyed")).toBe(1)
      unsubscribe({ sender })
      expect(sender.listenerCount("destroyed")).toBe(0)
    }
    expect(stop).toHaveBeenCalledTimes(15)
  })

  it("removes todo destroyed listeners on every explicit unsubscribe", () => {
    const stop = vi.fn()
    mocks.subscribeTodoChanges.mockReturnValue(stop)
    registerDbHandlers()

    const sender = new FakeWebContents()
    const subscribe = mocks.handlers.get("db:todos:subscribe")!
    const unsubscribe = mocks.handlers.get("db:todos:unsubscribe")!

    for (let i = 0; i < 15; i += 1) {
      subscribe({ sender })
      expect(sender.listenerCount("destroyed")).toBe(1)
      unsubscribe({ sender })
      expect(sender.listenerCount("destroyed")).toBe(0)
    }
    expect(stop).toHaveBeenCalledTimes(15)
  })
})

describe("background conversation titles", () => {
  it("titles an untitled source conversation before task:start resolves", async () => {
    const task = { id: "task-1" }
    const runner = {
      subscribe: vi.fn(() => vi.fn()),
      enqueue: vi.fn(() => task),
    } as any
    mocks.getConversation.mockReturnValue({ id: "conversation-1", title: null })
    registerTaskHandlers(runner)

    const start = mocks.handlers.get("task:start")!
    await expect(
      start({}, { conversationId: "conversation-1", message: "Fix the leak" })
    ).resolves.toBe(task)

    expect(mocks.generateTitle).toHaveBeenCalledWith("Fix the leak")
    expect(mocks.updateConversation).toHaveBeenCalledWith("conversation-1", {
      title: "Generated title",
    })
  })

  it("keeps an existing conversation title", () => {
    const task = { id: "task-2" }
    const runner = {
      subscribe: vi.fn(() => vi.fn()),
      enqueue: vi.fn(() => task),
    } as any
    mocks.getConversation.mockReturnValue({
      id: "conversation-1",
      title: "Existing title",
    })
    registerTaskHandlers(runner)

    const start = mocks.handlers.get("task:start")!
    expect(
      start({}, { conversationId: "conversation-1", message: "Another turn" })
    ).toBe(task)
    expect(mocks.generateTitle).not.toHaveBeenCalled()
  })
})

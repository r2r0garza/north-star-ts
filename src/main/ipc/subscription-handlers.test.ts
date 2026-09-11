import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  generateTitle: vi.fn(),
  getConversation: vi.fn(),
  setConversationTitleIfUntitled: vi.fn(),
  listTodos: vi.fn(() => []),
  subscribeConversationChanges: vi.fn<
    (listener: (payload: { conversationIds: string[] }) => void) => () => void
  >(() => vi.fn()),
  subscribeTodoChanges: vi.fn(() => vi.fn()),
  watchWorkspaceFiles: vi.fn(),
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
  setConversationTitleIfUntitled: mocks.setConversationTitleIfUntitled,
}))

vi.mock("../db/repositories/todos", () => ({
  listTodos: mocks.listTodos,
}))

vi.mock("../db/repositories", () => ({
  conversations: {
    subscribeConversationChanges: mocks.subscribeConversationChanges,
  },
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

vi.mock("../files/watcher", () => ({
  watchWorkspaceFiles: mocks.watchWorkspaceFiles,
}))

vi.mock("../tasks/todo-run", () => ({
  TODO_RUN_KICKOFF: "kickoff",
  actionableTodos: vi.fn(() => []),
  todoRunTitle: vi.fn(() => "Todos"),
  todoSeed: vi.fn(() => []),
}))

import { registerTaskHandlers } from "./task-handlers"
import { registerTerminalHandlers } from "./terminal-handlers"
import { registerFileWatchHandlers } from "./file-handlers"
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
  mocks.setConversationTitleIfUntitled.mockReset()
  mocks.subscribeConversationChanges.mockReset().mockReturnValue(vi.fn())
  mocks.subscribeTodoChanges.mockReset().mockReturnValue(vi.fn())
  mocks.watchWorkspaceFiles.mockReset()
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

  it("forwards file changes and only removes the matching subscription", async () => {
    const closeFirst = vi.fn()
    const closeSecond = vi.fn()
    const updateDirectories = vi.fn()
    let publish:
      | ((payload: { workspace: string; paths: string[] }) => void)
      | undefined
    mocks.watchWorkspaceFiles
      .mockImplementationOnce(async (_workspace, listener) => {
        publish = listener
        return { close: closeFirst, updateDirectories }
      })
      .mockResolvedValueOnce({ close: closeSecond, updateDirectories })
    registerFileWatchHandlers()

    const sender = new FakeWebContents()
    const subscribe = mocks.handlers.get("files:watch")!
    const update = mocks.handlers.get("files:watchDirectories")!
    const unsubscribe = mocks.handlers.get("files:unwatch")!

    await subscribe({ sender }, "/workspace-a", 1)
    await update({ sender }, 1, ["", "src"])
    expect(updateDirectories).toHaveBeenCalledWith(["", "src"])
    publish?.({ workspace: "/workspace-a", paths: ["src/a.ts"] })
    expect(sender.send).toHaveBeenCalledWith("files:changed", {
      workspace: "/workspace-a",
      paths: ["src/a.ts"],
    })

    await subscribe({ sender }, "/workspace-b", 2)
    expect(closeFirst).toHaveBeenCalledOnce()
    await unsubscribe({ sender }, 1)
    expect(closeSecond).not.toHaveBeenCalled()
    await unsubscribe({ sender }, 2)
    expect(closeSecond).toHaveBeenCalledOnce()
    expect(sender.listenerCount("destroyed")).toBe(0)
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

  it("forwards conversation changes and cleans up subscriptions", () => {
    const stop = vi.fn()
    let publish: ((payload: { conversationIds: string[] }) => void) | undefined
    mocks.subscribeConversationChanges.mockImplementation((listener) => {
      publish = listener
      return stop
    })
    registerDbHandlers()

    const sender = new FakeWebContents()
    const subscribe = mocks.handlers.get("db:conversations:subscribe")!
    const unsubscribe = mocks.handlers.get("db:conversations:unsubscribe")!

    subscribe({ sender })
    publish?.({ conversationIds: ["conversation-1"] })
    expect(sender.send).toHaveBeenCalledWith("db:conversations:change", {
      conversationIds: ["conversation-1"],
    })

    unsubscribe({ sender })
    expect(stop).toHaveBeenCalledOnce()
    expect(sender.listenerCount("destroyed")).toBe(0)
  })
})

describe("background conversation titles", () => {
  it("resolves task:start without waiting for the generated title", async () => {
    const task = { id: "task-1" }
    const runner = {
      subscribe: vi.fn(() => vi.fn()),
      enqueue: vi.fn(() => task),
    } as any
    let resolveTitle!: (title: string) => void
    mocks.generateTitle.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveTitle = resolve
      })
    )
    mocks.getConversation.mockReturnValue({ id: "conversation-1", title: null })
    registerTaskHandlers(runner)

    const start = mocks.handlers.get("task:start")!
    expect(
      start({}, { conversationId: "conversation-1", message: "Fix the leak" })
    ).toBe(task)
    expect(mocks.setConversationTitleIfUntitled).not.toHaveBeenCalled()

    resolveTitle("Generated title")
    await vi.waitFor(() => {
      expect(mocks.setConversationTitleIfUntitled).toHaveBeenCalledWith(
        "conversation-1",
        "Generated title"
      )
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

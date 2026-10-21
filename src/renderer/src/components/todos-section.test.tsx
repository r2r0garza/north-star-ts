// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { TaskLiveEvent, Todo, Task } from "@/types"
import { TodosSection } from "./todos-section"

let container: HTMLDivElement
let root: Root
let taskListener: (event: TaskLiveEvent) => void
let todoListener: (event: { conversationId: string; todos: Todo[] }) => void
let tasks: Task[]
let rows: Todo[]
const listTasks = vi.fn()
const listTodos = vi.fn()

function todo(status: Todo["status"], conversationId = "source"): Todo {
  return {
    conversationId,
    itemId: "1",
    seq: 0,
    content: "Check HTML",
    status,
    createdAt: 1,
    updatedAt: 1,
  }
}
function worker(): Task {
  return {
    id: "worker-task",
    conversationId: "worker",
    sourceConversationId: "source",
    status: "running",
    input: { kind: "todo_run" },
  } as Task
}
async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}
function lifecycle() {
  act(() =>
    taskListener({
      taskId: "worker-task",
      id: 1,
      event: { type: "status_change", from: "queued", to: "running" },
    })
  )
}
function publish(status: Todo["status"]) {
  act(() =>
    todoListener({ conversationId: "worker", todos: [todo(status, "worker")] })
  )
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  tasks = []
  rows = [todo("pending")]
  listTasks.mockReset().mockImplementation(async () => tasks)
  listTodos.mockReset().mockImplementation(async () => rows)
  Object.defineProperty(window, "cowork", {
    configurable: true,
    value: {
      db: {
        tasks: { list: listTasks },
        todos: {
          list: listTodos,
          onChange: (listener: typeof todoListener) => {
            todoListener = listener
            return vi.fn()
          },
        },
      },
      tasks: {
        onEvent: (listener: typeof taskListener) => {
          taskListener = listener
          return vi.fn()
        },
      },
    },
  })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe("TodosSection live background progress", () => {
  it("discovers an agent-started worker and applies every committed update without reloading", async () => {
    act(() => root.render(<TodosSection conversationId="source" />))
    await flush()
    expect(container.textContent).toContain("Pending")
    tasks = [worker()]
    rows = [todo("in_progress", "worker")]
    lifecycle()
    await flush()
    expect(listTodos).toHaveBeenLastCalledWith("worker")
    expect(container.textContent).toContain("In progress")
    publish("completed")
    expect(container.textContent).toContain("Completed")
    expect(container.textContent).not.toContain("In progress")
  })

  it("does not overwrite a live update with a stale list response", async () => {
    tasks = [worker()]
    rows = [todo("pending", "worker")]
    act(() => root.render(<TodosSection conversationId="source" />))
    await flush()
    let resolve!: (value: Todo[]) => void
    listTodos.mockReturnValueOnce(
      new Promise<Todo[]>((done) => {
        resolve = done
      })
    )
    lifecycle()
    await flush()
    publish("completed")
    resolve([todo("in_progress", "worker")])
    await flush()
    expect(container.textContent).toContain("Completed")
    expect(container.textContent).not.toContain("In progress")
  })

  it("ignores older task discovery responses arriving after newer ones", async () => {
    act(() => root.render(<TodosSection conversationId="source" />))
    await flush()
    let resolve!: (value: Task[]) => void
    listTasks.mockReturnValueOnce(
      new Promise<Task[]>((done) => {
        resolve = done
      })
    )
    lifecycle()
    tasks = [worker()]
    rows = [todo("completed", "worker")]
    lifecycle()
    await flush()
    resolve([])
    await flush()
    publish("in_progress")
    expect(container.textContent).toContain("In progress")
    expect(listTodos).toHaveBeenLastCalledWith("worker")
  })

  it("ignores responses from a previously selected conversation", async () => {
    let resolve!: (value: Task[]) => void
    listTasks.mockReturnValueOnce(
      new Promise<Task[]>((done) => {
        resolve = done
      })
    )
    act(() => root.render(<TodosSection conversationId="source" />))
    rows = [{ ...todo("completed", "other"), content: "Other assignment" }]
    act(() => root.render(<TodosSection conversationId="other" />))
    await flush()
    resolve([worker()])
    await flush()
    expect(container.textContent).toContain("Other assignment")
    expect(listTodos).toHaveBeenLastCalledWith("other")
  })
})

it("preserves Auto mode and disables handoff while dispatching and once a worker owns the list", async () => {
  let finish!: (task: Task) => void
  const startTodos = vi.fn(
    () =>
      new Promise<Task>((resolve) => {
        finish = resolve
      })
  )
  window.cowork.tasks.startTodos = startTodos
  const onRanInBackground = vi.fn()
  await act(async () =>
    root.render(
      <TodosSection
        conversationId="source"
        isAutoMode={() => true}
        onRanInBackground={onRanInBackground}
      />
    )
  )
  const button = container.querySelector("button")!
  expect(button.disabled).toBe(false)
  await act(async () => button.click())
  expect(startTodos).toHaveBeenCalledWith("source", { autoMode: true })
  expect(button.disabled).toBe(true)
  tasks = [worker()]
  await act(async () => finish(worker()))
  expect(onRanInBackground).toHaveBeenCalledTimes(1)
  expect(button.disabled).toBe(true)
  expect(button.title).toBe("Already running in the background")
  publish("completed")
  tasks = []
  rows = [todo("completed")]
  lifecycle()
  await flush()
  expect(button.disabled).toBe(true)
  expect(button.title).toBe("No pending tasks to run")
})

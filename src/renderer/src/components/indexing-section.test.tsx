// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { IndexStatus, TaskLiveEvent } from "@/types"
import { IndexingSection } from "./indexing-section"

let container: HTMLDivElement
let root: Root
let listeners: Set<(event: TaskLiveEvent) => void>

async function flushPromises() {
  await act(async () => {
    await Promise.resolve()
  })
}

function emit(payload: TaskLiveEvent) {
  act(() => {
    for (const listener of listeners) listener(payload)
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  listeners = new Set()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe("IndexingSection", () => {
  it("adopts a watcher-created indexing task and refreshes its live status", async () => {
    const previous: IndexStatus = {
      enabled: true,
      stage: "symbols",
      filesScanned: 2,
      filesTotal: 2,
      taskId: "task-old",
      taskStatus: "completed",
    }
    const watcherRun: IndexStatus = {
      enabled: true,
      stage: "file_map",
      filesScanned: 2,
      filesTotal: 4,
      taskId: "task-new",
      taskStatus: "running",
    }
    const completed: IndexStatus = {
      enabled: true,
      stage: "symbols",
      filesScanned: 4,
      filesTotal: 4,
      taskId: "task-new",
      taskStatus: "completed",
    }
    const adoption = deferred<IndexStatus>()
    const status = vi
      .fn()
      .mockResolvedValueOnce(previous)
      .mockReturnValueOnce(adoption.promise)
      .mockResolvedValueOnce(completed)

    Object.defineProperty(window, "cowork", {
      configurable: true,
      value: {
        db: {
          conversations: {
            get: vi.fn().mockResolvedValue({ workspaceId: "workspace-1" }),
          },
        },
        index: { status },
        tasks: {
          onEvent: (listener: (event: TaskLiveEvent) => void) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
        },
      },
    })

    act(() => root.render(<IndexingSection conversationId="conversation-1" />))
    await flushPromises()
    expect(container.textContent).toContain("Indexed 2 files")

    emit({
      taskId: "task-new",
      id: 1,
      event: {
        type: "index_progress",
        stage: "symbols",
        filesScanned: 1,
        filesTotal: 1,
      },
    })
    expect(status).toHaveBeenCalledTimes(2)

    emit({
      taskId: "task-new",
      id: 2,
      event: {
        type: "status_change",
        from: "running",
        to: "completed",
      },
    })
    await flushPromises()

    expect(status).toHaveBeenCalledTimes(3)
    expect(container.textContent).toContain("Indexed 4 files")

    adoption.resolve(watcherRun)
    await flushPromises()

    expect(container.textContent).toContain("Indexed 4 files")
    expect(container.textContent).not.toContain("Indexed 1 files")
  })
})

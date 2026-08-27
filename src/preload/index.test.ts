import { beforeAll, describe, expect, it, vi } from "vitest"

const electron = vi.hoisted(() => ({
  api: null as any,
  invoke: vi.fn(() => Promise.resolve()),
  on: vi.fn(),
  removeListener: vi.fn(),
}))

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: unknown) => {
      electron.api = api
    },
  },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    once: vi.fn(),
    removeListener: electron.removeListener,
    send: vi.fn(),
    sendSync: vi.fn(),
  },
  webUtils: { getPathForFile: vi.fn(() => "") },
}))

beforeAll(async () => {
  await import("./index")
})

describe("preload shared subscriptions", () => {
  it("keeps one task subscription until the last renderer consumer leaves", () => {
    const stopA = electron.api.tasks.onEvent(vi.fn())
    const stopB = electron.api.tasks.onEvent(vi.fn())

    expect(electron.invoke).toHaveBeenCalledTimes(1)
    expect(electron.invoke).toHaveBeenLastCalledWith("task:subscribe")

    stopA()
    expect(electron.invoke).toHaveBeenCalledTimes(1)

    stopB()
    expect(electron.invoke).toHaveBeenCalledTimes(2)
    expect(electron.invoke).toHaveBeenLastCalledWith("task:unsubscribe")
  })
})

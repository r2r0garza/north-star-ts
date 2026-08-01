import { beforeEach, describe, expect, it, vi } from "vitest"

const electronMock = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void

  class EventTargetMock {
    private listeners = new Map<string, Set<Listener>>()

    on(event: string, listener: Listener) {
      const listeners = this.listeners.get(event) ?? new Set<Listener>()
      listeners.add(listener)
      this.listeners.set(event, listeners)
      return this
    }

    once(event: string, listener: Listener) {
      const onceListener: Listener = (...args) => {
        this.off(event, onceListener)
        listener(...args)
      }
      return this.on(event, onceListener)
    }

    off(event: string, listener: Listener) {
      this.listeners.get(event)?.delete(listener)
      return this
    }

    emit(event: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(event) ?? []) listener(...args)
    }
  }

  class DebuggerMock extends EventTargetMock {
    attach = vi.fn()
    detach = vi.fn()
    isAttached = vi.fn(() => false)
    sendCommand = vi.fn(() => new Promise<never>(() => undefined))
  }

  class WebContentsMock extends EventTargetMock {
    debugger = new DebuggerMock()
    // View-scoped IpcMain (webContents.ipc). The session registers a
    // "browser-pick:picked" receiver on it in the constructor.
    ipc = { on: vi.fn(), removeListener: vi.fn() }
    currentUrl = "about:blank"
    title = ""
    loadURL = vi.fn(async (url: string) => {
      this.currentUrl = url
    })
    getURL = vi.fn(() => this.currentUrl)
    getTitle = vi.fn(() => this.title)
    isDestroyed = vi.fn(() => false)
    send = vi.fn()
    close = vi.fn()
  }

  const instances: WebContentsMock[] = []

  class WebContentsViewMock {
    webContents = new WebContentsMock()

    constructor() {
      instances.push(this.webContents)
    }
  }

  return { WebContentsViewMock, instances }
})

vi.mock("electron", () => ({
  WebContentsView: electronMock.WebContentsViewMock,
}))

import { BrowserSession } from "./session"

describe("BrowserSession.navigate", () => {
  beforeEach(() => {
    electronMock.instances.length = 0
  })

  it("starts the initial navigation without waiting for CDP setup", async () => {
    const session = new BrowserSession()
    const webContents = electronMock.instances[0]

    await expect(session.navigate("https://example.com", 100)).resolves.toEqual(
      { url: "https://example.com", title: "" }
    )

    expect(webContents.loadURL).toHaveBeenCalledWith("https://example.com")
    expect(webContents.debugger.attach).not.toHaveBeenCalled()
    expect(webContents.debugger.sendCommand).not.toHaveBeenCalled()
  })
})

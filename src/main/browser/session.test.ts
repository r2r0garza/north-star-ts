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
    private attached = false
    attach = vi.fn(() => {
      this.attached = true
    })
    detach = vi.fn(() => {
      this.attached = false
    })
    isAttached = vi.fn(() => this.attached)
    sendCommand = vi.fn(
      (_method?: string, _params?: Record<string, unknown>): Promise<unknown> =>
        new Promise<never>(() => undefined)
    )
  }

  class WebContentsMock extends EventTargetMock {
    debugger = new DebuggerMock()
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

describe("BrowserSession element picker", () => {
  beforeEach(() => {
    electronMock.instances.length = 0
  })

  it("uses CDP inspect mode and describes the selected backend node", async () => {
    const session = new BrowserSession()
    const webContents = electronMock.instances[0]
    const onElementPicked = vi.fn()
    session.onElementPicked = onElementPicked

    webContents.debugger.sendCommand.mockImplementation(async (method) => {
      if (method === "DOM.resolveNode") {
        return { object: { objectId: "picked-node" } }
      }
      if (method === "Runtime.callFunctionOn") {
        return {
          result: {
            value: {
              selector: "#save",
              tag: "button",
              text: "Save",
              name: "Save",
            },
          },
        }
      }
      if (method === "Accessibility.getPartialAXTree") {
        return {
          nodes: [
            {
              backendDOMNodeId: 42,
              role: { value: "button" },
              name: { value: "Save changes" },
            },
          ],
        }
      }
      return {}
    })

    session.setPickMode(true)

    await vi.waitFor(() => {
      expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
        "Overlay.setInspectMode",
        expect.objectContaining({ mode: "searchForNode" })
      )
    })

    webContents.debugger.emit("message", {}, "Overlay.inspectNodeRequested", {
      backendNodeId: 42,
    })

    await vi.waitFor(() => {
      expect(onElementPicked).toHaveBeenCalledWith({
        selector: "#save",
        role: "button",
        name: "Save changes",
        tag: "button",
        text: "Save",
      })
    })
  })

  it("turns inspect mode back off when an enable settles after selection", async () => {
    const session = new BrowserSession()
    const webContents = electronMock.instances[0]
    let resolveEnable: (() => void) | undefined
    const delayedEnable = new Promise<void>((resolve) => {
      resolveEnable = resolve
    })

    webContents.debugger.sendCommand.mockImplementation(
      async (method, params) => {
        if (
          method === "Overlay.setInspectMode" &&
          params?.mode === "searchForNode"
        ) {
          await delayedEnable
        }
        return {}
      }
    )

    session.setPickMode(true)

    await vi.waitFor(() => {
      expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
        "Overlay.setInspectMode",
        expect.objectContaining({ mode: "searchForNode" })
      )
    })

    // Chromium can emit the pick while Electron's command promise is still
    // pending. The selection turns the desired state off immediately.
    webContents.debugger.emit("message", {}, "Overlay.inspectNodeRequested", {
      backendNodeId: 42,
    })

    await vi.waitFor(() => {
      expect(
        webContents.debugger.sendCommand.mock.calls.filter(
          ([method, params]) =>
            method === "Overlay.setInspectMode" && params?.mode === "none"
        )
      ).toHaveLength(1)
    })

    // The stale enable now settles after the first cleanup. Reconciliation must
    // issue another off command so the picker cannot resurrect itself.
    resolveEnable?.()

    await vi.waitFor(() => {
      expect(
        webContents.debugger.sendCommand.mock.calls.filter(
          ([method, params]) =>
            method === "Overlay.setInspectMode" && params?.mode === "none"
        )
      ).toHaveLength(2)
    })
  })
})

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

import { BrowserSession, StaleRefError } from "./session"

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
      expect(webContents.debugger.detach).toHaveBeenCalledOnce()
      expect(onElementPicked).toHaveBeenCalledWith({
        selector: "#save",
        role: "button",
        name: "Save changes",
        tag: "button",
        text: "Save",
      })
    })
  })

  it("detaches immediately when selection arrives during a pending enable", async () => {
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
      expect(webContents.debugger.detach).toHaveBeenCalledOnce()
    })

    // Let the mocked promise settle so the test leaves no pending work. In real
    // Electron, detach rejects commands owned by the old debugger session.
    resolveEnable?.()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(webContents.debugger.detach).toHaveBeenCalledOnce()
  })

  it("detaches immediately when the user toggles pick mode off", async () => {
    const session = new BrowserSession()
    const webContents = electronMock.instances[0]
    const onPickModeChanged = vi.fn()
    session.onPickModeChanged = onPickModeChanged
    webContents.debugger.sendCommand.mockResolvedValue({})

    session.setPickMode(true)

    await vi.waitFor(() => {
      expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
        "Overlay.setInspectMode",
        expect.objectContaining({ mode: "searchForNode" })
      )
    })

    session.setPickMode(false)

    expect(webContents.debugger.detach).toHaveBeenCalledOnce()
    expect(onPickModeChanged.mock.calls).toEqual([[true], [false]])
  })
})

describe("BrowserSession.snapshot", () => {
  beforeEach(() => {
    electronMock.instances.length = 0
  })

  it("walks bounded candidates instead of requesting the full AX tree", async () => {
    const session = new BrowserSession()
    const webContents = electronMock.instances[0]
    webContents.currentUrl = "https://example.com"
    webContents.title = "Example"

    webContents.debugger.sendCommand.mockImplementation(
      async (method, params) => {
        if (method === "Runtime.evaluate") {
          const expression = String(params?.expression ?? "")
          if (params?.returnByValue === true) {
            return { result: { value: { count: 125, truncated: true } } }
          }
          const match = expression.match(/__coworkSnapshotCandidates\[(\d+)\]/)
          if (match) return { result: { objectId: `candidate-${match[1]}` } }
          return {}
        }
        if (method === "Accessibility.getPartialAXTree") {
          const objectId = String(params?.objectId ?? "")
          const index = Number(objectId.replace("candidate-", ""))
          return {
            nodes: [
              {
                backendDOMNodeId: 1_000 + index,
                role: { value: "button" },
                name: { value: `Button ${index}` },
              },
            ],
          }
        }
        if (method === "DOM.focus" || method === "Input.insertText") return {}
        return {}
      }
    )

    const outline = await session.snapshot(1_000)

    expect(webContents.debugger.sendCommand).not.toHaveBeenCalledWith(
      "Accessibility.getFullAXTree",
      expect.anything()
    )
    expect(outline).toContain("URL: https://example.com")
    expect(outline).toContain("[e100] button: Button 99")
    expect(outline).not.toContain("[e101]")
    expect(outline).toContain("[Snapshot truncated:")

    await expect(
      session.type("e100", "ok", false, 1_000)
    ).resolves.toMatchObject({
      target: 'button "Button 99"',
      url: "https://example.com",
      title: "Example",
    })
    await expect(session.type("e101", "no", false, 1_000)).rejects.toThrow(
      StaleRefError
    )
  })

  it("clears stale refs when snapshot collection fails", async () => {
    const session = new BrowserSession()
    const webContents = electronMock.instances[0]
    let failPartialTree = false

    webContents.debugger.sendCommand.mockImplementation(
      async (method, params) => {
        if (method === "Runtime.evaluate") {
          const expression = String(params?.expression ?? "")
          if (params?.returnByValue === true) {
            return { result: { value: { count: 1, truncated: false } } }
          }
          if (expression.includes("__coworkSnapshotCandidates[0]")) {
            return { result: { objectId: "candidate-0" } }
          }
          return {}
        }
        if (method === "Accessibility.getPartialAXTree") {
          if (failPartialTree) throw new Error("AX failed")
          return {
            nodes: [
              {
                backendDOMNodeId: 7,
                role: { value: "textbox" },
                name: { value: "Search" },
              },
            ],
          }
        }
        if (method === "DOM.focus" || method === "Input.insertText") return {}
        return {}
      }
    )

    await expect(session.snapshot(1_000)).resolves.toContain(
      "[e1] textbox: Search"
    )
    await expect(session.type("e1", "before", false, 1_000)).resolves.toEqual({
      target: 'textbox "Search"',
      url: "about:blank",
      title: "",
    })

    failPartialTree = true
    await expect(session.snapshot(1_000)).rejects.toThrow("AX failed")
    await expect(session.type("e1", "after", false, 1_000)).rejects.toThrow(
      StaleRefError
    )
  })

  it("caps rendered snapshot bytes", async () => {
    const session = new BrowserSession()
    const webContents = electronMock.instances[0]
    const longName = "Long accessible name ".repeat(100)

    webContents.debugger.sendCommand.mockImplementation(
      async (method, params) => {
        if (method === "Runtime.evaluate") {
          const expression = String(params?.expression ?? "")
          if (params?.returnByValue === true) {
            return { result: { value: { count: 500, truncated: true } } }
          }
          const match = expression.match(/__coworkSnapshotCandidates\[(\d+)\]/)
          if (match) return { result: { objectId: `candidate-${match[1]}` } }
          return {}
        }
        if (method === "Accessibility.getPartialAXTree") {
          return {
            nodes: [
              {
                backendDOMNodeId: 10,
                role: { value: "heading" },
                name: { value: longName },
              },
            ],
          }
        }
        return {}
      }
    )

    const outline = await session.snapshot(1_000)

    expect(Buffer.byteLength(outline, "utf8")).toBeLessThanOrEqual(20_000)
    expect(outline).toContain("[Snapshot truncated:")
  })
})

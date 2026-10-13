import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const sessions: any[] = []
  const windowHost = {
    addView: vi.fn(),
    removeView: vi.fn(),
    showView: vi.fn(),
    sendToChrome: vi.fn(),
    focusUrl: vi.fn(() => true),
    reveal: vi.fn(),
    hide: vi.fn(),
  }
  const sidebarHost = {
    attach: vi.fn(),
    detachCurrent: vi.fn(),
    focusUrl: vi.fn(() => true),
  }
  return { sessions, windowHost, sidebarHost }
})
vi.mock("./window", () => ({
  BrowserWindowHost: class {
    constructor() {
      return mocks.windowHost
    }
  },
}))
vi.mock("./sidebar-host", () => ({
  SidebarBrowserHost: class {
    constructor() {
      return mocks.sidebarHost
    }
  },
}))
vi.mock("../settings/service", () => ({}))
vi.mock("./session", () => ({
  BrowserSession: class {
    webContents: any
    view = {}
    constructor() {
      const listeners = new Map<string, Function>()
      this.webContents = {
        on: vi.fn((name, cb) => listeners.set(name, cb)),
        emit: (name: string, ...args: unknown[]) =>
          listeners.get(name)?.(...args),
        isDestroyed: vi.fn(() => false),
        getURL: () => "https://example.com",
        getTitle: () => "Example",
        isLoadingMainFrame: () => false,
        loadURL: vi.fn(async () => {}),
        navigationHistory: {
          canGoBack: vi.fn(() => false),
          canGoForward: vi.fn(() => false),
          goBack: vi.fn(),
          goForward: vi.fn(),
        },
      }
      mocks.sessions.push(this)
    }
  },
}))
import { BrowserManager } from "./manager"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.sessions.length = 0
})

it("navigates only available history on the active tab and pushes history state", () => {
  const manager = new BrowserManager()
  manager.userBack()
  manager.userForward()
  expect(mocks.sessions).toHaveLength(0)
  manager.setActiveConversation("a")
  manager.userNavigate("https://example.com")
  const wc = mocks.sessions[0].webContents
  manager.userBack()
  manager.userForward()
  expect(wc.navigationHistory.goBack).not.toHaveBeenCalled()
  expect(wc.navigationHistory.goForward).not.toHaveBeenCalled()
  wc.navigationHistory.canGoBack.mockReturnValue(true)
  wc.navigationHistory.canGoForward.mockReturnValue(true)
  manager.userBack()
  manager.userForward()
  expect(wc.navigationHistory.goBack).toHaveBeenCalledOnce()
  expect(wc.navigationHistory.goForward).toHaveBeenCalledOnce()
  wc.emit("did-navigate-in-page")
  expect(mocks.windowHost.sendToChrome).toHaveBeenLastCalledWith(
    "browser:tabs",
    [expect.objectContaining({ canGoBack: true, canGoForward: true })]
  )
  manager.setActiveConversation("b")
  manager.userBack()
  expect(wc.navigationHistory.goBack).toHaveBeenCalledOnce()
  manager.setActiveConversation("a")
  wc.isDestroyed.mockReturnValue(true)
  manager.userForward()
  expect(wc.navigationHistory.goForward).toHaveBeenCalledOnce()
})

it("routes page shortcuts to the current surface only for the active tab", () => {
  const manager = new BrowserManager()
  manager.setActiveConversation("a")
  manager.userNavigate("https://example.com")
  const wc = mocks.sessions[0].webContents
  const event = { preventDefault: vi.fn() }
  const input = {
    type: "keyDown",
    key: "l",
    ...(process.platform === "darwin" ? { meta: true } : { control: true }),
  }
  wc.emit("before-input-event", event, input)
  expect(mocks.sidebarHost.focusUrl).toHaveBeenCalledOnce()
  expect(event.preventDefault).toHaveBeenCalledOnce()
  manager.setSurface("window")
  wc.emit("before-input-event", event, input)
  expect(mocks.windowHost.focusUrl).toHaveBeenCalledOnce()
  wc.emit("before-input-event", event, { ...input, type: "keyUp" })
  manager.setActiveConversation("b")
  wc.emit("before-input-event", event, input)
  expect(mocks.windowHost.focusUrl).toHaveBeenCalledOnce()
})

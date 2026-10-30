import { expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const win = {
    visible: false,
    listeners: new Map<string, () => void>(),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: { send: vi.fn(), isDestroyed: () => false },
    isDestroyed: () => false,
    isVisible: () => win.visible,
    getContentSize: () => [1000, 760],
    loadURL: vi.fn(async () => undefined),
    loadFile: vi.fn(async () => undefined),
    on: (event: string, listener: () => void) => {
      win.listeners.set(event, listener)
    },
  }
  return { win }
})

vi.mock("electron", () => ({
  BrowserWindow: class {
    constructor() {
      return mocks.win
    }
  },
}))

import { BrowserWindowHost } from "./window"

const makeView = () => ({ setVisible: vi.fn(), setBounds: vi.fn() })
const bounds = { x: 0, y: 80, width: 1000, height: 680 }

it("keeps background tabs visible and laid out so CDP input can hit-test them", () => {
  const host = new BrowserWindowHost()
  const active = makeView()
  const background = makeView()
  host.addView("active", active as any)
  host.addView("background", background as any)
  host.showView("active")

  // Both views have a real viewport; neither is hidden.
  expect(background.setBounds).toHaveBeenLastCalledWith(bounds)
  expect(background.setVisible).toHaveBeenLastCalledWith(true)
  expect(active.setVisible).toHaveBeenLastCalledWith(true)
  expect(background.setVisible).not.toHaveBeenCalledWith(false)
  // The active tab is raised to the top of the stack last.
  expect(mocks.win.contentView.addChildView).toHaveBeenLastCalledWith(active)

  // A tab added later goes beneath the active one.
  const later = makeView()
  host.addView("later", later as any)
  expect(later.setBounds).toHaveBeenLastCalledWith(bounds)
  expect(mocks.win.contentView.addChildView).toHaveBeenLastCalledWith(active)
})

it("hides views only while the window is on screen with no active tab", () => {
  const host = new BrowserWindowHost()
  const view = makeView()
  mocks.win.visible = false
  host.addView("tab", view as any)
  host.showView(null)
  // Off screen: stay visible so a background workflow tab still takes input.
  expect(view.setVisible).toHaveBeenLastCalledWith(true)

  mocks.win.visible = true
  mocks.win.listeners.get("show")?.()
  // On screen with nothing active: don't show a stale page.
  expect(view.setVisible).toHaveBeenLastCalledWith(false)

  host.showView("tab")
  expect(view.setVisible).toHaveBeenLastCalledWith(true)
})

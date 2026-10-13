import { expect, it, vi } from "vitest"
import { SidebarBrowserHost } from "./sidebar-host"

it("transfers native page focus only while the embedded browser is visible", () => {
  const host = new SidebarBrowserHost()
  const focus = vi.fn()
  const send = vi.fn()
  const win = {
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn() },
    webContents: { focus, send },
  }
  host.setMainWindow(win as any)
  expect(host.focusUrl()).toBe(false)
  host.attach({ setVisible: vi.fn(), setBounds: vi.fn() } as any)
  host.reportBounds({ x: 0, y: 0, width: 400, height: 600 })
  expect(host.focusUrl()).toBe(true)
  expect(focus).toHaveBeenCalledOnce()
  expect(send).toHaveBeenCalledWith("browser:focus-url")
  host.reportBounds(null)
  expect(host.focusUrl()).toBe(false)
  host.reportBounds({ x: 0, y: 0, width: 400, height: 600 })
  host.setVisible(false)
  expect(host.focusUrl()).toBe(false)
  expect(focus).toHaveBeenCalledOnce()
})

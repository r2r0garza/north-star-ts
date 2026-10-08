// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { BrowserSlot } from "./activity-panel"

it("hides the native browser while a dialog portal exists and restores it on close", async () => {
  const reportBrowserBounds = vi.fn()
  Object.defineProperty(window, "cowork", {
    configurable: true,
    value: { reportBrowserBounds },
  })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 10,
    top: 20,
    width: 400,
    height: 600,
  } as DOMRect)
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<BrowserSlot active />))
    expect(reportBrowserBounds).toHaveBeenLastCalledWith({
      x: 10,
      y: 20,
      width: 400,
      height: 600,
    })
    const overlay = document.createElement("div")
    overlay.dataset.slot = "dialog-overlay"
    document.body.append(overlay)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reportBrowserBounds).toHaveBeenLastCalledWith(null)
    window.dispatchEvent(new Event("resize"))
    expect(reportBrowserBounds).toHaveBeenLastCalledWith(null)
    overlay.remove()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reportBrowserBounds).toHaveBeenLastCalledWith({
      x: 10,
      y: 20,
      width: 400,
      height: 600,
    })
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  }
})

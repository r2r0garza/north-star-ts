// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { TooltipButton, TooltipProvider } from "./tooltip"

it("closes when the mouse leaves the trigger toward the tooltip", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <TooltipButton tooltip="Search conversations">Search</TooltipButton>
        </TooltipProvider>
      )
    })
    const trigger = container.querySelector("button")!
    await act(async () => {
      trigger.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" })
      )
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    const tooltip = document.querySelector('[data-slot="tooltip-content"]')!
    expect(tooltip).not.toBeNull()

    await act(async () => {
      trigger.dispatchEvent(
        new PointerEvent("pointerout", {
          bubbles: true,
          pointerType: "mouse",
          relatedTarget: tooltip,
        })
      )
    })
    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull()
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

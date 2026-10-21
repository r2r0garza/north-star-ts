// @vitest-environment happy-dom
import { act, useState } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import {
  Trace,
  TraceLine,
  TraceTitle,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
} from "./trace"

it("uses controlled Radix disclosure state, a detail rail and compatible motion classes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  function Example() {
    const [open, setOpen] = useState(false)
    return (
      <Trace>
        <TraceCollapsible open={open} onOpenChange={setOpen}>
          <TraceCollapsibleTrigger>
            <TraceLine status="running">
              <TraceTitle>Working</TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>Details</TraceCollapsibleContent>
        </TraceCollapsible>
      </Trace>
    )
  }
  try {
    await act(async () => root.render(<Example />))
    const trigger = container.querySelector("button")!
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    expect(container.textContent).not.toContain("Details")
    expect(container.querySelector('[data-status="running"]')).not.toBeNull()
    await act(async () => trigger.click())
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    const content = container.querySelector(
      '[data-slot="trace-collapsible-content"]'
    )!
    expect(content.getAttribute("data-state")).toBe("open")
    expect(content.className).toContain(
      "data-[state=open]:animate-accordion-down"
    )
    expect(content.className).toContain("motion-reduce:animate-none")
    expect(
      container.querySelector('[data-slot="trace-collapsible-content-inner"]')
        ?.textContent
    ).toBe("Details")
    expect(
      container.querySelector('[data-slot="trace-title"]')?.className
    ).toContain("motion-reduce:trace-shimmer-none")
    await act(async () => trigger.click())
    expect(container.textContent).not.toContain("Details")
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

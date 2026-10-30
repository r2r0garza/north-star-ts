// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { ReasoningTrace } from "./reasoning-trace"

vi.mock("@/components/markdown", () => ({
  Markdown: ({ content }: { content: string }) => <p>{content}</p>,
}))

it("streams open while live and collapses once the reasoning ends", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const trigger = () =>
    container.querySelector('[data-slot="trace-collapsible-trigger"]')!

  await act(async () => root.render(<ReasoningTrace text="Plan" live />))
  expect(trigger().getAttribute("aria-expanded")).toBe("true")
  expect(container.textContent).toContain("Thinking…")
  expect(container.textContent).toContain("Plan")

  await act(async () => root.render(<ReasoningTrace text="Plan" />))
  expect(trigger().getAttribute("aria-expanded")).toBe("false")
  expect(container.textContent).toContain("Thought")

  await act(async () => root.unmount())
  container.remove()
})

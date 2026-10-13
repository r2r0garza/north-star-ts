// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { ApprovalCard } from "./tool-group"

it("keeps actions outside the bounded, scrollable command details", () => {
  const container = document.createElement("div")
  const root = createRoot(container)
  const onApproval = vi.fn()
  const summary =
    "$ cat > preguntas.md <<'EOF'\n" +
    "¿Cuál es la política?\n".repeat(500) +
    "EOF"
  act(() =>
    root.render(
      <ApprovalCard
        approval={{
          requestId: "request",
          status: "pending",
          kind: "shell",
          summary,
          reason: "Review command",
        }}
        onApproval={onApproval}
      />
    )
  )
  const details = container.querySelector('[data-slot="approval-details"]')!
  const actions = container.querySelector('[data-slot="approval-actions"]')!
  expect(details.classList.contains("overflow-auto")).toBe(true)
  expect(details.parentElement?.className).toContain("max-h-[50dvh]")
  expect(details.textContent).toContain(summary)
  expect(details.contains(actions)).toBe(false)
  expect(actions.classList.contains("shrink-0")).toBe(true)
  const buttons = Array.from(actions.querySelectorAll("button"))
  act(() =>
    buttons
      .find((button) => button.textContent?.includes("Approve once"))!
      .click()
  )
  expect(onApproval).toHaveBeenCalledWith("request", "approved")
  act(() =>
    buttons.find((button) => button.textContent?.includes("Deny"))!.click()
  )
  expect(onApproval).toHaveBeenCalledWith("request", "denied")
  act(() => root.unmount())
})

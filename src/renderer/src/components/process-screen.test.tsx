// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { GateCard } from "./process-screen"

let container: HTMLDivElement
let root: Root

const handlers = () => ({
  onApprove: vi.fn(),
  onDeny: vi.fn(),
  onRequestChanges: vi.fn(),
  onRetryReview: vi.fn(),
  onViewDetails: vi.fn(),
})

function clickByText(text: string) {
  const button = Array.from(container.querySelectorAll("button")).find((el) =>
    el.textContent?.includes(text)
  )
  expect(button).toBeTruthy()
  act(() => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe("GateCard", () => {
  it("renders a normal phase approval gate without validator retry controls", () => {
    const props = handlers()
    act(() => {
      root.render(
        <GateCard
          name="Implement"
          requestId="req-1"
          phaseRunId="phase-run-1"
          gateKind="phase"
          reworkRound={0}
          maxReworkRounds={0}
          isContainer={false}
          {...props}
        />
      )
    })

    expect(container.textContent).toContain(
      "approve to release its downstream phases"
    )
    expect(container.textContent).toContain("Approve")
    expect(container.textContent).not.toContain("Retry review")
    expect(container.textContent).not.toContain("Manual override")
  })

  it("renders validator-unavailable gates with retry and manual override actions", () => {
    const props = handlers()
    act(() => {
      root.render(
        <GateCard
          name="Implement"
          requestId="req-2"
          phaseRunId="phase-run-2"
          gateKind="validator"
          reworkRound={0}
          maxReworkRounds={3}
          isContainer={false}
          packet={
            {
              summary: {
                outcome:
                  "Implement could not be validated: validator returned an unparseable verdict",
                materialChanges: [],
                validationSummary: "No validation commands were recorded.",
                caveats: [],
              },
              artifacts: [],
              validations: [],
              evidenceWarnings: [],
            } as never
          }
          {...props}
        />
      )
    })

    expect(container.textContent).toContain("validator review is unavailable")
    expect(container.textContent).toContain(
      "validator returned an unparseable verdict"
    )
    expect(container.textContent).toContain("Retry review")
    expect(container.textContent).toContain("Manual override")

    clickByText("Retry review")
    expect(props.onRetryReview).toHaveBeenCalledWith("req-2", "phase-run-2")
    expect(props.onApprove).not.toHaveBeenCalled()

    clickByText("Manual override")
    expect(props.onApprove).toHaveBeenCalledWith("req-2", "phase-run-2")
  })
})

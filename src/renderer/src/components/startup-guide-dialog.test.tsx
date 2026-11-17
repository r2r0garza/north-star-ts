// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StartupGuideDialog } from "./startup-guide-dialog"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe("startup guide", () => {
  it("shows supported surfaces without retired orchestration", async () => {
    window.cowork = {
      system: () => ({ displayName: "North Star" }),
    } as unknown as typeof window.cowork
    await act(async () => {
      root.render(
        <StartupGuideDialog agentName="North Star" open onDismiss={vi.fn()} />
      )
    })
    expect(document.body.textContent).toContain("Dashboards")
    expect(document.body.textContent).toContain("Workflows")
    const kanbanSection = Array.from(document.querySelectorAll("section")).find(
      (section) => section.querySelector("h3")?.textContent === "Kanban Board"
    )
    expect(kanbanSection?.textContent).toContain(
      "Sync work items into a board, move cards through columns"
    )
    expect(document.body.textContent).toContain("Create and save reusable workflows")
    expect(document.body.textContent).not.toContain("Processes")
    expect(document.body.textContent).not.toContain("Mission Control")
  })
})

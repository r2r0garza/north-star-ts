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
  it.each([false, undefined])(
    "shows Processes when Mission Control is %s",
    async (missionControlEnabled) => {
      window.cowork = {
        system: () => ({ displayName: "North Star", missionControlEnabled }),
      } as unknown as typeof window.cowork

      await act(async () => {
        root.render(
          <StartupGuideDialog agentName="North Star" open onDismiss={vi.fn()} />
        )
      })

      expect(document.body.textContent).toContain("Getting around North Star")
      expect(document.body.textContent).toContain("Processes")
      expect(document.body.textContent).toContain(
        "Processes are reusable multi-step workflows."
      )
      expect(document.body.textContent).not.toContain("Mission Control")
    }
  )

  it("shows Mission Control when enabled", async () => {
    window.cowork = {
      system: () => ({
        displayName: "North Star",
        missionControlEnabled: true,
      }),
    } as unknown as typeof window.cowork

    await act(async () => {
      root.render(
        <StartupGuideDialog agentName="North Star" open onDismiss={vi.fn()} />
      )
    })

    expect(document.body.textContent).toContain("Mission Control")
    expect(document.body.textContent).toContain(
      "Mission Control plans features with a team of agent seats."
    )
    expect(document.body.textContent).not.toContain("Processes")
  })
})

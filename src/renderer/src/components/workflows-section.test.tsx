// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { WorkflowsSection } from "./workflows-section"
import type { ConversationWorkflows } from "../hooks/use-conversation-workflows"
import type { WorkflowRun } from "../../../shared/workflow-runs"
it("renders unavailable objectives, truthful statuses, and explicit results actions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const workflow = {
    id: "workflow",
    name: "Review",
    description: "",
    defaultObjective: "",
    steps: [],
  }
  const refresh = vi.fn(),
    start = vi.fn(),
    addToChat = vi.fn(),
    view = vi.fn()
  const state: ConversationWorkflows = {
    definitions: [workflow],
    loading: false,
    error: null,
    refresh,
    start,
    addToChat,
    adopt: vi.fn(),
    pending: () => false,
    workspaceReady: true,
    runs: [
      {
        run: {
          id: "run",
          workflow,
          status: "Completed",
          steps: [{ result: "Final" }],
        } as unknown as WorkflowRun,
        stale: false,
        missing: false,
      },
    ],
  }
  const container = document.createElement("div")
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(<WorkflowsSection controller={state} onViewResults={view} />)
    })
    const button = (text: string) =>
      [...container.querySelectorAll("button")].find(
        (b) => b.textContent === text
      )!
    expect(button("Run").disabled).toBe(true)
    expect(container.textContent).toContain("predefined objective")
    expect(container.textContent).toContain("Completed")
    await act(async () => {
      button("View Results").click()
      button("Add to Chat").click()
      button("Refresh workflows").click()
    })
    expect(view).toHaveBeenCalledWith("run")
    expect(addToChat).toHaveBeenCalledWith("run")
    expect(start).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledTimes(1)
    await act(async () => {
      root.render(
        <WorkflowsSection
          controller={{
            ...state,
            definitions: [],
            runs: [],
            workspaceReady: false,
          }}
          onViewResults={view}
        />
      )
    })
    expect(container.textContent).toContain("No workflows enabled")
    expect(container.textContent).toContain("workspace is required")
  } finally {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  }
})

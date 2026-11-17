// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { KanbanScreen } from "./kanban-screen"
import type { KanbanBoardSummary } from "../../../shared/kanban"

vi.mock("./dashboards-screen", () => ({ waitForTask: vi.fn() }))

it("sorts boards alphabetically and refreshes attention for unselected boards", async () => {
  vi.useFakeTimers()
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const board = (name: string, needsAttention = false): KanbanBoardSummary => ({
    id: name,
    name,
    needsAttention,
    workspace: "/Projects/test",
    source: null,
    filter: {
      tags: [],
      match: "all",
      excludeTags: [],
      assignee: { mode: "anyone" },
    },
    approvedHash: null,
    writeApproval: "always",
    approvedActions: [],
    actionsPaused: false,
    syncIntervalMs: 300000,
    lastSyncAt: null,
    lastSyncError: null,
    createdAt: 0,
    updatedAt: 0,
  })
  let boards = [board("Zulu", true), board("alpha"), board("Beta")]
  Object.assign(window, {
    cowork: {
      kanban: {
        list: vi.fn(async () => boards),
        graph: vi.fn(async (id: string) => ({
          board: boards.find((b) => b.id === id),
          columns: [],
          cards: [],
          sourceHash: null,
          approved: false,
          intakeCall: null,
          intakeError: null,
        })),
      },
    },
  })
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        <KanbanScreen onClose={vi.fn()} onOpenConversation={vi.fn()} />
      )
    )
    const picker = document.querySelector<HTMLButtonElement>(
      '[aria-label="Switch board: alpha"]'
    )!
    expect(picker).not.toBeNull()
    expect(document.body.textContent).toContain("Workspace: /Projects/test")
    await act(async () => picker.click())
    const options = () => [...document.querySelectorAll('[role="option"]')]
    expect(options().map((el) => el.textContent)).toEqual([
      "alpha",
      "Beta",
      "Zulu",
    ])
    expect(
      options().map(
        (el) => !!el.querySelector('[aria-label="Needs your attention"]')
      )
    ).toEqual([false, false, true])
    boards = [board("Zulu"), board("alpha"), board("Beta", true)]
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(
      options().map(
        (el) => !!el.querySelector('[aria-label="Needs your attention"]')
      )
    ).toEqual([false, true, false])
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})

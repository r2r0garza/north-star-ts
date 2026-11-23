// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { KanbanScreen } from "./kanban-screen"
import type { DragEndEvent } from "@dnd-kit/core"
import type {
  KanbanBoardSummary,
  KanbanCard,
  KanbanColumn,
} from "../../../shared/kanban"

vi.mock("./dashboards-screen", () => ({ waitForTask: vi.fn() }))
// Capture the board's drop handler; dragging itself needs real layout.
const drag = vi.hoisted(() => ({
  end: undefined as undefined | ((event: DragEndEvent) => void),
}))
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>()
  return {
    ...actual,
    DndContext: (props: React.ComponentProps<typeof actual.DndContext>) => {
      drag.end = props.onDragEnd
      return <actual.DndContext {...props} />
    },
  }
})

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
      types: [],
      states: [],
      assignee: { mode: "anyone" },
    },
    approvedHash: null,
    writeApproval: "always",
    approvedActions: [],
    actionsPaused: false,
    worktrees: true,
    parallelCommands: false,
    notifications: true,
    autoPromote: { states: [], tags: [] },
    dependencyLinks: null,
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
          layout: "repo",
          detectedLinks: [],
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

const board = {
  id: "b",
  name: "Board",
  needsAttention: false,
  workspace: "/Projects/test",
  source: null,
  filter: {
    tags: [],
    match: "all",
    excludeTags: [],
    types: [],
    states: [],
    assignee: { mode: "anyone" },
  },
  approvedHash: null,
  writeApproval: "always",
  approvedActions: [],
  actionsPaused: false,
  worktrees: true,
  parallelCommands: false,
  notifications: true,
  autoPromote: { states: [], tags: [] },
  dependencyLinks: null,
  syncIntervalMs: 300000,
  lastSyncAt: null,
  lastSyncError: null,
  createdAt: 0,
  updatedAt: 0,
} as KanbanBoardSummary
const dev = { id: "dev", name: "Dev", owner: "agent" } as KanbanColumn
const card = (id: string, columnId: string | null, runState: string) =>
  ({
    id,
    boardId: "b",
    externalId: id,
    item: {
      id,
      url: null,
      title: `Issue ${id}`,
      body: "",
      type: null,
      state: null,
      tags: [],
      assignees: [],
      updatedAt: null,
    },
    columnId,
    status: "active",
    runState,
    runError: null,
    worktree: null,
    branch: null,
    ownWorktree: null,
    repos: [],
    promoteHeld: false,
    outcome: null,
    visits: {},
    returns: {},
    continuation: null,
    createdAt: 0,
    updatedAt: 0,
  }) as KanbanCard

it("moves an idle card to the column it's dropped on, but never a running one", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const moveCard = vi.fn(async () => ({ ok: true }))
  Object.assign(window, {
    cowork: {
      kanban: {
        list: vi.fn(async () => [board]),
        graph: vi.fn(async () => ({
          board,
          columns: [dev],
          cards: [card("1", null, "idle"), card("2", "dev", "running")],
          sourceHash: null,
          approved: true,
          intakeCall: null,
          intakeError: null,
          layout: "repo",
          detectedLinks: [],
        })),
        moveCard,
        sync: vi.fn(async () => null),
      },
    },
  })
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const drop = (cardId: string, over: string | null) =>
    act(async () => {
      drag.end!({
        active: { id: cardId },
        over: over ? { id: over } : null,
      } as DragEndEvent)
    })
  try {
    await act(async () =>
      root.render(
        <KanbanScreen onClose={vi.fn()} onOpenConversation={vi.fn()} />
      )
    )
    // Only the idle card has a drag handle.
    const handle = (id: string) =>
      document.querySelector(`[aria-label="Drag #${id} to another column"]`)
    expect(handle("1")?.tagName).toBe("BUTTON")
    expect(handle("2")).toBeNull()

    await drop("1", "inbox") // same column
    await drop("1", null) // dropped outside any column
    await drop("2", "inbox") // running
    expect(moveCard).not.toHaveBeenCalled()

    await drop("1", "dev")
    expect(moveCard).toHaveBeenCalledWith("1", "dev")
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

it("toggles a card's own worktree from its menu, until the card has run", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const setOwnWorktree = vi.fn(async () => ({ ok: true }))
  const cards = [
    card("1", null, "idle"),
    { ...card("2", null, "idle"), started: true },
  ]
  Object.assign(window, {
    cowork: {
      kanban: {
        list: vi.fn(async () => [board]),
        graph: vi.fn(async () => ({
          board,
          columns: [dev],
          cards,
          sourceHash: null,
          approved: true,
          intakeCall: null,
          intakeError: null,
          layout: "repo",
          detectedLinks: [],
        })),
        setOwnWorktree,
        sync: vi.fn(async () => null),
      },
    },
  })
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const press = (element: Element) =>
    act(async () => {
      element.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          ctrlKey: false,
        })
      )
      element.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          button: 0,
          ctrlKey: false,
        })
      )
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
  const item = () =>
    [...document.querySelectorAll('[role="menuitemcheckbox"]')].find((e) =>
      e.textContent?.includes("Own worktree")
    )!
  try {
    await act(async () =>
      root.render(
        <KanbanScreen onClose={vi.fn()} onOpenConversation={vi.fn()} />
      )
    )
    await press(document.querySelector('[aria-label="Actions for #1"]')!)
    expect(item().getAttribute("aria-checked")).toBe("true") // board default
    await press(item())
    expect(setOwnWorktree).toHaveBeenCalledWith("1", false)

    await press(document.querySelector('[aria-label="Actions for #2"]')!)
    expect(item().getAttribute("data-disabled")).not.toBeNull()
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

it.each([false, true])(
  "selects the fresh duplicate after saving (edit intake: %s)",
  async (edit) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    const original = {
      ...board,
      source: {
        tracker: "github" as const,
        command: "gh issue list --repo 'owner/repo' --search {{query}}",
        fields: { id: "number", title: "title" },
      },
    }
    const copy = { ...original, id: "copy", name: "Board - Copy 3" }
    let boards = [
      original,
      { ...original, id: "c1", name: "Board - Copy" },
      { ...original, id: "c2", name: "Board - Copy 2" },
    ]
    const duplicate = vi.fn(async () => {
      boards = [...boards, copy]
      return { ok: true, boardId: copy.id }
    })
    const graph = vi.fn(async (id: string) => ({
      board: boards.find((b) => b.id === id),
      columns: [],
      cards: [],
      sourceHash: "fresh",
      approved: false,
      intakeCall: { command: "gh issue list" },
      intakeError: null,
      layout: "repo",
      detectedLinks: [],
    }))
    Object.assign(window, {
      cowork: { kanban: { list: vi.fn(async () => boards), graph, duplicate } },
    })
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    const clickText = async (text: string) =>
      act(async () => {
        ;[
          ...document.querySelectorAll<HTMLElement>(
            'button, [role="menuitem"]'
          ),
        ]
          .find((el) => el.textContent === text)!
          .click()
      })
    try {
      await act(async () =>
        root.render(
          <KanbanScreen
            onClose={vi.fn()}
            onOpenConversation={vi.fn()}
            focusBoard={{ id: "b" }}
          />
        )
      )
      await act(async () => {
        const trigger = document.querySelector('[aria-label="Board actions"]')!
        trigger.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
            ctrlKey: false,
          })
        )
        trigger.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            button: 0,
            ctrlKey: false,
          })
        )
        trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      })
      await clickText("Duplicate board")
      expect(
        (document.getElementById("duplicate-name") as HTMLInputElement).value
      ).toBe("Board - Copy 3")
      if (edit) {
        await clickText("Edit intake settings")
        expect(
          (document.getElementById("nb-name") as HTMLInputElement).value
        ).toBe("Board - Copy 3")
        expect(
          (document.getElementById("nb-repo") as HTMLInputElement).value
        ).toBe("owner/repo")
        await clickText("Duplicate board")
      } else await clickText("Keep intake and duplicate")
      expect(duplicate).toHaveBeenCalled()
      expect(graph).toHaveBeenLastCalledWith("copy")
      expect(
        document.querySelector('[aria-label="Switch board: Board - Copy 3"]')
      ).not.toBeNull()
    } finally {
      act(() => root.unmount())
      container.remove()
      vi.unstubAllGlobals()
    }
  }
)

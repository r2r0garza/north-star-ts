// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { KanbanSettingsSheet } from "./kanban-settings-sheet"
import type { KanbanBoardGraph } from "../../../shared/kanban"
import type { DragEndEvent } from "@dnd-kit/core"

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
const drop = (from: string, to: string | null) =>
  act(async () => {
    drag.end!({
      active: { id: from },
      over: to ? { id: to } : null,
    } as DragEndEvent)
  })

let root: Root
let container: HTMLDivElement
const saveSettings = vi.fn(async () => ({ ok: true }))
const graph: KanbanBoardGraph = {
  board: {
    id: "board",
    name: "Agent issues",
    workspace: null,
    source: null,
    filter: {
      tags: ["agent-go"],
      match: "all",
      excludeTags: [],
      assignee: { mode: "anyone" },
    },
    approvedHash: null,
    syncIntervalMs: 300_000,
    lastSyncAt: null,
    lastSyncError: null,
    createdAt: 0,
    updatedAt: 0,
  },
  columns: [
    {
      id: "todo",
      boardId: "board",
      name: "Todo",
      position: 0,
      agentName: null,
      instructions: "Plan the issue",
      gate: "human",
    },
    {
      id: "doing",
      boardId: "board",
      name: "In progress",
      position: 1,
      agentName: "custom-agent",
      instructions: "Implement the plan",
      gate: "agent",
    },
  ],
  cards: [],
  sourceHash: null,
  approved: false,
  intakeCall: null,
  intakeError: null,
}
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === name
  )!
const click = (name: string) =>
  act(async () => {
    button(name).click()
  })
beforeEach(() => {
  saveSettings.mockClear()
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  Object.assign(window, {
    cowork: { agents: { list: async () => [] }, kanban: { saveSettings } },
  })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it("keeps column identities and approval choices when navigating and reordering", async () => {
  await act(async () =>
    root.render(
      <KanbanSettingsSheet graph={graph} onClose={vi.fn()} onSaved={vi.fn()} />
    )
  )
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(
    document.querySelector('[role="switch"]')?.getAttribute("aria-checked")
  ).toBe("true")
  await act(() =>
    (document.querySelector('[role="switch"]') as HTMLButtonElement).click()
  )
  await click("In progress")
  expect(
    (document.querySelector("#kb-column-agent") as HTMLSelectElement).value
  ).toBe("custom-agent")
  await act(() =>
    (
      document.querySelector(
        '[aria-label="Move column up"]'
      ) as HTMLButtonElement
    ).click()
  )
  expect(
    (document.querySelector("#kb-column-name") as HTMLInputElement).value
  ).toBe("In progress")
  await click("Save changes")
  expect(saveSettings).toHaveBeenCalledWith(
    "board",
    expect.objectContaining({
      columns: [
        expect.objectContaining({ id: "doing", gate: "agent" }),
        expect.objectContaining({ id: "todo", gate: "agent" }),
      ],
      filter: graph.board.filter,
    })
  )
})

it("selects added columns and keeps a valid editor after removal", async () => {
  await act(async () =>
    root.render(
      <KanbanSettingsSheet graph={graph} onClose={vi.fn()} onSaved={vi.fn()} />
    )
  )
  await click("Add column")
  expect(
    (document.querySelector("#kb-column-name") as HTMLInputElement).value
  ).toBe("Column 3")
  await act(() =>
    (
      document.querySelector(
        '[aria-label="Remove column Column 3"]'
      ) as HTMLButtonElement
    ).click()
  )
  expect(
    (document.querySelector("#kb-column-name") as HTMLInputElement).value
  ).toBe("In progress")
  await click("Save changes")
  expect(saveSettings).toHaveBeenCalledWith(
    "board",
    expect.objectContaining({
      columns: graph.columns.map(({ boardId, position, ...col }) => col),
    })
  )
})

it("preserves edits across settings tabs and does not save on cancel", async () => {
  await act(async () =>
    root.render(
      <KanbanSettingsSheet graph={graph} onClose={vi.fn()} onSaved={vi.fn()} />
    )
  )
  const tab = (name: string) =>
    act(() => {
      button(name).dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 })
      )
    })
  await tab("General & filters")
  expect(document.querySelector("#kb-name")).not.toBeNull()
  await tab("Columns")
  expect(
    (document.querySelector("#kb-column-instructions") as HTMLTextAreaElement)
      .value
  ).toBe("Plan the issue")
  await click("Cancel")
  expect(saveSettings).not.toHaveBeenCalled()
})

it("prevents removing a column that contains issues", async () => {
  const occupiedGraph = {
    ...graph,
    cards: [{ columnId: "todo" }],
  } as KanbanBoardGraph
  await act(async () =>
    root.render(
      <KanbanSettingsSheet
        graph={occupiedGraph}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )
  )
  expect(
    (
      document.querySelector(
        '[aria-label="Remove column Todo"]'
      ) as HTMLButtonElement
    ).disabled
  ).toBe(true)
  expect(document.body.textContent).toContain(
    "This column contains issues and cannot be removed."
  )
})

it("reorders an unselected column without changing the editor or saved identities", async () => {
  await act(async () =>
    root.render(
      <KanbanSettingsSheet graph={graph} onClose={vi.fn()} onSaved={vi.fn()} />
    )
  )
  expect(document.querySelector('[aria-label="Reorder Todo"]')).not.toBeNull()
  expect(document.querySelector('[aria-label="Reorder Inbox"]')).toBeNull()
  await drop("doing", "todo")
  expect(
    (document.querySelector("#kb-column-name") as HTMLInputElement).value
  ).toBe("Todo")
  expect(
    [...document.querySelectorAll('[aria-label^="Reorder "]')].map((el) =>
      el.getAttribute("aria-label")
    )
  ).toEqual(["Reorder In progress", "Reorder Todo"])
  await click("Save changes")
  expect(saveSettings.mock.calls[0]).toEqual([
    "board",
    expect.objectContaining({
      columns: graph.columns
        .toReversed()
        .map(({ boardId, position, ...col }) => col),
    }),
  ])
})

it("supports dragging unsaved columns and ignores cancelled or unchanged drops", async () => {
  await act(async () =>
    root.render(
      <KanbanSettingsSheet graph={graph} onClose={vi.fn()} onSaved={vi.fn()} />
    )
  )
  await click("Add column")
  await click("Add column")
  const sortableId = (name: string) =>
    document
      .querySelector(`[aria-label="Reorder ${name}"]`)!
      .getAttribute("aria-describedby")
  expect(sortableId("Column 3")).not.toBeNull()
  const uuid = vi
    .spyOn(crypto, "randomUUID")
    .mockReturnValue("00000000-0000-4000-8000-000000000005")
  await click("Add column")
  uuid.mockRestore()
  await drop("todo", null)
  await drop("todo", "todo")
  await drop("00000000-0000-4000-8000-000000000005", "todo")
  expect(
    (document.querySelector("#kb-column-name") as HTMLInputElement).value
  ).toBe("Column 5")
  await click("Save changes")
  expect(saveSettings.mock.calls[0]).toEqual([
    "board",
    expect.objectContaining({
      columns: [
        expect.objectContaining({ name: "Column 5" }),
        expect.objectContaining({ id: "todo" }),
        expect.objectContaining({ id: "doing" }),
        expect.objectContaining({ name: "Column 3" }),
        expect.objectContaining({ name: "Column 4" }),
      ],
    }),
  ])
  const saved = saveSettings.mock.calls[0] as unknown as [
    string,
    { columns: Record<string, unknown>[] },
  ]
  expect(saved[1].columns.every((column) => !("sortId" in column))).toBe(true)
})

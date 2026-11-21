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
      types: [],
      states: [],
      assignee: { mode: "anyone" },
    },
    approvedHash: null,
    writeApproval: "once_per_action",
    approvedActions: [],
    actionsPaused: false,
    worktrees: true,
    parallelCommands: false,
    notifications: true,
    autoPromote: { states: [], tags: [] },
    dependencyLinks: null,
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
      owner: "agent",
      outcomes: [],
      actions: [],
      command: null,
      commandTimeoutMs: null,
      notify: false,
      wipLimit: null,
      entryGate: { states: [], tags: [] },
    },
    {
      id: "doing",
      boardId: "board",
      name: "In progress",
      position: 1,
      agentName: "custom-agent",
      instructions: "Implement the plan",
      gate: "agent",
      owner: "agent",
      outcomes: [],
      actions: [],
      command: null,
      commandTimeoutMs: null,
      notify: false,
      wipLimit: null,
      entryGate: { states: [], tags: [] },
    },
  ],
  cards: [],
  sourceHash: null,
  approved: false,
  intakeCall: null,
  intakeError: null,
  layout: "repo",
  detectedLinks: [],
}
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === name
  )!
const click = (name: string) =>
  act(async () => {
    button(name).click()
  })
const openPicker = async (id: string) => {
  await act(async () => {
    const trigger = document.getElementById(id)!
    trigger.focus()
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
    )
  })
}
const choose = async (id: string, label: string) => {
  await openPicker(id)
  await act(async () => {
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((item) => item.textContent === label)!
    expect(option, label).toBeDefined()
    option.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
    option.click()
  })
}
beforeEach(() => {
  saveSettings.mockClear()
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  Object.assign(window, {
    cowork: {
      agents: { list: async () => [] },
      providers: {
        list: async () => [
          { id: "acct", displayName: "Test account", enabled: true },
        ],
      },
      models: {
        list: async () => [{ modelId: "model-1", modelName: "Model One" }],
      },
      kanban: { saveSettings },
    },
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

it.each(["/Users/test/Projects/north-star", "C:\\Projects\\north-star", null])(
  "shows the board workspace beside its name: %s",
  async (workspace) => {
    await act(async () =>
      root.render(
        <KanbanSettingsSheet
          graph={{ ...graph, board: { ...graph.board, workspace } }}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />
      )
    )
    const name = [...document.querySelectorAll("span")].find(
      (span) => span.textContent === graph.board.name
    )!
    const label = name.nextElementSibling!
    expect(label.textContent).toBe(
      workspace ? `Workspace: ${workspace}` : "No workspace"
    )
    expect(label.getAttribute("title")).toBe(workspace)
    expect(saveSettings).not.toHaveBeenCalled()
  }
)

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
  expect(document.querySelector("#kb-column-agent")?.textContent).toContain(
    "custom-agent"
  )
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

it("selects a provider model independently of the agent and saves both", async () => {
  await act(async () =>
    root.render(
      <KanbanSettingsSheet graph={graph} onClose={vi.fn()} onSaved={vi.fn()} />
    )
  )
  await click("In progress")
  await choose("kb-column-model", "Model One")
  expect(document.querySelector("#kb-column-agent")?.textContent).toContain(
    "custom-agent"
  )
  await click("Save changes")
  expect(saveSettings).toHaveBeenCalledWith(
    "board",
    expect.objectContaining({
      columns: expect.arrayContaining([
        expect.objectContaining({
          id: "doing",
          agentName: "custom-agent",
          accountId: "acct",
          modelId: "model-1",
        }),
      ]),
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
      columns: graph.columns.map(
        ({ boardId, position, actions, ...col }) => col
      ),
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
        .map(({ boardId, position, actions, ...col }) => col),
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

it("saves goto outcomes by column id and the tracker-write settings, keeping stored actions", async () => {
  const withActions = {
    ...graph,
    columns: graph.columns.map((c) =>
      c.id === "doing"
        ? {
            ...c,
            actions: [
              {
                name: "label",
                phase: "enter",
                command: "gh issue edit {{id}}",
              },
            ],
          }
        : c
    ),
  } as KanbanBoardGraph
  await act(async () =>
    root.render(
      <KanbanSettingsSheet
        graph={withActions}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )
  )
  await act(() => button("In progress").click())
  expect(document.body.textContent).toContain("gh issue edit {{id}}")
  await click("Add outcome")
  const input = document.querySelector("#kb-outcome-0") as HTMLInputElement
  await act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!.call(input, "changes_requested")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await choose("kb-outcome-next-0", "Send to…")
  await click("Save changes")
  const saved = saveSettings.mock.calls[0] as unknown as [
    string,
    { columns: Record<string, unknown>[]; writeApproval: string },
  ]
  expect(saved[1].writeApproval).toBe("once_per_action")
  expect(saved[1].columns[1]).toMatchObject({
    id: "doing",
    outcomes: [
      {
        name: "changes_requested",
        next: "goto",
        target: "todo",
        maxReturns: 2,
      },
    ],
  })
  expect("actions" in saved[1].columns[1]).toBe(false)
})

it("edits a command and its time limit only on the user's own columns", async () => {
  const withUser = {
    ...graph,
    columns: graph.columns.map((c) =>
      c.id === "doing" ? { ...c, owner: "user", command: "npm run deploy" } : c
    ),
  } as KanbanBoardGraph
  await act(async () =>
    root.render(
      <KanbanSettingsSheet
        graph={withUser}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )
  )
  expect(document.querySelector("#kb-column-command")).toBeNull() // agent column
  await act(() => button("In progress").click())
  const command = document.querySelector(
    "#kb-column-command"
  ) as HTMLTextAreaElement
  expect(command.value).toBe("npm run deploy")
  expect(document.querySelector("#kb-column-timeout")?.textContent).toContain(
    "Off"
  )
  await choose("kb-column-timeout", "30 minutes")
  await click("Save changes")
  const saved = saveSettings.mock.calls[0] as unknown as [
    string,
    { columns: Record<string, unknown>[] },
  ]
  expect(saved[1].columns[1]).toMatchObject({
    id: "doing",
    owner: "user",
    command: "npm run deploy",
    commandTimeoutMs: 30 * 60_000,
  })
})

const openGeneral = () =>
  act(() => {
    button("General & filters").dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 })
    )
  })

it("shows the parallel-commands switch only with worktrees off, and saves both", async () => {
  await act(async () =>
    root.render(
      <KanbanSettingsSheet graph={graph} onClose={vi.fn()} onSaved={vi.fn()} />
    )
  )
  await openGeneral()
  expect(document.querySelector("#kb-worktrees")).not.toBeNull()
  expect(document.querySelector("#kb-parallel")).toBeNull()
  await act(async () =>
    (document.querySelector("#kb-worktrees") as HTMLButtonElement).click()
  )
  await act(async () =>
    (document.querySelector("#kb-parallel") as HTMLButtonElement).click()
  )
  await click("Save changes")
  const saved = saveSettings.mock.calls[0] as unknown as [
    string,
    { worktrees: boolean; parallelCommands: boolean },
  ]
  expect(saved[1]).toMatchObject({ worktrees: false, parallelCommands: true })
})

it("hides the worktrees switch when the workspace has no repos", async () => {
  await act(async () =>
    root.render(
      <KanbanSettingsSheet
        graph={{ ...graph, layout: "none" }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )
  )
  await openGeneral()
  expect(document.querySelector("#kb-worktrees")).toBeNull()
  expect(document.querySelector("#kb-parallel")).not.toBeNull()
})

it("shows the column notify switch only with board notifications off, and saves both", async () => {
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
  await tab("Columns")
  expect(document.querySelector("#kb-column-notify")).toBeNull()
  await tab("General & filters")
  await act(async () =>
    (document.querySelector("#kb-notifications") as HTMLButtonElement).click()
  )
  await tab("Columns")
  const notify = document.querySelector(
    "#kb-column-notify"
  ) as HTMLButtonElement
  expect(notify.getAttribute("aria-checked")).toBe("false")
  await act(async () => notify.click())
  await click("Save changes")
  const saved = saveSettings.mock.calls[0] as unknown as [
    string,
    { notifications: boolean; columns: { notify?: boolean }[] },
  ]
  expect(saved[1].notifications).toBe(false)
  expect(saved[1].columns[0].notify).toBe(true)
})

it("starts dependency links from the scan, lets the person add and remove them, and goes back to the scan", async () => {
  await act(async () =>
    root.render(
      <KanbanSettingsSheet
        graph={{ ...graph, detectedLinks: ["node_modules"] }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )
  )
  await act(() => {
    button("General & filters").dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 })
    )
  })
  const input = document.querySelector("#kb-link-new") as HTMLInputElement
  const type = (value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!.call(input, value)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
  await type("../outside")
  await click("Add")
  expect(button("Use detected")).toBeUndefined() // rejected: nothing changed
  await type("./apps/web/node_modules/")
  await click("Add")
  await act(() =>
    (
      document.querySelector(
        '[aria-label="Remove node_modules"]'
      ) as HTMLButtonElement
    ).click()
  )
  await click("Save changes")
  expect(saveSettings).toHaveBeenLastCalledWith(
    "board",
    expect.objectContaining({ dependencyLinks: ["apps/web/node_modules"] })
  )
  await click("Use detected")
  await click("Save changes")
  expect(saveSettings).toHaveBeenLastCalledWith(
    "board",
    expect.objectContaining({ dependencyLinks: null })
  )
})

it("uses shared fixed choices and keeps their saved values", async () => {
  await act(async () =>
    root.render(
      <KanbanSettingsSheet graph={graph} onClose={vi.fn()} onSaved={vi.fn()} />
    )
  )
  expect(document.querySelector('[data-slot="native-select"]')).toBeNull()
  await choose("kb-column-owner", "Me")
  expect(
    (document.querySelector("#kb-column-timeout") as HTMLButtonElement).disabled
  ).toBe(true)
  await choose("kb-column-owner", "An agent")
  await openGeneral()
  await choose("kb-match", "any")
  await choose("kb-assignee", "a person")
  expect(document.querySelector("#kb-user")).not.toBeNull()
  await choose("kb-write-approval", "Never ask")
  await click("Save changes")
  expect(saveSettings).toHaveBeenCalledWith(
    "board",
    expect.objectContaining({
      filter: expect.objectContaining({
        match: "any",
        assignee: { mode: "user", user: "" },
      }),
      writeApproval: "auto",
      columns: expect.arrayContaining([
        expect.objectContaining({ id: "todo", owner: "agent" }),
      ]),
    })
  )
})

it("searches grouped agents inside the modal and restores focus without dismissing it", async () => {
  window.cowork.agents.list = vi.fn().mockResolvedValue([
    {
      name: "reviewer",
      ref: "github:reviewer",
      label: "Reviewer",
      sourceKind: "github",
      description: "Reviews changes",
    },
    {
      name: "planner",
      ref: "claude:planner",
      label: "Planner",
      sourceKind: "claude",
    },
  ])
  const onClose = vi.fn()
  await act(async () =>
    root.render(
      <KanbanSettingsSheet graph={graph} onClose={onClose} onSaved={vi.fn()} />
    )
  )
  await openPicker("kb-column-agent")
  const popup = document.querySelector('[data-slot="combobox-content"]')!
  expect(popup.closest('[role="dialog"]')).not.toBeNull()
  expect(popup.textContent).toContain("GitHub")
  expect(popup.textContent).toContain("Claude")
  const search = document.querySelector<HTMLInputElement>(
    '[aria-label="Search agents"]'
  )!
  const type = async (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!.call(search, value)
      search.dispatchEvent(new Event("input", { bubbles: true }))
    })
  await type("no-such-agent")
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(0)
  expect(popup.textContent).toContain("No agents found.")
  await type("Reviewer")
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(1)
  await act(async () => {
    search.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
    )
  })
  await act(async () => {
    search.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    )
  })
  expect(document.querySelector("#kb-column-agent")?.textContent).toContain(
    "Reviewer"
  )
  expect(document.activeElement?.id).toBe("kb-column-agent")
  expect(onClose).not.toHaveBeenCalled()
  await click("Save changes")
  expect(saveSettings).toHaveBeenCalledWith(
    "board",
    expect.objectContaining({
      columns: expect.arrayContaining([
        expect.objectContaining({ agentName: "github:reviewer" }),
      ]),
    })
  )
})

it("preserves unavailable agent and model selections until explicitly reset", async () => {
  const saved = {
    ...graph,
    columns: graph.columns.map((c) => ({
      ...c,
      agentName: "missing-agent",
      accountId: "missing-account",
      modelId: "missing-model",
    })),
  }
  await act(async () =>
    root.render(
      <KanbanSettingsSheet graph={saved} onClose={vi.fn()} onSaved={vi.fn()} />
    )
  )
  expect(document.querySelector("#kb-column-agent")?.textContent).toContain(
    "missing-agent (unavailable)"
  )
  expect(document.querySelector("#kb-column-model")?.textContent).toContain(
    "missing-model (unavailable)"
  )
  expect(
    document.querySelector("#kb-column-model")?.getAttribute("aria-describedby")
  ).toBe("kb-column-model-error")
  await click("Save changes")
  expect(saveSettings).toHaveBeenLastCalledWith(
    "board",
    expect.objectContaining({
      columns: expect.arrayContaining([
        expect.objectContaining({
          agentName: "missing-agent",
          accountId: "missing-account",
          modelId: "missing-model",
        }),
      ]),
    })
  )
  await choose("kb-column-model", "Use application default")
  await choose("kb-column-agent", "North Star (default)")
  await click("Save changes")
  expect(saveSettings).toHaveBeenLastCalledWith(
    "board",
    expect.objectContaining({
      columns: expect.arrayContaining([
        expect.objectContaining({
          id: "todo",
          agentName: null,
          accountId: null,
          modelId: null,
        }),
      ]),
    })
  )
})

it("limits goto search to other columns and keeps target identity across reorder and rename", async () => {
  const saved = {
    ...graph,
    columns: graph.columns.map((c) =>
      c.id === "todo"
        ? {
            ...c,
            outcomes: [
              {
                name: "failed",
                next: "goto" as const,
                target: "doing",
                maxReturns: 2,
              },
            ],
          }
        : c
    ),
  }
  await act(async () =>
    root.render(
      <KanbanSettingsSheet graph={saved} onClose={vi.fn()} onSaved={vi.fn()} />
    )
  )
  await openPicker("kb-outcome-target-0")
  expect(
    [...document.querySelectorAll('[role="option"]')].map(
      (item) => item.textContent
    )
  ).toEqual(["In progress"])
  await act(async () =>
    (document.querySelector('[role="option"]') as HTMLElement).click()
  )
  await drop("doing", "todo")
  await click("Save changes")
  expect(saveSettings).toHaveBeenCalledWith(
    "board",
    expect.objectContaining({
      columns: [
        expect.objectContaining({ id: "doing" }),
        expect.objectContaining({
          id: "todo",
          outcomes: [expect.objectContaining({ target: "doing" })],
        }),
      ],
    })
  )
})

it("searches models by label and Escape returns focus without closing settings", async () => {
  const onClose = vi.fn()
  await act(async () =>
    root.render(
      <KanbanSettingsSheet graph={graph} onClose={onClose} onSaved={vi.fn()} />
    )
  )
  await openPicker("kb-column-model")
  const search = document.querySelector<HTMLInputElement>(
    '[aria-label="Search models"]'
  )!
  expect(
    document.querySelector('[data-slot="combobox-content"]')?.textContent
  ).toContain("Test account")
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!.call(search, "Model One")
    search.dispatchEvent(new Event("input", { bubbles: true }))
  })
  expect(
    [...document.querySelectorAll('[role="option"]')].map(
      (item) => item.textContent
    )
  ).toEqual(["Model One"])
  await act(async () =>
    search.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      })
    )
  )
  expect(onClose).not.toHaveBeenCalled()
  expect(document.activeElement?.id).toBe("kb-column-model")
  expect(document.querySelector("#kb-column-model")?.textContent).toContain(
    "Use application default"
  )
})

it("displays a discoverable legacy agent name without rewriting it on save", async () => {
  window.cowork.agents.list = vi.fn().mockResolvedValue([
    {
      name: "custom-agent",
      ref: "github:custom-agent",
      label: "Custom Agent",
      sourceKind: "github",
    },
  ])
  await act(async () =>
    root.render(
      <KanbanSettingsSheet graph={graph} onClose={vi.fn()} onSaved={vi.fn()} />
    )
  )
  await click("In progress")
  expect(document.querySelector("#kb-column-agent")?.textContent).toBe(
    "Custom Agent"
  )
  await click("Save changes")
  expect(saveSettings).toHaveBeenCalledWith(
    "board",
    expect.objectContaining({
      columns: expect.arrayContaining([
        expect.objectContaining({ id: "doing", agentName: "custom-agent" }),
      ]),
    })
  )
})

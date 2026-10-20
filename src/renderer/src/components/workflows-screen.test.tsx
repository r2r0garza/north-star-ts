// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { WorkflowsScreen } from "./workflows-screen"
import { EXAMPLE_WORKFLOWS } from "../../../main/db/workflow-schema"
import { toast } from "sonner"

vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }))

const drag = vi.hoisted(() => ({
  end: undefined as
    | undefined
    | ((event: {
        active: { id: string }
        over: { id: string } | null
      }) => void),
}))

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@dnd-kit/core")>()
  return {
    ...original,
    DndContext: (
      props: import("react").ComponentProps<typeof original.DndContext>
    ) => {
      drag.end = props.onDragEnd as typeof drag.end
      return <original.DndContext {...props} />
    },
  }
})

let container: HTMLDivElement
let root: Root

function fixtureRuns(): import("../../../shared/workflow-runs").WorkflowRun[] {
  return [
    ["completed", 0, "Completed", "2026-10-17T14:30:00Z"],
    ["active", 0, "Active", "2026-10-18T12:30:00Z"],
    ["cancelled", 1, "Cancelled", "2026-10-17T16:45:00Z"],
    ["paused", 2, "Paused", "2026-10-17T18:15:00Z"],
  ].map(([id, index, status, date]) => {
    const workflow = structuredClone(EXAMPLE_WORKFLOWS[index as number])
    return {
      id: String(id),
      taskId: String(id),
      workflowId: workflow.id,
      workflow,
      title: workflow.name,
      objective: "Check this project",
      workspaceId: "workspace-1",
      workspacePath: "/projects/north-star",
      projectId: null,
      projectName: null,
      accountId: "account",
      modelId: "model",
      status,
      createdAt: Date.parse(date as string),
      updatedAt: Date.parse(date as string),
      error: null,
      steps: workflow.steps.map((step) => ({
        ...step,
        accountId: step.id === "review-changes" ? "openai" : undefined,
        modelId: step.id === "review-changes" ? "gpt-test" : undefined,
        agentName: step.id === "review-changes" ? "north-star" : undefined,
        status:
          status === "Completed"
            ? "completed"
            : status === "Cancelled"
              ? "cancelled"
              : status === "Paused"
                ? "paused"
                : "active",
        conversationId: null,
        result: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      })),
    } as import("../../../shared/workflow-runs").WorkflowRun
  })
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  let stored = structuredClone(EXAMPLE_WORKFLOWS)
  vi.mocked(toast.error).mockClear()
  window.cowork = {
    system: vi.fn(() => ({ mainAgentName: "North Star" })),
    agents: {
      list: vi.fn(async () => [
        { name: "north-star", refId: "north-star", label: "North Star" },
        {
          name: "code-reviewer",
          refId: "code-reviewer",
          label: "Code Reviewer",
        },
      ]),
    },
    providers: {
      listWithModels: vi.fn(async () => [
        {
          account: { id: "openai", displayName: "OpenAI" },
          models: [{ modelId: "gpt-test", modelName: "GPT Test" }],
        },
        {
          account: { id: "anthropic", displayName: "Anthropic" },
          models: [{ modelId: "claude-test", modelName: "Claude Test" }],
        },
      ]),
    },
    tasks: { onEvent: vi.fn(() => () => {}) },
    workflowRuns: {
      list: vi.fn(async () => fixtureRuns()),
      start: vi.fn(async () => ({ ...fixtureRuns()[1], id: "new-run" })),
      pause: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
      retry: vi.fn(),
    },
    db: {
      workflows: {
        flush: vi.fn((updated: (typeof EXAMPLE_WORKFLOWS)[number]) => {
          stored = stored.map((workflow) =>
            workflow.id === updated.id ? structuredClone(updated) : workflow
          )
          return { ok: true }
        }),
        delete: vi.fn(async (id: string) => {
          stored = stored.filter((workflow) => workflow.id !== id)
        }),
        create: vi.fn(async () => {
          const workflow = {
            id: crypto.randomUUID(),
            name: "New workflow",
            description: "",
            defaultObjective: "",
            steps: [],
          }
          stored.push(workflow)
          return structuredClone(workflow)
        }),
        list: vi.fn(async () => structuredClone(stored)),
        update: vi.fn(async (updated: (typeof EXAMPLE_WORKFLOWS)[number]) => {
          stored = stored.map((workflow) =>
            workflow.id === updated.id ? structuredClone(updated) : workflow
          )
        }),
      },
      workspaces: {
        list: vi.fn().mockResolvedValue([
          {
            id: "workspace-1",
            name: "North Star",
            path: "/projects/north-star",
          },
          { id: "workspace-2", name: "Other", path: "/projects/other" },
        ]),
        upsert: vi.fn().mockResolvedValue({
          id: "workspace-1",
          name: "North Star",
          path: "/projects/north-star",
        }),
      },
      projects: {
        list: vi.fn().mockResolvedValue([
          { id: "project-1", name: "North Star", workspaceId: "workspace-1" },
          { id: "project-2", name: "Website", workspaceId: null },
        ]),
      },
    },
  } as unknown as typeof window.cowork
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it("defaults to Runs and switches between all, unassigned, and project scopes", async () => {
  const onClose = vi.fn()
  await act(async () => root.render(<WorkflowsScreen onClose={onClose} />))
  const tabs = Array.from(container.querySelectorAll('[role="tab"]'))
  expect(tabs.map((tab) => tab.textContent)).toEqual(["Runs", "Workflows"])
  expect(tabs[0].getAttribute("aria-selected")).toBe("true")
  expect(container.querySelector("h2")?.textContent).toBe("All runs")
  const filters = Array.from(container.querySelectorAll("nav button"))
  expect(filters.map((button) => button.textContent)).toEqual([
    "All",
    "None",
    "North Star",
    "Website",
  ])
  await act(async () => (filters[1] as HTMLButtonElement).click())
  expect(container.textContent).toContain(
    "Runs that aren't assigned to a project."
  )
  expect(filters[1].getAttribute("aria-pressed")).toBe("true")
  await act(async () => (filters[2] as HTMLButtonElement).click())
  expect(container.querySelector("h2")?.textContent).toBe("North Star · Runs")
  await act(async () => (filters[0] as HTMLButtonElement).click())
  expect(container.querySelector("h2")?.textContent).toBe("All runs")
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[aria-label="Close workflows"]')!
      .click()
  })
  expect(onClose).toHaveBeenCalledOnce()
})

it("shows clearly labeled workflow preview cards without execution controls enabled", async () => {
  await act(async () => root.render(<WorkflowsScreen onClose={() => {}} />))
  const tab = container.querySelector<HTMLElement>(
    '[role="tab"][id$="workflows"]'
  )!
  await act(async () => {
    tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
  })
  expect(container.querySelector("nav")).toBeNull()
  expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(3)
  expect(container.textContent).toContain(
    "Inspect and edit your saved workflows"
  )
  const runButtons = Array.from(container.querySelectorAll("button")).filter(
    (button) => button.textContent?.includes("Run workflow")
  )
  expect(runButtons).toHaveLength(3)
  expect(runButtons.every((button) => button.disabled)).toBe(true)
})

async function openCodeReview() {
  await act(async () => root.render(<WorkflowsScreen onClose={() => {}} />))
  await act(async () => {
    container
      .querySelector<HTMLElement>('[role="tab"][id$="workflows"]')!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
  })
  await act(async () => button("Code review").click())
}

function button(text: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent?.trim() === text
  )!
}

function stepTitles() {
  return Array.from(
    container.querySelectorAll("li [data-slot='collapsible-trigger']")
  ).map((element) => element.textContent)
}

it("opens workflow details, appends collapsed steps, and keeps edits when reopening with all steps collapsed", async () => {
  await openCodeReview()
  expect(
    container.querySelector<HTMLInputElement>("#workflow-title")?.value
  ).toBe("Code review")
  expect(
    container.querySelector<HTMLTextAreaElement>("#workflow-description")?.value
  ).toBe("Review changes, identify risks, and summarize findings.")
  expect(container.querySelectorAll('[aria-expanded="false"]')).toHaveLength(3)
  expect(container.querySelector("li input")).toBeNull()
  await act(async () => button("Add Step").click())
  expect(stepTitles()).toEqual([
    "1.Review changes",
    "2.Identify risks",
    "3.Summarize findings",
    "4.New step",
  ])
  expect(container.querySelectorAll('[aria-expanded="false"]')).toHaveLength(4)
  await act(async () => button("4.New step").click())
  const title = container.querySelector<HTMLInputElement>("li input")!
  const instructions =
    container.querySelector<HTMLTextAreaElement>("li textarea")!
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!.call(title, "Check tests")
    title.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )!.set!.call(instructions, "Run the relevant tests.")
    instructions.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Back to workflows"]')!
      .click()
  )
  expect(
    container.querySelector('[role="tab"][aria-selected="true"]')?.textContent
  ).toBe("Workflows")
  await act(async () => button("Code review").click())
  expect(container.querySelectorAll('[aria-expanded="false"]')).toHaveLength(4)
  expect(container.querySelector("li input")).toBeNull()
  await act(async () => button("4.Check tests").click())
  expect(container.querySelector<HTMLInputElement>("li input")?.value).toBe(
    "Check tests"
  )
  expect(
    container.querySelector<HTMLTextAreaElement>("li textarea")?.value
  ).toBe("Run the relevant tests.")
})

it("reorders steps after a drop and ignores cancelled or unchanged drops", async () => {
  await openCodeReview()
  await act(async () =>
    drag.end!({
      active: { id: "review-changes" },
      over: { id: "summarize-findings" },
    })
  )
  expect(stepTitles()).toEqual([
    "1.Identify risks",
    "2.Summarize findings",
    "3.Review changes",
  ])
  await act(async () =>
    drag.end!({ active: { id: "review-changes" }, over: null })
  )
  await act(async () =>
    drag.end!({
      active: { id: "review-changes" },
      over: { id: "review-changes" },
    })
  )
  expect(stepTitles()).toEqual([
    "1.Identify risks",
    "2.Summarize findings",
    "3.Review changes",
  ])
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Back to workflows"]')!
      .click()
  )
  await act(async () => button("Project health check").click())
  expect(stepTitles()).toEqual(["1.Check quality", "2.Report project health"])
})

it.each([
  {
    direction: "down",
    active: "review-changes",
    over: "summarize-findings",
    expected: ["identify-risks", "summarize-findings", "review-changes"],
  },
  {
    direction: "up",
    active: "summarize-findings",
    over: "review-changes",
    expected: ["summarize-findings", "review-changes", "identify-risks"],
  },
])(
  "immediately saves steps moved $direction and reloads the saved order",
  async ({ active, over, expected }) => {
    await openCodeReview()
    const update = vi.mocked(window.cowork.db.workflows.update)
    expect(update).not.toHaveBeenCalled()
    await act(async () =>
      drag.end!({ active: { id: active }, over: { id: over } })
    )
    expect(update).toHaveBeenCalledOnce()
    expect(update.mock.calls[0][0].steps.map((step) => step.id)).toEqual(
      expected
    )
    expect(window.cowork.db.workflows.flush).not.toHaveBeenCalled()
    await act(async () => root.render(null))
    await openCodeReview()
    expect(
      Array.from(
        container.querySelectorAll('button[aria-label^="Reorder step"]')
      ).map((handle) => handle.getAttribute("aria-label"))
    ).toEqual(
      expected.map((id, index) => {
        const step = EXAMPLE_WORKFLOWS.find(
          (workflow) => workflow.id === "code-review"
        )!.steps.find((step) => step.id === id)!
        return `Reorder step ${index + 1}: ${step.title}`
      })
    )
  }
)

it("updates workflow title and description in the header and collection", async () => {
  await openCodeReview()
  const title = container.querySelector<HTMLInputElement>("#workflow-title")!
  const description = container.querySelector<HTMLTextAreaElement>(
    "#workflow-description"
  )!
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!.call(title, "Review my project")
    title.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )!.set!.call(description, "A custom review workflow.")
    description.dispatchEvent(new Event("input", { bubbles: true }))
  })
  expect(container.querySelector("h1")?.textContent).toBe("Review my project")
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Back to workflows"]')!
      .click()
  )
  expect(button("Review my project")).toBeDefined()
  expect(container.textContent).toContain("A custom review workflow.")
  await act(async () => button("Review my project").click())
  expect(
    container.querySelector<HTMLInputElement>("#workflow-title")?.value
  ).toBe("Review my project")
  expect(
    container.querySelector<HTMLTextAreaElement>("#workflow-description")?.value
  ).toBe("A custom review workflow.")
})

it("deletes collapsed and expanded steps, renumbers the list, and allows adding after deleting all steps", async () => {
  await openCodeReview()
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Delete step 2: Identify risks"]'
      )!
      .click()
  )
  expect(stepTitles()).toEqual(["1.Review changes", "2.Summarize findings"])
  await act(async () => button("1.Review changes").click())
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Delete step 1: Review changes"]'
      )!
      .click()
  )
  expect(stepTitles()).toEqual(["1.Summarize findings"])
  expect(container.querySelector("li input")).toBeNull()
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Back to workflows"]')!
      .click()
  )
  await act(async () => button("Code review").click())
  expect(stepTitles()).toEqual(["1.Summarize findings"])
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Delete step 1: Summarize findings"]'
      )!
      .click()
  )
  expect(stepTitles()).toEqual([])
  await act(async () => button("Add Step").click())
  expect(stepTitles()).toEqual(["1.New step"])
  expect(container.querySelectorAll('[aria-expanded="false"]')).toHaveLength(1)
})

it("loads saved changes after remounting the Workflows screen", async () => {
  await openCodeReview()
  await act(async () => button("Add Step").click())
  expect(window.cowork.db.workflows.update).toHaveBeenCalledOnce()
  await act(async () => root.render(null))
  await openCodeReview()
  expect(stepTitles()).toEqual([
    "1.Review changes",
    "2.Identify risks",
    "3.Summarize findings",
    "4.New step",
  ])
})

it("reports a failed save rather than silently losing changes", async () => {
  await openCodeReview()
  vi.mocked(window.cowork.db.workflows.update).mockRejectedValueOnce(
    new Error("disk full")
  )
  await act(async () => button("Add Step").click())
  expect(toast.error).toHaveBeenCalledWith(
    expect.stringContaining("Could not save workflow")
  )
  expect(stepTitles()).toHaveLength(4)
})

it("reports workflow load failures", async () => {
  vi.mocked(window.cowork.db.workflows.list).mockRejectedValueOnce(
    new Error("unavailable")
  )
  await act(async () => root.render(<WorkflowsScreen onClose={() => {}} />))
  expect(toast.error).toHaveBeenCalledWith(
    expect.stringContaining("Could not load workflows")
  )
})

it("places New Run in the header for All and None, and below the empty message for projects", async () => {
  await act(async () => root.render(<WorkflowsScreen onClose={() => {}} />))
  const section = container.querySelector('section[aria-label="Project runs"]')!
  expect(section.querySelector("header button:last-child")?.textContent).toBe(
    "New Run"
  )
  expect(section.textContent).toContain("/projects/north-star")
  expect(section.textContent).not.toContain("No runs yet")
  await act(async () => button("None").click())
  expect(section.querySelector("header button:last-child")?.textContent).toBe(
    "New Run"
  )
  expect(section.querySelectorAll('ul[aria-label="Runs"] li')).toHaveLength(4)
  for (const project of ["North Star", "Website"]) {
    await act(async () => button(project).click())
    expect(section.querySelector("header button")).toBeNull()
    expect(section.textContent).toContain("No runs yet")
    const newRun = button("New Run")
    const message = Array.from(section.querySelectorAll("p")).find((element) =>
      element.textContent?.includes("Choose a workflow to get started")
    )!
    expect(
      message.compareDocumentPosition(newRun) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(section.querySelectorAll("button")).toHaveLength(1)
  }
  await act(async () => button("New Run").click())
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "New Run"
  )
  await act(async () => dialogButton("Cancel").click())
  await act(async () => button("North Star").click())
  await act(async () => button("New Run").click())
  const projectPicker =
    document.querySelector<HTMLButtonElement>("#new-run-project")!
  const workspacePicker =
    document.querySelector<HTMLButtonElement>("#new-run-workspace")!
  expect(projectPicker.textContent).toContain("North Star")
  expect(projectPicker.disabled).toBe(true)
  expect(workspacePicker.textContent).toContain("/projects/north-star")
  expect(workspacePicker.disabled).toBe(true)
  expect(dialogButton("Choose folder")).toBeUndefined()
  expect(dialogButton("Clear fields").disabled).toBe(true)
  await act(async () => dialogButton("Cancel").click())
  await act(async () => button("All").click())
  expect(section.querySelector("header button:last-child")?.textContent).toBe(
    "New Run"
  )
})

it("shows run dates below status badges and sorts newest first in All and None", async () => {
  await act(async () => root.render(<WorkflowsScreen onClose={() => {}} />))
  for (const scope of ["All", "None"]) {
    await act(async () => button(scope).click())
    const cards = Array.from(
      container.querySelectorAll('ul[aria-label="Runs"] li')
    )
    expect(
      cards.map(
        (card) => card.querySelector('[data-slot="badge"]')?.textContent
      )
    ).toEqual(["Active", "Paused", "Cancelled", "Completed"])
    const dates = cards.map((card) => {
      const time = card.querySelector("time")!
      expect(time.textContent).toBe(
        new Date(time.dateTime).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      )
      expect(time.previousElementSibling?.getAttribute("data-slot")).toBe(
        "badge"
      )
      return Date.parse(time.dateTime)
    })
    expect(dates).toEqual([...dates].sort((a, b) => b - a))
  }
})

it("toggles run filters and combines date and status without hiding header controls for zero matches", async () => {
  await act(async () => root.render(<WorkflowsScreen onClose={() => {}} />))
  const toggle = container.querySelector<HTMLButtonElement>(
    '[aria-label="Filter runs"]'
  )!
  expect(toggle.nextElementSibling?.textContent).toBe("New Run")
  expect(container.querySelector("#run-filters")).toBeNull()
  await act(async () => toggle.click())
  expect(toggle.getAttribute("aria-expanded")).toBe("true")
  const status = container.querySelector<HTMLButtonElement>("#run-status")!
  const badges = () =>
    Array.from(
      container.querySelectorAll('ul[aria-label="Runs"] [data-slot="badge"]')
    ).map((badge) => badge.textContent)
  async function setDate(value: string) {
    await act(async () =>
      container.querySelector<HTMLButtonElement>("#run-date")!.click()
    )
    const [year, month, day] = value.split("-").map(Number)
    let dayButton = document.querySelector<HTMLButtonElement>(
      `[data-day="${new Date(year, month - 1, day).toLocaleDateString()}"]`
    )
    for (let attempts = 0; !dayButton && attempts < 24; attempts++) {
      const previous = document.querySelector<HTMLButtonElement>(
        '[aria-label="Go to the Previous Month"]'
      )!
      await act(async () => previous.click())
      dayButton = document.querySelector<HTMLButtonElement>(
        `[data-day="${new Date(year, month - 1, day).toLocaleDateString()}"]`
      )
    }
    await act(async () => dayButton!.click())
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull()
  }
  async function setStatus(value: string) {
    await act(async () => status.click())
    const option = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]')
    ).find((element) => element.textContent === value)!
    expect(option).toBeDefined()
    await act(async () => option.click())
    expect(status.textContent).toBe(value)
  }
  for (const value of ["Active", "Completed", "Paused", "Cancelled"]) {
    await setStatus(value)
    expect(badges()).toEqual([value])
  }
  const timestamp = new Date(
    container.querySelector<HTMLTimeElement>("time")!.dateTime
  )
  const localDate = `${timestamp.getFullYear()}-${String(timestamp.getMonth() + 1).padStart(2, "0")}-${String(timestamp.getDate()).padStart(2, "0")}`
  await setDate(localDate)
  expect(badges()).toEqual(["Cancelled"])
  await setDate(
    `${timestamp.getFullYear()}-${String(timestamp.getMonth() + 1).padStart(2, "0")}-01`
  )
  expect(badges()).toEqual([])
  expect(container.textContent).toContain("No matching runs")
  expect(container.querySelector('[aria-label="Filter runs"]')).not.toBeNull()
  expect(button("New Run").closest("header")).not.toBeNull()
  await act(async () => toggle.click())
  expect(container.querySelector("#run-filters")).toBeNull()
  expect(container.textContent).toContain("No matching runs")
  await act(async () => toggle.click())
  await act(async () => button("Clear filters").click())
  expect(badges()).toEqual(["Active", "Paused", "Cancelled", "Completed"])
  expect(container.querySelector("#run-date")?.textContent).toContain(
    "Pick a date"
  )
  await setDate(localDate)
  expect(badges()).toContain("Cancelled")
  await act(async () => button("North Star").click())
  expect(container.querySelector('[aria-label="Filter runs"]')).toBeNull()
  expect(container.querySelector("#run-filters")).toBeNull()
  expect(container.textContent).toContain("No runs yet")
})

it("creates a saved workflow, opens its editor, and reloads its edits", async () => {
  await openCodeReview()
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Back to workflows"]')!
      .click()
  )
  const create = button("New Workflow")
  expect(create.parentElement?.querySelector("h2")?.textContent).toBe(
    "Workflow collection"
  )
  await act(async () => create.click())
  expect(window.cowork.db.workflows.create).toHaveBeenCalledOnce()
  expect(
    container.querySelector<HTMLInputElement>("#workflow-title")?.value
  ).toBe("New workflow")
  expect(
    container.querySelector<HTMLTextAreaElement>("#workflow-description")?.value
  ).toBe("")
  expect(stepTitles()).toEqual([])
  const title = container.querySelector<HTMLInputElement>("#workflow-title")!
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!.call(title, "My workflow")
    title.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => button("Add Step").click())
  await act(async () => root.render(null))
  await openCodeReview()
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Back to workflows"]')!
      .click()
  )
  await act(async () => button("My workflow").click())
  expect(stepTitles()).toEqual(["1.New step"])
})

it("keeps the collection open and reports workflow creation failures", async () => {
  await openCodeReview()
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Back to workflows"]')!
      .click()
  )
  vi.mocked(window.cowork.db.workflows.create).mockRejectedValueOnce(
    new Error("disk full")
  )
  await act(async () => button("New Workflow").click())
  expect(container.querySelector('[data-slot="workflow-detail"]')).toBeNull()
  expect(button("New Workflow").disabled).toBe(false)
  expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(3)
  expect(toast.error).toHaveBeenCalledWith(
    expect.stringContaining("Could not create workflow")
  )
})

async function openWorkflowCollection() {
  await openCodeReview()
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Back to workflows"]')!
      .click()
  )
}

function dialogButton(label: string) {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')
  ).find((element) => element.textContent === label)!
}

it("asks before deleting, supports Cancel and outside dismissal, and only deletes on Confirm", async () => {
  await openWorkflowCollection()
  const trash = () =>
    container.querySelector<HTMLButtonElement>(
      '[aria-label="Delete workflow: Code review"]'
    )!
  await act(async () => trash().click())
  expect(container.querySelector('[data-slot="workflow-detail"]')).toBeNull()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "Are you sure you want to delete “Code review”? This action cannot be undone."
  )
  expect(window.cowork.db.workflows.delete).not.toHaveBeenCalled()
  await act(async () => dialogButton("Cancel").click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => trash().click())
  await act(async () =>
    document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')!.click()
  )
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(window.cowork.db.workflows.delete).not.toHaveBeenCalled()
  await act(async () => trash().click())
  await act(async () => dialogButton("Confirm").click())
  expect(window.cowork.db.workflows.delete).toHaveBeenCalledWith("code-review")
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(2)
  expect(trash()).toBeNull()
  await act(async () => root.render(null))
  await act(async () => root.render(<WorkflowsScreen onClose={() => {}} />))
  await act(async () =>
    container
      .querySelector<HTMLElement>('[role="tab"][id$="workflows"]')!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
  )
  expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(2)
})

it("keeps the card and shows an error if deletion fails", async () => {
  await openWorkflowCollection()
  vi.mocked(window.cowork.db.workflows.delete).mockRejectedValueOnce(
    new Error("disk error")
  )
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Delete workflow: Code review"]'
      )!
      .click()
  )
  await act(async () => dialogButton("Confirm").click())
  expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(3)
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(dialogButton("Confirm").disabled).toBe(false)
  expect(toast.error).toHaveBeenCalledWith(
    expect.stringContaining("Could not delete workflow")
  )
})

it("sorts workflow cards alphabetically by trimmed title, ignoring capitalization", async () => {
  vi.mocked(window.cowork.db.workflows.list).mockResolvedValueOnce([
    { ...EXAMPLE_WORKFLOWS[0], name: " Zebra" },
    { ...EXAMPLE_WORKFLOWS[1], name: "  apple  " },
    { ...EXAMPLE_WORKFLOWS[2], name: "Banana" },
  ])
  await act(async () => root.render(<WorkflowsScreen onClose={() => {}} />))
  await act(async () =>
    container
      .querySelector<HTMLElement>('[role="tab"][id$="workflows"]')!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
  )
  expect(
    Array.from(container.querySelectorAll('[data-slot="card-title"]')).map(
      (element) => element.textContent?.trim()
    )
  ).toEqual(["apple", "Banana", "Zebra"])
})

async function editText(selector: string, value: string) {
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    selector
  )!
  await act(async () => {
    const prototype =
      field.tagName === "INPUT"
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value)
    field.dispatchEvent(new Event("input", { bubbles: true }))
  })
  return field
}

it("saves text on blur, not keystrokes, and saves structural changes immediately", async () => {
  await openCodeReview()
  const update = vi.mocked(window.cowork.db.workflows.update)
  for (const [selector, value] of [
    ["#workflow-title", "Review"],
    ["#workflow-description", "Description"],
    ["#workflow-default-objective", "Default objective"],
  ]) {
    const before = update.mock.calls.length
    const field = await editText(selector, value)
    expect(update).toHaveBeenCalledTimes(before)
    await act(async () =>
      field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
    )
    expect(update).toHaveBeenCalledTimes(before + 1)
    await act(async () =>
      field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
    )
    expect(update).toHaveBeenCalledTimes(before + 1)
  }
  await act(async () => button("1.Review changes").click())
  for (const [selector, value] of [
    ["li input", "New step title"],
    ["li textarea", "New step instructions"],
  ]) {
    const before = update.mock.calls.length
    const field = await editText(selector, value)
    expect(update).toHaveBeenCalledTimes(before)
    await act(async () =>
      field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
    )
    expect(update).toHaveBeenCalledTimes(before + 1)
  }
  let before = update.mock.calls.length
  await act(async () => button("Add Step").click())
  expect(update).toHaveBeenCalledTimes(before + 1)
  before = update.mock.calls.length
  await act(async () =>
    drag.end!({
      active: { id: "review-changes" },
      over: { id: "summarize-findings" },
    })
  )
  expect(update).toHaveBeenCalledTimes(before + 1)
  before = update.mock.calls.length
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Delete step 3: New step title"]'
      )!
      .click()
  )
  expect(update).toHaveBeenCalledTimes(before + 1)
})

it("shows Default Objective below Description and reloads its saved text", async () => {
  await openCodeReview()
  expect(
    container.querySelector('label[for="workflow-title"]')?.textContent
  ).toBe("Workflow Title")
  const description = container.querySelector<HTMLTextAreaElement>(
    "#workflow-description"
  )!
  const objective = container.querySelector<HTMLTextAreaElement>(
    "#workflow-default-objective"
  )!
  expect(description.parentElement!.nextElementSibling).toBe(
    objective.parentElement
  )
  expect(objective.className).toBe(description.className)
  expect(objective.value).toBe("")
  const sidebarSwitch = container.querySelector<HTMLButtonElement>(
    "#workflow-view-in-sidebar"
  )!
  expect(sidebarSwitch.disabled).toBe(true)
  expect(sidebarSwitch.getAttribute("data-state")).toBe("unchecked")
  await editText("#workflow-default-objective", "Find actionable improvements.")
  expect(window.cowork.db.workflows.update).not.toHaveBeenCalled()
  await act(async () =>
    objective.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
  )
  expect(window.cowork.db.workflows.update).toHaveBeenCalledWith(
    expect.objectContaining({
      defaultObjective: "Find actionable improvements.",
    })
  )
  const enabledSidebarSwitch = container.querySelector<HTMLButtonElement>(
    "#workflow-view-in-sidebar"
  )!
  expect(enabledSidebarSwitch.disabled).toBe(false)
  expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull()
  await act(async () => enabledSidebarSwitch.click())
  expect(window.cowork.db.workflows.update).toHaveBeenCalledWith(
    expect.objectContaining({ viewInConversationSidebar: true })
  )
  await act(async () => root.render(null))
  await openCodeReview()
  expect(
    container.querySelector<HTMLTextAreaElement>("#workflow-default-objective")
      ?.value
  ).toBe("Find actionable improvements.")
  expect(
    container
      .querySelector<HTMLButtonElement>("#workflow-view-in-sidebar")
      ?.getAttribute("data-state")
  ).toBe("checked")
})

it("flushes pending text edits on app exit without needing blur", async () => {
  await openCodeReview()
  await editText("#workflow-title", "Saved on quit")
  expect(window.cowork.db.workflows.update).not.toHaveBeenCalled()
  await act(async () =>
    window.dispatchEvent(new Event("beforeunload", { cancelable: true }))
  )
  expect(window.cowork.db.workflows.flush).toHaveBeenCalledWith(
    expect.objectContaining({ name: "Saved on quit" })
  )
})

it("flushes pending text when leaving the editor and avoids writing an unchanged workflow", async () => {
  await openCodeReview()
  await editText("#workflow-description", "Save when leaving")
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Back to workflows"]')!
      .click()
  )
  expect(window.cowork.db.workflows.flush).toHaveBeenCalledOnce()
  expect(window.cowork.db.workflows.flush).toHaveBeenCalledWith(
    expect.objectContaining({ description: "Save when leaving" })
  )
  vi.mocked(window.cowork.db.workflows.flush).mockClear()
  await act(async () => button("Code review").click())
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Back to workflows"]')!
      .click()
  )
  expect(window.cowork.db.workflows.flush).not.toHaveBeenCalled()
})

it("opens persisted run activity and invokes lifecycle controls", async () => {
  await act(async () => root.render(<WorkflowsScreen onClose={() => {}} />))
  const card = container.querySelector<HTMLButtonElement>(
    'ul[aria-label="Runs"] button'
  )!
  await act(async () => card.click())
  expect(container.textContent).toContain("Auto mode")
  expect(container.textContent).not.toContain("Simulated preview")
  expect(container.textContent).toContain("Review changes")
  expect(container.textContent).toContain("OpenAI · GPT Test")
  await act(async () => button("Pause").click())
  expect(window.cowork.workflowRuns.pause).toHaveBeenCalledWith("active")
  await act(async () => button("Cancel").click())
  expect(window.cowork.workflowRuns.cancel).toHaveBeenCalledWith("active")
})

async function selectRunOption(id: string, label: string) {
  await act(async () =>
    document.querySelector<HTMLButtonElement>(`#${id}`)!.click()
  )
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]')
  ).find((item) => item.textContent === label)!
  expect(option).toBeDefined()
  expect(option.closest('[data-slot="dialog-content"]')).toBe(
    document.querySelector('[data-slot="dialog-content"]')
  )
  expect(getComputedStyle(option).pointerEvents).not.toBe("none")
  await act(async () => option.click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
}

async function editRunObjective(value: string) {
  const field =
    document.querySelector<HTMLTextAreaElement>("#new-run-objective")!
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )!.set!.call(field, value)
    field.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

it("requires workspace, workflow, and nonblank objective, and starts a persisted run", async () => {
  await act(async () => root.render(<WorkflowsScreen onClose={() => {}} />))
  await act(async () => button("New Run").click())
  expect(dialogButton("Start").disabled).toBe(true)
  await selectRunOption("new-run-workflow", "Code review")
  await editRunObjective("Review this project")
  expect(dialogButton("Start").disabled).toBe(true)
  await selectRunOption("new-run-project", "North Star")
  expect(document.querySelector("#new-run-workspace")?.textContent).toContain(
    "/projects/north-star"
  )
  expect(dialogButton("Start").disabled).toBe(false)
  await editRunObjective(" \n ")
  expect(dialogButton("Start").disabled).toBe(true)
  await editRunObjective("Review this project")
  await selectRunOption("new-run-workspace", "/projects/other")
  expect(document.querySelector("#new-run-project")?.textContent).toContain(
    "No project"
  )
  await selectRunOption("new-run-workspace", "/projects/north-star")
  expect(document.querySelector("#new-run-project")?.textContent).toContain(
    "North Star"
  )
  await selectRunOption("new-run-project", "Website")
  expect(document.querySelector("#new-run-workspace")?.textContent).toContain(
    "Select a workspace"
  )
  expect(dialogButton("Start").disabled).toBe(true)
  await selectRunOption("new-run-workspace", "/projects/north-star")
  await act(async () => dialogButton("Start").click())
  expect(window.cowork.workflowRuns.start).toHaveBeenCalledWith({
    workspaceId: "workspace-1",
    projectId: "project-1",
    workflowId: "code-review",
    objective: "Review this project",
  })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(container.querySelector('[data-slot="run-detail"]')).not.toBeNull()
})

it("prefills workflow objectives, preserves dismissed drafts, and clears every field on request", async () => {
  const workflows = structuredClone(EXAMPLE_WORKFLOWS)
  workflows[0].defaultObjective = "  Find issues.  "
  workflows[1].defaultObjective = " \n "
  vi.mocked(window.cowork.db.workflows.list).mockResolvedValueOnce(workflows)
  await act(async () => root.render(<WorkflowsScreen onClose={() => {}} />))
  await act(async () => button("New Run").click())
  await selectRunOption("new-run-workflow", "Code review")
  expect(
    document.querySelector<HTMLTextAreaElement>("#new-run-objective")?.value
  ).toBe("  Find issues.  ")
  await editRunObjective("My objective")
  await selectRunOption("new-run-project", "North Star")
  await act(async () =>
    document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')!.click()
  )
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => button("New Run").click())
  expect(
    document.querySelector<HTMLTextAreaElement>("#new-run-objective")?.value
  ).toBe("My objective")
  expect(dialogButton("Start").disabled).toBe(false)
  await act(async () => dialogButton("Cancel").click())
  await act(async () => button("New Run").click())
  expect(
    document.querySelector<HTMLTextAreaElement>("#new-run-objective")?.value
  ).toBe("My objective")
  await selectRunOption("new-run-workflow", "Project health check")
  expect(
    document.querySelector<HTMLTextAreaElement>("#new-run-objective")?.value
  ).toBe("")
  await selectRunOption("new-run-workflow", "Code review")
  await act(async () => dialogButton("Clear fields").click())
  expect(document.querySelector("#new-run-project")?.textContent).toContain(
    "No project"
  )
  expect(document.querySelector("#new-run-workspace")?.textContent).toContain(
    "Select a workspace"
  )
  expect(document.querySelector("#new-run-workflow")?.textContent).toContain(
    "Select a workflow"
  )
  expect(
    document.querySelector<HTMLTextAreaElement>("#new-run-objective")?.value
  ).toBe("")
  expect(dialogButton("Start").disabled).toBe(true)
})

it("matches a hand-picked workspace to its project and leaves it unchanged when picking is cancelled", async () => {
  window.cowork.pickWorkspace = vi
    .fn()
    .mockResolvedValueOnce({ path: "/projects/north-star" })
    .mockResolvedValueOnce({})
  await act(async () => root.render(<WorkflowsScreen onClose={() => {}} />))
  await act(async () => button("New Run").click())
  await act(async () => dialogButton("Choose folder").click())
  expect(window.cowork.db.workspaces.upsert).toHaveBeenCalledWith(
    "/projects/north-star"
  )
  expect(document.querySelector("#new-run-project")?.textContent).toContain(
    "North Star"
  )
  expect(document.querySelector("#new-run-workspace")?.textContent).toContain(
    "/projects/north-star"
  )
  await act(async () => dialogButton("Choose folder").click())
  expect(window.cowork.db.workspaces.upsert).toHaveBeenCalledOnce()
  expect(document.querySelector("#new-run-project")?.textContent).toContain(
    "North Star"
  )
})

it("reports workspace load and folder selection failures without enabling Start", async () => {
  vi.mocked(window.cowork.db.workspaces.list).mockRejectedValueOnce(
    new Error("unavailable")
  )
  window.cowork.pickWorkspace = vi
    .fn()
    .mockRejectedValueOnce(new Error("unavailable"))
  await act(async () => root.render(<WorkflowsScreen onClose={() => {}} />))
  await act(async () => button("New Run").click())
  expect(toast.error).toHaveBeenCalledWith(
    expect.stringContaining("Could not load workspaces")
  )
  await act(async () => dialogButton("Choose folder").click())
  expect(toast.error).toHaveBeenCalledWith(
    expect.stringContaining("Could not select workspace")
  )
  expect(dialogButton("Start").disabled).toBe(true)
  expect(dialogButton("Choose folder").disabled).toBe(false)
})

it.each(["saved workspace", "folder"])(
  "starts a run for a locked project without a default using a %s",
  async (selection) => {
    window.cowork.pickWorkspace = vi
      .fn()
      .mockResolvedValue({ path: "/projects/north-star" })
    await act(async () => root.render(<WorkflowsScreen onClose={() => {}} />))
    const projectFilter = Array.from(
      container.querySelectorAll<HTMLButtonElement>("nav button")
    ).find((item) => item.textContent === "Website")!
    await act(async () => projectFilter.click())
    await act(async () => button("New Run").click())
    const projectPicker =
      document.querySelector<HTMLButtonElement>("#new-run-project")!
    expect(projectPicker.disabled).toBe(true)
    expect(projectPicker.textContent).toContain("Website")
    expect(
      document.querySelector<HTMLButtonElement>("#new-run-workspace")!.disabled
    ).toBe(false)
    expect(dialogButton("Choose folder")).toBeDefined()
    await selectRunOption("new-run-workflow", "Code review")
    await editRunObjective("Review the website")
    expect(dialogButton("Start").disabled).toBe(true)
    if (selection === "folder")
      await act(async () => dialogButton("Choose folder").click())
    else await selectRunOption("new-run-workspace", "/projects/north-star")
    expect(projectPicker.disabled).toBe(true)
    expect(projectPicker.textContent).toContain("Website")
    expect(dialogButton("Start").disabled).toBe(false)
    await act(async () => dialogButton("Start").click())
    expect(window.cowork.workflowRuns.start).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      projectId: "project-2",
      workflowId: "code-review",
      objective: "Review the website",
    })
  }
)

it("opens a single anchored model picker, filters models, and saves the step selection", async () => {
  await openCodeReview()
  await act(async () => button("1.Review changes").click())
  const trigger = container.querySelector<HTMLButtonElement>(
    "#review-changes-model"
  )!
  expect(trigger.className).toContain("flex")
  await act(async () => trigger.click())
  const popup = document.querySelector<HTMLElement>(
    '[data-slot="combobox-content"]'
  )!
  expect(popup).not.toBeNull()
  expect(popup.className).toContain("min-w-72")
  expect(popup.querySelector('[data-slot="combobox-trigger"]')).toBeNull()
  expect(popup.textContent).toContain("OpenAI")
  expect(popup.textContent).toContain("Anthropic")
  const search = popup.querySelector<HTMLInputElement>("input")!
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!.call(search, "Claude")
    search.dispatchEvent(new Event("input", { bubbles: true }))
  })
  expect(popup.textContent).not.toContain("GPT Test")
  const option = Array.from(
    popup.querySelectorAll<HTMLElement>('[role="option"]')
  ).find((item) => item.textContent === "Claude Test")!
  await act(async () => option.click())
  expect(trigger.textContent).toContain("Claude Test")
  expect(window.cowork.db.workflows.update).toHaveBeenCalledWith(
    expect.objectContaining({
      steps: expect.arrayContaining([
        expect.objectContaining({
          id: "review-changes",
          accountId: "anthropic",
          modelId: "claude-test",
        }),
      ]),
    })
  )
})

it("opens the exact requested sidebar run and reports a missing run without substituting another", async () => {
  await act(async () =>
    root.render(
      <WorkflowsScreen
        onClose={() => {}}
        requestedRun={{ id: "completed", requestId: "first" }}
      />
    )
  )
  expect(container.querySelector('[data-slot="run-detail"]')).not.toBeNull()
  await act(async () =>
    root.render(
      <WorkflowsScreen
        onClose={() => {}}
        requestedRun={{ id: "missing", requestId: "second" }}
      />
    )
  )
  expect(container.textContent).toContain("This workflow run is unavailable.")
  expect(container.querySelector('[data-slot="run-detail"]')).toBeNull()
})

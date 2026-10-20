// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, afterEach, expect, it, vi } from "vitest"
import {
  useConversationWorkflows,
  workflowUnavailableReason,
  type ConversationWorkflows,
} from "./use-conversation-workflows"
import type { WorkflowConversationContext } from "../App"
import type { WorkflowRun } from "../../../shared/workflow-runs"
import type { WorkflowDefinition } from "../../../shared/workflows"
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }))
const definition: WorkflowDefinition = {
  id: "workflow",
  name: "Review",
  description: "",
  defaultObjective: "  Review changes  ",
  viewInConversationSidebar: true,
  steps: [{ id: "step", title: "Review", instructions: "Review it" }],
}
const fixture = (status: WorkflowRun["status"] = "Active"): WorkflowRun => ({
  id: "run",
  taskId: "task",
  workflowId: definition.id,
  workflow: definition,
  title: definition.name,
  objective: "Review changes",
  workspaceId: "workspace",
  workspacePath: "/exact/worktree",
  projectId: "project",
  projectName: "Project",
  accountId: "account",
  modelId: "model",
  status,
  steps: [
    {
      ...definition.steps[0],
      status: "completed",
      result: "Final output",
      error: null,
      conversationId: null,
      startedAt: null,
      finishedAt: null,
    },
  ],
  error: null,
  createdAt: 1,
  updatedAt: 1,
})
let root: Root
let container: HTMLDivElement
let controller: ConversationWorkflows
let context: WorkflowConversationContext | null
let visible: boolean
let append: ReturnType<
  typeof vi.fn<(text: string, context: WorkflowConversationContext) => boolean>
>
const listDefinitions = vi.fn()
const listRuns = vi.fn()
const start = vi.fn()
const upsert = vi.fn()
function Harness() {
  controller = useConversationWorkflows({ context, visible, append })
  return null
}
async function render() {
  await act(async () => {
    root.render(<Harness />)
  })
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  context = {
    key: "conversation",
    generation: {},
    workspace: "/exact/worktree",
    projectId: "project",
    ready: true,
  }
  visible = true
  append = vi.fn(() => true)
  listDefinitions
    .mockReset()
    .mockResolvedValue([
      definition,
      { ...definition, id: "hidden", viewInConversationSidebar: false },
      { ...definition, id: "legacy", viewInConversationSidebar: undefined },
    ])
  listRuns.mockReset().mockResolvedValue([fixture()])
  start.mockReset().mockResolvedValue(fixture())
  upsert
    .mockReset()
    .mockResolvedValue({ id: "workspace", path: "/exact/worktree" })
  window.cowork = {
    db: {
      workflows: { list: listDefinitions },
      workspaces: {
        list: vi.fn(async () => [
          { id: "other", path: "/other" },
          { id: "workspace", path: "/exact/worktree" },
        ]),
        upsert,
      },
    },
    workflowRuns: { list: listRuns, start },
  } as unknown as typeof window.cowork
  container = document.createElement("div")
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it("shows only explicitly enabled definitions and refreshes after reopening", async () => {
  await render()
  expect(controller.definitions.map((w) => w.id)).toEqual(["workflow"])
  visible = false
  await render()
  listDefinitions.mockResolvedValue([{ ...definition, id: "new" }])
  visible = true
  await render()
  expect(controller.definitions[0].id).toBe("new")
})
it("launches a normal run with default, exact workspace, and project without inserting output", async () => {
  await render()
  await act(async () => {
    await controller.start("workflow")
  })
  expect(start).toHaveBeenCalledExactlyOnceWith({
    workflowId: "workflow",
    objective: "Review changes",
    workspaceId: "workspace",
    projectId: "project",
  })
  expect(upsert).not.toHaveBeenCalled()
  expect(controller.runs[0].run.status).toBe("Active")
  expect(append).not.toHaveBeenCalled()
})
it("prevents duplicate starts and revalidates settings", async () => {
  await render()
  await act(async () => {
    await Promise.all([
      controller.start("workflow"),
      controller.start("workflow"),
    ])
  })
  expect(start).toHaveBeenCalledTimes(1)
  listDefinitions.mockResolvedValue([
    { ...definition, viewInConversationSidebar: false },
  ])
  await act(async () => {
    await controller.start("workflow")
  })
  expect(start).toHaveBeenCalledTimes(1)
  expect(controller.error).toContain("no longer available")
})
it("rejects unusable objectives, steps, and missing context", async () => {
  expect(
    workflowUnavailableReason({ ...definition, defaultObjective: "  " })
  ).toContain("objective")
  expect(workflowUnavailableReason({ ...definition, steps: [] })).toContain(
    "steps"
  )
  expect(
    workflowUnavailableReason({
      ...definition,
      steps: [{ ...definition.steps[0], instructions: " " }],
    })
  ).toContain("steps")
  context = { ...context!, workspace: "" }
  await render()
  await act(async () => {
    await controller.start("workflow")
  })
  expect(start).not.toHaveBeenCalled()
})
it("does not launch after a context change during workspace resolution", async () => {
  await render()
  let resolve!: (rows: WorkflowDefinition[]) => void
  listDefinitions.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done
    })
  )
  let request!: Promise<void>
  await act(async () => {
    request = controller.start("workflow")
  })
  context = { ...context!, generation: {}, key: "another" }
  await render()
  await act(async () => {
    resolve([definition])
    await request
  })
  expect(start).not.toHaveBeenCalled()
})
it.each([
  "Active",
  "Completed",
  "Paused",
  "Cancelled",
  "Failed",
  "Interrupted",
] as const)("polls authoritative %s status", async (status) => {
  vi.useFakeTimers()
  await render()
  await act(async () => {
    await controller.start("workflow")
  })
  listRuns.mockResolvedValue([fixture(status)])
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(controller.runs[0].run.status).toBe(status)
  visible = false
  await render()
  const count = listRuns.mock.calls.length
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })
  expect(listRuns).toHaveBeenCalledTimes(count)
})
it("marks failed refreshes stale and missing runs unavailable", async () => {
  vi.useFakeTimers()
  await render()
  await act(async () => {
    await controller.start("workflow")
  })
  listRuns.mockRejectedValue(new Error("offline"))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(controller.runs[0].stale).toBe(true)
  listRuns.mockResolvedValue([])
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(controller.runs[0].missing).toBe(true)
})
it("retrieves fresh final output only on explicit Add to Chat", async () => {
  await render()
  await act(async () => {
    await controller.start("workflow")
  })
  listRuns.mockResolvedValue([fixture("Completed")])
  await act(async () => {
    await controller.addToChat("run")
  })
  expect(append).toHaveBeenCalledTimes(1)
  expect(append.mock.calls[0][0]).toContain("DATA: Final output")
  expect(append.mock.calls[0][0]).toContain('"runId":"run"')
  expect(append.mock.calls[0][1]).toBe(context)
})
it("preserves run tracking across draft adoption and independent conversations", async () => {
  await render()
  await act(async () => {
    await controller.start("workflow")
    controller.adopt("conversation", "created")
  })
  context = { ...context!, key: "created", generation: {} }
  await render()
  expect(controller.runs[0].run.id).toBe("run")
  context = { ...context!, key: "unrelated", generation: {} }
  await render()
  expect(controller.runs).toEqual([])
})

it("keeps multiple launches and reports service validation errors", async () => {
  await render()
  start
    .mockResolvedValueOnce(fixture())
    .mockResolvedValueOnce({ ...fixture(), id: "second" })
  await act(async () => {
    await controller.start("workflow")
    await controller.start("workflow")
  })
  expect(controller.runs.map((entry) => entry.run.id)).toEqual([
    "second",
    "run",
  ])
  start.mockRejectedValueOnce(new Error("Workspace is not a directory"))
  await act(async () => {
    await controller.start("workflow")
  })
  expect(controller.error).toBe("Workspace is not a directory")
  expect(controller.pending("workflow")).toBe(false)
})
it("rejects late Add to Chat responses after leaving and returning to a conversation", async () => {
  await render()
  let resolve!: (rows: WorkflowRun[]) => void
  listRuns.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done
    })
  )
  let request!: Promise<void>
  await act(async () => {
    request = controller.addToChat("run")
  })
  context = { ...context!, generation: {}, key: "other" }
  await render()
  context = { ...context!, generation: {}, key: "conversation" }
  await render()
  await act(async () => {
    resolve([fixture("Completed")])
    await request
  })
  expect(append).not.toHaveBeenCalled()
})
it("adopts an in-flight launch when first Send creates the conversation", async () => {
  await render()
  let resolve!: (run: WorkflowRun) => void
  start.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done
    })
  )
  let request!: Promise<void>
  await act(async () => {
    request = controller.start("workflow")
  })
  await act(async () => {
    controller.adopt("conversation", "created")
  })
  context = { ...context!, key: "created", generation: {} }
  await render()
  expect(controller.pending("workflow")).toBe(true)
  await act(async () => {
    await controller.start("workflow")
  })
  expect(start).toHaveBeenCalledTimes(1)
  await act(async () => {
    resolve(fixture())
    await request
  })
  expect(controller.runs.map((entry) => entry.run.id)).toEqual(["run"])
  expect(controller.pending("workflow")).toBe(false)
})

it("clears action errors on launch and Add to Chat recovery", async () => {
  await render()
  start.mockRejectedValueOnce(new Error("Launch failed"))
  await act(async () => {
    await controller.start("workflow")
  })
  expect(controller.error).toBe("Launch failed")
  await act(async () => {
    await controller.start("workflow")
  })
  expect(controller.error).toBeNull()
  listRuns.mockRejectedValueOnce(new Error("Output failed"))
  await act(async () => {
    await controller.addToChat("run")
  })
  expect(controller.error).toBe("Output failed")
  listRuns.mockResolvedValue([fixture("Completed")])
  await act(async () => {
    await controller.addToChat("run")
  })
  expect(controller.error).toBeNull()
  start.mockRejectedValueOnce(new Error("Launch failed again"))
  await act(async () => {
    await controller.start("workflow")
  })
  await act(async () => {
    await controller.addToChat("run")
  })
  expect(controller.error).toBeNull()
})

it("does not carry action errors to another context or back", async () => {
  await render()
  start.mockRejectedValueOnce(new Error("Launch failed"))
  await act(async () => {
    await controller.start("workflow")
  })
  expect(controller.error).toBe("Launch failed")
  context = { ...context!, key: "other", generation: {} }
  await render()
  expect(controller.error).toBeNull()
  context = { ...context!, key: "conversation", generation: {} }
  await render()
  expect(controller.error).toBeNull()
})

it("keeps definition loading errors separate from action errors", async () => {
  await render()
  start.mockRejectedValueOnce(new Error("Launch failed"))
  await act(async () => {
    await controller.start("workflow")
  })
  await act(async () => {
    await controller.refresh()
  })
  expect(controller.error).toBe("Launch failed")
  listDefinitions.mockRejectedValueOnce(new Error("offline"))
  await act(async () => {
    await controller.refresh()
  })
  await act(async () => {
    await controller.start("workflow")
  })
  expect(controller.error).toBe("Could not load workflows. Refresh to retry.")
  await act(async () => {
    await controller.refresh()
  })
  expect(controller.error).toBeNull()
})

it("releases an adopted pending launch on rejection and allows retry", async () => {
  await render()
  let reject!: (cause: Error) => void
  start.mockReturnValueOnce(
    new Promise((_, fail) => {
      reject = fail
    })
  )
  let request!: Promise<void>
  await act(async () => {
    request = controller.start("workflow")
  })
  await act(async () => {
    controller.adopt("conversation", "created")
  })
  context = { ...context!, key: "created", generation: {} }
  await render()
  expect(controller.pending("workflow")).toBe(true)
  await act(async () => {
    reject(new Error("late failure"))
    await request
  })
  expect(controller.pending("workflow")).toBe(false)
  expect(controller.error).toBeNull()
  await act(async () => {
    await controller.start("workflow")
  })
  expect(start).toHaveBeenCalledTimes(2)
})

it("keeps pending launches independent across workflows and conversations", async () => {
  listDefinitions.mockResolvedValue([
    definition,
    { ...definition, id: "second" },
  ])
  await render()
  let resolve!: (run: WorkflowRun) => void
  start.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done
    })
  )
  let request!: Promise<void>
  await act(async () => {
    request = controller.start("workflow")
  })
  expect(controller.pending("second")).toBe(false)
  await act(async () => {
    await controller.start("second")
  })
  context = { ...context!, key: "other", generation: {} }
  await render()
  expect(controller.pending("workflow")).toBe(false)
  await act(async () => {
    await controller.start("workflow")
  })
  expect(start).toHaveBeenCalledTimes(3)
  await act(async () => {
    resolve(fixture())
    await request
  })
})

it("ignores late action failures after navigation", async () => {
  await render()
  let reject!: (cause: Error) => void
  start.mockReturnValueOnce(
    new Promise((_, fail) => {
      reject = fail
    })
  )
  let request!: Promise<void>
  await act(async () => {
    request = controller.start("workflow")
  })
  context = { ...context!, key: "other", generation: {} }
  await render()
  await act(async () => {
    reject(new Error("late failure"))
    await request
  })
  expect(controller.error).toBeNull()
})

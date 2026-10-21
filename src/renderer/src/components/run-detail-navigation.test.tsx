// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { RunDetail } from "./run-detail"
import { EXAMPLE_WORKFLOWS } from "../../../main/db/workflow-schema"
import type { WorkflowRun } from "../../../shared/workflow-runs"

it("preserves historical context, restores positions, follows live steps, and resets for another run", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const workflow = EXAMPLE_WORKFLOWS[0]
  const run: WorkflowRun = {
    id: "navigation",
    taskId: "task",
    workflowId: workflow.id,
    workflow,
    title: "Review workspace",
    objective: "Review the workspace",
    workspaceId: "workspace",
    workspacePath: "/project",
    projectId: null,
    projectName: null,
    accountId: "account",
    modelId: "model",
    status: "Active",
    error: null,
    createdAt: 0,
    updatedAt: 0,
    steps: ["first", "second", "third"].map((id, index) => ({
      ...workflow.steps[0],
      id,
      status: index === 0 ? "active" : "waiting",
      conversationId: id,
      result: "Saved result",
      error: null,
      startedAt: 0,
      finishedAt: null,
    })),
  }
  vi.stubGlobal("cowork", {
    providers: { listWithModels: async () => [] },
    tasks: { onEvent: () => () => {} },
    db: {
      messages: {
        list: vi.fn(async (id: string) => [
          { id, role: "assistant", content: `Output ${id}` },
        ]),
      },
    },
  })
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const render = async (value = run) => {
    await act(async () =>
      root.render(
        <RunDetail run={value} onBack={() => {}} onClose={() => {}} />
      )
    )
  }
  const steps = () =>
    Array.from(container.querySelectorAll<HTMLButtonElement>("nav ol button"))
  const click = async (button: HTMLButtonElement) => {
    await act(async () => button.click())
  }
  const area = () =>
    container.querySelector<HTMLElement>(
      '[aria-label="Transcript scroll area"]'
    )!
  const offsets = new WeakMap<HTMLElement, number>()
  const descriptors = Object.getOwnPropertyDescriptors(HTMLElement.prototype)
  Object.defineProperties(HTMLElement.prototype, {
    scrollHeight: {
      configurable: true,
      get() {
        return this.querySelector('[aria-label="Step transcript"]') ? 2000 : 500
      },
    },
    clientHeight: {
      configurable: true,
      get() {
        return 500
      },
    },
    scrollTop: {
      configurable: true,
      get() {
        return offsets.get(this) ?? 0
      },
      set(value: number) {
        offsets.set(
          this,
          Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))
        )
      },
    },
  })
  try {
    await render()
    expect(steps()[0].getAttribute("aria-current")).toBe("step")
    expect(container.textContent).toContain("Output first")
    expect(container.querySelector("#step-panel")?.textContent).not.toContain(
      workflow.steps[0].instructions
    )
    await click(
      container.querySelector<HTMLButtonElement>("#step-tab-Details")!
    )
    expect(container.querySelector("#step-panel")?.textContent).toContain(
      "Instructions"
    )
    const advanced: WorkflowRun = {
      ...run,
      steps: run.steps.map((step, index) => ({
        ...step,
        status: index === 0 ? "completed" : index === 1 ? "active" : "waiting",
      })),
    }
    await render(advanced)
    expect(steps()[0].getAttribute("aria-current")).toBe("step")
    await click(
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent === "View active step"
      )!
    )
    expect(steps()[1].getAttribute("aria-current")).toBe("step")
    const node = area()
    expect(node.scrollTop).toBe(1500)
    await act(async () => {
      node.scrollTop = 1500
      node.dispatchEvent(new Event("scroll"))
      node.scrollTop = 250
      node.dispatchEvent(new Event("scroll"))
    })
    let finishLoad!: (
      messages: Awaited<ReturnType<typeof window.cowork.db.messages.list>>
    ) => void
    vi.mocked(window.cowork.db.messages.list).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLoad = resolve
        })
    )
    await click(container.querySelector<HTMLButtonElement>("#step-tab-Result")!)
    await click(
      container.querySelector<HTMLButtonElement>("#step-tab-Transcript")!
    )
    expect(area().scrollTop).toBe(0)
    await act(async () => {
      area().dispatchEvent(new Event("scroll"))
    })
    await click(container.querySelector<HTMLButtonElement>("#step-tab-Result")!)
    await act(async () => finishLoad([]))
    await click(
      container.querySelector<HTMLButtonElement>("#step-tab-Transcript")!
    )
    expect(area().scrollTop).toBe(250)
    await click(container.querySelector<HTMLButtonElement>("#step-tab-Result")!)
    await click(
      container.querySelector<HTMLButtonElement>("#step-tab-Transcript")!
    )
    expect(area().scrollTop).toBe(250)
    await click(steps()[0])
    await click(steps()[1])
    expect(area().scrollTop).toBe(250)
    const finalActive: WorkflowRun = {
      ...advanced,
      steps: advanced.steps.map((step, index) => ({
        ...step,
        status: index === 2 ? "active" : "completed",
      })),
    }
    await render(finalActive)
    expect(steps()[1].getAttribute("aria-current")).toBe("step")
    await render({ ...run, id: "fresh" })
    expect(steps()[0].getAttribute("aria-current")).toBe("step")
    await render({ ...advanced, id: "fresh" })
    expect(steps()[1].getAttribute("aria-current")).toBe("step")
    await render({ ...run, id: "finished", status: "Completed" })
    expect(container.querySelector('[aria-label="Run outcome"]')).not.toBeNull()
  } finally {
    act(() => root.unmount())
    container.remove()
    for (const key of ["scrollHeight", "clientHeight", "scrollTop"]) {
      if (descriptors[key])
        Object.defineProperty(HTMLElement.prototype, key, descriptors[key])
      else Reflect.deleteProperty(HTMLElement.prototype, key)
    }
    vi.unstubAllGlobals()
  }
})

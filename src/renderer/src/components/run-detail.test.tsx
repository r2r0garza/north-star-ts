// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import type { Message } from "../../../main/db/types"
import type { WorkflowRun } from "../../../shared/workflow-runs"
import { EXAMPLE_WORKFLOWS } from "../../../main/db/workflow-schema"
import { RunDetail } from "./run-detail"

it("keeps tool responses inside their matching collapsed calls, including after refresh", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.useFakeTimers()
  const workflow = EXAMPLE_WORKFLOWS[0]
  const message = (id: string, fields: Partial<Message>): Message => ({
    id,
    conversationId: "conversation",
    seq: 0,
    role: "assistant",
    content: null,
    toolCalls: null,
    toolCallId: null,
    toolName: null,
    tokenEstimate: null,
    createdAt: 0,
    ...fields,
  })
  let messages = [
    message("assistant", {
      content: "Checking files",
      toolCalls: [
        { id: "first", name: "read_file", arguments: '{"path":"first.ts"}' },
        { id: "second", name: "read_file", arguments: '{"path":"second.ts"}' },
      ],
    }),
    message("second-result", {
      role: "tool",
      toolCallId: "second",
      content: "Second file output",
    }),
    message("orphan", {
      role: "tool",
      toolCallId: "missing",
      content: "Unmatched output",
    }),
    message("unlinked", { role: "tool", content: "Unlinked output" }),
    message("final", { content: "Finished checking" }),
  ]
  const run: WorkflowRun = {
    id: "run",
    taskId: "task",
    workflowId: workflow.id,
    workflow,
    title: "Test run",
    objective: "Check files",
    workspaceId: "workspace",
    workspacePath: "/project",
    projectId: null,
    projectName: null,
    accountId: "account",
    modelId: "model",
    status: "Completed",
    error: null,
    createdAt: 0,
    updatedAt: 0,
    steps: [
      {
        ...workflow.steps[0],
        status: "completed",
        conversationId: "conversation",
        result: null,
        error: null,
        startedAt: 0,
        finishedAt: 0,
      },
    ],
  }
  vi.stubGlobal("cowork", {
    providers: { listWithModels: vi.fn(async () => []) },
    tasks: { onEvent: () => () => {} },
    db: { messages: { list: vi.fn(async () => messages) } },
  })
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        <RunDetail
          run={run}
          workflow={workflow}
          onBack={() => {}}
          onClose={() => {}}
        />
      )
    )
    const transcript = container.querySelector(
      '[aria-label="Step transcript"]'
    )!
    const calls = transcript.querySelectorAll("details")
    expect(calls).toHaveLength(2)
    expect(calls[0].open).toBe(false)
    expect(calls[1].open).toBe(false)
    expect(calls[0].textContent).not.toContain("Second file output")
    expect(calls[1].textContent).toContain("Second file output")
    expect(transcript.querySelectorAll("pre")).toHaveLength(3)
    expect(transcript.children).toHaveLength(4)
    expect(transcript.textContent).toContain("Unmatched output")
    expect(transcript.textContent).toContain("Unlinked output")
    expect(transcript.textContent).toContain("Finished checking")

    await act(async () => {
      calls[0].open = true
    })
    messages = [
      ...messages,
      message("first-result", {
        role: "tool",
        toolCallId: "first",
        content: "First file output",
      }),
    ]
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(calls[0].open).toBe(true)
    expect(calls[0].textContent).toContain("First file output")
    expect(calls[1].textContent).not.toContain("First file output")
    expect(transcript.children).toHaveLength(4)
    await act(async () => {
      calls[0].open = false
    })
    expect(calls[0].open).toBe(false)
    expect(transcript.querySelectorAll("pre")).toHaveLength(4)
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})

it.each<{
  status: WorkflowRun["status"]
  stepStatus: WorkflowRun["steps"][number]["status"]
  result: string | null
  error: string | null
  expected: string
}>([
  {
    status: "Failed",
    stepStatus: "failed",
    result: "Login needed\nNext action: Sign in",
    error: "Login needed",
    expected: "Next action: Sign in",
  },
  {
    status: "Failed",
    stepStatus: "failed",
    result: "Stopped without a next action",
    error: "Stopped",
    expected: "Stopped without a next action",
  },
  {
    status: "Failed",
    stepStatus: "failed",
    result: null,
    error: "Provider unavailable",
    expected: "Provider unavailable",
  },
  {
    status: "Paused",
    stepStatus: "paused",
    result: "Partial work saved",
    error: null,
    expected: "Partial work saved",
  },
  {
    status: "Cancelled",
    stepStatus: "cancelled",
    result: "Cancelled step output",
    error: null,
    expected: "Cancelled step output",
  },
  {
    status: "Completed",
    stepStatus: "completed",
    result: "Earlier step output",
    error: null,
    expected: "Final step output",
  },
])("shows the relevant $status outcome ($expected)", async (testCase) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const workflow = EXAMPLE_WORKFLOWS[0]
  const run: WorkflowRun = {
    id: "run",
    taskId: "task",
    workflowId: workflow.id,
    workflow,
    title: "Test run",
    objective: "Check files",
    workspaceId: "workspace",
    workspacePath: "/project",
    projectId: null,
    projectName: null,
    accountId: "account",
    modelId: "model",
    status: testCase.status,
    error: testCase.error,
    createdAt: 0,
    updatedAt: 0,
    steps: [
      {
        ...workflow.steps[0],
        status: testCase.stepStatus,
        conversationId: "earlier-conversation",
        result: testCase.result,
        error: testCase.error,
        startedAt: 0,
        finishedAt: 1,
      },
      {
        ...workflow.steps[0],
        id: "last",
        status: testCase.status === "Completed" ? "completed" : "waiting",
        conversationId:
          testCase.status === "Completed" ? "last-conversation" : null,
        result: testCase.status === "Completed" ? "Final step output" : null,
        error: null,
        startedAt: null,
        finishedAt: null,
      },
    ],
  }
  vi.stubGlobal("cowork", {
    providers: { listWithModels: vi.fn(async () => []) },
    tasks: { onEvent: () => () => {} },
    db: {
      messages: {
        list: vi.fn(async () => [
          {
            id: "old-response",
            role: "assistant",
            content: "Obsolete previous attempt report",
          },
        ]),
      },
    },
  })
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(<RunDetail run={run} onBack={() => {}} onClose={() => {}} />)
    )
    const outcome = container.querySelector('[aria-label="Run outcome"]')!
    expect(outcome.textContent).toContain(testCase.expected)
    expect(outcome.textContent).not.toContain(
      "Obsolete previous attempt report"
    )
    expect(outcome.textContent).not.toContain("No agent response is available")
    if (!testCase.result?.includes("Next action:"))
      expect(outcome.textContent).not.toContain("Next action:")
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

it.each([
  ["Failed", "Retry", "retry"],
  ["Paused", "Resume", "resume"],
] as const)("opens a feedback modal for a %s run and sends the feedback with %s", async (status, label, action) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const workflow = EXAMPLE_WORKFLOWS[0]
  const control = vi.fn(async () => {})
  const run: WorkflowRun = {
    id: "run",
    taskId: "task",
    workflowId: workflow.id,
    workflow,
    title: "Failed run",
    objective: "Check files",
    workspaceId: "workspace",
    workspacePath: "/project",
    projectId: null,
    projectName: null,
    accountId: "account",
    modelId: "model",
    status,
    error: "Validation failed",
    createdAt: 0,
    updatedAt: 0,
    steps: [
      {
        ...workflow.steps[0],
        status: "failed",
        conversationId: null,
        result: null,
        error: "Validation failed",
        startedAt: 0,
        finishedAt: 0,
      },
    ],
  }
  vi.stubGlobal("cowork", {
    providers: { listWithModels: vi.fn(async () => []) },
    tasks: { onEvent: () => () => {} },
    db: { messages: { list: vi.fn(async () => []) } },
    workflowRuns: { [action]: control },
  })
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const button = (label: string, scope: ParentNode) =>
    [...scope.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === label
    )!
  try {
    await act(async () =>
      root.render(
        <RunDetail
          run={run}
          workflow={workflow}
          onBack={() => {}}
          onClose={() => {}}
        />
      )
    )
    await act(async () => button(label, container).click())
    expect(control).not.toHaveBeenCalled()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain(`${label} run`)
    const textarea = dialog.querySelector("textarea")!
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )!.set!.call(textarea, "Skip the browser tests")
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => button(label, dialog).click())
    expect(control).toHaveBeenCalledWith("run", "Skip the browser tests")
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

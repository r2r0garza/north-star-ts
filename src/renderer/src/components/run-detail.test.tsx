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
    const stepTrigger =
      container.querySelector<HTMLButtonElement>("nav ol button")!
    expect(stepTrigger.getAttribute("aria-current")).toBeNull()
    expect(container.querySelector('[aria-label="Step transcript"]')).toBeNull()
    const reads = vi.mocked(window.cowork.db.messages.list).mock.calls.length
    expect(reads).toBe(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(vi.mocked(window.cowork.db.messages.list).mock.calls.length).toBe(
      reads
    )
    await act(async () => stepTrigger.click())
    const transcript = container.querySelector(
      '[aria-label="Step transcript"]'
    )!
    const scrollArea = container.querySelector<HTMLElement>(
      '[aria-label="Transcript scroll area"]'
    )!
    Object.defineProperties(scrollArea, {
      scrollHeight: { configurable: true, value: 2000 },
      clientHeight: { configurable: true, value: 500 },
    })
    await act(async () => {
      scrollArea.scrollTop = 1500
      scrollArea.dispatchEvent(new Event("scroll"))
      scrollArea.scrollTop = 300
      scrollArea.dispatchEvent(new Event("scroll"))
    })
    const latest = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button")
    ).find((button) => button.textContent === "Jump to latest")!
    expect(latest).toBeTruthy()
    await act(async () => latest.click())
    expect(scrollArea.scrollTop).toBe(2000)
    expect(container.textContent).not.toContain("Jump to latest")
    const calls = transcript.querySelectorAll<HTMLButtonElement>(
      '[data-slot="trace-collapsible-trigger"]'
    )
    expect(calls).toHaveLength(2)
    expect(calls[0].getAttribute("aria-expanded")).toBe("false")
    expect(calls[1].getAttribute("aria-expanded")).toBe("false")
    expect(transcript.textContent).not.toContain("Second file output")
    await act(async () => {
      calls[0].click()
      calls[1].click()
    })
    const callContent = (index: number) =>
      calls[index].closest('[data-slot="trace-collapsible"]')!
    expect(callContent(0).textContent).not.toContain("Second file output")
    expect(callContent(1).textContent).toContain("Second file output")
    expect(transcript.querySelectorAll("pre")).toHaveLength(3)
    expect(transcript.children).toHaveLength(4)
    expect(transcript.textContent).toContain("Unmatched output")
    expect(transcript.textContent).toContain("Unlinked output")
    expect(transcript.textContent).toContain("Finished checking")
    for (const [status, label, traceStatus] of [
      ["waiting", "Waiting", "pending"],
      ["active", "Active", "running"],
      ["completed", "Completed", null],
      ["paused", "Paused", null],
      ["cancelled", "Cancelled", null],
      ["failed", "Failed", "error"],
      ["interrupted", "Interrupted", null],
    ] as const) {
      await act(async () =>
        root.render(
          <RunDetail
            run={{ ...run, steps: [{ ...run.steps[0], status }] }}
            workflow={workflow}
            onBack={() => {}}
            onClose={() => {}}
          />
        )
      )
      expect(stepTrigger.getAttribute("aria-current")).toBe("step")
      expect(stepTrigger.textContent).toContain(label)
      expect(
        stepTrigger
          .querySelector('[data-slot="trace-line"]')!
          .getAttribute("data-status")
      ).toBe(traceStatus)
      expect(calls[0].getAttribute("aria-expanded")).toBe("true")
      if (status === "active") {
        expect(calls[0].textContent).toContain("Running")
        expect(calls[0].textContent).not.toContain("Interrupted")
      }
    }
    messages = [
      ...messages,
      message("first-result", {
        role: "tool",
        toolCallId: "first",
        content: "First file output",
      }),
      message("first-extra", {
        role: "tool",
        toolCallId: "first",
        content: "ERROR[extra]: additional response",
      }),
    ]
    await act(async () =>
      root.render(
        <RunDetail
          run={{
            ...run,
            status: "Active",
            steps: [{ ...run.steps[0], status: "active" }],
          }}
          workflow={workflow}
          onBack={() => {}}
          onClose={() => {}}
        />
      )
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(calls[0].getAttribute("aria-expanded")).toBe("true")
    expect(callContent(0).textContent).toContain("First file output")
    expect(callContent(0).textContent).toContain(
      "ERROR[extra]: additional response"
    )
    expect(calls[0].textContent).toContain("Failed")
    messages = [
      ...messages,
      message("command-call", {
        toolCalls: [
          {
            id: "cmd",
            name: "exec_command",
            arguments:
              '{ "command": "echo exact", "_activity": "Checking command" }',
          },
        ],
      }),
      message("cmd-result", {
        role: "tool",
        toolCallId: "cmd",
        content: JSON.stringify({
          status: "completed",
          exitCode: 4,
          signal: null,
          output: "Command output",
        }),
      }),
      message("cmd-extra", {
        role: "tool",
        toolCallId: "cmd",
        content: "Historical extra response",
      }),
    ]
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    const commandTrigger = [
      ...transcript.querySelectorAll<HTMLButtonElement>(
        '[data-slot="trace-collapsible-trigger"]'
      ),
    ].find((button) => button.textContent?.includes("Checking command"))!
    expect(commandTrigger.textContent).toContain("Exited with code 4")
    await act(async () => commandTrigger.click())
    const commandBody = commandTrigger.closest(
      '[data-slot="trace-collapsible"]'
    )!
    expect(
      commandBody.querySelector('[data-slot="code-block-code"]')?.textContent
    ).toBe("echo exact")
    expect(commandBody.textContent).toContain("Command output")
    expect(commandBody.textContent).toContain("Historical extra response")
    expect(transcript.textContent).toContain("Unmatched output")
    expect(callContent(1).textContent).not.toContain("First file output")
    expect(transcript.children).toHaveLength(5)
    expect(transcript.querySelectorAll("pre")).toHaveLength(10)
    await act(async () => calls[0].click())
    expect(calls[0].getAttribute("aria-expanded")).toBe("false")
    expect(transcript.textContent).not.toContain("First file output")
    const resultTab = container.querySelector<HTMLButtonElement>(
      '[role="tab"][id="step-tab-Result"]'
    )!
    await act(async () => resultTab.click())
    const closedReads = vi.mocked(window.cowork.db.messages.list).mock.calls
      .length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(vi.mocked(window.cowork.db.messages.list).mock.calls.length).toBe(
      closedReads
    )
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>("#step-tab-Transcript")!
        .click()
    )
    const openReads = vi.mocked(window.cowork.db.messages.list).mock.calls
      .length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(vi.mocked(window.cowork.db.messages.list).mock.calls.length).toBe(
      openReads + 1
    )
    messages = [
      ...messages,
      message("completion", { content: "Final saved output" }),
    ]
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
    expect(container.querySelector('[aria-label="Run outcome"]')).not.toBeNull()
    await act(async () => stepTrigger.click())
    expect(
      container.querySelector('[aria-label="Step transcript"]')?.textContent
    ).toContain("Final saved output")
    const completedReads = vi.mocked(window.cowork.db.messages.list).mock.calls
      .length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(vi.mocked(window.cowork.db.messages.list).mock.calls.length).toBe(
      completedReads
    )
    await act(async () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>("nav button"))
        .find((button) => button.textContent === "Run outcome")!
        .click()
    )
    expect(
      container.querySelector('[aria-label="Run outcome"]')?.textContent
    ).toContain("Final saved output")
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
    if (testCase.status !== "Completed") {
      await act(async () =>
        Array.from(container.querySelectorAll<HTMLButtonElement>("nav button"))
          .find((button) => button.textContent === "Run outcome")!
          .click()
      )
    }
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
] as const)(
  "opens a feedback modal for a %s run and sends the feedback with %s",
  async (status, label, action) => {
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
  }
)

it("shows live workflow command output in its existing disclosure and retains the final result", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const workflow = EXAMPLE_WORKFLOWS[0]
  const listeners = new Set<(payload: any) => void>()
  const run: WorkflowRun = {
    id: "live-run",
    taskId: "task",
    workflowId: workflow.id,
    workflow,
    title: "Live run",
    objective: "Check files",
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
    steps: [
      {
        ...workflow.steps[0],
        status: "active",
        conversationId: "conversation",
        result: null,
        error: null,
        startedAt: 0,
        finishedAt: null,
      },
    ],
  }
  vi.stubGlobal("cowork", {
    providers: { listWithModels: async () => [] },
    tasks: {
      onEvent: (listener: (payload: any) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    db: {
      messages: {
        list: async () => [
          {
            id: "assistant",
            role: "assistant",
            conversationId: "conversation",
            content: null,
            toolCalls: [
              {
                id: "launch",
                name: "exec_command",
                arguments: '{"command":"echo hello"}',
              },
            ],
          },
        ],
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
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-slot="trace-collapsible-trigger"]'
    )!
    await act(async () => trigger.click())
    const update = async (
      status: string,
      output: string,
      exitCode: number | null
    ) =>
      act(async () => {
        for (const listener of listeners)
          listener({
            taskId: "task",
            event: {
              type: "command_output",
              id: "launch",
              result: JSON.stringify({
                status,
                output,
                exitCode,
                signal: null,
                sessionId: "s",
              }),
            },
          })
      })
    await update("running", "hello\n", null)
    expect(
      container.querySelectorAll('[data-slot="code-block-code"]')[1].textContent
    ).toBe("hello\n")
    expect(trigger.textContent).toContain("Running")
    await update("completed", "hello\ndone\n", 0)
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(trigger.textContent).toContain("Completed successfully")
    expect(
      container.querySelectorAll('[data-slot="code-block-code"]')[1].textContent
    ).toBe("hello\ndone\n")
    expect(container.textContent).not.toContain(
      "Final outcome unavailable in this snapshot"
    )
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

it("never labels an unanswered mutation as successful after its step stops", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const workflow = EXAMPLE_WORKFLOWS[0]
  const messages: Message[] = [
    {
      id: "assistant",
      conversationId: "conversation",
      seq: 0,
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "write",
          name: "write_file_tool",
          arguments: '{"path":"unfinished.ts"}',
        },
        { id: "patch", name: "apply_patch_tool", arguments: "{}" },
      ],
      toolCallId: null,
      toolName: null,
      tokenEstimate: null,
      createdAt: 0,
    },
  ]
  vi.stubGlobal("cowork", {
    providers: { listWithModels: vi.fn(async () => []) },
    tasks: { onEvent: () => () => {} },
    db: { messages: { list: vi.fn(async () => messages) } },
  })
  const run = (
    status: WorkflowRun["steps"][number]["status"]
  ): WorkflowRun => ({
    id: "run",
    taskId: "task",
    workflowId: workflow.id,
    workflow,
    title: "Test run",
    objective: "Write files",
    workspaceId: "workspace",
    workspacePath: "/project",
    projectId: null,
    projectName: null,
    accountId: "account",
    modelId: "model",
    status: status === "active" ? "Active" : "Paused",
    error: null,
    createdAt: 0,
    updatedAt: 0,
    steps: [
      {
        ...workflow.steps[0],
        status,
        conversationId: "conversation",
        result: null,
        error: null,
        startedAt: 0,
        finishedAt: 0,
      },
    ],
  })
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const labels = () =>
    Array.from(
      container.querySelectorAll('[data-slot="trace-collapsible-trigger"]'),
      (trigger) => trigger.textContent
    )
  try {
    for (const [status, expected] of [
      ["active", ["Writing unfinished.ts", "Applying patch"]],
      ["interrupted", ["Write interrupted unfinished.ts", "Patch interrupted"]],
      ["paused", ["Write interrupted unfinished.ts", "Patch interrupted"]],
      ["cancelled", ["Write interrupted unfinished.ts", "Patch interrupted"]],
      ["completed", ["Write interrupted unfinished.ts", "Patch interrupted"]],
    ] as const) {
      await act(async () =>
        root.render(
          <RunDetail
            run={run(status)}
            workflow={workflow}
            onBack={() => {}}
            onClose={() => {}}
          />
        )
      )
      const step = container.querySelector<HTMLButtonElement>("nav ol button")!
      await act(async () => step.click())
      const current = labels()
      expected.forEach((label, index) =>
        expect(current[index]).toContain(label)
      )
      expect(current.join(" ")).not.toMatch(/Wrote|Applied patch/)
    }
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

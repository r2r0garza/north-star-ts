import { beforeEach, expect, it, vi } from "vitest"
import type { WorkflowRun } from "../../shared/workflow-runs"
import type { WorkflowDefinition } from "../../shared/workflows"

const state = vi.hoisted(() => ({
  runs: new Map<string, WorkflowRun>(),
  agent: vi.fn(),
  unknown: vi.fn(() => [] as string[]),
  conversations: 0,
  projects: new Map<
    string,
    { id: string; name: string; workspaceId: string | null }
  >(),
  conversationProjects: [] as (string | null | undefined)[],
  tasks: new Map<string, { status: string; error: string | null }>(),
  indexRun: undefined as { taskId: string } | undefined,
  indexed: null as object | null,
  autoIndex: vi.fn(),
  workflow: {} as WorkflowDefinition,
  afterSave: undefined as ((run: WorkflowRun) => void) | undefined,
}))
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock("../tasks/runner", () => ({}))
vi.mock("../db/connection", () => ({
  getDb: () => ({ transaction: (fn: () => void) => fn }),
}))
vi.mock("../db/repositories/workspaces", () => ({
  getWorkspace: () => ({ id: "ws", path: process.cwd() }),
}))
vi.mock("../db/repositories/projects", () => ({
  getProject: (id: string) => state.projects.get(id),
}))
vi.mock("../db/repositories/workflows", () => ({
  listWorkflows: () => [structuredClone(state.workflow)],
}))
vi.mock("../db/repositories/workflow-runs", () => ({
  saveWorkflowRun: (run: WorkflowRun) => {
    state.runs.set(run.id, structuredClone(run))
    state.afterSave?.(run)
  },
  getWorkflowRun: (id: string) => structuredClone(state.runs.get(id)),
  listWorkflowRuns: () =>
    [...state.runs.values()].map((run) => structuredClone(run)),
}))
vi.mock("../db/repositories/conversations", () => ({
  createConversation: vi.fn((input: { projectId?: string | null }) => {
    if (input.projectId && !state.projects.has(input.projectId))
      throw new Error("FOREIGN KEY constraint failed")
    state.conversationProjects.push(input.projectId)
    return { id: `conversation-${++state.conversations}` }
  }),
}))
vi.mock("../db/repositories/messages", () => ({ appendMessage: vi.fn() }))
vi.mock("../db/repositories/tasks", () => ({
  getTask: (id: string) =>
    state.tasks.get(id) ?? { status: "running", error: null },
}))
vi.mock("../agent/providers", () => ({
  resolveLlmTarget: () => ({ account: { id: "account" }, model: "model" }),
}))
vi.mock("../agent", () => ({ runAgentLoop: state.agent }))
vi.mock("../agent/repair", () => ({
  unknownSideEffectingToolCalls: state.unknown,
}))
vi.mock("../db/repositories/index-runs", () => ({
  getRunByWorkspace: () => state.indexRun,
}))
vi.mock("../index/indexed-workspace", () => ({
  indexedWorkspaceFor: async () => state.indexed,
}))
vi.mock("../index/auto-index", () => ({ autoIndexWorkspace: state.autoIndex }))
import { WorkflowService } from "./service"
import { appendMessage } from "../db/repositories/messages"
import { createConversation } from "../db/repositories/conversations"
import type { TaskRunner, TaskExecContext } from "../tasks/runner"

const runner = {
  enqueueKind: vi.fn(() => ({ id: "task" })),
  pause: vi.fn(),
  cancel: vi.fn(),
  resume: vi.fn(),
  restart: vi.fn(),
}
const service = new WorkflowService(runner as unknown as TaskRunner)
function start() {
  return service.start({
    workspaceId: "ws",
    workflowId: "wf",
    objective: "Check project",
  })
}
function context(
  run: WorkflowRun,
  signal = new AbortController().signal
): TaskExecContext {
  return {
    task: { id: "task", input: { runId: run.id } } as TaskExecContext["task"],
    signal,
    emit: vi.fn(),
    workspace: process.cwd(),
  }
}
function handoff(id: string, status = "completed") {
  return JSON.stringify({
    version: 1,
    taskId: id,
    status,
    summary: "Checked project",
    changes: [],
    verification: ["Tests passed"],
    unresolved: status === "completed" ? [] : ["Login needed"],
    nextAction: status === "completed" ? null : "Sign in",
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  state.runs.clear()
  state.conversations = 0
  state.projects.clear()
  state.conversationProjects = []
  state.unknown.mockReturnValue([])
  state.agent.mockReset()
  state.tasks.clear()
  state.indexRun = undefined
  state.indexed = null
  state.autoIndex.mockReset()
  state.afterSave = undefined
  state.workflow = {
    id: "wf",
    name: "Test",
    description: "",
    defaultObjective: "",
    steps: [
      { id: "a", title: "First", instructions: "Inspect" },
      { id: "b", title: "Second", instructions: "Report" },
    ],
  }
})
it("validates start and snapshots a durable run", () => {
  expect(() =>
    service.start({ workspaceId: "ws", workflowId: "wf", objective: " " })
  ).toThrow("Invalid")
  expect(() =>
    service.start({
      workspaceId: "ws",
      workflowId: "missing",
      objective: "Test",
    })
  ).toThrow("workflow")
  expect(() =>
    service.start({
      workspaceId: "ws",
      projectId: "missing",
      workflowId: "wf",
      objective: "Test",
    })
  ).toThrow("Project")
  const run = start()
  run.steps[0].instructions = "Changed"
  expect(state.runs.get(run.id)?.steps[0].instructions).toBe("Inspect")
  expect(run.taskId).toBe("task")
})
it("keeps executing from the launch snapshot after the workflow is edited mid-run", async () => {
  const { PAUSE_ABORT_REASON } = await import("../agent/abort")
  const run = start()
  const pause = new AbortController()
  // Pause right after step 1 completes, before step 2 builds its prompt.
  state.afterSave = (saved) => {
    if (saved.steps[0].status === "completed") pause.abort(PAUSE_ABORT_REASON)
  }
  state.agent.mockResolvedValueOnce({ content: handoff(`${run.id}:a`) })
  expect(await service.execute(context(run, pause.signal))).toMatchObject({
    paused: true,
  })
  state.afterSave = undefined
  state.workflow.name = "Edited"
  state.workflow.steps = [
    { id: "a", title: "First", instructions: "Inspect" },
    { id: "b", title: "Renamed", instructions: "Changed" },
    { id: "c", title: "Extra", instructions: "Added" },
  ]
  state.agent.mockResolvedValueOnce({ content: handoff(`${run.id}:b`) })

  expect(await service.execute(context(run))).not.toHaveProperty("error")
  expect(state.agent).toHaveBeenCalledTimes(2)
  const prompt = vi.mocked(appendMessage).mock.calls[1][0].content
  expect(prompt).toContain("Current step: Second")
  expect(prompt).toContain("Instructions: Report")
  expect(prompt).not.toContain("Changed")
  const saved = state.runs.get(run.id)!
  expect(saved.title).toBe("Test")
  expect(saved.steps.map((step) => step.instructions)).toEqual([
    "Inspect",
    "Report",
  ])
  expect(saved.steps.every((step) => step.status === "completed")).toBe(true)
})
it("executes ordered autonomous turns, passes prior results, and skips completed steps on resume", async () => {
  const run = start()
  state.agent.mockImplementation(async () => ({
    content: handoff(
      `${run.id}:${state.agent.mock.calls.length === 1 ? "a" : "b"}`
    ),
  }))
  expect(await service.execute(context(run))).toEqual({
    content: "Checked project\nTests passed",
  })
  expect(state.agent).toHaveBeenCalledTimes(2)
  expect(state.runs.get(run.id)?.steps[0].result).not.toContain("Next action:")
  for (const [opts] of state.agent.mock.calls)
    expect(opts).toMatchObject({
      autoMode: true,
      suppressUserQuestions: true,
      unattended: true,
      conversationSubagentsEnabled: false,
      workspace: process.cwd(),
    })
  expect(vi.mocked(appendMessage).mock.calls[1][0].content).toContain(
    "Tests passed"
  )
  await service.execute(context(run))
  expect(state.agent).toHaveBeenCalledTimes(2)
})
it.each([
  ["coding-agent", "qa-agent"],
  ["coding-agent", null],
  [undefined, "qa-agent"],
])("uses each step's selected agent (%s, %s)", async (first, second) => {
  const run = start()
  run.steps[0].agentName = first
  run.steps[1].agentName = second
  state.runs.set(run.id, structuredClone(run))
  state.agent
    .mockResolvedValueOnce({ content: handoff(`${run.id}:a`) })
    .mockResolvedValueOnce({ content: handoff(`${run.id}:b`) })

  expect(await service.execute(context(run))).not.toHaveProperty("error")
  expect(createConversation).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ mode: "north_star", agentName: first ?? null })
  )
  expect(createConversation).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ mode: "north_star", agentName: second ?? null })
  )
  expect(state.agent.mock.calls[0][0].conversationId).toBe("conversation-1")
  expect(state.agent.mock.calls[1][0].conversationId).toBe("conversation-2")

  await service.execute(context(run))
  expect(createConversation).toHaveBeenCalledTimes(2)
})
it.each(["blocked", "failed"])(
  "does not advance after a %s handoff",
  async (status) => {
    const run = start()
    state.agent.mockResolvedValue({ content: handoff(`${run.id}:a`, status) })
    expect(await service.execute(context(run))).toEqual({
      error: "Login needed",
    })
    expect(state.agent).toHaveBeenCalledTimes(1)
    expect(state.runs.get(run.id)?.steps[0].result).toContain("Login needed")
    expect(state.runs.get(run.id)?.steps[0].result).toContain(
      "Next action: Sign in"
    )
    expect(state.runs.get(run.id)?.steps.map((step) => step.status)).toEqual([
      "failed",
      "waiting",
    ])
  }
)
it("fails malformed completion after one repair turn instead of advancing", async () => {
  const run = start()
  state.agent.mockResolvedValue({ content: "All done" })
  expect(await service.execute(context(run))).toHaveProperty("error")
  expect(state.agent).toHaveBeenCalledTimes(2)
  expect(state.runs.get(run.id)?.steps[0].status).toBe("failed")
})
it("repairs an invalid handoff with one tool-free turn", async () => {
  const run = start()
  const twice = `${handoff(`${run.id}:a`)}\n${handoff(`${run.id}:a`)}`
  state.agent
    .mockResolvedValueOnce({ content: twice })
    .mockResolvedValueOnce({ content: handoff(`${run.id}:a`) })
    .mockResolvedValue({ content: handoff(`${run.id}:b`) })
  await service.execute(context(run))
  const repair = state.agent.mock.calls[1][0]
  expect(repair.userMessage).toContain("found 2")
  expect(repair.reportOnly).toBe(true)
  expect(state.runs.get(run.id)?.steps.map((step) => step.status)).toEqual([
    "completed",
    "completed",
  ])
  expect(state.agent).toHaveBeenCalledTimes(3)
})
it("aborts instead of waiting on interactive requirements", async () => {
  const run = start()
  state.agent.mockImplementation(async (opts) => {
    opts.onEvent({ type: "question" })
    expect(opts.abort.signal.aborted).toBe(true)
    return { stopped: true }
  })
  expect(await service.execute(context(run))).toHaveProperty(
    "error",
    "Unattended workflow encountered an interactive requirement"
  )
})
it("cancels active work and preserves the unexecuted frontier", async () => {
  const run = start()
  const abort = new AbortController()
  state.agent.mockImplementation(async () => {
    abort.abort()
    return { stopped: true }
  })
  expect(await service.execute(context(run, abort.signal))).toMatchObject({
    stopped: true,
  })
  expect(state.runs.get(run.id)?.steps.map((step) => step.status)).toEqual([
    "cancelled",
    "waiting",
  ])
})
it("refuses resume/retry when step side effects are unknown", async () => {
  const run = start()
  state.agent.mockResolvedValue({ error: "Unavailable" })
  await service.execute(context(run))
  state.unknown.mockReturnValue(["write_file"])
  expect(() => service.control(run.id, "resume")).toThrow("unknown")
  expect(() => service.control(run.id, "retry")).toThrow("unknown")
  expect(runner.restart).not.toHaveBeenCalled()
})

it("pauses and resumes the current step without replaying completed steps", async () => {
  const { PAUSE_ABORT_REASON } = await import("../agent/abort")
  const run = start()
  const abort = new AbortController()
  state.agent.mockImplementationOnce(async () => ({
    content: handoff(`${run.id}:a`),
  }))
  state.agent.mockImplementationOnce(async () => {
    abort.abort(PAUSE_ABORT_REASON)
    return { stopped: true }
  })
  expect(await service.execute(context(run, abort.signal))).toMatchObject({
    paused: true,
  })
  expect(state.runs.get(run.id)?.steps.map((step) => step.status)).toEqual([
    "completed",
    "paused",
  ])
  state.agent.mockResolvedValue({ content: handoff(`${run.id}:b`) })
  await service.execute(context(run))
  expect(state.agent).toHaveBeenCalledTimes(3)
  expect(state.conversations).toBe(2)
  expect(state.runs.get(run.id)?.steps.map((step) => step.status)).toEqual([
    "completed",
    "completed",
  ])
})

it("indexes an unindexed workspace at high priority before the first step", async () => {
  const indexed = new WorkflowService(runner as unknown as TaskRunner, {
    service: { ensureRunning: vi.fn() },
  })
  const run = start()
  state.autoIndex.mockImplementation(() => {
    state.indexRun = { taskId: "index-task" }
    state.tasks.set("index-task", { status: "running", error: null })
    setTimeout(
      () => state.tasks.set("index-task", { status: "completed", error: null }),
      20
    )
  })
  state.agent.mockImplementation(async () => {
    expect(state.tasks.get("index-task")?.status).toBe("completed")
    return {
      content: handoff(
        `${run.id}:${state.agent.mock.calls.length === 1 ? "a" : "b"}`
      ),
    }
  })
  await indexed.execute(context(run))
  expect(state.autoIndex).toHaveBeenCalledWith(
    "ws",
    "high",
    expect.anything(),
    undefined
  )
  expect(state.runs.get(run.id)?.indexing).toBe("ready")
  expect(state.agent).toHaveBeenCalledTimes(2)
})
it("skips indexing when the workspace is indexed or indexing is turned off", async () => {
  const indexed = new WorkflowService(runner as unknown as TaskRunner, {
    service: { ensureRunning: vi.fn() },
  })
  state.agent.mockImplementation(async () => ({
    content: handoff(
      `${run.id}:${state.agent.mock.calls.length === 1 ? "a" : "b"}`
    ),
  }))
  // Turned off: autoIndexWorkspace leaves no live index task behind.
  let run = start()
  await indexed.execute(context(run))
  expect(state.autoIndex).toHaveBeenCalledTimes(1)
  expect(state.runs.get(run.id)?.indexing).toBeUndefined()
  // Already indexed and idle: no trigger at all.
  state.indexed = {}
  state.agent.mockClear()
  run = start()
  await indexed.execute(context(run))
  expect(state.autoIndex).toHaveBeenCalledTimes(1)
  expect(state.agent).toHaveBeenCalledTimes(2)
})
it("settles a saved running indexing state when a paused run resumes after indexing finished", async () => {
  const indexed = new WorkflowService(runner as unknown as TaskRunner, {
    service: { ensureRunning: vi.fn() },
  })
  const run = start()
  state.autoIndex.mockImplementation(() => {
    state.indexRun = { taskId: "index-task" }
    state.tasks.set("index-task", { status: "running", error: null })
  })
  const pause = new AbortController()
  setTimeout(() => pause.abort("pause"), 20)
  await indexed.execute(context(run, pause.signal))
  expect(state.runs.get(run.id)?.indexing).toBe("running")
  expect(state.agent).not.toHaveBeenCalled()

  // Indexing finished while paused; the resumed run must not keep showing it.
  state.tasks.set("index-task", { status: "completed", error: null })
  state.indexed = {}
  state.agent.mockImplementation(async () => ({
    content: handoff(
      `${run.id}:${state.agent.mock.calls.length === 1 ? "a" : "b"}`
    ),
  }))
  await indexed.execute(context(state.runs.get(run.id)!))
  expect(state.runs.get(run.id)?.indexing).toBe("ready")
  expect(state.agent).toHaveBeenCalledTimes(2)
})

it.each(["completed", "failed"])(
  "projects %s task errors without restoring obsolete completion errors",
  (status) => {
    const run = start()
    run.error = "Previous workflow failure"
    state.runs.set(run.id, structuredClone(run))
    state.tasks.set("task", { status, error: "Task failure" })
    expect(service.list()[0]).toMatchObject({
      status: status === "completed" ? "Completed" : "Failed",
      error: status === "completed" ? null : "Task failure",
    })
  }
)

it.each(["retry", "resume"] as const)(
  "restores execution intent on %s after a repair-only turn",
  async (action) => {
    const { PAUSE_ABORT_REASON } = await import("../agent/abort")
    const run = start()
    const abort = new AbortController()
    state.agent.mockResolvedValueOnce({ content: handoff(`${run.id}:a`) })
    state.agent.mockResolvedValueOnce({ content: "Malformed handoff" })
    state.agent.mockImplementationOnce(async (opts) => {
      expect(opts.reportOnly).toBe(true)
      expect(opts.userMessage).toContain("Do not redo the step")
      if (action === "resume") abort.abort(PAUSE_ABORT_REASON)
      return { content: handoff(`${run.id}:b`, "blocked") }
    })
    await service.execute(context(run, abort.signal))
    service.control(run.id, action)
    expect(
      runner[action === "retry" ? "restart" : "resume"]
    ).toHaveBeenCalledWith("task")
    state.agent.mockResolvedValueOnce({ content: handoff(`${run.id}:b`) })
    expect(await service.execute(context(run))).toHaveProperty("content")
    const continuation = state.agent.mock.calls[3][0]
    expect(continuation.userMessage).toContain(
      "Resume execution of the unfinished step"
    )
    expect(continuation.userMessage).toContain(
      "supersedes any previous report-only"
    )
    expect(continuation.userMessage).toContain("do not repeat completed work")
    expect(continuation.userMessage).toContain("Current step: Second")
    expect(continuation.reportOnly).not.toBe(true)
    expect(continuation.conversationId).toBe(
      state.agent.mock.calls[1][0].conversationId
    )
    expect(state.agent).toHaveBeenCalledTimes(4)
    expect(state.conversations).toBe(2)
    expect(state.runs.get(run.id)?.steps.map((step) => step.status)).toEqual([
      "completed",
      "completed",
    ])
  }
)

it.each(["before execution", "between steps", "before retry"])(
  "continues after project deletion %s while retaining historical metadata",
  async (when) => {
    state.projects.set("project", {
      id: "project",
      name: "Historical project",
      workspaceId: "ws",
    })
    const run = service.start({
      workspaceId: "ws",
      projectId: "project",
      workflowId: "wf",
      objective: "Check project",
    })
    if (when === "before execution") state.projects.delete("project")
    state.agent.mockImplementation(async (opts) => {
      if (when === "between steps") state.projects.delete("project")
      if (when === "before retry" && state.agent.mock.calls.length === 1)
        return { error: "Temporary failure" }
      return {
        content: handoff(
          `${run.id}:${opts.conversationId === "conversation-1" ? "a" : "b"}`
        ),
      }
    })
    if (when === "before retry") {
      expect(await service.execute(context(run))).toEqual({
        error: "Temporary failure",
      })
      state.projects.delete("project")
      service.control(run.id, "retry")
    }
    expect(await service.execute(context(run))).toHaveProperty("content")
    expect(state.conversationProjects).toEqual(
      when === "before execution" ? [null, null] : ["project", null]
    )
    expect(state.runs.get(run.id)).toMatchObject({
      projectId: "project",
      projectName: "Historical project",
      workspaceId: "ws",
    })
  }
)

it.each(["blocked", "failed"])(
  "clears an obsolete %s result before retrying into a provider error",
  async (status) => {
    const run = start()
    state.agent
      .mockResolvedValueOnce({ content: handoff(`${run.id}:a`) })
      .mockResolvedValueOnce({ content: handoff(`${run.id}:b`, status) })
    await service.execute(context(run))
    const previous = state.runs.get(run.id)!
    expect(previous.steps[1].result).toContain("Next action: Sign in")
    expect(previous.steps[1].finishedAt).not.toBeNull()
    service.control(run.id, "retry")
    state.agent.mockImplementationOnce(async () => {
      const active = state.runs.get(run.id)!
      expect(active.steps[1]).toMatchObject({
        status: "active",
        result: null,
        error: null,
        finishedAt: null,
        startedAt: previous.steps[1].startedAt,
      })
      expect(active.steps[0]).toEqual(previous.steps[0])
      return { error: "Provider unavailable" }
    })
    expect(await service.execute(context(run))).toEqual({
      error: "Provider unavailable",
    })
    expect(state.runs.get(run.id)?.steps[1]).toMatchObject({
      status: "failed",
      result: null,
      error: "Provider unavailable",
    })
    expect(state.agent).toHaveBeenCalledTimes(3)
  }
)

it("leaves shutdown-aborted work for interruption reconciliation and resumes the same conversation", async () => {
  const { SHUTDOWN_ABORT_REASON } = await import("../agent/abort")
  const run = start()
  const abort = new AbortController()
  state.agent.mockImplementationOnce(async () => {
    abort.abort(SHUTDOWN_ABORT_REASON)
    return { stopped: true }
  })
  expect(await service.execute(context(run, abort.signal))).toMatchObject({
    stopped: true,
    paused: false,
  })
  expect(state.runs.get(run.id)?.steps.map((step) => step.status)).toEqual([
    "active",
    "waiting",
  ])
  state.tasks.set("task", { status: "interrupted", error: null })
  const interrupted = service.list()[0]
  expect(interrupted.status).toBe("Interrupted")
  expect(interrupted.steps.map((step) => step.status)).toEqual([
    "interrupted",
    "waiting",
  ])
  service.control(run.id, "resume")
  state.tasks.set("task", { status: "running", error: null })
  state.agent
    .mockResolvedValueOnce({ content: handoff(`${run.id}:a`) })
    .mockResolvedValueOnce({ content: handoff(`${run.id}:b`) })
  expect(await service.execute(context(run))).toHaveProperty("content")
  expect(state.agent.mock.calls[1][0].conversationId).toBe(
    state.agent.mock.calls[0][0].conversationId
  )
  expect(state.conversations).toBe(2)
  const completed = structuredClone(state.runs.get(run.id)!)
  await service.execute(context(run))
  expect(state.agent).toHaveBeenCalledTimes(3)
  expect(state.runs.get(run.id)?.steps).toEqual(completed.steps)
})

it("prefixes assigned skills and activates them without duplicating opening messages", async () => {
  state.workflow.steps[0].skillName = "git-commit"
  const run = start()
  state.workflow.steps[0].skillName = "changed"
  expect(run.steps[0].skillName).toBe("git-commit")
  state.agent.mockResolvedValueOnce({ content: handoff(`${run.id}:a`) })
  state.agent.mockResolvedValueOnce({ content: handoff(`${run.id}:b`) })
  expect(await service.execute(context(run))).not.toHaveProperty("error")
  expect(vi.mocked(appendMessage).mock.calls[0][0].content).toMatch(
    /^\/git-commit\nExecute step/
  )
  expect(state.agent.mock.calls[0][0]).toMatchObject({ skills: ["git-commit"] })
  expect(state.agent.mock.calls[0][0]).not.toHaveProperty("userMessage")
  expect(state.agent.mock.calls[1][0]).not.toHaveProperty("skills")
  expect(vi.mocked(appendMessage).mock.calls[1][0].content).toMatch(
    /^Execute step/
  )
})

it("keeps assigned skills active when resuming a step", async () => {
  state.workflow.steps[0].skillName = "git-commit"
  const run = start()
  const saved = state.runs.get(run.id)!
  saved.steps[0].conversationId = "existing-conversation"
  state.agent.mockResolvedValueOnce({ content: handoff(`${run.id}:a`) })
  state.agent.mockResolvedValueOnce({ content: handoff(`${run.id}:b`) })
  expect(await service.execute(context(run))).not.toHaveProperty("error")
  expect(state.agent.mock.calls[0][0]).toMatchObject({
    skills: ["git-commit"],
    userMessage: expect.stringMatching(/^\/git-commit\nResume/),
  })
})

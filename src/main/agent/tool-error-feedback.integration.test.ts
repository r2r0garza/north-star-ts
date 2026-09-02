import { access, mkdtemp, mkdir, writeFile } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { randomUUID } from "crypto"
import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()
const electronPaths = vi.hoisted(() => ({
  home: "/tmp/north-star-test-home",
  appPath: "/Users/r2r0garza/Documents/01-Projects/north_star_ts",
}))

let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))
vi.mock("electron", () => ({
  app: {
    getPath: (name: string) =>
      name === "home" ? electronPaths.home : tmpdir(),
    getAppPath: () => electronPaths.appPath,
  },
}))
vi.mock("./memory/service", () => ({ recordMemoryTurn: vi.fn(async () => {}) }))

type CompletionRequest = {
  messages: any[]
  tools: string[]
}

const scriptedCompletions: Array<
  (request: CompletionRequest) => AsyncIterable<any>
> = []
const completionRequests: CompletionRequest[] = []

vi.mock("./providers", () => {
  class NoActiveProviderError extends Error {}
  return {
    resolveLlm: () => ({
      client: {},
      model: "test-model",
      accountId: "test-account",
      apiMode: "completions",
    }),
    createCompletion: async (
      _client: unknown,
      _model: string,
      _maxTokens: number,
      base: { messages: any[]; tools: Array<{ function: { name: string } }> }
    ) => {
      const snapshot = structuredClone({
        messages: base.messages,
        tools: base.tools.map((tool) => tool.function.name),
      })
      completionRequests.push(snapshot)
      const next = scriptedCompletions.shift()
      if (!next) throw new Error("unexpected completion request")
      return next(snapshot)
    },
    isTransientError: (err: unknown) =>
      (err as { transient?: boolean }).transient === true,
    resolveModelLabel: () => "test-model",
    NoActiveProviderError,
  }
})

import { createConversation } from "../db/repositories/conversations"
import { appendMessage, listMessages } from "../db/repositories/messages"
import {
  listToolCallLifecycle,
  markToolCallStarted,
  markToolCallUnknown,
  normalizeToolActionIdentity,
  recordToolCallIntents,
  updateToolCallOperationIdentity,
} from "../db/repositories/tool-call-lifecycle"
import {
  consumeAttempt,
  getBudget,
  recordFailure,
} from "../db/repositories/model-request-retry-budgets"
import { createTask, getTask } from "../db/repositories/tasks"
import { upsertWorkspace } from "../db/repositories/workspaces"
import * as processes from "../db/repositories/processes"
import { ProcessService } from "../tasks/process/service"
import { runAgentLoop } from "."
import {
  testExports as toolRegistry,
  toolDefinitions,
  type Tool,
} from "./tools"
import { TOOL_EFFECTS } from "./tools/types"
import type { TaskEventPayload } from "../tasks/runner"

function streamToolCalls(
  calls: Array<{ id: string; name: string; arguments: string }>
): AsyncIterable<any> {
  return (async function* () {
    yield {
      choices: [
        {
          delta: {
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: call.arguments,
              },
            })),
          },
          finish_reason: "tool_calls",
        },
      ],
    }
  })()
}

function streamText(content: string): AsyncIterable<any> {
  return (async function* () {
    yield {
      choices: [
        {
          delta: { content },
          finish_reason: "stop",
        },
      ],
    }
  })()
}

function streamLengthToolCall(): AsyncIterable<any> {
  return (async function* () {
    yield {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "truncated_tool",
                type: "function",
                function: {
                  name: "read_file_tool",
                  arguments: '{"path":"ok',
                },
              },
            ],
          },
          finish_reason: "length",
        },
      ],
    }
  })()
}

function transientError(message: string): Error & { transient: true } {
  const err = new Error(message) as Error & { transient: true }
  err.transient = true
  return err
}

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "north-star-loop-"))
  await writeFile(join(workspace, "ok.txt"), "corrected content\n", "utf-8")
  return workspace
}

function toolRows(conversationId: string) {
  return listMessages(conversationId).filter(
    (message) => message.role === "tool"
  )
}

function contentsByCallId(conversationId: string): Map<string, string> {
  return new Map(
    toolRows(conversationId).map((message) => [
      message.toolCallId!,
      message.content ?? "",
    ])
  )
}

function lastMessage(request: CompletionRequest, role: string) {
  return [...request.messages]
    .reverse()
    .find((message) => message.role === role)
}

let unofferedToolExecutions = 0

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  runMigrations(db)
  scriptedCompletions.length = 0
  completionRequests.length = 0
  unofferedToolExecutions = 0
})

afterEach(() => {
  vi.restoreAllMocks()
  toolRegistry.byName.delete("test_throw_tool")
  toolRegistry.byName.delete("test_unoffered_tool")
  const registered = toolDefinitions.findIndex(
    (tool) => tool.function.name === "test_throw_tool"
  )
  if (registered !== -1) toolDefinitions.splice(registered, 1)
})

describe.skipIf(!sqliteLoads)("agent loop tool-error feedback", () => {
  it("blocks equivalent fresh-id mutations after an unknown operation", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    const priorAssistant = appendMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "call_unknown",
          name: "write_file_tool",
          arguments: JSON.stringify({
            path: "guarded.txt",
            content: "first",
            mode: "create",
          }),
        },
      ],
    })
    recordToolCallIntents({
      conversationId: conversation.id,
      assistantMessageId: priorAssistant.id,
      logicalRoundId: "after-seq:1",
      calls: [
        {
          id: "call_unknown",
          name: "write_file_tool",
          arguments: JSON.stringify({
            path: "guarded.txt",
            content: "first",
            mode: "create",
          }),
        },
      ],
    })
    updateToolCallOperationIdentity({
      conversationId: conversation.id,
      toolCallId: "call_unknown",
      identity: normalizeToolActionIdentity({
        kind: "file_write",
        identity: "file_write:guarded.txt",
      }),
    })
    markToolCallStarted({
      conversationId: conversation.id,
      toolCallId: "call_unknown",
    })
    markToolCallUnknown({
      conversationId: conversation.id,
      toolCallId: "call_unknown",
      error: "Interrupted before completion; result unknown.",
    })

    scriptedCompletions.push(() =>
      streamToolCalls([
        {
          id: "call_retry",
          name: "write_file_tool",
          arguments: JSON.stringify({
            path: "guarded.txt",
            content: "second",
            mode: "append",
          }),
        },
      ])
    )
    scriptedCompletions.push((request) => {
      expect(lastMessage(request, "tool")).toMatchObject({
        tool_call_id: "call_retry",
      })
      expect(lastMessage(request, "tool")?.content).toContain("ERROR[blocked]")
      return streamText("Blocked duplicate.")
    })

    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "try again",
      abort: new AbortController(),
      onEvent: () => {},
    })

    expect(result).toEqual({ content: "Blocked duplicate." })
    await expect(access(join(workspace, "guarded.txt"))).rejects.toThrow()
    const lifecycle = listToolCallLifecycle(conversation.id)
    expect(lifecycle.map((row) => [row.toolCallId, row.state])).toContainEqual([
      "call_unknown",
      "unknown",
    ])
    expect(lifecycle.map((row) => [row.toolCallId, row.state])).toContainEqual([
      "call_retry",
      "settled_error",
    ])
    expect(
      lifecycle.find((row) => row.toolCallId === "call_unknown")?.invocationId
    ).toBe(
      lifecycle.find((row) => row.toolCallId === "call_retry")?.invocationId
    )
  })

  it("allows equivalent fresh-id reads after an unknown read outcome", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    const priorAssistant = appendMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "call_unknown_read",
          name: "read_file_tool",
          arguments: JSON.stringify({ path: "ok.txt" }),
        },
      ],
    })
    recordToolCallIntents({
      conversationId: conversation.id,
      assistantMessageId: priorAssistant.id,
      logicalRoundId: "after-seq:1",
      calls: [
        {
          id: "call_unknown_read",
          name: "read_file_tool",
          arguments: JSON.stringify({ path: "ok.txt" }),
        },
      ],
    })
    markToolCallStarted({
      conversationId: conversation.id,
      toolCallId: "call_unknown_read",
    })
    markToolCallUnknown({
      conversationId: conversation.id,
      toolCallId: "call_unknown_read",
      error: "Interrupted before completion; result unknown.",
    })

    scriptedCompletions.push(() =>
      streamToolCalls([
        {
          id: "call_retry_read",
          name: "read_file_tool",
          arguments: JSON.stringify({ path: "ok.txt" }),
        },
      ])
    )
    scriptedCompletions.push((request) => {
      expect(lastMessage(request, "tool")).toMatchObject({
        tool_call_id: "call_retry_read",
      })
      expect(lastMessage(request, "tool")?.content).toContain(
        "corrected content"
      )
      return streamText("Read retry worked.")
    })

    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "read again",
      abort: new AbortController(),
      onEvent: () => {},
    })

    expect(result).toEqual({ content: "Read retry worked." })
    expect(
      listToolCallLifecycle(conversation.id).map((row) => [
        row.toolCallId,
        row.state,
      ])
    ).toContainEqual(["call_retry_read", "settled_success"])
  })

  it("persists tool failures and feeds them into the next model request for recovery", async () => {
    const throwingTool: Tool = {
      effects: TOOL_EFFECTS.readOnlySequential,
      definition: {
        type: "function",
        function: {
          name: "test_throw_tool",
          description: "Throws in tests.",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: async () => {
        throw new Error("controlled throw")
      },
    }
    const unofferedTool: Tool = {
      effects: TOOL_EFFECTS.readOnlySequential,
      definition: {
        type: "function",
        function: {
          name: "test_unoffered_tool",
          description: "Must never execute when not offered.",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: async () => {
        unofferedToolExecutions += 1
        return "should not run"
      },
    }
    toolDefinitions.push(throwingTool.definition)
    toolRegistry.byName.set("test_throw_tool", throwingTool)
    toolRegistry.byName.set("test_unoffered_tool", unofferedTool)

    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })

    scriptedCompletions.push(() =>
      streamToolCalls([
        {
          id: "call_missing",
          name: "read_file_tool",
          arguments: JSON.stringify({ path: "missing.txt" }),
        },
        {
          id: "call_sibling",
          name: "read_file_tool",
          arguments: JSON.stringify({ path: "ok.txt" }),
        },
        {
          id: "call_throw",
          name: "test_throw_tool",
          arguments: "{}",
        },
        {
          id: "call_unavailable",
          name: "test_unoffered_tool",
          arguments: "{}",
        },
        {
          id: "call_bad_json",
          name: "read_file_tool",
          arguments: '{"path":',
        },
      ])
    )
    scriptedCompletions.push((request) => {
      const ids = request.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.tool_call_id)
      expect(ids).toEqual([
        "call_missing",
        "call_sibling",
        "call_throw",
        "call_unavailable",
        "call_bad_json",
      ])
      const byId = new Map(
        request.messages
          .filter((message) => message.role === "tool")
          .map((message) => [message.tool_call_id, message.content])
      )
      expect(byId.get("call_missing")).toContain("ERROR[not_found]")
      expect(byId.get("call_sibling")).toContain("corrected content")
      expect(byId.get("call_throw")).toContain(
        "Error running test_throw_tool: controlled throw"
      )
      expect(byId.get("call_unavailable")).toContain("ERROR[tool_unavailable]")
      expect(byId.get("call_bad_json")).toContain("ERROR[bad_tool_arguments]")
      return streamToolCalls([
        {
          id: "call_corrected",
          name: "read_file_tool",
          arguments: JSON.stringify({ path: "ok.txt" }),
        },
      ])
    })
    scriptedCompletions.push((request) => {
      expect(lastMessage(request, "tool")).toMatchObject({
        tool_call_id: "call_corrected",
      })
      expect(lastMessage(request, "tool")?.content).toContain(
        "corrected content"
      )
      return streamText("Recovered.")
    })

    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "recover from tool failures",
      abort: new AbortController(),
      onEvent: () => {},
    })

    expect(result).toEqual({ content: "Recovered." })
    expect(unofferedToolExecutions).toBe(0)
    expect(completionRequests).toHaveLength(3)
    expect(getBudget(conversation.id, "after-seq:1")).toMatchObject({
      status: "completed",
      attemptsConsumed: 1,
    })
    expect(getBudget(conversation.id, "after-seq:7")).toMatchObject({
      status: "completed",
      attemptsConsumed: 1,
    })
    expect(getBudget(conversation.id, "after-seq:9")).toMatchObject({
      status: "completed",
      attemptsConsumed: 1,
    })
    const persisted = contentsByCallId(conversation.id)
    expect(persisted.get("call_missing")).toContain("ERROR[not_found]")
    expect(persisted.get("call_sibling")).toContain("corrected content")
    expect(persisted.get("call_throw")).toContain("controlled throw")
    expect(persisted.get("call_unavailable")).toContain(
      "ERROR[tool_unavailable]"
    )
    expect(persisted.get("call_bad_json")).toContain(
      "ERROR[bad_tool_arguments]"
    )
    expect(persisted.get("call_corrected")).toContain("corrected content")
    const lifecycle = listToolCallLifecycle(conversation.id)
    expect(lifecycle.map((row) => [row.toolCallId, row.state])).toEqual([
      ["call_missing", "settled_error"],
      ["call_sibling", "settled_success"],
      ["call_throw", "settled_error"],
      ["call_unavailable", "settled_error"],
      ["call_bad_json", "settled_error"],
      ["call_corrected", "settled_success"],
    ])
    expect(lifecycle.map((row) => row.logicalRoundId)).toEqual([
      "after-seq:1",
      "after-seq:1",
      "after-seq:1",
      "after-seq:1",
      "after-seq:1",
      "after-seq:7",
    ])
    expect(lifecycle.every((row) => row.startedAt !== null)).toBe(true)
    expect(lifecycle.every((row) => row.settledAt !== null)).toBe(true)
  })

  it("does not execute a known tool body when plan mode makes it unavailable", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })

    scriptedCompletions.push((request) => {
      expect(request.tools).not.toContain("write_file_tool")
      return streamToolCalls([
        {
          id: "call_write",
          name: "write_file_tool",
          arguments: JSON.stringify({ path: "forbidden.txt", content: "nope" }),
        },
      ])
    })
    scriptedCompletions.push((request) => {
      expect(lastMessage(request, "tool")).toMatchObject({
        tool_call_id: "call_write",
      })
      expect(lastMessage(request, "tool")?.content).toContain(
        "ERROR[tool_unavailable]"
      )
      return streamText("Handled.")
    })

    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "try a write during planning",
      abort: new AbortController(),
      planMode: true,
      onEvent: () => {},
    })

    expect(result).toEqual({ content: "Handled." })
    expect(contentsByCallId(conversation.id).get("call_write")).toContain(
      "ERROR[tool_unavailable]"
    )
  })

  it.each(["completed", "blocked", "failed", "invalid"])(
    "enforces a %s outcome after native tool-error recovery in a real process worker",
    async (outcomeStatus) => {
      const workspace = await makeWorkspace()
      await mkdir(join(workspace, ".claude", "agents"), { recursive: true })
      await writeFile(
        join(workspace, ".claude", "agents", "reader.md"),
        [
          "---",
          "name: reader",
          "description: Reads files for a process phase.",
          "tools: Read",
          "---",
          "Use file reads only.",
          "",
        ].join("\n"),
        "utf-8"
      )

      const workspaceId = upsertWorkspace(workspace).id
      const source = createConversation({
        mode: "interactive",
        workspaceId,
      })
      const definition = processes.createProcessDefinition({
        name: "Loop test",
      })
      const phase = processes.createPhase({
        processId: definition.id,
        key: "read",
        name: "Read",
        completionContract: {
          policy: "validated",
          version: 1,
          requiredArtifacts: ["ok.txt"],
        },
        routing: "single",
        position: 0,
      })
      processes.createPhaseAgent({
        phaseId: phase.id,
        agentName: "reader",
        position: 0,
      })
      const backingTask = createTask({
        conversationId: source.id,
        sourceConversationId: source.id,
        status: "running",
        title: "Process",
        input: { kind: "process_run" },
      })
      const run = processes.createProcessRun({
        processId: definition.id,
        sourceConversationId: source.id,
        workspaceId,
        taskId: backingTask.id,
        objective: "read files",
        status: "running",
      })

      scriptedCompletions.push((request) => {
        expect(request.tools).toContain("read_file_tool")
        expect(request.tools).not.toContain("write_file_tool")
        return streamToolCalls([
          {
            id: "process_missing",
            name: "read_file_tool",
            arguments: JSON.stringify({ path: "missing.txt" }),
          },
        ])
      })
      scriptedCompletions.push((request) => {
        expect(lastMessage(request, "tool")).toMatchObject({
          tool_call_id: "process_missing",
        })
        expect(lastMessage(request, "tool")?.content).toContain(
          "ERROR[not_found]"
        )
        return streamToolCalls([
          {
            id: "process_corrected",
            name: "read_file_tool",
            arguments: JSON.stringify({ path: "ok.txt" }),
          },
        ])
      })
      scriptedCompletions.push((request) => {
        expect(lastMessage(request, "tool")).toMatchObject({
          tool_call_id: "process_corrected",
        })
        expect(lastMessage(request, "tool")?.content).toContain(
          "corrected content"
        )
        const system = request.messages.find((m) => m.role === "system")
          ?.content as string
        const attemptId = system.match(/attemptId: "([^"]+)"/)?.[1]
        expect(attemptId).toBeTruthy()
        return streamText(
          outcomeStatus === "invalid"
            ? "phase done"
            : JSON.stringify({
                version: 1,
                attemptId,
                status: outcomeStatus,
                output: "Read the file",
                evidence: "Read ok.txt after correcting the failed read",
                reason: "Need another input",
                nextAction: "Provide the input",
              })
        )
      })

      const svc = new ProcessService({ enqueueKind: vi.fn() } as never)
      const events: TaskEventPayload[] = []
      const result = await svc.execute({
        task: {
          ...backingTask,
          input: { processRunId: run.id },
        } as never,
        signal: new AbortController().signal,
        emit: (event) => {
          events.push(event)
        },
        workspace: undefined,
      })

      if (outcomeStatus === "completed")
        expect(result).toEqual({ content: "process complete" })
      else expect(result).toHaveProperty("error")
      expect(processes.getProcessRun(run.id)?.status).toBe(
        outcomeStatus === "completed" ? "completed" : "failed"
      )
      const phaseRun = processes.listPhaseRuns({
        runId: run.id,
        parentId: null,
      })[0]
      expect(phaseRun.status).toBe(
        outcomeStatus === "completed" ? "completed" : "failed"
      )
      if (outcomeStatus === "completed")
        expect(phaseRun.completionReceipt?.checkedArtifacts).toEqual(["ok.txt"])
      expect(phaseRun.agentName).toBe("reader")
      const workerTask = getTask(phaseRun.taskId!)
      expect(workerTask).toBeTruthy()
      const workerResults = contentsByCallId(workerTask!.conversationId)
      expect(workerResults.get("process_missing")).toContain("ERROR[not_found]")
      expect(workerResults.get("process_corrected")).toContain(
        "corrected content"
      )
      expect(completionRequests).toHaveLength(3)
    }
  )

  it("keeps a process worker tool failure distinct from a later API failure", async () => {
    const workspace = await makeWorkspace()
    await mkdir(join(workspace, ".claude", "agents"), { recursive: true })
    await writeFile(
      join(workspace, ".claude", "agents", "reader.md"),
      [
        "---",
        "name: reader",
        "description: Reads files for a process phase.",
        "tools: Read",
        "---",
        "Use file reads only.",
        "",
      ].join("\n"),
      "utf-8"
    )

    const workspaceId = upsertWorkspace(workspace).id
    const source = createConversation({
      mode: "interactive",
      workspaceId,
    })
    const definition = processes.createProcessDefinition({ name: "Loop test" })
    const phase = processes.createPhase({
      processId: definition.id,
      key: "read",
      name: "Read",
      routing: "single",
      position: 0,
    })
    processes.createPhaseAgent({
      phaseId: phase.id,
      agentName: "reader",
      position: 0,
    })
    const backingTask = createTask({
      conversationId: source.id,
      sourceConversationId: source.id,
      status: "running",
      title: "Process",
      input: { kind: "process_run" },
    })
    const run = processes.createProcessRun({
      processId: definition.id,
      sourceConversationId: source.id,
      workspaceId,
      taskId: backingTask.id,
      objective: "read files",
      status: "running",
    })

    scriptedCompletions.push(() =>
      streamToolCalls([
        {
          id: "process_missing",
          name: "read_file_tool",
          arguments: JSON.stringify({ path: "missing.txt" }),
        },
      ])
    )
    const apiError = Object.assign(new Error("invalid api key after tool"), {
      status: 401,
    })
    scriptedCompletions.push((request) => {
      expect(lastMessage(request, "tool")).toMatchObject({
        tool_call_id: "process_missing",
      })
      expect(lastMessage(request, "tool")?.content).toContain(
        "ERROR[not_found]"
      )
      throw apiError
    })

    const svc = new ProcessService({ enqueueKind: vi.fn() } as never)
    const events: TaskEventPayload[] = []
    const result = await svc.execute({
      task: {
        ...backingTask,
        input: { processRunId: run.id },
      } as never,
      signal: new AbortController().signal,
      emit: (event) => {
        events.push(event)
      },
      workspace: undefined,
    })

    expect(result).toEqual({
      error: "a process phase failed",
      retryable: false,
    })
    expect(processes.getProcessRun(run.id)?.status).toBe("failed")
    const phaseRun = processes.listPhaseRuns({
      runId: run.id,
      parentId: null,
    })[0]
    expect(phaseRun.status).toBe("failed")
    expect(phaseRun.agentName).toBe("reader")
    expect(phaseRun.failure).toMatchObject({
      code: "model_request_failed",
      stage: "model_request",
      message: "invalid api key after tool",
      phaseRunId: phaseRun.id,
      phaseId: phase.id,
      workerTaskId: phaseRun.taskId,
      agentName: "reader",
    })
    expect(phaseRun.failure?.taskId).toBe(phaseRun.taskId)
    expect(phaseRun.failure?.toolCallId ?? null).toBeNull()

    const attempts = processes.listPhaseAttempts({ phaseRunId: phaseRun.id })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      stage: "model_request",
      error: "invalid api key after tool",
      workerTaskId: phaseRun.taskId,
      failure: {
        code: "model_request_failed",
        stage: "model_request",
      },
    })

    const failedEvent = events.find(
      (event) => event.type === "process_phase" && event.status === "failed"
    )
    expect(failedEvent).toMatchObject({
      type: "process_phase",
      phaseRunId: phaseRun.id,
      failure: {
        code: "model_request_failed",
        stage: "model_request",
      },
    })

    const workerTask = getTask(phaseRun.taskId!)
    expect(workerTask).toBeTruthy()
    const workerResults = contentsByCallId(workerTask!.conversationId)
    expect(workerResults.get("process_missing")).toContain("ERROR[not_found]")
    const lifecycle = listToolCallLifecycle(workerTask!.conversationId)
    expect(lifecycle).toHaveLength(1)
    expect(lifecycle[0]).toMatchObject({
      toolCallId: "process_missing",
      toolName: "read_file_tool",
      state: "settled_error",
      logicalRoundId: "after-seq:1",
    })
    expect(lifecycle[0].error).toContain("ERROR[not_found]")
    expect(getBudget(workerTask!.conversationId, "after-seq:3")).toMatchObject({
      status: "exhausted",
      attemptsConsumed: 1,
      lastError: "invalid api key after tool",
    })
    expect(completionRequests).toHaveLength(2)
  })

  it("retries only the failed model request after a completed tool round", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    let executions = 0
    const sideEffectTool: Tool = {
      effects: TOOL_EFFECTS.mutation,
      definition: {
        type: "function",
        function: {
          name: "test_throw_tool",
          description: "Counts executions in tests.",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: async () => {
        executions += 1
        return `executed ${executions}`
      },
    }
    toolDefinitions.push(sideEffectTool.definition)
    toolRegistry.byName.set("test_throw_tool", sideEffectTool)

    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })

    scriptedCompletions.push(() =>
      streamToolCalls([
        {
          id: "side_effect_once",
          name: "test_throw_tool",
          arguments: "{}",
        },
      ])
    )
    scriptedCompletions.push((request) => {
      expect(lastMessage(request, "tool")).toMatchObject({
        tool_call_id: "side_effect_once",
        content: "executed 1",
      })
      throw transientError("temporary outage 1")
    })
    scriptedCompletions.push((request) => {
      expect(lastMessage(request, "tool")).toMatchObject({
        tool_call_id: "side_effect_once",
        content: "executed 1",
      })
      throw transientError("temporary outage 2")
    })
    scriptedCompletions.push((request) => {
      expect(lastMessage(request, "tool")).toMatchObject({
        tool_call_id: "side_effect_once",
        content: "executed 1",
      })
      return streamText("done after retry")
    })

    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "run the side effect once",
      abort: new AbortController(),
      onEvent: () => {},
    })

    expect(result).toEqual({ content: "done after retry" })
    expect(executions).toBe(1)
    expect(completionRequests).toHaveLength(4)
    expect(getBudget(conversation.id, "after-seq:1")).toMatchObject({
      status: "completed",
      attemptsConsumed: 1,
    })
    expect(getBudget(conversation.id, "after-seq:3")).toMatchObject({
      status: "completed",
      attemptsConsumed: 3,
      lastError: "temporary outage 2",
    })
    expect(contentsByCallId(conversation.id).get("side_effect_once")).toBe(
      "executed 1"
    )
  })

  it("discards partial text and tool fragments from a failed stream retry", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    const tokens: string[] = []

    scriptedCompletions.push(() =>
      (async function* () {
        yield {
          choices: [
            {
              delta: {
                content: "abandoned text",
                tool_calls: [
                  {
                    index: 0,
                    id: "partial_tool",
                    type: "function",
                    function: {
                      name: "read_file_tool",
                      arguments: '{"path":"ok',
                    },
                  },
                ],
              },
            },
          ],
        }
        throw transientError("socket died mid-stream")
      })()
    )
    scriptedCompletions.push(() => streamText("clean retry"))

    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "stream retry",
      abort: new AbortController(),
      onEvent: (event) => {
        if (event.type === "token") tokens.push(event.delta)
      },
    })

    expect(result).toEqual({ content: "clean retry" })
    expect(tokens).toEqual(["clean retry"])
    expect(getBudget(conversation.id, "after-seq:1")).toMatchObject({
      status: "completed",
      attemptsConsumed: 2,
      lastError: "socket died mid-stream",
    })
    expect(contentsByCallId(conversation.id).has("partial_tool")).toBe(false)
    expect(
      listMessages(conversation.id).some((message) =>
        String(message.content ?? "").includes("abandoned text")
      )
    ).toBe(false)
    expect(completionRequests).toHaveLength(2)
  })

  it("does not retry deterministic provider failures", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    const err = Object.assign(new Error("invalid api key"), { status: 401 })

    scriptedCompletions.push(() => {
      throw err
    })

    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "auth failure",
      abort: new AbortController(),
      onEvent: () => {},
    })

    expect(result).toEqual({ error: "invalid api key", retryable: false })
    expect(completionRequests).toHaveLength(1)
    expect(getBudget(conversation.id, "after-seq:1")).toMatchObject({
      status: "exhausted",
      attemptsConsumed: 1,
      lastError: "invalid api key",
    })
  })

  it("exhausts a durable budget without a transient retry for truncated tool calls", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })

    scriptedCompletions.push(() => streamLengthToolCall())

    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "make an oversized tool call",
      abort: new AbortController(),
      onEvent: () => {},
    })

    expect(result.error).toContain(
      "The model's response was truncated before the tool call completed"
    )
    expect(result.retryable).toBe(false)
    expect(completionRequests).toHaveLength(1)
    expect(getBudget(conversation.id, "after-seq:1")).toMatchObject({
      status: "exhausted",
      attemptsConsumed: 1,
    })
    expect(contentsByCallId(conversation.id).has("truncated_tool")).toBe(false)
  })

  it("makes zero provider calls when a resumed model round is past its durable deadline", async () => {
    const conversation = createConversation({ mode: "interactive" })
    appendMessage({
      conversationId: conversation.id,
      role: "user",
      content: "resume the in-flight request",
    })
    consumeAttempt({
      conversationId: conversation.id,
      logicalRoundId: "after-seq:1",
      maxAttempts: 3,
      maxElapsedMs: 1,
      now: 1000,
    })
    recordFailure({
      conversationId: conversation.id,
      logicalRoundId: "after-seq:1",
      error: "gateway 503",
      now: 1001,
    })

    const result = await runAgentLoop({
      conversationId: conversation.id,
      abort: new AbortController(),
      onEvent: () => {},
    })

    expect(result.error).toContain("Model request failed after 1 attempts")
    expect(completionRequests).toHaveLength(0)
    expect(getBudget(conversation.id, "after-seq:1")).toMatchObject({
      status: "exhausted",
      attemptsConsumed: 1,
      lastError: "gateway 503",
    })
    expect(listMessages(conversation.id).at(-1)?.content ?? "").toContain(
      "The turn ended early"
    )
  })
})

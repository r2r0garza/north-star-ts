import { mkdtemp, mkdir, writeFile } from "fs/promises"
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
    getPath: (name: string) => (name === "home" ? electronPaths.home : tmpdir()),
    getAppPath: () => electronPaths.appPath,
  },
}))
vi.mock("./memory/service", () => ({ recordMemoryTurn: vi.fn(async () => {}) }))

type CompletionRequest = {
  messages: any[]
  tools: string[]
}

const scriptedCompletions: Array<(request: CompletionRequest) => AsyncIterable<any>> = []
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
    isTransientError: () => false,
    resolveModelLabel: () => "test-model",
    NoActiveProviderError,
  }
})

import { createConversation } from "../db/repositories/conversations"
import { listMessages } from "../db/repositories/messages"
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

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "north-star-loop-"))
  await writeFile(join(workspace, "ok.txt"), "corrected content\n", "utf-8")
  return workspace
}

function toolRows(conversationId: string) {
  return listMessages(conversationId).filter((message) => message.role === "tool")
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
  return [...request.messages].reverse().find((message) => message.role === role)
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
  toolRegistry.byName.delete("test_throw_tool")
  toolRegistry.byName.delete("test_unoffered_tool")
  const registered = toolDefinitions.findIndex(
    (tool) => tool.function.name === "test_throw_tool"
  )
  if (registered !== -1) toolDefinitions.splice(registered, 1)
})

describe.skipIf(!sqliteLoads)("agent loop tool-error feedback", () => {
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

  it("delivers native tool error feedback through a real process phase worker", async () => {
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
      return streamText("phase done")
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

    expect(result).toEqual({ content: "process complete" })
    expect(processes.getProcessRun(run.id)?.status).toBe("completed")
    const phaseRun = processes.listPhaseRuns({ runId: run.id, parentId: null })[0]
    expect(phaseRun.status).toBe("completed")
    expect(phaseRun.agentName).toBe("reader")
    const workerTask = getTask(phaseRun.taskId!)
    expect(workerTask).toBeTruthy()
    const workerResults = contentsByCallId(workerTask!.conversationId)
    expect(workerResults.get("process_missing")).toContain("ERROR[not_found]")
    expect(workerResults.get("process_corrected")).toContain(
      "corrected content"
    )
    expect(completionRequests).toHaveLength(3)
  })
})

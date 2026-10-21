import { access, mkdtemp, mkdir, readFile, writeFile } from "fs/promises"
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
// Chat Python venv: no real interpreter in tests. Only turns that set
// chatPythonVenv ever consult it.
vi.mock("../python/chat-venv", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../python/chat-venv")>()),
  resolveChatVenvOverlay: async () => ({
    prependPath: ["/venv/bin"],
    vars: { VIRTUAL_ENV: "/venv" },
  }),
}))

type CompletionRequest = {
  messages: any[]
  tools: string[]
  maxTokens: number
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
      maxTokens: number,
      base: { messages: any[]; tools: Array<{ function: { name: string } }> }
    ) => {
      const snapshot = structuredClone({
        messages: base.messages,
        tools: base.tools.map((tool) => tool.function.name),
        maxTokens,
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
import { queueSteering, steeringState, cancelSteering } from "./steering"
import { MODEL_STREAM_IDLE } from "./model-request-retry"
import {
  addConversationNote,
  takeConversationNotes,
} from "../db/repositories/conversation-notes"
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
import { resolveApproval, runAgentLoop, runChat, stopChat } from "."
import { replaceTodos } from "../db/repositories/todos"
import {
  repairDanglingToolCalls,
  unknownSideEffectingToolCalls,
} from "./repair"
import {
  testExports as toolRegistry,
  toolDefinitions,
  type Tool,
} from "./tools"
import { testCommandSessions } from "./tools/command_session_tools"
import { LocalEnvironment } from "./env/local"
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

function streamTextEnding(
  content: string,
  finishReason: string
): AsyncIterable<any> {
  return (async function* () {
    yield { choices: [{ delta: { content }, finish_reason: finishReason }] }
  })()
}

// nav-test-5's QA reply: a DSML tool call cut off mid-parameter, which the
// provider passed through as text.
const TRUNCATED_DSML =
  'Let me verify the last rewrite path.\n<｜DSML｜ invoke name="exec_command">\n<｜DSML｜ parameter name="command" string="true">cd repo && python - <<\'PY\'\nco.create("run-1", not_before='

function streamEmpty(finishReason: string | null): AsyncIterable<any> {
  return (async function* () {
    yield {
      choices: [
        {
          delta: {},
          finish_reason: finishReason,
        },
      ],
    }
  })()
}

const nodeCmd = (code: string) =>
  `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`

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
  testCommandSessions.clear()
  toolRegistry.byName.delete("test_throw_tool")
  toolRegistry.byName.delete("test_unoffered_tool")
  const registered = toolDefinitions.findIndex(
    (tool) => tool.function.name === "test_throw_tool"
  )
  if (registered !== -1) toolDefinitions.splice(registered, 1)
})

describe.skipIf(!sqliteLoads)("agent loop tool-error feedback", () => {
  it("delivers steering queued during the final response and continues the same run", async () => {
    const conversation = createConversation({ mode: "chat" })
    let queued = false
    scriptedCompletions.push(
      () => streamText("Original answer"),
      (request) => {
        expect(lastMessage(request, "user").content).toContain(
          "Focus on tests instead"
        )
        expect(
          request.messages.some(
            (message) =>
              message.role === "assistant" &&
              message.content === "Original answer"
          )
        ).toBe(true)
        return streamText("Updated answer")
      }
    )
    const result = await runChat(
      { conversationId: conversation.id, message: "Start" },
      (event) => {
        if (event.type === "token" && !queued) {
          queued = true
          const runId = steeringState(conversation.id).runId!
          queueSteering(conversation.id, runId, {
            id: "steer-final",
            message: "Focus on tests instead",
            attachments: [],
            skills: [],
          })
        }
      }
    )
    expect(result.content).toBe("Updated answer")
    expect(
      listMessages(conversation.id)
        .filter((message) => message.role === "user")
        .map((message) => message.content)
    ).toEqual(["Start", "Focus on tests instead"])
    expect(steeringState(conversation.id)).toEqual({
      runId: null,
      messages: [],
    })
  })

  it("waits for every parallel tool result before delivering steering", async () => {
    const workspace = await makeWorkspace()
    await writeFile(join(workspace, "steering.txt"), "hello")
    const conversation = createConversation({ mode: "interactive" })
    let queued = false
    const done = new Set<string>()
    scriptedCompletions.push(
      () =>
        streamToolCalls([
          {
            id: "steer-read-1",
            name: "read_file_tool",
            arguments: JSON.stringify({ path: "steering.txt" }),
          },
          {
            id: "steer-read-2",
            name: "read_file_tool",
            arguments: JSON.stringify({ path: "steering.txt" }),
          },
        ]),
      (request) => {
        const userIndex = request.messages.findIndex(
          (message) =>
            message.role === "user" && message.content === "New direction"
        )
        expect(
          request.messages
            .slice(0, userIndex)
            .filter((message) => message.role === "tool")
        ).toHaveLength(2)
        return streamText("Steered after tools")
      }
    )
    const result = await runChat(
      { conversationId: conversation.id, workspace, message: "Read both" },
      (event) => {
        if (event.type === "tool" && event.phase === "start" && !queued) {
          queued = true
          queueSteering(
            conversation.id,
            steeringState(conversation.id).runId!,
            {
              id: "parallel-steer",
              message: "New direction",
              attachments: [],
              skills: [],
            }
          )
        }
        if (event.type === "tool" && event.phase === "done") done.add(event.id)
        if (event.type === "steering_delivered") expect(done.size).toBe(2)
      }
    )
    expect(result.content).toBe("Steered after tools")
    const stored = listMessages(conversation.id)
    expect(stored.filter((message) => message.role === "tool")).toHaveLength(2)
    expect(
      stored.findIndex((message) => message.content === "New direction")
    ).toBeGreaterThan(
      stored.findIndex((message) => message.toolCallId === "steer-read-2")
    )
  })

  it("wakes an idle background-command wait to deliver steering", async () => {
    const conversation = createConversation({ mode: "chat" })
    let queued = false
    scriptedCompletions.push(
      () =>
        streamToolCalls([
          {
            id: "steering-background",
            name: "exec_command",
            arguments: JSON.stringify({
              command: "sleep 10",
              background: true,
            }),
          },
        ]),
      () => streamText("Waiting for command"),
      (request) => {
        expect(lastMessage(request, "user").content).toContain(
          "Stop waiting and explain"
        )
        stopChat(conversation.id)
        return streamText("Steering received")
      }
    )
    const result = await runChat(
      {
        conversationId: conversation.id,
        message: "Start command",
        autoMode: true,
      },
      (event) => {
        if (
          event.type === "command_wait" &&
          event.phase === "start" &&
          !queued
        ) {
          queued = true
          queueSteering(
            conversation.id,
            steeringState(conversation.id).runId!,
            {
              id: "wake-steer",
              message: "Stop waiting and explain",
              attachments: [],
              skills: [],
            }
          )
        }
      }
    )
    expect(queued).toBe(true)
    expect(result.stopped).toBe(true)
    expect(
      listMessages(conversation.id).some(
        (message) => message.content === "Stop waiting and explain"
      )
    ).toBe(true)
  })

  it("keeps undelivered steering recoverable when Stop is pressed", async () => {
    const conversation = createConversation({ mode: "chat" })
    let queued = false
    scriptedCompletions.push(() => streamText("Working"))
    await runChat(
      { conversationId: conversation.id, message: "Start" },
      (event) => {
        if (event.type === "token" && !queued) {
          queued = true
          queueSteering(
            conversation.id,
            steeringState(conversation.id).runId!,
            {
              id: "stopped-steer",
              message: "Do not lose this",
              attachments: [],
              skills: [],
            }
          )
          stopChat(conversation.id)
        }
      }
    )
    expect(steeringState(conversation.id)).toMatchObject({
      runId: null,
      messages: [
        {
          id: "stopped-steer",
          status: "returned",
          message: "Do not lose this",
        },
      ],
    })
  })

  it("cancels queued steering without stopping the active run", async () => {
    const conversation = createConversation({ mode: "chat" })
    let queued = false
    scriptedCompletions.push(() => streamText("Unchanged answer"))
    const result = await runChat(
      { conversationId: conversation.id, message: "Start" },
      (event) => {
        if (event.type === "token" && !queued) {
          queued = true
          const runId = steeringState(conversation.id).runId!
          queueSteering(conversation.id, runId, {
            id: "cancel-me",
            message: "Never deliver",
            attachments: [],
            skills: [],
          })
          cancelSteering(conversation.id, "cancel-me")
        }
      }
    )
    expect(result.content).toBe("Unchanged answer")
    expect(
      listMessages(conversation.id).some(
        (message) => message.content === "Never deliver"
      )
    ).toBe(false)
  })

  it("executes a clicked Bash script once before model interpretation and delivers failure output", async () => {
    const workspace = await makeWorkspace()
    const ws = upsertWorkspace(workspace)
    const conversation = createConversation({
      mode: "interactive",
      workspaceId: ws.id,
    })
    const command =
      "printf 'clicked stdout\\n'; printf 'clicked stderr\\n' >&2; exit 7"
    const source = appendMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: `\`\`\`bash\n${command}\n\`\`\``,
    })
    scriptedCompletions.push(
      (request) => {
        const result = lastMessage(request, "tool")
        expect(result).toBeDefined()
        expect(request.tools).not.toContain("exec_command")
        return streamText("Waiting for your script.")
      },
      (request) => {
        expect(JSON.stringify(request.messages)).toContain("clicked stdout")
        expect(JSON.stringify(request.messages)).toContain("clicked stderr")
        expect(JSON.stringify(request.messages)).toContain("exitCode")
        return streamText("The script exited with code 7.")
      }
    )
    const result = await runChat({
      conversationId: conversation.id,
      message: "",
      bashBlock: { messageId: source.id, offset: 0 },
      autoMode: true,
    })
    expect(result.error).toBeUndefined()
    expect(result.content).toContain("code 7")
    const calls = listMessages(conversation.id).flatMap(
      (m) => m.toolCalls ?? []
    )
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0].arguments)).toEqual({
      command: `${command}\n`,
      background: true,
    })
  })

  it("does not spawn a clicked command when its approval is denied", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({
      mode: "interactive",
      workspaceId: upsertWorkspace(workspace).id,
    })
    const source = appendMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: `\`\`\`bash\n${nodeCmd("console.log('never ran')")}\n\`\`\``,
    })
    const spawn = vi.spyOn(LocalEnvironment.prototype, "spawnCommand")
    scriptedCompletions.push((request) => {
      expect(lastMessage(request, "tool")?.content).toContain("ERROR[denied]")
      return streamText("The command was not run.")
    })
    const result = await runChat(
      {
        conversationId: conversation.id,
        message: "",
        bashBlock: { messageId: source.id, offset: 0 },
      },
      (event) => {
        if (event.type === "approval")
          resolveApproval(event.requestId, "denied")
      }
    )
    expect(result.error).toBeUndefined()
    expect(spawn).not.toHaveBeenCalled()
  })

  it("stops a clicked background command without waking another model request", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({
      mode: "interactive",
      workspaceId: upsertWorkspace(workspace).id,
    })
    const source = appendMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: `\`\`\`bash\n${nodeCmd("setTimeout(() => console.log('late'), 2000)")}\n\`\`\``,
    })
    scriptedCompletions.push(() => streamText("Waiting."))
    const result = await runChat(
      {
        conversationId: conversation.id,
        message: "",
        bashBlock: { messageId: source.id, offset: 0 },
        autoMode: true,
      },
      (event) => {
        if (event.type === "command_wait" && event.phase === "start")
          stopChat(conversation.id)
      }
    )
    expect(result.stopped).toBe(true)
    expect(completionRequests).toHaveLength(1)
  })

  it("rejects a second click while the first command turn is active", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({
      mode: "interactive",
      workspaceId: upsertWorkspace(workspace).id,
    })
    const source = appendMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: `\`\`\`bash\n${nodeCmd("console.log('once')")}\n\`\`\``,
    })
    const req = {
      conversationId: conversation.id,
      message: "",
      bashBlock: { messageId: source.id, offset: 0 },
    }
    let duplicate: ReturnType<typeof runChat> | undefined
    scriptedCompletions.push(() => streamText("Not run."))
    await runChat(req, (event) => {
      if (event.type === "approval") {
        duplicate = runChat(req)
        resolveApproval(event.requestId, "denied")
      }
    })
    expect((await duplicate)?.error).toContain("idle conversation")
    expect(
      listMessages(conversation.id).flatMap((m) => m.toolCalls ?? [])
    ).toHaveLength(1)
  })

  it("rejects plan mode, user-authored commands, and stale block offsets", async () => {
    const conversation = createConversation({ mode: "interactive" })
    const source = appendMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: "```bash\necho no\n```",
    })
    const user = appendMessage({
      conversationId: conversation.id,
      role: "user",
      content: source.content,
    })
    for (const extra of [
      { bashBlock: { messageId: source.id, offset: 0 }, planMode: true },
      { bashBlock: { messageId: user.id, offset: 0 } },
      { bashBlock: { messageId: source.id, offset: 99 } },
    ]) {
      const result = await runChat({
        conversationId: conversation.id,
        message: "",
        ...extra,
      })
      expect(result.error).toBeDefined()
    }
    expect(completionRequests).toHaveLength(0)
    expect(
      listMessages(conversation.id).flatMap((m) => m.toolCalls ?? [])
    ).toHaveLength(0)
  })

  it("rejects a clicked block from another conversation without starting a model or command", async () => {
    const a = createConversation({ mode: "chat" })
    const b = createConversation({ mode: "chat" })
    const source = appendMessage({
      conversationId: a.id,
      role: "assistant",
      content: "```bash\necho nope\n```",
    })
    const result = await runChat({
      conversationId: b.id,
      message: "",
      bashBlock: { messageId: source.id, offset: 0 },
    })
    expect(result.error).toContain("does not belong")
    expect(completionRequests).toHaveLength(0)
    expect(listMessages(b.id)).toHaveLength(0)
  })

  it.each(["textful", "textless", "partial", "markup", "filter", "reasoning"])(
    "persists terminal refusal without tools or retries (%s)",
    async (kind) => {
      const workspace = await makeWorkspace()
      const conversation = createConversation({ mode: "interactive" })
      const markup =
        '<tool_call>{"name":"exec_command","arguments":{"command":"echo should-not-run"}}</tool_call>'
      scriptedCompletions.push(() =>
        (async function* () {
          yield {
            choices: [
              {
                delta: {
                  ...(kind === "textful"
                    ? { content: "I cannot complete this request." }
                    : {}),
                  ...(kind === "markup"
                    ? { content: `I declined this call: ${markup}` }
                    : {}),
                  ...(kind === "reasoning"
                    ? {
                        reasoning_content: "private thinking",
                        reasoning: "more private thinking",
                      }
                    : {}),
                  ...(kind === "partial"
                    ? {
                        tool_calls: [
                          {
                            index: 0,
                            id: "denied",
                            type: "function",
                            function: {
                              name: "exec_command",
                              arguments: '{"command":',
                            },
                          },
                        ],
                      }
                    : {}),
                },
                finish_reason: null,
              },
            ],
          }
          yield {
            choices: [
              {
                delta:
                  kind === "textless" || kind === "filter"
                    ? {}
                    : { refusal: "Request declined." },
                finish_reason: kind === "filter" ? "content_filter" : "refusal",
              },
            ],
          }
        })()
      )
      const events: any[] = []
      const result = await runAgentLoop({
        conversationId: conversation.id,
        workspace,
        userMessage: "Perform the task",
        abort: new AbortController(),
        onEvent: (event) => events.push(event),
      })
      expect(result.error).toBeUndefined()
      expect(result.content).toBeTruthy()
      expect(result.content).not.toContain("private thinking")
      if (kind === "markup") expect(result.content).toContain(markup)
      expect(completionRequests).toHaveLength(1)
      const history = listMessages(conversation.id)
      const assistant = history.filter(
        (message) => message.role === "assistant"
      )
      expect(assistant).toHaveLength(1)
      expect(assistant[0].content).toBe(result.content)
      expect(assistant[0].toolCalls).toBeNull()
      expect(history.some((message) => message.role === "tool")).toBe(false)
      expect(listToolCallLifecycle(conversation.id)).toEqual([])
      expect(
        events.some(
          (event) =>
            event.type === "approval_request" || event.type === "tool_start"
        )
      ).toBe(false)
      expect(getBudget(conversation.id, "after-seq:1")).toMatchObject({
        status: "completed",
        attemptsConsumed: 1,
      })
    }
  )

  it.each([
    { background: false, separateTurns: false },
    { background: false, separateTurns: true },
    { background: true, separateTurns: true },
  ])(
    "approves and executes deliberate reruns ($background background, $separateTurns separate turns)",
    async ({ background, separateTurns }) => {
      const workspace = await makeWorkspace()
      const conversation = createConversation({ mode: "interactive" })
      const command = nodeCmd(
        "require('fs').appendFileSync('runs.txt', 'x'); console.log('idle completion')"
      )
      const approvals: string[] = []
      const run = () =>
        runAgentLoop({
          conversationId: conversation.id,
          workspace,
          userMessage: approvals.length
            ? "Run that test again, please."
            : "Run the test.",
          abort: new AbortController(),
          onEvent: (event) => {
            if (event.type !== "approval") return
            approvals.push(event.reason)
            queueMicrotask(() => resolveApproval(event.requestId, "approved"))
          },
        })

      for (const attempt of [1, 2]) {
        scriptedCompletions.push(() =>
          streamToolCalls([
            {
              id: `run_${attempt}`,
              name: "exec_command",
              arguments: JSON.stringify({ command, background }),
            },
          ])
        )
        if (background) {
          scriptedCompletions.push((request) => {
            expect(lastMessage(request, "tool")?.content).not.toContain(
              "ERROR["
            )
            return streamToolCalls([
              {
                id: `wait_${attempt}`,
                name: "wait_for_events",
                arguments: "{}",
              },
            ])
          })
        }
        if (separateTurns || attempt === 2) {
          scriptedCompletions.push((request) => {
            expect(lastMessage(request, "tool")?.content).not.toContain(
              "ERROR["
            )
            return streamText("Test finished.")
          })
          expect(await run()).toEqual({ content: "Test finished." })
        }
      }
      expect(approvals).toHaveLength(2)
      expect(await readFile(join(workspace, "runs.txt"), "utf8")).toBe("xx")
    }
  )

  it("registers an approval before emitting it", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    scriptedCompletions.push(() =>
      streamToolCalls([
        {
          id: "synchronous_approval",
          name: "exec_command",
          arguments: JSON.stringify({ command: nodeCmd("console.log('ran')") }),
        },
      ])
    )
    scriptedCompletions.push((request) => {
      expect(lastMessage(request, "tool")?.content).toContain("ran")
      return streamText("Done.")
    })

    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "Run the command.",
      abort: new AbortController(),
      onEvent: (event) => {
        if (event.type === "approval") {
          resolveApproval(event.requestId, "approved")
        }
      },
    })

    expect(result).toEqual({ content: "Done." })
  })

  it("a kind-wide approval covers later actions of that kind in the conversation", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    const write = (id: string, path: string) =>
      streamToolCalls([
        {
          id,
          name: "write_file_tool",
          arguments: JSON.stringify({ path, mode: "create", content: "x" }),
        },
      ])
    scriptedCompletions.push(() => write("pkg", "package.json"))
    scriptedCompletions.push(() => write("main", "main.py"))
    scriptedCompletions.push(() => streamText("Done."))
    const prompted: string[] = []

    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "Scaffold the project.",
      abort: new AbortController(),
      onEvent: (event) => {
        if (event.type !== "approval") return
        prompted.push(event.summary)
        resolveApproval(event.requestId, "approved", "kind")
      },
    })

    expect(result).toEqual({ content: "Done." })
    // Only the first write prompted; main.py rode the kind-wide grant.
    expect(prompted).toHaveLength(1)
    expect(prompted[0]).toContain("package.json")
    expect(await readFile(join(workspace, "main.py"), "utf8")).toBe("x")
  })

  it("an all-file-changes approval covers creates, edits, and folders", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    const call = (id: string, name: string, args: Record<string, unknown>) =>
      streamToolCalls([{ id, name, arguments: JSON.stringify(args) }])
    scriptedCompletions.push(() =>
      call("create", "write_file_tool", {
        path: "main.py",
        mode: "create",
        content: "print('a')",
      })
    )
    scriptedCompletions.push(() =>
      call("edit", "edit_file_tool", {
        path: "main.py",
        old_string: "'a'",
        new_string: "'b'",
      })
    )
    scriptedCompletions.push(() =>
      call("mkdir", "create_directory", { path: "src" })
    )
    scriptedCompletions.push(() => streamText("Done."))
    const prompted: string[] = []

    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "Scaffold the project.",
      abort: new AbortController(),
      onEvent: (event) => {
        if (event.type !== "approval") return
        prompted.push(event.kind ?? "")
        resolveApproval(event.requestId, "approved", "file_changes")
      },
    })

    expect(result).toEqual({ content: "Done." })
    expect(prompted).toEqual(["file_write"])
    expect(await readFile(join(workspace, "main.py"), "utf8")).toBe(
      "print('b')"
    )
  })

  it("never grants an ineligible kind kind-wide", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    const exec = (id: string, text: string) =>
      streamToolCalls([
        {
          id,
          name: "exec_command",
          arguments: JSON.stringify({
            command: nodeCmd(`console.log('${text}')`),
          }),
        },
      ])
    scriptedCompletions.push(() => exec("one", "one"))
    scriptedCompletions.push(() => exec("two", "two"))
    scriptedCompletions.push(() => streamText("Done."))
    let prompts = 0

    await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "Run both.",
      abort: new AbortController(),
      onEvent: (event) => {
        if (event.type !== "approval") return
        prompts++
        resolveApproval(event.requestId, "approved", "kind")
      },
    })

    expect(prompts).toBe(2)
  })

  it("reuses completed identical calls within the same model request", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    const command = nodeCmd("require('fs').appendFileSync('once.txt', 'x')")
    scriptedCompletions.push(() =>
      streamToolCalls(
        ["original", "duplicate"].map((id) => ({
          id,
          name: "exec_command",
          arguments: JSON.stringify({ command }),
        }))
      )
    )
    scriptedCompletions.push((request) => {
      expect(lastMessage(request, "tool")?.content).not.toContain("ERROR[")
      return streamText("Done.")
    })
    expect(
      await runAgentLoop({
        conversationId: conversation.id,
        workspace,
        userMessage: "Run once.",
        abort: new AbortController(),
        autoMode: true,
        onEvent: () => {},
      })
    ).toEqual({ content: "Done." })
    expect(await readFile(join(workspace, "once.txt"), "utf8")).toBe("x")
    const results = contentsByCallId(conversation.id)
    expect(results.get("duplicate")).toBe(results.get("original"))
  })

  it("executes distinct writes sharing an approval identity in the same request", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    scriptedCompletions.push(() =>
      streamToolCalls(
        ["one", "two"].map((content) => ({
          id: `write_${content}`,
          name: "write_file_tool",
          arguments: JSON.stringify({
            path: "chunks.txt",
            mode: "append",
            content,
          }),
        }))
      )
    )
    scriptedCompletions.push(() => streamText("Done."))
    expect(
      await runAgentLoop({
        conversationId: conversation.id,
        workspace,
        userMessage: "Write both chunks.",
        abort: new AbortController(),
        autoMode: true,
        onEvent: () => {},
      })
    ).toEqual({ content: "Done." })
    expect(await readFile(join(workspace, "chunks.txt"), "utf8")).toBe("onetwo")
  })

  it("does not reuse a denial when a later request repeats the command", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    let approvals = 0
    for (const decision of ["denied", "approved"] as const) {
      scriptedCompletions.push(() =>
        streamToolCalls([
          {
            id: `run_${decision}`,
            name: "exec_command",
            arguments: JSON.stringify({
              command: nodeCmd("console.log('ran again')"),
            }),
          },
        ])
      )
      scriptedCompletions.push((request) => {
        expect(lastMessage(request, "tool")?.content).toContain(
          decision === "denied" ? "ERROR[denied]" : "ran again"
        )
        return streamText("Done.")
      })
      expect(
        await runAgentLoop({
          conversationId: conversation.id,
          workspace,
          userMessage: "Run the command.",
          abort: new AbortController(),
          onEvent: (event) => {
            if (event.type !== "approval") return
            approvals += 1
            queueMicrotask(() => resolveApproval(event.requestId, decision))
          },
        })
      ).toEqual({ content: "Done." })
    }
    expect(approvals).toBe(2)
  })

  it("reports the classifier reason for a hard block", async () => {
    const spawn = vi
      .spyOn(LocalEnvironment.prototype, "spawnCommand")
      .mockImplementation(async () => {
        throw new Error("Must not spawn a blocked command")
      })
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    scriptedCompletions.push(() =>
      streamToolCalls([
        {
          id: "hard_block",
          name: "exec_command",
          arguments: JSON.stringify({ command: "rm -rf /" }),
        },
      ])
    )
    scriptedCompletions.push((request) => {
      expect(lastMessage(request, "tool")?.content).toBe(
        "ERROR[blocked]: recursive delete of root filesystem"
      )
      return streamText("Blocked.")
    })
    expect(
      await runAgentLoop({
        conversationId: conversation.id,
        workspace,
        userMessage: "Check the block.",
        abort: new AbortController(),
        autoMode: true,
        onEvent: () => {},
      })
    ).toEqual({ content: "Blocked." })
    expect(spawn).not.toHaveBeenCalled()
  })

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
      expect(lastMessage(request, "tool")?.content).toContain(
        "ERROR[tool_reconciliation_blocked]"
      )
      expect(lastMessage(request, "tool")?.content).toContain("unknown outcome")
      expect(lastMessage(request, "tool")?.content).not.toContain("blocklist")
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

  it("waits for owned background command completion before finalizing", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })

    scriptedCompletions.push(() =>
      streamToolCalls([
        {
          id: "start_background",
          name: "exec_command",
          arguments: JSON.stringify({
            command: nodeCmd(
              "setTimeout(() => { process.stdout.write('background done\\n'); process.exit(0) }, 60)"
            ),
            background: true,
          }),
        },
      ])
    )
    scriptedCompletions.push(() => streamEmpty("stop"))
    scriptedCompletions.push((request) => {
      const runtimeEvent = lastMessage(request, "user")
      expect(runtimeEvent?.content).toContain(
        "Runtime event: background command completion"
      )
      expect(runtimeEvent?.content).toContain("background done")
      return streamText("Observed the background completion.")
    })

    const events: TaskEventPayload[] = []
    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "start a background command",
      abort: new AbortController(),
      autoMode: true,
      onEvent: (event) => events.push(event),
    })

    expect(result).toEqual({ content: "Observed the background completion." })
    expect(
      events
        .filter((event) => event.type === "command_wait")
        .map((event) => event.phase)
    ).toEqual(["start", "done"])
    expect(completionRequests).toHaveLength(3)
    expect(
      listMessages(conversation.id).some(
        (message) =>
          message.role === "assistant" &&
          typeof message.content === "string" &&
          message.content.trim().length === 0
      )
    ).toBe(false)
    expect(
      listMessages(conversation.id).some(
        (message) =>
          message.role === "system" &&
          String(message.content ?? "").includes(
            "Runtime event: background command completion"
          )
      )
    ).toBe(true)
  })

  it("offers only read-only tools and refuses writes on a read-only turn", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "north_star" })

    scriptedCompletions.push(() =>
      streamToolCalls([
        {
          id: "call_write",
          name: "write_file_tool",
          arguments: JSON.stringify({ path: "out.txt", content: "x" }),
        },
      ])
    )
    scriptedCompletions.push(() => streamText("done"))

    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "validate",
      abort: new AbortController(),
      autoMode: true,
      unattended: true,
      readOnlyTools: true,
      onEvent: () => {},
    })

    expect(result).toEqual({ content: "done" })
    expect(completionRequests[0].tools).toContain("read_file_tool")
    for (const name of [
      "write_file_tool",
      "edit_file_tool",
      "apply_patch_tool",
      "exec_command",
      "write_plan",
    ])
      expect(completionRequests[0].tools).not.toContain(name)
    await expect(access(join(workspace, "out.txt"))).rejects.toThrow()
  })

  it("retries an empty final model response without persisting a blank assistant message", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })

    scriptedCompletions.push(() => streamEmpty("stop"))
    scriptedCompletions.push(() => streamText("Recovered final answer."))

    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "finish the task",
      abort: new AbortController(),
      onEvent: () => {},
    })

    expect(result).toEqual({ content: "Recovered final answer." })
    expect(completionRequests).toHaveLength(2)
    const budget = getBudget(conversation.id, "after-seq:1")
    expect(budget).toMatchObject({
      status: "completed",
      attemptsConsumed: 2,
    })
    expect(budget!.lastError).toContain(
      "The model returned no usable answer. The turn ended before it could finish."
    )
    expect(budget!.lastError).toContain("[model_response_diagnostic]")
    const assistantMessages = listMessages(conversation.id).filter(
      (message) => message.role === "assistant"
    )
    expect(assistantMessages.map((message) => message.content)).toEqual([
      "Recovered final answer.",
    ])
  })

  it("fails repeated empty final model responses without completing the retry budget", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })

    scriptedCompletions.push(() => streamEmpty("stop"))
    scriptedCompletions.push(() => streamEmpty("stop"))
    scriptedCompletions.push(() => streamEmpty("stop"))

    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "finish the task",
      abort: new AbortController(),
      onEvent: () => {},
    })

    expect(result.error).toContain("The model returned no usable answer")
    expect(result.retryable).toBe(false)
    expect(completionRequests).toHaveLength(3)
    const budget = getBudget(conversation.id, "after-seq:1")
    expect(budget).toMatchObject({
      status: "exhausted",
      attemptsConsumed: 3,
    })
    expect(budget!.lastError).toContain(
      "The model returned no usable answer. The turn ended before it could finish."
    )
    expect(budget!.lastError).toContain("[model_response_diagnostic]")
    const assistantMessages = listMessages(conversation.id).filter(
      (message) => message.role === "assistant"
    )
    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0].content).toContain(
      "The model returned no usable answer"
    )
  })

  describe("hung streams", () => {
    const saved = { ...MODEL_STREAM_IDLE }
    beforeEach(() => {
      MODEL_STREAM_IDLE.firstChunkMs = 40
      MODEL_STREAM_IDLE.betweenChunksMs = 40
    })
    afterEach(() => Object.assign(MODEL_STREAM_IDLE, saved))

    const hanging = (firstChunk?: string): AsyncIterable<any> =>
      (async function* () {
        if (firstChunk)
          yield {
            choices: [{ delta: { content: firstChunk }, finish_reason: null }],
          }
        await new Promise(() => {})
      })()

    it("re-issues a round whose stream never sends anything", async () => {
      const workspace = await makeWorkspace()
      const conversation = createConversation({ mode: "interactive" })
      scriptedCompletions.push(
        () => hanging(),
        () => streamText("Recovered.")
      )
      const result = await runAgentLoop({
        conversationId: conversation.id,
        workspace,
        userMessage: "go",
        abort: new AbortController(),
        onEvent: () => {},
      })
      expect(result).toEqual({ content: "Recovered." })
      expect(completionRequests).toHaveLength(2)
      expect(getBudget(conversation.id, "after-seq:1:stall-1")).toMatchObject({
        status: "completed",
      })
    })

    it("discards a stream that stops mid-reply and re-issues the round", async () => {
      const workspace = await makeWorkspace()
      const conversation = createConversation({ mode: "interactive" })
      scriptedCompletions.push(
        () => hanging("Half an ans"),
        () => streamText("Whole answer.")
      )
      const result = await runAgentLoop({
        conversationId: conversation.id,
        workspace,
        userMessage: "go",
        abort: new AbortController(),
        onEvent: () => {},
      })
      expect(result).toEqual({ content: "Whole answer." })
    })

    it("fails the turn when the stream stays hung through every re-issue", async () => {
      const workspace = await makeWorkspace()
      const conversation = createConversation({ mode: "interactive" })
      scriptedCompletions.push(
        () => hanging(),
        () => hanging(),
        () => hanging()
      )
      const result = await runAgentLoop({
        conversationId: conversation.id,
        workspace,
        userMessage: "go",
        abort: new AbortController(),
        onEvent: () => {},
      })
      expect(result.error).toContain("looks hung")
      expect(completionRequests).toHaveLength(3)
    })
  })

  it("delivers a note left mid-turn before the next model round, once", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    addConversationNote(
      conversation.id,
      "Stop investigating and write the plan.",
      "user"
    )

    scriptedCompletions.push(() => streamText("Plan written."))
    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "refine the story",
      abort: new AbortController(),
      onEvent: () => {},
    })

    expect(result).toEqual({ content: "Plan written." })
    const last = completionRequests[0].messages.at(-1)
    expect(last).toMatchObject({ role: "user" })
    expect(String(last.content)).toContain(
      "Note from the user while you work:\n\nStop investigating and write the plan."
    )
    expect(takeConversationNotes(conversation.id)).toEqual([])
  })

  it("re-issues an empty length response with a higher output cap", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })

    scriptedCompletions.push(
      () => streamEmpty("length"),
      () => streamText("Done after raising the cap.")
    )

    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "finish the task",
      abort: new AbortController(),
      onEvent: () => {},
    })

    expect(result).toEqual({ content: "Done after raising the cap." })
    expect(completionRequests.map((r) => r.maxTokens)).toEqual([8192, 16_384])
    expect(getBudget(conversation.id, "after-seq:1")).toMatchObject({
      status: "exhausted",
      attemptsConsumed: 1,
    })
  })

  it("re-issues a truncated text reply instead of taking it as the answer", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })

    scriptedCompletions.push(
      () => streamTextEnding(TRUNCATED_DSML, "length"),
      () => streamText("Verified: the schedule survives every rewrite path.")
    )

    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "verify the story",
      abort: new AbortController(),
      onEvent: () => {},
    })

    expect(result).toEqual({
      content: "Verified: the schedule survives every rewrite path.",
    })
    expect(completionRequests.map((r) => r.maxTokens)).toEqual([8192, 16_384])
  })

  it("fails a reply that is still a truncated tool call at the top cap", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })

    scriptedCompletions.push(
      () => streamTextEnding(TRUNCATED_DSML, "length"),
      () => streamTextEnding(TRUNCATED_DSML, "length"),
      () => streamTextEnding(TRUNCATED_DSML, "length")
    )

    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "verify the story",
      abort: new AbortController(),
      onEvent: () => {},
    })

    expect(result.error).toContain("in the middle of a tool call")
    expect(result.retryable).toBe(false)
  })

  it("retries a tool call that arrived as unparsed text", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })

    scriptedCompletions.push(
      () =>
        streamTextEnding(
          '<｜DSML｜ invoke name="list_files_tool">\n<｜DSML｜ parameter name="path" string="true">.</｜DSML｜ parameter>\n</｜DSML｜ invoke>',
          "stop"
        ),
      () => streamText("Done.")
    )

    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "list the files",
      abort: new AbortController(),
      onEvent: () => {},
    })

    expect(result).toEqual({ content: "Done." })
    expect(completionRequests).toHaveLength(2)
    expect(getBudget(conversation.id, "after-seq:1")).toMatchObject({
      status: "completed",
      attemptsConsumed: 2,
    })
  })

  it("fails empty length responses once the output cap can't go higher", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })

    scriptedCompletions.push(
      () => streamEmpty("length"),
      () => streamEmpty("length"),
      () => streamEmpty("length")
    )

    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "finish the task",
      abort: new AbortController(),
      onEvent: () => {},
    })

    expect(result.error).toContain("output limit")
    expect(result.retryable).toBe(false)
    expect(completionRequests.map((r) => r.maxTokens)).toEqual([
      8192, 16_384, 32_768,
    ])
    expect(getBudget(conversation.id, "after-seq:1:cap-32768")).toMatchObject({
      status: "exhausted",
      attemptsConsumed: 1,
    })
  })

  it("keeps the output-limit failure when the provider rejects a higher cap", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })

    scriptedCompletions.push(
      () => streamEmpty("length"),
      () => {
        throw new Error("max_tokens is too large: 16384")
      }
    )

    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "finish the task",
      abort: new AbortController(),
      onEvent: () => {},
    })

    expect(result.error).toContain("rejected a higher output cap")
    expect(result.retryable).toBe(false)
    expect(completionRequests).toHaveLength(2)
  })

  it.each([
    {
      finishReason: "unexpected_reason",
      expected: 'unsupported finish reason "unexpected_reason"',
    },
  ])(
    "fails empty $finishReason responses without an automatic retry",
    async ({ finishReason, expected }) => {
      const workspace = await makeWorkspace()
      const conversation = createConversation({ mode: "interactive" })

      scriptedCompletions.push(() => streamEmpty(finishReason))

      const result = await runAgentLoop({
        conversationId: conversation.id,
        workspace,
        userMessage: "finish the task",
        abort: new AbortController(),
        onEvent: () => {},
      })

      expect(result.error).toContain(expected)
      expect(result.retryable).toBe(false)
      expect(completionRequests).toHaveLength(1)
      expect(getBudget(conversation.id, "after-seq:1")).toMatchObject({
        status: "exhausted",
        attemptsConsumed: 1,
      })
    }
  )

  it.each([
    {
      label: "withholds delegation from an opted-out conversation",
      conversationSubagentsEnabled: false,
      offered: false,
    },
    {
      label: "offers delegation to an opted-in conversation",
      conversationSubagentsEnabled: true,
      offered: true,
    },
    {
      label: "preserves delegation for independent background runs",
      conversationSubagentsEnabled: undefined,
      offered: true,
    },
  ])("$label", async ({ conversationSubagentsEnabled, offered }) => {
    const workspace = await makeWorkspace()
    const agentsDir = join(workspace, ".cowork", "agents")
    await mkdir(agentsDir, { recursive: true })
    await writeFile(
      join(agentsDir, "parent.agent.md"),
      [
        "---",
        "name: parent",
        "description: Delegates work.",
        "tools: [agent]",
        "children: [child]",
        "user-invocable: true",
        "---",
        "Delegate suitable work.",
      ].join("\n"),
      "utf-8"
    )
    await writeFile(
      join(agentsDir, "child.agent.md"),
      [
        "---",
        "name: child",
        "description: Handles delegated work.",
        "tools: [read]",
        "---",
        "Read files and report back.",
      ].join("\n"),
      "utf-8"
    )
    const conversation = createConversation({
      mode: "interactive",
      agentName: "parent",
    })

    scriptedCompletions.push((request) => {
      expect(request.tools.includes("spawn_subagent")).toBe(offered)
      expect(request.tools.includes("spawn_subagents")).toBe(offered)
      const system = request.messages.find(
        (message) => message.role === "system"
      )?.content as string
      expect(system.includes("## Subagents")).toBe(offered)
      return streamText("Done.")
    })

    expect(
      await runAgentLoop({
        conversationId: conversation.id,
        workspace,
        agentDir: workspace,
        userMessage: "Handle this task.",
        abort: new AbortController(),
        conversationSubagentsEnabled,
        onEvent: () => {},
      })
    ).toEqual({ content: "Done." })
  })

  it.each([false, true])(
    "tool handoff carries the trusted %s snapshot, not model arguments",
    async (enabled) => {
      const workspace = await makeWorkspace()
      const conversation = createConversation({ mode: "interactive" })
      replaceTodos(conversation.id, [
        { id: "one", content: "Work", status: "pending" },
      ])
      const enqueueTask = vi.fn(() => ({ id: "child-task", status: "queued" }))
      scriptedCompletions.push(() =>
        streamToolCalls([
          {
            id: "handoff",
            name: "run_todos_in_background",
            arguments: JSON.stringify({
              conversationSubagentsEnabled: !enabled,
            }),
          },
        ])
      )
      scriptedCompletions.push(() => streamText("Done."))
      expect(
        await runAgentLoop({
          conversationId: conversation.id,
          workspace,
          userMessage: "Work",
          abort: new AbortController(),
          autoMode: true,
          conversationSubagentsEnabled: enabled,
          enqueueTask,
        })
      ).toEqual({ content: "Done." })
      expect(enqueueTask).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "todo_run",
          conversationId: conversation.id,
        }),
        enabled
      )
    }
  )

  it.each(["spawn_subagent", "spawn_subagents"])(
    "rejects stale %s calls with delegation off",
    async (name) => {
      const workspace = await makeWorkspace()
      const conversation = createConversation({ mode: "interactive" })
      scriptedCompletions.push((request) => {
        expect(request.tools).not.toContain("spawn_subagent")
        expect(request.tools).not.toContain("spawn_subagents")
        return streamToolCalls([
          {
            id: "stale-spawn",
            name,
            arguments: JSON.stringify(
              name === "spawn_subagent"
                ? { agent_name: "child", prompt: "Go" }
                : {
                    assignments: [
                      {
                        id: "writer",
                        agent: { type: "ephemeral", profile: "general" },
                        prompt: "Go",
                        access: "write",
                      },
                    ],
                  }
            ),
          },
        ])
      })
      scriptedCompletions.push((request) => {
        expect(JSON.stringify(request.messages)).toContain(
          "ERROR[tool_unavailable]"
        )
        return streamText("Done.")
      })
      expect(
        await runAgentLoop({
          conversationId: conversation.id,
          workspace,
          userMessage: "Work",
          abort: new AbortController(),
          conversationSubagentsEnabled: false,
        })
      ).toEqual({ content: "Done." })
      expect(completionRequests).toHaveLength(2)
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM conversations").get()
      ).toEqual({ n: 1 })
      expect(db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({
        n: 0,
      })
    }
  )

  it.each([
    { label: "passes a chat's Python venv to its subagents", chat: true },
    { label: "keeps the venv from subagents of other runs", chat: false },
  ])("$label", async ({ chat }) => {
    const workspace = await makeWorkspace()
    const agentsDir = join(workspace, ".cowork", "agents")
    await mkdir(agentsDir, { recursive: true })
    await writeFile(
      join(agentsDir, "parent.agent.md"),
      [
        "---",
        "name: parent",
        "description: Delegates work.",
        "tools: [agent]",
        "children: [child]",
        "user-invocable: true",
        "---",
        "Delegate suitable work.",
      ].join("\n"),
      "utf-8"
    )
    await writeFile(
      join(agentsDir, "child.agent.md"),
      [
        "---",
        "name: child",
        "description: Handles delegated work.",
        "tools: [read]",
        "---",
        "Read files and report back.",
      ].join("\n"),
      "utf-8"
    )
    const conversation = createConversation({
      mode: "interactive",
      agentName: "parent",
    })
    // Record rather than assert inside the callbacks: a throw in the child's
    // completion is caught by the child loop and would not fail the test.
    const sawVenvNote: boolean[] = []
    const recordVenvNote = (request: CompletionRequest) =>
      sawVenvNote.push(
        (
          request.messages.find((message) => message.role === "system")
            ?.content as string
        ).includes("## Python packages")
      )

    scriptedCompletions.push((request) => {
      recordVenvNote(request)
      return streamToolCalls([
        {
          id: "spawn-1",
          name: "spawn_subagent",
          arguments: JSON.stringify({ agent_name: "child", prompt: "Go." }),
        },
      ])
    })
    scriptedCompletions.push((request) => {
      recordVenvNote(request)
      return streamText("Child done.")
    })
    scriptedCompletions.push(() => streamText("Done."))

    expect(
      await runAgentLoop({
        conversationId: conversation.id,
        workspace,
        agentDir: workspace,
        userMessage: "Handle this task.",
        abort: new AbortController(),
        conversationSubagentsEnabled: true,
        chatPythonVenv: chat,
        onEvent: () => {},
      })
    ).toEqual({ content: "Done." })
    expect(scriptedCompletions).toHaveLength(0)
    // [parent's first request, child's request]
    expect(sawVenvNote).toEqual([chat, chat])
  })

  // Plan 033.4 offering policy: dashboard_read rides with dashboard_write in
  // non-Chat modes but stays offered in plan mode; custom agents opt in through
  // `dashboard` (read + write) or the read-only `dashboard_read` category.
  it.each([
    {
      label: "chat",
      mode: "chat",
      planMode: false,
      tools: undefined,
      read: false,
      write: false,
    },
    {
      label: "interactive",
      mode: "interactive",
      planMode: false,
      tools: undefined,
      read: true,
      write: true,
    },
    {
      label: "plan mode",
      mode: "interactive",
      planMode: true,
      tools: undefined,
      read: true,
      write: false,
    },
    {
      label: "agent [dashboard]",
      mode: "interactive",
      planMode: false,
      tools: "[dashboard]",
      read: true,
      write: true,
    },
    {
      label: "agent [dashboard_read]",
      mode: "interactive",
      planMode: false,
      tools: "[dashboard_read]",
      read: true,
      write: false,
    },
    {
      label: "agent [read]",
      mode: "interactive",
      planMode: false,
      tools: "[read]",
      read: false,
      write: false,
    },
  ] as const)(
    "offers dashboard tools per policy: $label",
    async ({ mode, planMode, tools, read, write }) => {
      const workspace = await makeWorkspace()
      let agentName: string | undefined
      if (tools) {
        const agentsDir = join(workspace, ".cowork", "agents")
        await mkdir(agentsDir, { recursive: true })
        await writeFile(
          join(agentsDir, "dash.agent.md"),
          [
            "---",
            "name: dash",
            "description: Reads dashboards.",
            `tools: ${tools}`,
            "user-invocable: true",
            "---",
            "Answer from dashboards.",
          ].join("\n"),
          "utf-8"
        )
        agentName = "dash"
      }
      const conversation = createConversation({ mode, agentName })

      scriptedCompletions.push((request) => {
        expect(request.tools.includes("dashboard_read")).toBe(read)
        expect(request.tools.includes("dashboard_write")).toBe(write)
        return streamText("Done.")
      })

      expect(
        await runAgentLoop({
          conversationId: conversation.id,
          workspace,
          agentDir: workspace,
          userMessage: "What does the dashboard say?",
          abort: new AbortController(),
          planMode,
          onEvent: () => {},
        })
      ).toEqual({ content: "Done." })
    }
  )

  it("does not execute a known tool body when plan mode makes it unavailable", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })

    scriptedCompletions.push((request) => {
      expect(request.tools).not.toContain("write_file_tool")
      expect(request.tools).toContain("web_fetch")
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

  it("exposes exhausted transport failures for an outer automatic retry", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })

    scriptedCompletions.push(() => {
      throw transientError("fetch failed")
    })
    scriptedCompletions.push(() => {
      throw transientError("fetch failed")
    })
    scriptedCompletions.push(() => {
      throw transientError("fetch failed")
    })

    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "retry the transport failure",
      abort: new AbortController(),
      taskId: "task-1",
      onEvent: () => {},
    })

    expect(result.error).toBe(
      "Model request failed after 3 attempts: fetch failed"
    )
    expect(result.retryable).toBe(true)
    expect(result.failure).toMatchObject({
      code: "model_request_retry_exhausted",
      stage: "model_request",
      retryable: true,
      taskId: "task-1",
    })
    expect(completionRequests).toHaveLength(3)
  })

  it("repairs interrupted calls before replaying later failure and user messages", async () => {
    const conversation = createConversation({ mode: "chat" })
    appendMessage({
      conversationId: conversation.id,
      role: "user",
      content: "inspect",
    })
    appendMessage({
      conversationId: conversation.id,
      role: "assistant",
      toolCalls: [
        {
          id: "interrupted-read",
          name: "read_file_tool",
          arguments: '{"path":"notes.txt"}',
        },
      ],
    })
    appendMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: "⚠️ The turn ended early: Something went wrong",
    })
    appendMessage({
      conversationId: conversation.id,
      role: "user",
      content: "you got cut off",
    })
    scriptedCompletions.push((request) => {
      const index = request.messages.findIndex(
        (m) => m.tool_calls?.[0]?.id === "interrupted-read"
      )
      expect(request.messages[index + 1]).toMatchObject({
        role: "tool",
        tool_call_id: "interrupted-read",
      })
      expect(
        request.messages.some((m) =>
          m.content?.includes("The turn ended early")
        )
      ).toBe(false)
      return streamText("recovered")
    })
    expect(
      await runAgentLoop({
        conversationId: conversation.id,
        userMessage: "try again",
        abort: new AbortController(),
        onEvent: () => {},
      })
    ).toEqual({ content: "recovered" })
  })

  it("does not poison gateway requests or later turns with malformed write arguments", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    const malformed = '{"path": "src/db/_realistic.ts"'
    const run = (userMessage: string) =>
      runAgentLoop({
        conversationId: conversation.id,
        workspace,
        userMessage,
        abort: new AbortController(),
        onEvent: () => {},
      })
    const validateGatewayHistory = (request: CompletionRequest) => {
      for (const message of request.messages) {
        for (const call of message.tool_calls ?? []) {
          expect(() => JSON.parse(call.function.arguments)).not.toThrow()
        }
      }
      const failedCall = request.messages
        .flatMap((m) => m.tool_calls ?? [])
        .find((c) => c.id === "broken-write")
      expect(JSON.parse(failedCall.function.arguments)).toEqual({
        _invalid_tool_arguments: malformed,
      })
      expect(
        request.messages.find((m) => m.tool_call_id === "broken-write")?.content
      ).toContain("ERROR[bad_tool_arguments]")
    }
    scriptedCompletions.push(() =>
      streamToolCalls([
        { id: "broken-write", name: "write_file_tool", arguments: malformed },
      ])
    )
    for (let i = 0; i < 3; i++) {
      scriptedCompletions.push((request) => {
        validateGatewayHistory(request)
        throw transientError("Something went wrong")
      })
    }
    expect((await run("write the file")).error).toContain(
      "failed after 3 attempts"
    )
    scriptedCompletions.push((request) => {
      validateGatewayHistory(request)
      throw new Error("bedrock error: unsupported model")
    })
    expect((await run("you got cut off")).error).toBe(
      "bedrock error: unsupported model"
    )
    scriptedCompletions.push((request) => {
      validateGatewayHistory(request)
      return streamText("recovered")
    })
    expect(await run("try again")).toEqual({ content: "recovered" })
    expect(
      listMessages(conversation.id).find(
        (m) => m.toolCalls?.[0]?.id === "broken-write"
      )?.toolCalls?.[0].arguments
    ).toBe(malformed)
    await expect(
      access(join(workspace, "src/db/_realistic.ts"))
    ).rejects.toThrow()
    expect(completionRequests).toHaveLength(6)
  })

  it("makes fresh model requests after an exhausted turn", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    const conversation = createConversation({ mode: "chat" })
    const run = (userMessage: string) =>
      runAgentLoop({
        conversationId: conversation.id,
        userMessage,
        abort: new AbortController(),
        onEvent: () => {},
      })
    for (let i = 0; i < 3; i++) {
      scriptedCompletions.push(() => {
        throw transientError("Something went wrong")
      })
    }
    expect((await run("hello")).error).toContain("failed after 3 attempts")
    scriptedCompletions.push(() => {
      throw new Error("bedrock error: unsupported model")
    })
    expect((await run("you got cut off")).error).toBe(
      "bedrock error: unsupported model"
    )
    scriptedCompletions.push(() => streamText("recovered"))
    expect(await run("try again")).toEqual({ content: "recovered" })
    expect(completionRequests).toHaveLength(5)
  })

  it("discards partial text and tool fragments from a failed stream retry", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    const streamEvents: Array<
      | { type: "token"; delta: string; attemptId?: string }
      | {
          type: "stream_attempt"
          phase: "start" | "commit" | "rollback"
          attemptId: string
          attempt?: number
          retrying?: boolean
        }
    > = []

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
        if (event.type === "token" || event.type === "stream_attempt") {
          streamEvents.push(event)
        }
      },
    })

    expect(result).toEqual({ content: "clean retry" })
    expect(
      streamEvents.map(({ type, ...event }) => ({ type, ...event }))
    ).toEqual([
      {
        type: "stream_attempt",
        phase: "start",
        attemptId: "after-seq:1:attempt:1",
        attempt: 1,
      },
      {
        type: "token",
        delta: "abandoned text",
        attemptId: "after-seq:1:attempt:1",
      },
      {
        type: "stream_attempt",
        phase: "rollback",
        attemptId: "after-seq:1:attempt:1",
        retrying: true,
      },
      {
        type: "stream_attempt",
        phase: "start",
        attemptId: "after-seq:1:attempt:2",
        attempt: 2,
      },
      {
        type: "token",
        delta: "clean retry",
        attemptId: "after-seq:1:attempt:2",
      },
      {
        type: "stream_attempt",
        phase: "commit",
        attemptId: "after-seq:1:attempt:2",
      },
    ])
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

  it("raises the cap for truncated tool calls, then fails at the top step", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })

    scriptedCompletions.push(
      () => streamLengthToolCall(),
      () => streamLengthToolCall(),
      () => streamLengthToolCall()
    )

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
    // Re-issued at each higher cap before giving up at the top step.
    expect(completionRequests.map((r) => r.maxTokens)).toEqual([
      8192, 16_384, 32_768,
    ])
    expect(getBudget(conversation.id, "after-seq:1:cap-32768")).toMatchObject({
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

describe.skipIf(!sqliteLoads)("tool batch durability and cancellation", () => {
  function installTool(
    execute: Tool["execute"],
    effects = TOOL_EFFECTS.readOnlyParallel as Tool["effects"]
  ) {
    const tool: Tool = {
      effects,
      executionPolicy: { timeoutMs: 100 },
      definition: {
        type: "function",
        function: {
          name: "test_batch_tool",
          description: "Batch fault injection",
          parameters: { type: "object", properties: {} },
        },
      },
      execute,
    }
    toolRegistry.byName.set("test_batch_tool", tool)
    toolDefinitions.push(tool.definition)
    return tool
  }
  afterEach(() => {
    vi.useRealTimers()
    toolRegistry.byName.delete("test_batch_tool")
    const index = toolDefinitions.findIndex(
      (tool) => tool.function.name === "test_batch_tool"
    )
    if (index !== -1) toolDefinitions.splice(index, 1)
  })
  const batchCall = (id: string) => ({
    id,
    name: "test_batch_tool",
    arguments: JSON.stringify({ id }),
  })

  it("persists activity metadata but excludes it from executable tool arguments", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    const execute = vi.fn<Tool["execute"]>(async () => "inspected")
    installTool(execute)
    scriptedCompletions.push(() =>
      streamToolCalls([
        {
          ...batchCall("activity"),
          arguments: JSON.stringify({
            id: "activity",
            _activity: "Inspecting prompt construction",
          }),
        },
      ])
    )
    scriptedCompletions.push(() => streamText("Done"))
    await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "inspect",
      abort: new AbortController(),
      onEvent: () => {},
    })
    expect(execute.mock.calls[0][0]).toEqual({ id: "activity" })
    const saved = listMessages(conversation.id).flatMap(
      (message) => message.toolCalls ?? []
    )
    expect(
      JSON.parse(saved.find((call) => call.id === "activity")!.arguments)
        ._activity
    ).toBe("Inspecting prompt construction")
  })

  it("durably saves siblings while a read hangs, then projects one ordered result per call", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    let finish!: (result: string) => void
    let lateImage!: () => void
    let pendingEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      pendingEntered = resolve
    })
    let pendingSignal!: AbortSignal
    installTool(async (args, ctx) => {
      if (args.id === "bad") throw new Error("controlled read error")
      if (args.id === "good") return "successful sibling"
      pendingSignal = ctx.signal!
      lateImage = () => ctx.emitImage?.({ jpegBase64: "late", alt: "late" })
      return new Promise((resolve) => {
        finish = resolve
        pendingEntered()
      })
    })
    scriptedCompletions.push(() =>
      streamToolCalls([
        batchCall("pending"),
        batchCall("bad"),
        batchCall("good"),
      ])
    )
    scriptedCompletions.push((request) => {
      const results = request.messages.filter((m) => m.role === "tool")
      expect(results.map((r) => r.tool_call_id)).toEqual([
        "pending",
        "bad",
        "good",
      ])
      expect(results[0].content).toContain("ERROR[tool_timeout]")
      expect(results[1].content).toContain("controlled read error")
      expect(results[2].content).toBe("successful sibling")
      return streamText("Recovered after deadline")
    })
    vi.useFakeTimers()
    let siblingsDone!: () => void
    const siblings = new Promise<void>((resolve) => {
      siblingsDone = resolve
    })
    let done = 0
    const run = runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "read",
      abort: new AbortController(),
      onEvent: (event) => {
        if (event.type === "tool" && event.phase === "done" && ++done === 2)
          siblingsDone()
      },
    })
    await Promise.all([siblings, entered])
    expect(
      listToolCallLifecycle(conversation.id).map((r) => [
        r.toolCallId,
        r.state,
        r.result,
      ])
    ).toEqual([
      ["pending", "started", null],
      [
        "bad",
        "settled_error",
        expect.stringContaining("controlled read error"),
      ],
      ["good", "settled_success", "successful sibling"],
    ])
    expect(completionRequests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(await run).toEqual({ content: "Recovered after deadline" })
    expect(pendingSignal.aborted).toBe(true)
    const before = listMessages(conversation.id)
    lateImage()
    finish("late success")
    await vi.advanceTimersByTimeAsync(0)
    expect(listMessages(conversation.id)).toEqual(before)
    expect(done).toBe(3)
    expect(toolRows(conversation.id).map((r) => r.toolCallId)).toEqual([
      "pending",
      "bad",
      "good",
    ])
  })

  it("records unknown mutation outcomes, prevents the next barrier/model request, and blocks replay", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    let entered!: () => void
    const active = new Promise<void>((resolve) => {
      entered = resolve
    })
    const execute = vi.fn(async () => {
      entered()
      return new Promise<string>(() => {})
    })
    installTool(execute, TOOL_EFFECTS.mutation)
    scriptedCompletions.push(() =>
      streamToolCalls([batchCall("mutation"), batchCall("later")])
    )
    vi.useFakeTimers()
    const run = runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "change",
      abort: new AbortController(),
      onEvent: () => {},
    })
    await active
    await vi.advanceTimersByTimeAsync(100)
    expect((await run).error).toContain("Reconcile")
    expect(execute).toHaveBeenCalledTimes(1)
    expect(completionRequests).toHaveLength(1)
    expect(listToolCallLifecycle(conversation.id).map((r) => r.state)).toEqual([
      "unknown",
      "not_started",
    ])
    expect(
      unknownSideEffectingToolCalls(conversation.id).map((c) => c.id)
    ).toEqual(["mutation"])
    repairDanglingToolCalls(conversation.id)
    expect(toolRows(conversation.id)).toHaveLength(2)
  })

  it("Stop settles active reads without dispatching queued calls, mutations, or another model request", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    const abort = new AbortController()
    let started!: () => void
    const active = new Promise<void>((resolve) => {
      started = resolve
    })
    let executions = 0
    installTool(async () => {
      if (++executions === 4) started()
      return new Promise<string>(() => {})
    })
    scriptedCompletions.push(() =>
      streamToolCalls([
        ...["a", "b", "c", "d", "queued"].map(batchCall),
        {
          id: "mutation",
          name: "write_file_tool",
          arguments: JSON.stringify({
            path: "should-not-exist.txt",
            content: "bad",
          }),
        },
      ])
    )
    const run = runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "read",
      abort,
      onEvent: () => {},
    })
    await active
    abort.abort()
    expect(await run).toMatchObject({ stopped: true })
    expect(executions).toBe(4)
    expect(completionRequests).toHaveLength(1)
    expect(listToolCallLifecycle(conversation.id).map((r) => r.state)).toEqual([
      "settled_error",
      "settled_error",
      "settled_error",
      "settled_error",
      "not_started",
      "not_started",
    ])
    expect(toolRows(conversation.id)).toHaveLength(6)
    await expect(
      access(join(workspace, "should-not-exist.txt"))
    ).rejects.toThrow()
  })

  it("surfaces lifecycle persistence faults as result_persistence", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    installTool(async () => "backend result")
    // Fail only terminal lifecycle persistence, after execution has returned.
    db.exec(`CREATE TRIGGER fail_tool_result BEFORE UPDATE OF state ON tool_call_lifecycle
      WHEN NEW.state = 'settled_success' BEGIN SELECT RAISE(FAIL, 'disk failure'); END`)
    scriptedCompletions.push(() => streamToolCalls([batchCall("persist_fail")]))
    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "read",
      abort: new AbortController(),
      onEvent: () => {},
    })
    expect(result).toMatchObject({
      retryable: false,
      failure: { stage: "result_persistence", toolCallId: "persist_fail" },
    })
    expect(completionRequests).toHaveLength(1)
    expect(toolRows(conversation.id)).toHaveLength(0)
    expect(listToolCallLifecycle(conversation.id)[0].state).toBe("started")
  })

  it("rebuilds ordered messages from durable lifecycle results if transcript persistence fails", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    installTool(async (args) => String(args.id))
    db.exec(`CREATE TRIGGER fail_tool_message BEFORE INSERT ON messages
      WHEN NEW.role = 'tool' BEGIN SELECT RAISE(FAIL, 'disk failure'); END`)
    scriptedCompletions.push(() =>
      streamToolCalls([batchCall("first"), batchCall("second")])
    )
    const result = await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "read",
      abort: new AbortController(),
      onEvent: () => {},
    })
    expect(result.failure?.stage).toBe("result_persistence")
    expect(listToolCallLifecycle(conversation.id).map((r) => r.state)).toEqual([
      "settled_success",
      "settled_success",
    ])
    db.exec("DROP TRIGGER fail_tool_message")
    repairDanglingToolCalls(conversation.id)
    repairDanglingToolCalls(conversation.id)
    expect(
      toolRows(conversation.id).map((r) => [r.toolCallId, r.content])
    ).toEqual([
      ["first", "first"],
      ["second", "second"],
    ])
  })

  it.each([
    ["present_chart", "interactive"],
    ["present_table", "interactive"],
    ["present_chart", "chat"],
    ["present_table", "chat"],
  ] as const)(
    "persists %s in %s with activity metadata and replays an equivalent invocation",
    async (toolName, mode) => {
      const conversation = createConversation({ mode })
      const args = {
        " _activity": "Presenting observed results",
        title: "Observed results",
        ...(toolName === "present_chart"
          ? {
              chartKind: "line",
              xKey: "period",
              series: [{ key: "value", label: "Value" }],
            }
          : {
              columns: [
                { key: "period", label: "Period", valueType: "string" },
                { key: "value", label: "Value", valueType: "number" },
              ],
            }),
        data: [
          { period: "Jan", value: 0 },
          { period: "Feb", value: null },
        ],
      }
      let acknowledgement: string | undefined
      const artifacts: unknown[] = []
      scriptedCompletions.push(
        (request) => {
          expect(request.tools).toContain(toolName)
          return streamToolCalls([
            {
              id: "chart-first",
              name: toolName,
              arguments: JSON.stringify(args),
            },
          ])
        },
        (request) => {
          acknowledgement = lastMessage(request, "tool")?.content as string
          expect(JSON.parse(acknowledgement)).toMatchObject({
            status: "saved_for_presentation",
            revision: 1,
            rowCount: 2,
          })
          return streamToolCalls([
            {
              id: "chart-retry",
              name: toolName,
              arguments: JSON.stringify(args),
            },
          ])
        },
        (request) => {
          expect(lastMessage(request, "tool")?.content).toBe(acknowledgement)
          return streamText("Chart saved.")
        }
      )
      const result = await runAgentLoop({
        conversationId: conversation.id,
        userMessage: "Present the observations",
        abort: new AbortController(),
        onEvent: (event) => {
          if (event.type === "tool" && event.phase === "done" && event.artifact)
            artifacts.push(event.artifact)
        },
      })
      expect(result).toEqual({ content: "Chart saved." })
      expect(artifacts).toHaveLength(2)
      expect(artifacts[0]).toEqual(artifacts[1])
      expect(
        listMessages(conversation.id)
          .filter((row) => row.artifact)
          .map((row) => row.artifact)
      ).toEqual(artifacts)
      expect(contentsByCallId(conversation.id).get("chart-first")).toBe(
        acknowledgement
      )
      expect(contentsByCallId(conversation.id).get("chart-retry")).toBe(
        acknowledgement
      )
    }
  )

  it.each([
    {
      mode: "chat" as const,
      workspace: false,
      planMode: false,
      readOnlyTools: false,
      expected: true,
    },
    {
      mode: "interactive" as const,
      workspace: false,
      planMode: false,
      readOnlyTools: false,
      expected: true,
    },
    {
      mode: "north_star" as const,
      workspace: true,
      planMode: false,
      readOnlyTools: false,
      expected: true,
    },
    {
      mode: "interactive" as const,
      workspace: true,
      planMode: true,
      readOnlyTools: false,
      expected: false,
    },
    {
      mode: "north_star" as const,
      workspace: true,
      planMode: false,
      readOnlyTools: true,
      expected: false,
    },
  ])(
    "qualifies snapshot tool availability: $mode workspace=$workspace plan=$planMode readOnly=$readOnlyTools",
    async (scenario) => {
      const conversation = createConversation({ mode: scenario.mode })
      scriptedCompletions.push((request) => {
        for (const name of ["present_chart", "present_table"])
          expect(request.tools.includes(name)).toBe(scenario.expected)
        return streamText("Qualified.")
      })
      expect(
        await runAgentLoop({
          conversationId: conversation.id,
          workspace: scenario.workspace ? await makeWorkspace() : undefined,
          userMessage: "Present results",
          planMode: scenario.planMode,
          readOnlyTools: scenario.readOnlyTools,
          abort: new AbortController(),
          onEvent: () => {},
        })
      ).toEqual({ content: "Qualified." })
    }
  )

  it.each(["presentation", "read", "dashboard"])(
    "qualifies restricted custom-agent snapshot permissions: %s",
    async (category) => {
      const workspace = await makeWorkspace()
      const agentsDir = join(workspace, ".cowork", "agents")
      await mkdir(agentsDir, { recursive: true })
      await writeFile(
        join(agentsDir, "presenter.agent.md"),
        `---\nname: presenter\ndescription: Presents results.\ntools: [${category}]\n---\nPresent the supplied data.`
      )
      const conversation = createConversation({
        mode: "interactive",
        agentName: "presenter",
      })
      scriptedCompletions.push((request) => {
        for (const name of ["present_chart", "present_table"])
          expect(request.tools.includes(name)).toBe(category === "presentation")
        return streamText("Qualified.")
      })
      expect(
        await runAgentLoop({
          conversationId: conversation.id,
          workspace,
          agentDir: workspace,
          userMessage: "Present",
          abort: new AbortController(),
          onEvent: () => {},
        })
      ).toEqual({ content: "Qualified." })
    }
  )

  it("rejects an unoffered snapshot call on read-only turns without exposing a reference", async () => {
    const conversation = createConversation({ mode: "north_star" })
    scriptedCompletions.push(
      () =>
        streamToolCalls([
          {
            id: "blocked-artifact",
            name: "present_table",
            arguments: JSON.stringify({
              title: "Blocked",
              columns: [{ key: "value", label: "Value", valueType: "number" }],
              data: [{ value: 1 }],
            }),
          },
        ]),
      () => streamText("Not saved.")
    )
    expect(
      await runAgentLoop({
        conversationId: conversation.id,
        userMessage: "Present",
        readOnlyTools: true,
        abort: new AbortController(),
        onEvent: () => {},
      })
    ).toEqual({ content: "Not saved." })
    const result = listMessages(conversation.id).find(
      (message) => message.toolCallId === "blocked-artifact"
    )!
    expect(result.content).toContain("ERROR[tool_unavailable]")
    expect(result.artifact).toBeUndefined()
  })

  it("offers read_document alongside read_file_tool for a Chat document attachment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "north-star-attach-"))
    const pdf = join(dir, "report.pdf")
    const notes = join(dir, "notes.txt")
    await writeFile(pdf, "%PDF-1.4\n", "utf-8")
    await writeFile(notes, "plain text\n", "utf-8")
    const conversation = createConversation({ mode: "chat" })

    scriptedCompletions.push((request) => {
      expect(request.tools).toContain("read_file_tool")
      expect(request.tools).toContain("read_document")
      // The note must route each attachment to the reader that can parse it —
      // read_file_tool would only return ERROR[binary] for the PDF.
      const content = lastMessage(request, "user")?.content as string
      expect(content).toContain("read with read_file_tool: notes.txt")
      expect(content).toContain("read with read_document: report.pdf")
      return streamText("Read it.")
    })

    const result = await runAgentLoop({
      conversationId: conversation.id,
      attachments: [notes, pdf],
      userMessage: "summarize these",
      abort: new AbortController(),
      onEvent: () => {},
    })

    expect(result).toEqual({ content: "Read it." })
  })

  it("withholds read_document when no Chat attachment needs it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "north-star-attach-"))
    const notes = join(dir, "notes.txt")
    await writeFile(notes, "plain text\n", "utf-8")
    const conversation = createConversation({ mode: "chat" })

    scriptedCompletions.push((request) => {
      expect(request.tools).toContain("read_file_tool")
      expect(request.tools).not.toContain("read_document")
      expect(lastMessage(request, "user")?.content).toContain(
        "read with read_file_tool: notes.txt"
      )
      return streamText("Read it.")
    })

    const result = await runAgentLoop({
      conversationId: conversation.id,
      attachments: [notes],
      userMessage: "summarize this",
      abort: new AbortController(),
      onEvent: () => {},
    })

    expect(result).toEqual({ content: "Read it." })
  })
})

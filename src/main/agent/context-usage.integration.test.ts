import { mkdtemp, writeFile } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"
import type { ContextUsageEntry } from "./context/usage-log"

// Plan 108: the agent loop asks for streamed usage and logs one context-usage
// line per model round attempt.

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))
vi.mock("electron", () => ({
  app: {
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir(),
  },
}))
vi.mock("./memory/service", () => ({ recordMemoryTurn: vi.fn(async () => {}) }))

const logged = vi.hoisted(() => [] as ContextUsageEntry[])
vi.mock("./context/usage-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./context/usage-log")>()),
  contextUsageLog: {
    append: async (entry: ContextUsageEntry) => {
      logged.push(entry)
    },
  },
}))

type CompletionRequest = {
  messages: any[]
  streamOptions: unknown
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
      provider: "openai_compatible",
    }),
    createCompletion: async (
      _client: unknown,
      _model: string,
      _maxTokens: number,
      base: { messages: any[]; stream_options?: unknown }
    ) => {
      const snapshot = structuredClone({
        messages: base.messages,
        streamOptions: base.stream_options,
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
import { MODEL_STREAM_IDLE, testStreamUsage } from "./model-request-retry"
import { runAgentLoop } from "."

function streamToolCall(id: string, name: string, args: string) {
  return (async function* () {
    yield {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: { name, arguments: args },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }
    // The usage chunk follows the last content chunk, with no choices.
    yield {
      choices: [],
      usage: { prompt_tokens: 5000, completion_tokens: 40, total_tokens: 5040 },
    }
  })()
}

function streamText(content: string): AsyncIterable<any> {
  return (async function* () {
    yield { choices: [{ delta: { content }, finish_reason: "stop" }] }
  })()
}

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "north-star-ctx-"))
  await writeFile(join(workspace, "ok.txt"), "hello\n", "utf-8")
  return workspace
}

async function run(conversationId: string, workspace: string) {
  return runAgentLoop({
    conversationId,
    workspace,
    userMessage: "go",
    abort: new AbortController(),
    onEvent: () => {},
  })
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  runMigrations(db)
  scriptedCompletions.length = 0
  completionRequests.length = 0
  logged.length = 0
  testStreamUsage.reset()
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe.skipIf(!sqliteLoads)("per-round context usage logging", () => {
  it("asks for usage and logs reported and estimated sizes per round", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    scriptedCompletions.push(
      () =>
        streamToolCall(
          "call_1",
          "read_file_tool",
          JSON.stringify({ path: "ok.txt" })
        ),
      () => streamText("Done.")
    )

    expect(await run(conversation.id, workspace)).toMatchObject({
      content: "Done.",
      usage: { promptTokens: 5000, completionTokens: 40 },
    })
    expect(completionRequests.map((r) => r.streamOptions)).toEqual([
      { include_usage: true },
      { include_usage: true },
    ])

    expect(logged).toHaveLength(2)
    const [first, second] = logged
    expect(first).toMatchObject({
      conversationId: conversation.id,
      round: 1,
      attempt: 1,
      provider: "openai_compatible",
      accountId: "test-account",
      model: "test-model",
      mode: "interactive",
      outcome: "ok",
      request: {
        reported: 5000,
        estimator: "o200k",
        usageRequested: true,
      },
      response: { reported: 40, finishReason: "tool_calls" },
    })
    expect(first.request.estimated).toBeGreaterThan(0)
    expect(first.request.ratio).toBeCloseTo(5000 / first.request.estimated, 2)
    expect(first.response.estimated).toBeGreaterThan(0)

    // No usage on the second round: the local estimate stands alone, and it
    // now includes the tool round trip.
    expect(second).toMatchObject({
      round: 2,
      outcome: "ok",
      request: { reported: null, ratio: null },
      response: { reported: null, finishReason: "stop" },
    })
    expect(second.request.byRole.tool).toBeGreaterThan(0)
    expect(second.request.messageCount).toBe(first.request.messageCount + 2)
    expect(second.request.estimated).toBeGreaterThan(first.request.estimated)

    // Counts and IDs only: no message content.
    expect(JSON.stringify(logged)).not.toContain("hello")
  })

  it("retries once without stream_options when the provider rejects it", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    scriptedCompletions.push(
      () => {
        throw Object.assign(
          new Error(
            "400 Unrecognized request argument supplied: stream_options"
          ),
          { status: 400 }
        )
      },
      () => streamText("Done."),
      () => streamText("Again.")
    )

    expect(await run(conversation.id, workspace)).toEqual({ content: "Done." })
    expect(await run(conversation.id, workspace)).toEqual({ content: "Again." })
    expect(completionRequests.map((r) => r.streamOptions)).toEqual([
      { include_usage: true },
      undefined,
      undefined,
    ])
    expect(logged.map((e) => [e.outcome, e.request.usageRequested])).toEqual([
      ["ok", false],
      ["ok", false],
    ])
  })

  it("logs a transient failure as a retry, then the successful attempt", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    scriptedCompletions.push(
      () => {
        throw Object.assign(new Error("socket died"), { transient: true })
      },
      () => streamText("Recovered.")
    )

    expect(await run(conversation.id, workspace)).toEqual({
      content: "Recovered.",
    })
    expect(logged.map((e) => [e.round, e.attempt, e.outcome])).toEqual([
      [1, 1, "retry"],
      [1, 2, "ok"],
    ])
    expect(logged[0].request.estimated).toBe(logged[1].request.estimated)
  })

  it("logs a deterministic failure once as an error", async () => {
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    scriptedCompletions.push(() => {
      throw Object.assign(new Error("invalid api key"), { status: 401 })
    })

    expect(await run(conversation.id, workspace)).toMatchObject({
      error: "invalid api key",
    })
    expect(logged.map((e) => e.outcome)).toEqual(["error"])
  })

  describe("hung streams", () => {
    const saved = { ...MODEL_STREAM_IDLE }
    beforeEach(() => {
      MODEL_STREAM_IDLE.firstChunkMs = 40
      MODEL_STREAM_IDLE.betweenChunksMs = 40
    })
    afterEach(() => Object.assign(MODEL_STREAM_IDLE, saved))

    it("logs a stalled attempt under its own round id", async () => {
      const workspace = await makeWorkspace()
      const conversation = createConversation({ mode: "interactive" })
      scriptedCompletions.push(
        () =>
          (async function* () {
            await new Promise(() => {})
          })(),
        () => streamText("Recovered.")
      )

      expect(await run(conversation.id, workspace)).toEqual({
        content: "Recovered.",
      })
      expect(logged.map((e) => [e.round, e.roundId, e.outcome])).toEqual([
        [1, "after-seq:1", "stalled"],
        [1, "after-seq:1:stall-1", "ok"],
      ])
    })
  })
})

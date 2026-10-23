import { mkdtemp, writeFile } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"
import type { ContextUsageEntry } from "./context/usage-log"

// Plan 118: in-turn compaction driven through the real round loop with a
// scripted provider.

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

const scripted: Array<() => AsyncIterable<any>> = []
const requests: any[][] = []
const bodies: any[] = []
const llm = vi.hoisted(() => ({ provider: "openai_compatible" }))

vi.mock("./providers", () => {
  class NoActiveProviderError extends Error {}
  return {
    resolveLlm: () => ({
      client: {},
      model: "test-model",
      accountId: "test-account",
      apiMode: "completions",
      provider: llm.provider,
    }),
    createCompletion: async (
      _client: unknown,
      _model: string,
      _maxTokens: number,
      base: { messages: any[]; context_clearing?: unknown }
    ) => {
      requests.push(structuredClone(base.messages))
      bodies.push({ context_clearing: base.context_clearing })
      const next = scripted.shift()
      if (!next) throw new Error("unexpected completion request")
      return next()
    },
    isTransientError: (err: unknown) =>
      (err as { transient?: boolean }).transient === true,
    resolveModelLabel: () => "test-model",
    NoActiveProviderError,
  }
})

import { createConversation } from "../db/repositories/conversations"
import { getMaxMessageSeq, listMessages } from "../db/repositories/messages"
import { upsertConversationSummary } from "../db/repositories/conversation-summaries"
import * as settingsService from "../settings/service"
import { measureRequest } from "./context/request-size"
import { testStreamUsage } from "./model-request-retry"
import { registerTurnCompactor, runAgentLoop } from "."

const FILE = Array.from(
  { length: 300 },
  (_, i) => `line ${i} alpha beta gamma delta`
).join("\n")

function readCall(id: string, path: string, promptTokens?: number) {
  return () =>
    (async function* () {
      if (promptTokens)
        yield {
          choices: [],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: 10,
            total_tokens: promptTokens + 10,
          },
        }
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id,
                  type: "function",
                  function: {
                    name: "read_file_tool",
                    arguments: JSON.stringify({ path }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }
    })()
}

function parallelReads(names: string[]) {
  return () =>
    (async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: names.map((name, index) => ({
                index,
                id: `p_${name}`,
                type: "function",
                function: {
                  name: "read_file_tool",
                  arguments: JSON.stringify({ path: `${name}.txt` }),
                },
              })),
            },
            finish_reason: "tool_calls",
          },
        ],
      }
    })()
}

function text(content: string) {
  return () =>
    (async function* () {
      yield { choices: [{ delta: { content }, finish_reason: "stop" }] }
    })()
}

function setThreshold(n: number) {
  settingsService.setIndexing({
    ...settingsService.getIndexing(),
    turnCompactionTokenThreshold: n,
  })
}

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "north-star-compact-"))
  for (const name of ["a", "b", "c", "d", "e", "f"])
    await writeFile(join(dir, `${name}.txt`), `${name}\n${FILE}\n`, "utf-8")
  return dir
}

function run(conversationId: string, dir: string, userMessage = "go") {
  return runAgentLoop({
    conversationId,
    workspace: dir,
    userMessage,
    abort: new AbortController(),
    onEvent: () => {},
  })
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  runMigrations(db)
  settingsService._resetCacheForTests()
  scripted.length = 0
  requests.length = 0
  bodies.length = 0
  llm.provider = "openai_compatible"
  logged.length = 0
  testStreamUsage.reset()
  registerTurnCompactor(null)
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  registerTurnCompactor(null)
  vi.restoreAllMocks()
})

describe.skipIf(!sqliteLoads)("in-turn compaction", () => {
  it("tier 1 stubs old tool results in the request but not the transcript", async () => {
    const dir = await workspace()
    const conversation = createConversation({ mode: "interactive" })
    const reads = ["a", "b", "c", "d", "e", "f"]
    // Small enough that the six reads cross it.
    setThreshold(9000)
    scripted.push(
      ...reads.map((name, i) => readCall(`r${i}`, `${name}.txt`)),
      text("Done.")
    )

    expect(await run(conversation.id, dir)).toMatchObject({ content: "Done." })

    const last = requests[requests.length - 1]
    const results = last.filter((m) => m.role === "tool")
    expect(results[0].content).toMatch(
      /^\[Earlier result cleared to save context: read_file_tool a\.txt/
    )
    // The last three rounds stay verbatim.
    expect(results.slice(-3).every((m) => m.content.includes("line 299"))).toBe(
      true
    )
    // The opening request is never touched.
    expect(last.some((m) => m.role === "user" && m.content === "go")).toBe(true)
    // Persisted transcript stays complete.
    const stored = listMessages(conversation.id).filter(
      (m) => m.role === "tool"
    )
    expect(stored).toHaveLength(6)
    expect(stored.every((m) => m.content?.includes("line 299"))).toBe(true)
    expect(logged.some((e) => e.compaction?.tier === 1)).toBe(true)
  })

  it("tier 2 rebuilds from the summary with pinned instructions and the ledger", async () => {
    const dir = await workspace()
    const conversation = createConversation({ mode: "interactive" })
    // Tier 1 keeps three full rounds, which alone exceed this threshold.
    setThreshold(6000)
    registerTurnCompactor(async (conversationId) => {
      upsertConversationSummary({
        conversationId,
        summary: "## Remaining\n- defect X still open",
        coversThrough: getMaxMessageSeq(conversationId),
        messageCount: 0,
      })
      return true
    })
    scripted.push(
      readCall("r0", "a.txt"),
      readCall("r1", "b.txt"),
      readCall("r2", "c.txt"),
      readCall("r3", "d.txt"),
      text("Done.")
    )

    expect(
      await run(
        conversation.id,
        dir,
        "Implement the feature; keep docs current"
      )
    ).toMatchObject({ content: "Done." })

    // A rebuild after the first read round, so there is a round to carry.
    const compacted = requests.find(
      (r) => String(r[1]?.content).includes("## Work ledger") && r.length > 2
    )
    expect(compacted).toBeDefined()
    const [system, continuation, ...round] = compacted!
    expect(system.role).toBe("system")
    expect(system.content).toContain("defect X still open")
    expect(continuation.role).toBe("user")
    expect(continuation.content).toContain(
      "Implement the feature; keep docs current"
    )
    expect(continuation.content).toContain("## Work ledger")
    expect(continuation.content).toContain("Continue from Remaining.")
    // The latest round follows, paired: the model has not seen it yet.
    expect(round[0].role).toBe("assistant")
    const ids = round[0].tool_calls.map((c: any) => c.id)
    expect(round.slice(1).every((m) => ids.includes(m.tool_call_id))).toBe(true)
    expect(measureRequest(compacted!).total).toBeLessThanOrEqual(6000)
    expect(
      listMessages(conversation.id).filter((m) => m.role === "tool")
    ).toHaveLength(4)
    expect(logged.some((e) => e.compaction?.tier === 2)).toBe(true)
  })

  it("does not summarize away a big round the model has not seen yet", async () => {
    const dir = await workspace()
    const conversation = createConversation({ mode: "interactive" })
    // One round of parallel reads alone exceeds this.
    setThreshold(12000)
    let compactions = 0
    registerTurnCompactor(async (conversationId) => {
      compactions += 1
      upsertConversationSummary({
        conversationId,
        summary: "## Remaining\n- review the files",
        coversThrough: getMaxMessageSeq(conversationId),
        messageCount: 0,
      })
      return true
    })
    scripted.push(parallelReads(["a", "b", "c", "d", "e"]), text("Reviewed."))

    expect(await run(conversation.id, dir)).toMatchObject({
      content: "Reviewed.",
    })
    expect(compactions).toBe(1)
    const after = requests[1]
    // Every file's result reaches the model, shortened to fit, with a note.
    const results = after.filter((m) => m.role === "tool")
    expect(results).toHaveLength(5)
    for (const [i, name] of ["a", "b", "c", "d", "e"].entries()) {
      expect(results[i].content).toContain(name)
      expect(results[i].content).toContain(
        "Truncated to fit the context budget"
      )
    }
    expect(measureRequest(after).total).toBeLessThanOrEqual(12000)
  })

  it("leaves tier 1 to Anthropic and judges tier 2 by the reported size", async () => {
    const dir = await workspace()
    const conversation = createConversation({ mode: "interactive" })
    llm.provider = "anthropic"
    setThreshold(6000)
    let compactions = 0
    registerTurnCompactor(async () => {
      compactions += 1
      return false
    })
    // The provider reports a cleared request well under the threshold, though
    // the local estimate of the full history is far above it.
    scripted.push(
      readCall("r0", "a.txt", 500),
      readCall("r1", "b.txt", 500),
      readCall("r2", "c.txt", 500),
      readCall("r3", "d.txt", 500),
      text("Done.")
    )

    expect(await run(conversation.id, dir)).toMatchObject({ content: "Done." })
    expect(bodies[0].context_clearing).toEqual({
      trigger: 6000,
      clearAtLeast: 3000,
    })
    // No client-side stubs and no summary: the server owns tier 1.
    expect(JSON.stringify(requests)).not.toContain("Earlier result cleared")
    expect(compactions).toBe(0)
    expect(measureRequest(requests[requests.length - 1]).total).toBeGreaterThan(
      6000
    )
  })

  it("logs and shows a server-side clear reported by Anthropic", async () => {
    const dir = await workspace()
    const conversation = createConversation({ mode: "interactive" })
    llm.provider = "anthropic"
    setThreshold(60000)
    scripted.push(() =>
      (async function* () {
        yield {
          choices: [{ delta: { content: "Done." }, finish_reason: "stop" }],
        }
        yield {
          choices: [],
          usage: {
            prompt_tokens: 20000,
            completion_tokens: 5,
            total_tokens: 20005,
            context_cleared: { input_tokens: 45000, tool_uses: 7 },
          },
        }
      })()
    )
    const events: any[] = []
    await runAgentLoop({
      conversationId: conversation.id,
      workspace: dir,
      userMessage: "go",
      abort: new AbortController(),
      onEvent: (event) => events.push(event),
    })

    expect(logged[0].compaction).toEqual({
      tier: 1,
      before: 65000,
      after: 20000,
      clearedResults: 7,
      server: true,
    })
    expect(events).toContainEqual({
      type: "context_compacted",
      tier: 1,
      before: 65000,
      after: 20000,
    })
  })

  it("rebuilds an Anthropic turn once the reported size passes the threshold", async () => {
    const dir = await workspace()
    const conversation = createConversation({ mode: "interactive" })
    llm.provider = "anthropic"
    setThreshold(6000)
    let compactions = 0
    registerTurnCompactor(async () => {
      compactions += 1
      return false
    })
    scripted.push(readCall("r0", "a.txt", 9000), text("Done."))

    expect(await run(conversation.id, dir)).toMatchObject({ content: "Done." })
    expect(compactions).toBe(1)
  })

  it("fails an overflow clearly without resending the same request", async () => {
    const dir = await workspace()
    const conversation = createConversation({ mode: "interactive" })
    setThreshold(0)
    scripted.push(() => {
      throw Object.assign(
        new Error("This model's maximum context length is 8192 tokens."),
        { status: 400, code: "context_length_exceeded" }
      )
    })

    const result = await run(conversation.id, dir)
    expect(result.error).toMatch(/exceeds the model's context window/)
    expect(requests).toHaveLength(1)
  })

  it("compacts and retries once on overflow when the request can shrink", async () => {
    const dir = await workspace()
    const conversation = createConversation({ mode: "interactive" })
    // High enough that the watermark never fires on its own.
    setThreshold(1_000_000)
    scripted.push(
      readCall("r0", "a.txt"),
      readCall("r1", "b.txt"),
      readCall("r2", "c.txt"),
      readCall("r3", "d.txt"),
      () => {
        throw Object.assign(new Error("context_length_exceeded: too long"), {
          status: 400,
        })
      },
      text("Done.")
    )

    expect(await run(conversation.id, dir)).toMatchObject({ content: "Done." })
    const [failed, retried] = requests.slice(-2)
    expect(measureRequest(retried).total).toBeLessThan(
      measureRequest(failed).total
    )
  })
})

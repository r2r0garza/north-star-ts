import { mkdtemp, writeFile } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import Database from "better-sqlite3"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

// Refocus and seat memory inside the real agent loop (plan 106.7): a seat turn
// after a forced compaction carries the intent chain, the interval reminder
// lands every N rounds, and active lessons ride in the system block with an
// exposure recorded. The model is scripted; everything else is real.

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getAppPath: () => tmpdir() },
}))
vi.mock("../agent/memory/service", () => ({
  recordMemoryTurn: vi.fn(async () => {}),
  extractSeatLessons: vi.fn(async () => []),
}))

type CompletionRequest = { messages: any[]; tools: string[] }
const scripted: Array<() => AsyncIterable<any>> = []
const requests: CompletionRequest[] = []

vi.mock("../agent/providers", () => {
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
      requests.push(
        structuredClone({
          messages: base.messages,
          tools: (base.tools ?? []).map((tool) => tool.function.name),
        })
      )
      const next = scripted.shift()
      if (!next) throw new Error("unexpected completion request")
      return next()
    },
    isTransientError: () => false,
    resolveModelLabel: () => "test-model",
    NoActiveProviderError,
  }
})

import * as rigs from "../db/repositories/rigs"
import * as features from "../db/repositories/features"
import * as seatSessionsRepo from "../db/repositories/seat-sessions"
import * as memories from "../db/repositories/seat-memories"
import { createConversation } from "../db/repositories/conversations"
import { listMessages } from "../db/repositories/messages"
import { upsertWorkspace } from "../db/repositories/workspaces"
import { runAgentLoop } from "../agent"
import { onConversationCompacted } from "./refocus"
import { isRefocusEvent } from "../../shared/runtime-messages"
import type { SeatTurnIdentity } from "./seat-turns"

function streamToolCall(id: string): AsyncIterable<any> {
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
                function: {
                  name: "read_file_tool",
                  arguments: JSON.stringify({ path: "ok.txt" }),
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

function streamText(content: string): AsyncIterable<any> {
  return (async function* () {
    yield { choices: [{ delta: { content }, finish_reason: "stop" }] }
  })()
}

function fixture() {
  const rig = rigs.createRig({ name: "Team" })
  const pod = rigs.createPod({
    rigId: rig.id,
    key: "implementation",
    name: "Implementation",
  })
  rigs.createSeat({
    podId: pod.id,
    key: "builder",
    role: "builder",
    charter: "Builds the user story and nothing else.",
    agentRefId: "agentref:v1:builder",
    agentLabel: "Builder",
  })
  const workspace = upsertWorkspace(tmpdir())
  const graph = features.createFeature({
    key: "billing",
    name: "Billing",
    intent: "Customers can be invoiced.",
    definitionOfDone: "Invoices go out monthly.",
    rigId: rig.id,
    workspaceId: workspace.id,
  })
  const created = features.createUserStory({
    milestoneId: graph.milestones[0].id,
    key: "invoice-model",
    title: "Invoice model",
    spec: {
      goal: "Add an invoice model.",
      acceptance: ["Has line items", "Totals are computed"],
      outOfScope: ["PDF rendering"],
    },
  })
  const userStory = created.userStories.find((s) => s.key === "invoice-model")!
  features.startFeature(graph.feature.id)
  const feature = features.getFeature(graph.feature.id)!
  const identity: SeatTurnIdentity = {
    featureId: feature.id,
    address: "builder@implementation",
    profile: "work",
    anchor: { kind: "user_story", id: userStory.id },
    wakeHop: null,
  }
  return { rig, feature, identity }
}

async function makeWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), "north-star-refocus-"))
  await writeFile(join(dir, "ok.txt"), "content\n", "utf-8")
  return dir
}

function sessionConversation(featureId: string) {
  const conversation = createConversation({ mode: "interactive" })
  seatSessionsRepo.createSeatSession({
    featureId,
    seatAddress: "builder@implementation",
    conversationId: conversation.id,
  })
  return conversation
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  runMigrations(db)
  scripted.length = 0
  requests.length = 0
})

describe.skipIf(!sqliteLoads)("Refocus in the agent loop", () => {
  it("gives the next seat turn the intent chain after a forced compaction", async () => {
    const { feature, identity } = fixture()
    const workspace = await makeWorkspace()
    const conversation = sessionConversation(feature.id)
    expect(
      seatSessionsRepo.getSeatSessionByConversation(conversation.id)
    ).toBeTruthy()

    // The summary service compacted the seat's conversation mid-user-story.
    onConversationCompacted(conversation.id)

    scripted.push(() => streamText("Continuing the model."))
    await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "Carry on with the invoice model.",
      abort: new AbortController(),
      missionControlSeat: identity,
      onEvent: () => {},
    })

    const last = requests[0].messages.at(-1)
    expect(last.role).toBe("user")
    const text = String(last.content)
    expect(isRefocusEvent(text)).toBe(true)
    expect(text).toContain("(compaction)")
    expect(text).toContain(
      'You are working on: user story invoice-model "Invoice model"'
    )
    expect(text).toContain("AC-1 Has line items; AC-2 Totals are computed")
    expect(text).toContain("OUT OF SCOPE: PDF rendering")
    expect(text).toContain('which serves: feature billing "Billing"')
    expect(text).toContain(
      "Your seat: builder@implementation — Builds the user story"
    )
    expect(text).toContain("propose_followup")
    // Persisted, so the transcript shows it as a chip.
    expect(
      listMessages(conversation.id).some((m) => isRefocusEvent(m.content))
    ).toBe(true)
  })

  it("drops a refocus note on a turn that is not a seat turn", async () => {
    fixture()
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })
    db.prepare(
      "INSERT INTO conversation_notes (id, conversation_id, body, source, created_at) VALUES ('n1', ?, ?, 'refocus', ?)"
    ).run(conversation.id, JSON.stringify({ kind: "compaction" }), Date.now())
    scripted.push(() => streamText("Hi."))
    await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "hello",
      abort: new AbortController(),
      onEvent: () => {},
    })
    expect(
      requests[0].messages.some((m: any) => isRefocusEvent(String(m.content)))
    ).toBe(false)
  })

  it("refocuses a working seat every N rounds of one step", async () => {
    const { feature, identity } = fixture()
    features.setFeatureBudgets(feature.id, { refocusEveryRounds: 2 })
    const workspace = await makeWorkspace()
    const conversation = createConversation({ mode: "interactive" })

    scripted.push(
      () => streamToolCall("c1"),
      () => streamToolCall("c2"),
      () => streamToolCall("c3"),
      () => streamText("Done.")
    )
    await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "Build the user story.",
      abort: new AbortController(),
      missionControlSeat: identity,
      onEvent: () => {},
    })

    const reminders = (request: CompletionRequest) =>
      request.messages.filter((m: any) => isRefocusEvent(String(m.content)))
        .length
    expect(requests.map(reminders)).toEqual([0, 0, 1, 1])
    expect(String(requests[2].messages.at(-1).content)).toContain("(interval)")
  })

  it("injects only approved seat lessons and records who saw them", async () => {
    const { rig, identity } = fixture()
    const workspace = await makeWorkspace()
    const pending = memories.createSeatMemory({
      rigId: rig.id,
      seatAddress: "builder@implementation",
      content: "The payments e2e tests need STRIPE_MOCK=1.",
      kind: "pitfall",
      status: "pending_review",
    })
    const conversation = createConversation({ mode: "interactive" })

    scripted.push(() => streamText("One."))
    await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "Build.",
      abort: new AbortController(),
      missionControlSeat: identity,
      onEvent: () => {},
    })
    expect(JSON.stringify(requests[0].messages)).not.toContain("STRIPE_MOCK")

    memories.reviewSeatMemory(pending.id, "approve")
    scripted.push(() => streamText("Two."))
    await runAgentLoop({
      conversationId: conversation.id,
      workspace,
      userMessage: "Build again.",
      abort: new AbortController(),
      missionControlSeat: identity,
      onEvent: () => {},
    })
    const system = String(requests[1].messages[0].content)
    expect(system).toContain(
      "Pitfall: The payments e2e tests need STRIPE_MOCK=1."
    )
    expect(
      memories.listExposures([pending.id]).map((e) => e.conversationId)
    ).toEqual([conversation.id])
  })
})

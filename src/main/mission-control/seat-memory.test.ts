import { tmpdir } from "os"
import Database from "better-sqlite3"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

// Seat memory (plan 106.7): lessons cross features only once approved, spread
// only by explicit sharing, and a retraction reaches every copy and exactly the
// live sessions that were shown one.

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getAppPath: () => tmpdir() },
}))
vi.mock("../agent/memory/service", () => ({
  extractSeatLessons: vi.fn(async () => []),
}))

import * as rigs from "../db/repositories/rigs"
import * as features from "../db/repositories/features"
import * as seatSessionsRepo from "../db/repositories/seat-sessions"
import * as memories from "../db/repositories/seat-memories"
import { appendMessage } from "../db/repositories/messages"
import { createConversation } from "../db/repositories/conversations"
import { takeConversationNotes } from "../db/repositories/conversation-notes"
import { upsertWorkspace } from "../db/repositories/workspaces"
import {
  recordSeatLessons,
  retractSeatMemory,
  seatMemorySection,
  shareSeatMemory,
} from "./seat-memory"
import { seatTurns, type SeatTurnIdentity } from "./seat-turns"
import { toolDefinitions } from "../agent/tools"
import { seatCommsTools } from "../agent/tools/seat_comms_tools"
import { mapTools } from "../agent/tools/map_tools"

const BUILDER = "builder@implementation"
const QA = "qa@implementation"

function rigWithSeats() {
  const rig = rigs.createRig({ name: "Team" })
  const pod = rigs.createPod({
    rigId: rig.id,
    key: "implementation",
    name: "Implementation",
  })
  for (const key of ["builder", "qa"])
    rigs.createSeat({
      podId: pod.id,
      key,
      role: key,
      agentRefId: `agentref:v1:${key}`,
      agentLabel: key,
    })
  return rig
}

function featureOn(rigId: string, key: string) {
  const graph = features.createFeature({
    key,
    name: key,
    intent: `Do ${key}.`,
    definitionOfDone: "",
    rigId,
    workspaceId: upsertWorkspace(tmpdir()).id,
  })
  features.startFeature(graph.feature.id)
  return features.getFeature(graph.feature.id)!
}

function turn(featureId: string, address = BUILDER): SeatTurnIdentity {
  return { featureId, address, profile: "work", anchor: null, wakeHop: null }
}

function workedConversation() {
  const conversation = createConversation({ mode: "interactive" })
  appendMessage({
    conversationId: conversation.id,
    role: "user",
    content: "Build it.",
  })
  appendMessage({
    conversationId: conversation.id,
    role: "assistant",
    content: "The e2e suite hung until I set STRIPE_MOCK=1; then it passed.",
  })
  return conversation
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)("seat memory", () => {
  it("carries a lesson from feature A to the same seat in feature B only after approval", async () => {
    const rig = rigWithSeats()
    const a = featureOn(rig.id, "feature-a")
    const b = featureOn(rig.id, "feature-b")
    const conversation = workedConversation()

    const learned = await recordSeatLessons({
      identity: turn(a.id),
      conversationId: conversation.id,
      sinceSeq: 0,
      extract: async () => [
        {
          content: "The payments e2e tests need STRIPE_MOCK=1.",
          kind: "pitfall",
        },
      ],
    })
    expect(learned).toHaveLength(1)
    expect(learned[0]).toMatchObject({
      status: "pending_review",
      originFeatureId: a.id,
      originConversationId: conversation.id,
    })
    expect(learned[0].originMessageId).toBeTruthy()

    const inB = createConversation({ mode: "interactive" })
    expect(seatMemorySection(turn(b.id), inB.id)).toBeNull()

    memories.reviewSeatMemory(learned[0].id, "approve")
    const section = seatMemorySection(turn(b.id), inB.id)
    expect(section?.content).toContain("STRIPE_MOCK=1")
    // Another seat of the same rig never sees it without a share.
    expect(seatMemorySection(turn(b.id, QA), inB.id)).toBeNull()
  })

  it("activates at once when the feature auto-activates, and skips near-duplicates", async () => {
    const rig = rigWithSeats()
    const feature = featureOn(rig.id, "feature-a")
    features.setFeatureBudgets(feature.id, { autoActivateLessons: 1 })
    const lesson = {
      content: "The payments e2e tests need STRIPE_MOCK=1.",
      kind: "pitfall" as const,
    }
    const first = await recordSeatLessons({
      identity: turn(feature.id),
      conversationId: workedConversation().id,
      sinceSeq: 0,
      extract: async () => [lesson],
    })
    expect(first[0].status).toBe("active")
    const again = await recordSeatLessons({
      identity: turn(feature.id),
      conversationId: workedConversation().id,
      sinceSeq: 0,
      extract: async () => [
        { ...lesson, content: "Payments e2e tests need STRIPE_MOCK=1 set." },
      ],
    })
    expect(again).toEqual([])
  })

  it("never learns from a read-only wake", async () => {
    const rig = rigWithSeats()
    const feature = featureOn(rig.id, "feature-a")
    const extract = vi.fn(async () => [])
    await recordSeatLessons({
      identity: { ...turn(feature.id), profile: "consult" },
      conversationId: workedConversation().id,
      sinceSeq: 0,
      extract,
    })
    expect(extract).not.toHaveBeenCalled()
  })

  it("retracts a shared lesson with its copies and corrects exactly the exposed live sessions", () => {
    const rig = rigWithSeats()
    const feature = featureOn(rig.id, "feature-a")
    const original = memories.createSeatMemory({
      rigId: rig.id,
      seatAddress: BUILDER,
      content: "Always run the migrations twice.",
      kind: "lesson",
      status: "active",
    })
    const copy = shareSeatMemory(original.id, QA)
    expect(copy).toMatchObject({
      derivedFrom: original.id,
      source: "shared",
      status: "active",
    })
    expect(() => shareSeatMemory(original.id, QA)).toThrow(/already has/)

    // Exposed: a live builder session, a rotated QA session, a running QA
    // worker. Not exposed: another live session.
    const live = createConversation({ mode: "interactive" })
    seatSessionsRepo.createSeatSession({
      featureId: feature.id,
      seatAddress: BUILDER,
      conversationId: live.id,
    })
    const rotated = createConversation({ mode: "interactive" })
    const rotatedSession = seatSessionsRepo.createSeatSession({
      featureId: feature.id,
      seatAddress: QA,
      conversationId: rotated.id,
    })
    seatSessionsRepo.retireSeatSession(rotatedSession.id, "rotated", "test")
    const unexposed = createConversation({ mode: "interactive" })
    seatSessionsRepo.createSeatSession({
      featureId: feature.id,
      seatAddress: BUILDER,
      conversationId: unexposed.id,
    })

    seatMemorySection(turn(feature.id), live.id)
    seatMemorySection(turn(feature.id, QA), rotated.id)

    const result = retractSeatMemory(original.id, "it corrupts the schema")
    expect(result.retracted.map((m) => m.id).sort()).toEqual(
      [original.id, copy.id].sort()
    )
    expect(result.exposedConversations).toBe(2)
    expect(result.notified).toEqual([
      { featureId: feature.id, address: BUILDER },
    ])

    const liveNotes = takeConversationNotes(live.id)
    expect(liveNotes).toHaveLength(1)
    expect(liveNotes[0].body).toContain(
      '"Always run the migrations twice." is retracted because it corrupts the schema; do not apply it.'
    )
    expect(takeConversationNotes(unexposed.id)).toEqual([])

    // Future sessions no longer get it.
    const later = createConversation({ mode: "interactive" })
    expect(seatMemorySection(turn(feature.id), later.id)).toBeNull()
    expect(seatMemorySection(turn(feature.id, QA), later.id)).toBeNull()
  })

  it("counts a running step worker as live, and leaves a finished one its correction", async () => {
    const rig = rigWithSeats()
    const feature = featureOn(rig.id, "feature-a")
    const memory = memories.createSeatMemory({
      rigId: rig.id,
      seatAddress: BUILDER,
      content: "Use the fixtures in tests/fixtures.",
      kind: "convention",
      status: "active",
    })
    const running = createConversation({ mode: "interactive" })
    const finished = createConversation({ mode: "interactive" })
    seatMemorySection(turn(feature.id), running.id)
    seatMemorySection(turn(feature.id), finished.id)
    const release = await seatTurns.acquire(running.id, turn(feature.id))
    try {
      const result = retractSeatMemory(memory.id, "")
      expect(result.notified).toEqual([
        { featureId: feature.id, address: BUILDER },
      ])
    } finally {
      release()
    }
    // Not live, but if it's ever woken again the correction is there.
    expect(takeConversationNotes(finished.id)).toHaveLength(1)
  })

  it("offers no tool that writes seat memory", () => {
    const names = [
      ...toolDefinitions.map((d) => d.function.name),
      ...seatCommsTools.map((t) => t.definition.function.name),
      ...mapTools.map((t) => t.definition.function.name),
    ]
    expect(names.filter((name) => /memor|lesson/i.test(name))).toEqual([])
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { tmpdir } from "os"
import { runMigrations } from "../../db/migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

// Health monitoring end to end (plan 106.8): real SQLite, the real Comms bus,
// the real Navigator pause, and real Refocus notes. Seats are scripted by
// posting their messages directly; the clock is faked.

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../../db/connection", () => ({ getDb: () => db }))
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getAppPath: () => tmpdir() },
}))

import * as rigs from "../../db/repositories/rigs"
import * as features from "../../db/repositories/features"
import * as events from "../../db/repositories/mc-events"
import * as mergeQueue from "../../db/repositories/merge-queue"
import * as seatComms from "../../db/repositories/seat-comms"
import * as seatSessions from "../../db/repositories/seat-sessions"
import { createConversation } from "../../db/repositories/conversations"
import { upsertWorkspace } from "../../db/repositories/workspaces"
import type { Feature, UserStory } from "../../db/types"
import { SeatComms, type CommsResult } from "../comms"
import { Navigator } from "../navigator"
import { recordRefocusDelivered, signalDrift } from "../refocus"
import type { SeatTurnIdentity } from "../seat-turns"
import { HealthMonitor, pendingDecisionAnchors } from "./monitor"

const MIN = 60 * 1000
const BUILDER = "builder@implementation"
const QA = "qa@implementation"
const POD_LEAD = "lead@implementation"
const TOP_LEAD = "lead@orchestration"

let bus: SeatComms
let monitor: HealthMonitor
let navigator: Navigator
const notifications: string[] = []
const conversations = new Map<string, string>()

function tick(minutes = 1) {
  vi.setSystemTime(Date.now() + minutes * MIN)
}

function ok(result: CommsResult) {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
  return result.message
}

function seat(feature: Feature, address: string): SeatTurnIdentity {
  return {
    featureId: feature.id,
    address,
    profile: "work",
    anchor: null,
    wakeHop: null,
  }
}

// Orchestration oversees implementation; each pod has its own lead.
function orchestrated(): { feature: Feature; userStory: UserStory } {
  const rig = rigs.createRig({ name: "Health" })
  const orchestration = rigs.createPod({
    rigId: rig.id,
    key: "orchestration",
    name: "Orchestration",
  })
  const implementation = rigs.createPod({
    rigId: rig.id,
    key: "implementation",
    name: "Implementation",
  })
  const top = rigs.createSeat({
    podId: orchestration.id,
    key: "lead",
    role: "lead",
    agentRefId: "agentref:v1:lead",
    decisionRights: [
      "accept_proof",
      "merge",
      "revise_plan",
      "escalate_to_user",
    ],
  })
  rigs.updatePod(orchestration.id, { leadSeatId: top.id })
  const podLead = rigs.createSeat({
    podId: implementation.id,
    key: "lead",
    role: "lead",
    agentRefId: "agentref:v1:lead",
    decisionRights: ["accept_proof"],
  })
  rigs.updatePod(implementation.id, { leadSeatId: podLead.id })
  for (const key of ["builder", "qa"])
    rigs.createSeat({
      podId: implementation.id,
      key,
      role: key,
      agentRefId: `agentref:v1:${key}`,
    })
  rigs.setOversight(rig.id, [
    { overseerPodId: orchestration.id, overseenPodId: implementation.id },
  ])
  const graph = features.createFeature({
    key: "billing",
    name: "Billing",
    intent: "Customers can be invoiced.",
    definitionOfDone: "Invoices go out monthly.",
    rigId: rig.id,
    workspaceId: upsertWorkspace(tmpdir()).id,
    defaultPodKey: "implementation",
  })
  features.createUserStory({
    milestoneId: graph.milestones[0].id,
    key: "invoice-model",
    title: "Invoice model",
    spec: {
      goal: "Add an invoice model.",
      acceptance: ["Has line items"],
      touchHints: ["src/billing/**"],
    },
  })
  features.startFeature(graph.feature.id)
  const full = features.getFeatureGraph(graph.feature.id)!
  // Live seat sessions, so a Refocus has somewhere to land.
  for (const address of [BUILDER, QA]) {
    const conversationId = createConversation({ mode: "interactive" }).id
    seatSessions.createSeatSession({
      featureId: full.feature.id,
      seatAddress: address,
      conversationId,
    })
    conversations.set(address, conversationId)
  }
  return { feature: full.feature, userStory: full.userStories[0] }
}

function refocusNotes(address: string) {
  return db
    .prepare(
      "SELECT id, body FROM conversation_notes WHERE conversation_id = ? AND source = 'refocus' ORDER BY created_at"
    )
    .all(conversations.get(address)) as Array<{ id: string; body: string }>
}

// The agent loop delivering a seat's queued Refocus notes.
function deliverRefocus(feature: Feature, address: string) {
  for (const note of refocusNotes(address))
    recordRefocusDelivered(
      seat(feature, address),
      JSON.parse(note.body),
      conversations.get(address)!,
      note.id
    )
}

function alerts(feature: Feature) {
  return seatComms
    .listMessages({ featureId: feature.id })
    .filter((m) => m.kind === "alert")
}

beforeEach(() => {
  if (!sqliteLoads) return
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-09-29T09:00:00Z"))
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
  notifications.length = 0
  conversations.clear()
  bus = new SeatComms({ dispatch: () => {}, notifyUser: () => {} })
  navigator = new Navigator({
    startUserStory: vi.fn(),
    startHook: vi.fn(),
    cancelPlaybookRun: vi.fn(),
    workspaceMode: vi.fn(),
    advanceMilestone: vi.fn(),
    kickMerges: vi.fn(),
    completeMilestone: vi.fn(),
    direct: vi.fn(),
    notifyUser: vi.fn(),
    heartbeatMs: 0,
    debounceMs: 60_000,
  })
  monitor = new HealthMonitor({
    notifyUser: (title) => notifications.push(title),
    alert: (input) => {
      ok(bus.alert(input))
    },
    pause: (featureId, reason) => navigator.pause(featureId, reason, "health"),
    refocus: (conversationId, signal) => signalDrift(conversationId, signal),
    intervalMs: 0,
  })
})

afterEach(() => {
  navigator?.stop()
  monitor?.stop()
  vi.useRealTimers()
})

describe.skipIf(!sqliteLoads)("health: the event stream", () => {
  it("records each work transition exactly once, even when replayed", () => {
    const { feature, userStory } = orchestrated()
    for (const status of [
      "ready",
      "running",
      "proving",
      "integrating",
    ] as const)
      features.setUserStoryExecution(userStory.id, { status }, "test")
    const entry = mergeQueue.enqueueMerge({
      milestoneId: userStory.milestoneId,
      userStoryId: userStory.id,
      playbookRunId: null,
      proofAcceptedAt: Date.now(),
    })
    mergeQueue.updateMergeEntry(entry.id, { status: "merging" }, ["queued"])
    mergeQueue.updateMergeEntry(entry.id, { status: "merged" }, ["merging"])
    // A replayed merge after a crash: the guard doesn't match, nothing new.
    mergeQueue.updateMergeEntry(entry.id, { status: "merged" }, ["merging"])
    features.setUserStoryExecution(userStory.id, { status: "done" }, "test")
    // A replayed emission for the same row records nothing.
    expect(
      events.recordEvent({
        featureId: feature.id,
        type: "user_story_done",
        userStoryId: userStory.id,
        refId: userStory.id,
      })
    ).toBe(false)

    const types = events.listEvents(feature.id).map((e) => e.type)
    const count = (type: string) => types.filter((t) => t === type).length
    expect(count("feature_active")).toBe(1)
    expect(count("user_story_started")).toBe(1)
    expect(count("merge_landed")).toBe(1)
    expect(count("user_story_done")).toBe(1)
    const done = events
      .listEvents(feature.id, { types: ["user_story_done"] })
      .at(0)!
    expect(done).toMatchObject({
      class: "progress",
      weight: 5,
      userStoryId: userStory.id,
      milestoneId: userStory.milestoneId,
    })
  })

  it("classifies messages, refusals, and the user's words", () => {
    const { feature } = orchestrated()
    ok(bus.send(seat(feature, BUILDER), { to: QA, body: "Schema question" }))
    const refused = bus.send(seat(feature, BUILDER), {
      to: QA,
      body: "x".repeat(20_000),
    })
    expect(refused.ok).toBe(false)
    ok(bus.steer({ featureId: feature.id, to: POD_LEAD, body: "Keep going" }))
    const stream = events.listEvents(feature.id)
    expect(
      stream
        .filter((e) => e.type !== "feature_active")
        .map((e) => [e.type, e.class, e.seatAddress])
    ).toEqual([
      ["message_sent", "ceremony", BUILDER],
      ["message_refused", "ceremony", BUILDER],
      ["steer", "neutral", "user@rig"],
    ])
  })
})

describe.skipIf(!sqliteLoads)("health: ping-pong", () => {
  it("alerts the pod lead, refocuses both seats, and pauses when it continues", () => {
    const { feature } = orchestrated()
    const exchange = (n: number, threadId: string | null) => {
      let thread = threadId
      for (let i = 0; i < n; i++) {
        tick()
        const from = i % 2 ? QA : BUILDER
        const sent = ok(
          bus.send(seat(feature, from), {
            to: from === BUILDER ? QA : BUILDER,
            body: `Round ${i}: are we sure about the invoice schema?`,
            threadId: thread,
          })
        )
        thread = sent.threadId
      }
      return thread!
    }

    const thread = exchange(6, null)
    monitor.evaluate(feature.id)
    const [signal] = monitor
      .report(feature.id)
      .signals.filter((s) => s.detector === "ping_pong")
    expect(signal).toMatchObject({
      status: "open",
      severity: "warn",
      anchorKind: "thread",
      anchorId: thread,
      alertedTo: POD_LEAD,
    })
    // The context-bearing seat, not a random one (and not the top lead).
    const [alert] = alerts(feature)
    expect(alert).toMatchObject({
      fromAddress: "health@rig",
      toAddress: POD_LEAD,
    })
    expect(alert.body).toContain("Ping-pong")
    expect(alert.body).toMatch(/continue.*\n.*replan.*\n.*escalate/)
    expect(notifications).toEqual([
      "Health: Ping-pong · builder@implementation ↔ qa@implementation",
    ])
    // Both offending seats get a drift Refocus.
    for (const address of [BUILDER, QA]) {
      const [note] = refocusNotes(address)
      expect(JSON.parse(note.body)).toMatchObject({
        kind: "drift",
        signal: { code: "ping_pong" },
      })
    }
    // Evaluating again changes nothing: one alert per signal.
    tick()
    monitor.evaluate(feature.id)
    expect(alerts(feature)).toHaveLength(1)
    expect(refocusNotes(BUILDER)).toHaveLength(1)

    // The Refocus lands, and the seats keep going.
    deliverRefocus(feature, BUILDER)
    exchange(2, thread)
    monitor.evaluate(feature.id)
    const ignored = monitor
      .report(feature.id)
      .signals.find((s) => s.detector === "refocus_ignored")!
    expect(ignored).toMatchObject({ severity: "warn", status: "open" })
    expect(features.getFeature(feature.id)!.status).toBe("active")
    expect(refocusNotes(BUILDER)).toHaveLength(2)

    // A second ignored Refocus is critical: the feature pauses.
    deliverRefocus(feature, QA)
    exchange(2, thread)
    monitor.evaluate(feature.id)
    const paused = features.getFeature(feature.id)!
    expect(paused.status).toBe("paused")
    expect(paused.drive.pausedBy).toBe("health")
    expect(paused.drive.pauseReason).toContain("Refocus ignored")
    expect(notifications.at(-1)).toBe(
      "Mission Control paused “Billing” (health)"
    )
    expect(monitor.report(feature.id).status).toBe("paused_by_health")

    // Resuming acknowledges what was open, so age alone can't re-pause it.
    navigator.resume(feature.id)
    monitor.onResumed(feature.id)
    expect(
      monitor.report(feature.id).signals.filter((s) => s.status === "open")
    ).toEqual([])
  })
})

describe.skipIf(!sqliteLoads)("health: alerts are not ceremony_rising", () => {
  it("rising health alerts alone don't fire it; the same seat chatter does", () => {
    const { feature } = orchestrated()
    const start = Date.now()
    // An hour of climbing ceremony: 2, 5, then 9 in each 20 minutes.
    const climb = (post: (i: number) => void) => {
      let i = 0
      ;[2, 5, 9].forEach((count, third) => {
        for (let n = 0; n < count; n++) {
          vi.setSystemTime(start + third * 20 * MIN + (n + 1) * MIN)
          post(i++)
        }
      })
      vi.setSystemTime(start + 60 * MIN + 30 * 1000)
    }
    climb((i) =>
      ok(
        bus.alert({
          featureId: feature.id,
          to: POD_LEAD,
          body: `Alert ${i}`,
          anchor: null,
        })
      )
    )
    monitor.evaluate(feature.id)
    expect(
      monitor
        .report(feature.id)
        .signals.some((s) => s.detector === "ceremony_rising")
    ).toBe(false)

    vi.setSystemTime(start)
    // The same shape from a seat, each in its own thread (no ping-pong).
    climb((i) =>
      ok(
        bus.send(seat(feature, BUILDER), {
          to: i % 2 ? QA : POD_LEAD,
          body: `Status update ${i}`,
        })
      )
    )
    monitor.evaluate(feature.id)
    expect(
      monitor
        .report(feature.id)
        .signals.find((s) => s.detector === "ceremony_rising")
    ).toMatchObject({ severity: "warn", alertedTo: POD_LEAD })
  })
})

describe.skipIf(!sqliteLoads)(
  "health: proofs, escalation, and a healthy run",
  () => {
    it("raises proof_polishing for a proof edited after acceptance", () => {
      const { feature, userStory } = orchestrated()
      for (const status of ["ready", "running", "proving"] as const)
        features.setUserStoryExecution(userStory.id, { status }, "test")
      // What record_proof emits: accepted, then two more tries on a frozen proof.
      events.recordEvent({
        featureId: feature.id,
        type: "proof_accepted",
        userStoryId: userStory.id,
        seatAddress: QA,
        refId: "run-1",
      })
      for (let i = 0; i < 2; i++) {
        tick()
        events.recordEvent({
          featureId: feature.id,
          type: "proof_after_acceptance",
          userStoryId: userStory.id,
          seatAddress: QA,
        })
      }
      monitor.evaluate(feature.id)
      const signal = monitor
        .report(feature.id)
        .signals.find((s) => s.detector === "proof_polishing")!
      expect(signal).toMatchObject({
        severity: "warn",
        anchorKind: "user_story",
        anchorId: userStory.id,
        alertedTo: POD_LEAD,
      })
      expect(signal.evidence).toHaveLength(2)
      expect(monitor.anchors(feature.id)).toEqual({
        [userStory.id]: "warn",
        [userStory.milestoneId]: "warn",
      })
    })

    it("pauses on a warning nobody acknowledged for 30 minutes, not on an acknowledged one", () => {
      const { feature } = orchestrated()
      ok(
        bus.send(seat(feature, BUILDER), {
          to: QA,
          body: "Please approve the merge so I can land it.",
        })
      )
      monitor.evaluate(feature.id)
      const signal = monitor
        .report(feature.id)
        .signals.find((s) => s.detector === "approval_by_proxy")!
      expect(signal.severity).toBe("warn")
      tick(31)
      monitor.evaluate(feature.id)
      expect(features.getFeature(feature.id)!.drive.pausedBy).toBe("health")

      // Acknowledged in time, the same warning just stays on the Health tab.
      const other = orchestratedAgain()
      ok(
        bus.send(seat(other, BUILDER), {
          to: QA,
          body: "Please approve the merge so I can land it.",
        })
      )
      monitor.evaluate(other.id)
      const second = monitor
        .report(other.id)
        .signals.find((s) => s.detector === "approval_by_proxy")!
      monitor.setSignalStatus(second.id, "acknowledge")
      tick(31)
      monitor.evaluate(other.id)
      expect(features.getFeature(other.id)!.status).toBe("active")
    })

    it("doesn't pause over a story already waiting on the user's decision (plan 110.05)", () => {
      const { feature, userStory } = orchestrated()
      const entry = mergeQueue.enqueueMerge({
        milestoneId: userStory.milestoneId,
        userStoryId: userStory.id,
        playbookRunId: null,
        proofAcceptedAt: Date.now(),
      })
      mergeQueue.updateMergeEntry(entry.id, {
        status: "conflict",
        escalated: true,
      })
      expect(pendingDecisionAnchors(feature.id)).toEqual(
        new Set([userStory.id, userStory.milestoneId])
      )
      for (let i = 0; i < 3; i++) {
        tick()
        events.recordEvent({
          featureId: feature.id,
          type: "proof_rejected",
          userStoryId: userStory.id,
          seatAddress: QA,
          refId: `run-1:${i}`,
        })
      }
      monitor.evaluate(feature.id)
      expect(
        monitor
          .report(feature.id)
          .signals.find((s) => s.detector === "proof_polishing")
      ).toMatchObject({ severity: "warn", anchorId: userStory.id })
      tick(31)
      monitor.evaluate(feature.id)
      expect(features.getFeature(feature.id)!.status).toBe("active")

      // The user decides: the count starts over and the signal clears.
      events.recordEvent({
        featureId: feature.id,
        type: "user_decision",
        userStoryId: userStory.id,
      })
      monitor.evaluate(feature.id)
      expect(
        monitor
          .report(feature.id)
          .signals.find((s) => s.detector === "proof_polishing")
      ).toMatchObject({ status: "resolved" })
    })

    it("raises no warnings on a normal healthy Autopilot run", () => {
      const { feature, userStory } = orchestrated()
      const at = () => {
        tick(4)
        monitor.evaluate(feature.id)
      }
      for (const status of ["ready", "running"] as const)
        features.setUserStoryExecution(userStory.id, { status }, "start")
      at()
      const q = ok(
        bus.send(seat(feature, BUILDER), {
          to: QA,
          body: "Does the invoice need a currency field?",
        })
      )
      at()
      ok(
        bus.send(seat(feature, QA), {
          to: BUILDER,
          body: "Yes, ISO 4217 code.",
          threadId: q.threadId,
        })
      )
      at()
      features.setUserStoryExecution(
        userStory.id,
        { status: "proving" },
        "proof"
      )
      events.recordEvent({
        featureId: feature.id,
        type: "proof_accepted",
        userStoryId: userStory.id,
        seatAddress: QA,
        refId: "run-1",
      })
      events.recordEvent({
        featureId: feature.id,
        type: "criterion_met",
        userStoryId: userStory.id,
        seatAddress: QA,
        refId: `${userStory.id}:AC1`,
      })
      at()
      features.setUserStoryExecution(
        userStory.id,
        { status: "integrating" },
        "merge"
      )
      const entry = mergeQueue.enqueueMerge({
        milestoneId: userStory.milestoneId,
        userStoryId: userStory.id,
        playbookRunId: null,
        proofAcceptedAt: Date.now(),
      })
      mergeQueue.updateMergeEntry(entry.id, {
        status: "merged",
        touchedFiles: ["src/billing/invoice.ts"],
        outsideHints: [],
      })
      features.setUserStoryExecution(userStory.id, { status: "done" }, "merged")
      at()
      const report = monitor.report(feature.id)
      expect(report.signals.filter((s) => s.severity !== "info")).toEqual([])
      expect(report.status).toBe("healthy")
      expect(report.windows.find((w) => w.key === "lifetime")).toMatchObject({
        progress: 5 + 3 + 3 + 1,
      })
      expect(notifications).toEqual([])
    })
  }
)

// A second, independent feature on the same rig.
function orchestratedAgain(): Feature {
  const rig = rigs.listRigs()[0]
  const graph = features.createFeature({
    key: "billing-two",
    name: "Billing two",
    intent: "More invoices.",
    definitionOfDone: "Done.",
    rigId: rig.id,
    workspaceId: upsertWorkspace(tmpdir()).id,
    defaultPodKey: "implementation",
  })
  features.startFeature(graph.feature.id)
  return features.getFeature(graph.feature.id)!
}

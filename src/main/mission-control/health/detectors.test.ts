import { describe, expect, it } from "vitest"
import type { McEvent } from "../../db/types"
import {
  HEALTH_EVENTS,
  HEALTH_SETTING_SPECS,
  healthSettings,
  type HealthEventType,
} from "../../../shared/mission-control/health-weights"
import {
  approvalByProxy,
  ceremonyRising,
  normalizeFailure,
  pingPong,
  proofPolishing,
  retryChurn,
  rightAskedFor,
  runDetectors,
  scopeDrift,
  stalled,
  type HealthSnapshot,
  type SnapshotMessage,
} from "./detectors"

// Health detectors (plan 106.8) over synthetic event sequences: each fires
// on its pathology and stays quiet on the healthy look-alike.

const MIN = 60 * 1000
const NOW = 10 * 60 * MIN
let seq = 0

function event(
  type: HealthEventType,
  at: number,
  extra: Partial<McEvent> = {}
): McEvent {
  const spec = HEALTH_EVENTS[type]
  return {
    id: `e${++seq}`,
    featureId: "f",
    milestoneId: null,
    userStoryId: null,
    seatAddress: null,
    class: spec.class,
    type,
    weight: spec.weight,
    refId: null,
    detail: null,
    createdAt: at,
    ...extra,
  }
}

function message(
  from: string,
  to: string,
  at: number,
  extra: Partial<SnapshotMessage> = {}
): SnapshotMessage {
  return {
    id: `m${++seq}`,
    threadId: "t1",
    from,
    to,
    kind: "message",
    status: "delivered",
    body: "Can you look at this?",
    needsDecision: null,
    createdAt: at,
    ...extra,
  }
}

function snapshot(patch: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    now: NOW,
    feature: { id: "f", status: "active", startedAt: NOW - 5 * 60 * MIN },
    settings: healthSettings({}),
    events: [],
    activeWorkers: 1,
    userStories: [
      {
        id: "s1",
        key: "invoice-model",
        title: "Invoice model",
        status: "running",
        attempts: 1,
        podKey: "implementation",
        touchHints: ["src/billing/**"],
      },
    ],
    maxAttempts: 3,
    messages: [],
    seats: [
      {
        address: "lead@implementation",
        podKey: "implementation",
        isLead: true,
        decisionRights: ["accept_proof", "merge"],
      },
      {
        address: "builder@implementation",
        podKey: "implementation",
        isLead: false,
        decisionRights: [],
      },
      {
        address: "qa@implementation",
        podKey: "implementation",
        isLead: false,
        decisionRights: [],
      },
    ],
    merges: [],
    ...patch,
  }
}

describe("health defaults", () => {
  it("pins the default weights and thresholds", () => {
    expect(HEALTH_EVENTS.user_story_done.weight).toBe(5)
    expect(HEALTH_EVENTS.milestone_completed.weight).toBe(8)
    expect(HEALTH_EVENTS.message_sent.weight).toBe(1)
    expect(HEALTH_EVENTS.rework_round.weight).toBe(2)
    expect(HEALTH_EVENTS.alert.class).toBe("ceremony")
    expect(
      Object.fromEntries(HEALTH_SETTING_SPECS.map((s) => [s.key, s.default]))
    ).toEqual({
      healthCeremonyRatio: 6,
      healthStallMinutes: 45,
      healthPingPongMessages: 6,
      healthOutsideHintFiles: 5,
      healthEscalateMinutes: 30,
    })
  })

  it("reads user overrides and falls back on bad values", () => {
    expect(
      healthSettings({ healthStallMinutes: 10, healthPingPongMessages: -1 })
    ).toMatchObject({ healthStallMinutes: 10, healthPingPongMessages: 6 })
  })
})

describe("ceremony_rising", () => {
  // Ceremony in each 20-minute third of the last hour.
  function climbing(counts: number[], type: HealthEventType = "message_sent") {
    return counts.flatMap((n, third) =>
      Array.from({ length: n }, (_, i) =>
        event(type, NOW - 60 * MIN + third * 20 * MIN + (i + 1) * 1000, {
          seatAddress: "builder@implementation",
        })
      )
    )
  }

  it("fires when ceremony climbs past the ratio with no progress", () => {
    const [finding] = ceremonyRising(snapshot({ events: climbing([1, 3, 5]) }))
    expect(finding.detector).toBe("ceremony_rising")
    expect(finding.severity).toBe("warn")
    expect(finding.offenders.addresses).toEqual(["builder@implementation"])
  })

  it("stays quiet when ceremony is flat, falling, or progress landed recently", () => {
    expect(ceremonyRising(snapshot({ events: climbing([4, 4, 4]) }))).toEqual(
      []
    )
    expect(ceremonyRising(snapshot({ events: climbing([5, 3, 1]) }))).toEqual(
      []
    )
    // A burst after a quiet start is not a trend.
    expect(ceremonyRising(snapshot({ events: climbing([0, 0, 9]) }))).toEqual(
      []
    )
    expect(
      ceremonyRising(
        snapshot({
          events: [
            ...climbing([1, 3, 5]),
            event("user_story_done", NOW - 10 * MIN),
          ],
        })
      )
    ).toEqual([])
  })

  it("never counts health alerts toward the ratio", () => {
    expect(
      ceremonyRising(snapshot({ events: climbing([2, 6, 12], "alert") }))
    ).toEqual([])
  })
})

describe("stalled", () => {
  it("warns past the threshold and goes critical at twice it", () => {
    const warn = stalled(
      snapshot({ events: [event("merge_landed", NOW - 50 * MIN)] })
    )
    expect(warn[0]).toMatchObject({ detector: "stalled", severity: "warn" })
    expect(warn[0].offenders.userStoryIds).toEqual(["s1"])
    const critical = stalled(
      snapshot({ events: [event("merge_landed", NOW - 95 * MIN)] })
    )
    expect(critical[0].severity).toBe("critical")
  })

  it("doesn't count time spent waiting on the user with nothing running", () => {
    // The plan sat unapplied for 106 minutes; the planning review just started.
    const justStarted = snapshot({
      events: [event("hook_completed", NOW - 106 * MIN)],
      workersSince: NOW - 1000,
    })
    expect(stalled(justStarted)).toEqual([])
    // The same worker quiet past the threshold still warns.
    expect(
      stalled({ ...justStarted, workersSince: NOW - 50 * MIN })[0]
    ).toMatchObject({ severity: "warn" })
  })

  it("restarts the clock when the drive resumes, and needs a worker running", () => {
    expect(
      stalled(
        snapshot({
          events: [
            event("merge_landed", NOW - 120 * MIN),
            event("feature_active", NOW - 10 * MIN),
          ],
        })
      )
    ).toEqual([])
    expect(
      stalled(
        snapshot({
          activeWorkers: 0,
          events: [event("merge_landed", NOW - 120 * MIN)],
        })
      )
    ).toEqual([])
  })
})

describe("proof_polishing", () => {
  it("fires when a proof is recorded again after acceptance", () => {
    const [finding] = proofPolishing(
      snapshot({
        events: [
          event("proof_accepted", NOW - 5 * MIN, { userStoryId: "s1" }),
          event("proof_after_acceptance", NOW - 2 * MIN, {
            userStoryId: "s1",
            seatAddress: "qa@implementation",
          }),
        ],
      })
    )
    expect(finding).toMatchObject({
      detector: "proof_polishing",
      severity: "warn",
      anchor: { kind: "user_story", id: "s1" },
    })
    expect(finding.offenders.addresses).toEqual(["qa@implementation"])
  })

  it("fires on three rejections across attempts, not on two", () => {
    const rejected = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        event("proof_rejected", NOW - (10 - i) * MIN, { userStoryId: "s1" })
      )
    expect(proofPolishing(snapshot({ events: rejected(2) }))).toEqual([])
    expect(proofPolishing(snapshot({ events: rejected(3) }))).toHaveLength(1)
  })

  it("is only informational once the user story is done", () => {
    const [finding] = proofPolishing(
      snapshot({
        userStories: [{ ...snapshot().userStories[0], status: "done" }],
        events: [
          event("proof_after_acceptance", NOW - MIN, { userStoryId: "s1" }),
        ],
      })
    )
    expect(finding.severity).toBe("info")
  })
})

describe("ping_pong", () => {
  const exchange = (n: number, start = NOW - 30 * MIN) =>
    Array.from({ length: n }, (_, i) =>
      i % 2
        ? message(
            "qa@implementation",
            "builder@implementation",
            start + i * MIN
          )
        : message(
            "builder@implementation",
            "qa@implementation",
            start + i * MIN
          )
    )

  it("fires on six alternating messages between two seats", () => {
    const [finding] = pingPong(snapshot({ messages: exchange(6) }))
    expect(finding).toMatchObject({
      detector: "ping_pong",
      anchor: {
        kind: "thread",
        id: "t1",
        label: "builder@implementation ↔ qa@implementation",
      },
    })
    expect(finding.evidence).toHaveLength(6)
  })

  it("stays quiet under the threshold, across progress, or with a third seat", () => {
    expect(pingPong(snapshot({ messages: exchange(5) }))).toEqual([])
    expect(
      pingPong(
        snapshot({
          messages: exchange(6),
          events: [event("criterion_met", NOW - 30 * MIN + 2.5 * MIN)],
        })
      )
    ).toEqual([])
    const broken = exchange(6)
    broken[3] = message(
      "lead@implementation",
      "builder@implementation",
      broken[3].createdAt
    )
    expect(pingPong(snapshot({ messages: broken }))).toEqual([])
  })

  it("ignores a loop that ended over an hour ago", () => {
    expect(
      pingPong(snapshot({ messages: exchange(8, NOW - 120 * MIN) }))
    ).toEqual([])
  })
})

describe("scope_drift", () => {
  it("fires on files far past the touch hints", () => {
    const touched = Array.from({ length: 8 }, (_, i) => `src/other/${i}.ts`)
    const [finding] = scopeDrift(
      snapshot({
        merges: [
          { userStoryId: "s1", touchedFiles: touched, outsideHints: touched },
        ],
      })
    )
    expect(finding.detector).toBe("scope_drift")
    expect(finding.summary).toContain("8 files outside its touch hints")
  })

  it("fires on three follow-ups from one user story", () => {
    const followups = [1, 2, 3].map((i) =>
      event("followup_proposed", NOW - i * MIN, { userStoryId: "s1" })
    )
    expect(scopeDrift(snapshot({ events: followups.slice(0, 2) }))).toEqual([])
    expect(scopeDrift(snapshot({ events: followups }))[0].summary).toContain(
      "3 follow-ups"
    )
  })

  it("stays quiet for work within its hints", () => {
    expect(
      scopeDrift(
        snapshot({
          merges: [
            {
              userStoryId: "s1",
              touchedFiles: ["src/billing/a.ts", "src/billing/b.ts"],
              outsideHints: [],
            },
          ],
        })
      )
    ).toEqual([])
  })
})

describe("approval_by_proxy", () => {
  it("fires when a seat asks a seat without the right to approve", () => {
    const [finding] = approvalByProxy(
      snapshot({
        messages: [
          message("builder@implementation", "qa@implementation", NOW - MIN, {
            body: "Please approve the merge so I can land this.",
          }),
        ],
      })
    )
    expect(finding).toMatchObject({
      detector: "approval_by_proxy",
      anchor: { kind: "seat", id: "builder@implementation" },
    })
  })

  it("stays quiet when the target holds the right, or nothing is asked", () => {
    expect(
      approvalByProxy(
        snapshot({
          messages: [
            message(
              "builder@implementation",
              "lead@implementation",
              NOW - MIN,
              {
                body: "Please approve the merge.",
              }
            ),
            message("builder@implementation", "qa@implementation", NOW - MIN, {
              body: "Can you run the tests on the invoice model?",
            }),
          ],
        })
      )
    ).toEqual([])
  })

  it("reads the right a request is about", () => {
    expect(rightAskedFor("approve the merge")).toBe("merge")
    expect(rightAskedFor("sign off on the proof")).toBe("accept_proof")
    expect(rightAskedFor("authorize the plan change")).toBe("revise_plan")
    expect(rightAskedFor("approve this")).toBeNull()
  })
})

describe("retry_churn", () => {
  const failed = (attempt: number, reason: string) =>
    event("user_story_failed", NOW - (10 - attempt) * MIN, {
      userStoryId: "s1",
      detail: { reason, attempt },
    })

  it("is critical when a user story fails the same way twice", () => {
    const [finding] = retryChurn(
      snapshot({
        events: [
          failed(1, "Tests failed: 3 failing in invoice.test.ts"),
          failed(2, "Tests failed: 4 failing in invoice.test.ts"),
        ],
      })
    )
    expect(finding).toMatchObject({
      detector: "retry_churn",
      severity: "critical",
    })
  })

  it("is critical when every attempt is used", () => {
    const story = { ...snapshot().userStories[0], status: "failed" as const }
    const [finding] = retryChurn(
      snapshot({
        userStories: [{ ...story, attempts: 3 }],
        events: [failed(1, "a"), failed(2, "b"), failed(3, "c")],
      })
    )
    expect(finding.summary).toContain("all 3")
  })

  it("stays quiet for different failures with attempts left", () => {
    expect(
      retryChurn(
        snapshot({ events: [failed(1, "timeout"), failed(2, "lint")] })
      )
    ).toEqual([])
  })

  it("normalizes ids and numbers out of failure reasons", () => {
    expect(
      normalizeFailure("Run 2f1e0c9a-1111-4222-8333-444455556666 failed 3x")
    ).toBe(
      normalizeFailure("Run 9a9a9a9a-1111-4222-8333-444455556666 failed 7x")
    )
  })
})

describe("runDetectors", () => {
  it("raises nothing on a healthy run", () => {
    const events = [
      event("feature_active", NOW - 60 * MIN),
      event("user_story_started", NOW - 55 * MIN, { userStoryId: "s1" }),
      event("message_sent", NOW - 50 * MIN, {
        seatAddress: "builder@implementation",
      }),
      event("message_sent", NOW - 48 * MIN, {
        seatAddress: "qa@implementation",
      }),
      event("validator_round", NOW - 40 * MIN, { userStoryId: "s1" }),
      event("proof_accepted", NOW - 30 * MIN, { userStoryId: "s1" }),
      event("criterion_met", NOW - 30 * MIN, { userStoryId: "s1" }),
      event("merge_landed", NOW - 25 * MIN, { userStoryId: "s1" }),
      event("user_story_done", NOW - 25 * MIN, { userStoryId: "s1" }),
    ]
    expect(
      runDetectors(
        snapshot({
          events,
          messages: [
            message(
              "builder@implementation",
              "qa@implementation",
              NOW - 50 * MIN
            ),
            message(
              "qa@implementation",
              "builder@implementation",
              NOW - 48 * MIN
            ),
          ],
        })
      )
    ).toEqual([])
  })

  it("skips muted detectors", () => {
    const s = snapshot({ events: [event("merge_landed", NOW - 50 * MIN)] })
    expect(runDetectors(s)).toHaveLength(1)
    expect(runDetectors(s, new Set(["stalled"]))).toEqual([])
  })
})

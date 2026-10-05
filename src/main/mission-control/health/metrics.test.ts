import { describe, expect, it } from "vitest"
import type { McEvent } from "../../db/types"
import {
  HEALTH_EVENTS,
  type HealthEventType,
} from "../../../shared/mission-control/health-weights"
import {
  breakdown,
  ceremonyRatio,
  series,
  tally,
  throughput,
  windows,
} from "./metrics"

const MIN = 60 * 1000
const NOW = 5 * 60 * MIN
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

describe("health metrics", () => {
  it("guards the ratio with one unit of progress", () => {
    expect(ceremonyRatio(6, 0)).toBe(6)
    expect(ceremonyRatio(6, 3)).toBe(2)
  })

  it("tallies progress and ceremony, keeping alerts out of the rising measure", () => {
    const t = tally([
      event("user_story_done", NOW),
      event("message_sent", NOW),
      event("alert", NOW),
      event("user_story_started", NOW),
    ])
    expect(t).toMatchObject({
      progress: 5,
      ceremony: 2,
      ceremonyExAlerts: 1,
      progressEvents: 1,
      ceremonyEvents: 2,
      messages: 1,
    })
  })

  it("windows the stream", () => {
    const stream = [
      event("message_sent", NOW - 90 * MIN),
      event("message_sent", NOW - 30 * MIN),
      event("merge_landed", NOW - 5 * MIN),
    ]
    const [quarter, hour, lifetime] = windows(stream, NOW)
    expect(quarter).toMatchObject({ progress: 3, ceremony: 0 })
    expect(hour).toMatchObject({ progress: 3, ceremony: 1 })
    expect(lifetime).toMatchObject({ progress: 3, ceremony: 2 })
  })

  it("buckets a series", () => {
    const points = series(
      [event("message_sent", NOW - 55 * MIN), event("merge_landed", NOW - MIN)],
      NOW - 60 * MIN,
      NOW,
      6
    )
    expect(points).toHaveLength(6)
    expect(points[0].ceremony).toBe(1)
    expect(points[5].progress).toBe(3)
  })

  it("breaks numbers down by seat and pod", () => {
    const result = breakdown(
      [
        event("message_sent", NOW, { seatAddress: "builder@impl" }),
        event("message_sent", NOW, { seatAddress: "builder@impl" }),
        event("proof_accepted", NOW, { seatAddress: "qa@impl" }),
        event("user_story_done", NOW, { userStoryId: "s1" }),
        event("direction", NOW, { seatAddress: "navigator@rig" }),
      ],
      {
        storyPod: new Map([["s1", "impl"]]),
        busyMs: new Map([["lead@orch", 60_000]]),
      }
    )
    expect(result.seats.map((s) => s.key)).toEqual([
      "builder@impl",
      "lead@orch",
      "qa@impl",
    ])
    expect(result.seats[0]).toMatchObject({ ceremony: 2, messages: 2 })
    const impl = result.pods.find((p) => p.key === "impl")!
    expect(impl).toMatchObject({ progress: 8, ceremony: 2 })
    expect(result.pods.find((p) => p.key === "orch")!.busyMs).toBe(60_000)
  })

  it("measures throughput and the median story time", () => {
    const stream = [
      event("user_story_started", NOW - 100 * MIN, { userStoryId: "a" }),
      event("user_story_done", NOW - 80 * MIN, { userStoryId: "a" }),
      event("user_story_started", NOW - 50 * MIN, { userStoryId: "b" }),
      event("user_story_done", NOW - 10 * MIN, { userStoryId: "b" }),
    ]
    expect(throughput(stream, NOW, 2 * 60 * MIN)).toEqual({
      lastHour: 1,
      perActiveHour: 1,
      medianStoryMinutes: 30,
    })
  })
})

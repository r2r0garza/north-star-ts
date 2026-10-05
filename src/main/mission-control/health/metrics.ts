import type { McEvent } from "../../db/types"
import { parseSeatAddress } from "../../../shared/mission-control/address"
import {
  CEREMONY_RISING_EXCLUDED,
  RATIO_EPSILON,
} from "../../../shared/mission-control/health-weights"

// Health metrics (plan 106.8): pure functions over the event stream. The main
// signal is ceremony rising while progress stays flat: the team is busy, but
// the map isn't moving.

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

export function ceremonyRatio(ceremony: number, progress: number): number {
  return ceremony / Math.max(progress, RATIO_EPSILON)
}

export interface Tally {
  progress: number
  ceremony: number
  // Ceremony without health alerts: what ceremony_rising measures.
  ceremonyExAlerts: number
  progressEvents: number
  ceremonyEvents: number
  messages: number
}

export function tally(events: readonly McEvent[]): Tally {
  const out: Tally = {
    progress: 0,
    ceremony: 0,
    ceremonyExAlerts: 0,
    progressEvents: 0,
    ceremonyEvents: 0,
    messages: 0,
  }
  for (const event of events) {
    if (event.class === "progress") {
      out.progress += event.weight
      out.progressEvents++
    } else if (event.class === "ceremony") {
      out.ceremony += event.weight
      out.ceremonyEvents++
      if (!CEREMONY_RISING_EXCLUDED.has(event.type))
        out.ceremonyExAlerts += event.weight
      if (event.type === "message_sent") out.messages++
    }
  }
  return out
}

export function between(
  events: readonly McEvent[],
  from: number,
  to = Number.POSITIVE_INFINITY
): McEvent[] {
  return events.filter((e) => e.createdAt >= from && e.createdAt < to)
}

export function lastOf(
  events: readonly McEvent[],
  predicate: (event: McEvent) => boolean
): McEvent | null {
  for (let i = events.length - 1; i >= 0; i--)
    if (predicate(events[i])) return events[i]
  return null
}

export function lastProgress(events: readonly McEvent[]): McEvent | null {
  return lastOf(events, (e) => e.class === "progress")
}

export interface HealthWindow {
  key: "15m" | "1h" | "lifetime"
  label: string
  progress: number
  ceremony: number
  ratio: number
  progressEvents: number
  ceremonyEvents: number
}

export function windows(
  events: readonly McEvent[],
  now: number
): HealthWindow[] {
  const spans = [
    { key: "15m" as const, label: "Last 15 min", since: now - 15 * MINUTE_MS },
    { key: "1h" as const, label: "Last hour", since: now - HOUR_MS },
    { key: "lifetime" as const, label: "Whole run", since: 0 },
  ]
  return spans.map(({ key, label, since }) => {
    const t = tally(between(events, since))
    return {
      key,
      label,
      progress: t.progress,
      ceremony: t.ceremony,
      ratio: ceremonyRatio(t.ceremony, t.progress),
      progressEvents: t.progressEvents,
      ceremonyEvents: t.ceremonyEvents,
    }
  })
}

export interface SeriesPoint {
  start: number
  end: number
  progress: number
  ceremony: number
}

// Progress and ceremony weight per bucket over [from, to).
export function series(
  events: readonly McEvent[],
  from: number,
  to: number,
  buckets: number
): SeriesPoint[] {
  const span = Math.max(1, to - from)
  const size = span / buckets
  const points: SeriesPoint[] = Array.from({ length: buckets }, (_, i) => ({
    start: Math.round(from + i * size),
    end: Math.round(from + (i + 1) * size),
    progress: 0,
    ceremony: 0,
  }))
  for (const event of events) {
    if (event.createdAt < from || event.createdAt >= to) continue
    const index = Math.min(
      buckets - 1,
      Math.floor((event.createdAt - from) / size)
    )
    if (event.class === "progress") points[index].progress += event.weight
    else if (event.class === "ceremony") points[index].ceremony += event.weight
  }
  return points
}

export interface BreakdownRow {
  // A pod key, or a seat address.
  key: string
  progress: number
  ceremony: number
  ratio: number
  messages: number
  progressEvents: number
  // Time spent running playbook steps (the seat's "busy" time).
  busyMs: number
}

// Per-seat and per-pod numbers. An event counts for the seat that caused it;
// one without a seat (a user story done, a merge) counts for its user story's
// pod.
export function breakdown(
  events: readonly McEvent[],
  input: {
    storyPod: ReadonlyMap<string, string | null>
    busyMs: ReadonlyMap<string, number>
  }
): { pods: BreakdownRow[]; seats: BreakdownRow[] } {
  const seats = new Map<string, McEvent[]>()
  const pods = new Map<string, McEvent[]>()
  const push = (map: Map<string, McEvent[]>, key: string, e: McEvent) => {
    const list = map.get(key)
    if (list) list.push(e)
    else map.set(key, [e])
  }
  for (const event of events) {
    if (event.class === "neutral") continue
    const seat = event.seatAddress ? parseSeatAddress(event.seatAddress) : null
    if (seat) {
      push(seats, event.seatAddress!, event)
      push(pods, seat.podKey, event)
      continue
    }
    const pod = event.userStoryId ? input.storyPod.get(event.userStoryId) : null
    if (pod) push(pods, pod, event)
  }
  for (const address of input.busyMs.keys())
    if (!seats.has(address) && parseSeatAddress(address)) seats.set(address, [])
  const row = (key: string, list: McEvent[], busyMs: number): BreakdownRow => {
    const t = tally(list)
    return {
      key,
      progress: t.progress,
      ceremony: t.ceremony,
      ratio: ceremonyRatio(t.ceremony, t.progress),
      messages: t.messages,
      progressEvents: t.progressEvents,
      busyMs,
    }
  }
  const podBusy = new Map<string, number>()
  for (const [address, ms] of input.busyMs) {
    const pod = parseSeatAddress(address)?.podKey
    if (pod) podBusy.set(pod, (podBusy.get(pod) ?? 0) + ms)
  }
  for (const pod of podBusy.keys()) if (!pods.has(pod)) pods.set(pod, [])
  const byCeremony = (a: BreakdownRow, b: BreakdownRow) =>
    b.ceremony - a.ceremony || a.key.localeCompare(b.key)
  return {
    seats: [...seats]
      .map(([key, list]) => row(key, list, input.busyMs.get(key) ?? 0))
      .sort(byCeremony),
    pods: [...pods]
      .map(([key, list]) => row(key, list, podBusy.get(key) ?? 0))
      .sort(byCeremony),
  }
}

export interface Throughput {
  // User stories merged (or done without a merge) in the last hour.
  lastHour: number
  // Per hour of active drive time over the whole run.
  perActiveHour: number | null
  // Median minutes from a user story's start to done.
  medianStoryMinutes: number | null
}

export function throughput(
  events: readonly McEvent[],
  now: number,
  activeMs: number
): Throughput {
  const done = events.filter((e) => e.type === "user_story_done")
  const started = new Map<string, number>()
  const durations: number[] = []
  for (const event of events) {
    if (!event.userStoryId) continue
    if (event.type === "user_story_started")
      started.set(event.userStoryId, event.createdAt)
    else if (event.type === "user_story_done") {
      const from = started.get(event.userStoryId)
      if (from !== undefined) durations.push(event.createdAt - from)
    }
  }
  durations.sort((a, b) => a - b)
  const median = durations.length
    ? durations.length % 2
      ? durations[(durations.length - 1) / 2]
      : (durations[durations.length / 2 - 1] +
          durations[durations.length / 2]) /
        2
    : null
  return {
    lastHour: done.filter((e) => e.createdAt >= now - HOUR_MS).length,
    perActiveHour:
      activeMs >= 5 * MINUTE_MS
        ? Math.round((done.length / (activeMs / HOUR_MS)) * 10) / 10
        : null,
    medianStoryMinutes: median === null ? null : Math.round(median / MINUTE_MS),
  }
}

import type {
  FeatureStatus,
  HealthAnchorKind,
  HealthEvidence,
  HealthSeverity,
  McEvent,
  RigDecisionRight,
  SeatMessageKind,
  SeatMessageStatus,
  UserStoryStatus,
} from "../../db/types"
import { parseSeatAddress } from "../../../shared/mission-control/address"
import {
  CEREMONY_RISING_EXCLUDED,
  HEALTH_EVENTS,
  type HealthDetector,
  type HealthSettings,
} from "../../../shared/mission-control/health-weights"
import { between, ceremonyRatio, lastOf, lastProgress, tally } from "./metrics"

// Health detectors (plan 106.8). Each is a pure, explainable function over the
// event stream plus a little durable state, returning findings with the
// concrete evidence they rest on. No transcripts, no models. The monitor
// turns findings into signals, alerts, Refocus, and auto-pause.

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
// Message-based detectors look back this far; older loops have cleared.
export const MESSAGE_LOOKBACK_MS = HOUR_MS
// ceremony_rising: nothing moved for this long.
export const CEREMONY_QUIET_MS = 30 * MINUTE_MS
// proof_polishing: rejected proofs across a user story's attempts.
export const PROOF_REJECTIONS = 3
// scope_drift: follow-ups proposed from one user story.
export const FOLLOWUPS_PER_STORY = 3
const EVIDENCE_MAX = 10

export interface SnapshotUserStory {
  id: string
  key: string
  title: string
  status: UserStoryStatus
  attempts: number
  podKey: string | null
  touchHints: string[]
}

export interface SnapshotMessage {
  id: string
  threadId: string
  from: string
  to: string
  kind: SeatMessageKind
  status: SeatMessageStatus
  body: string
  needsDecision: RigDecisionRight | null
  createdAt: number
}

export interface SnapshotSeat {
  address: string
  podKey: string
  isLead: boolean
  decisionRights: RigDecisionRight[]
}

export interface HealthSnapshot {
  now: number
  feature: {
    id: string
    status: FeatureStatus
    startedAt: number | null
  }
  settings: HealthSettings
  // Oldest first.
  events: McEvent[]
  // Playbook runs and seat turns in flight.
  activeWorkers: number
  // When the oldest running playbook run started. A stall is measured from
  // there at the earliest: time spent waiting on the user with nothing
  // running (an unapplied plan) isn't a stall.
  workersSince?: number | null
  userStories: SnapshotUserStory[]
  maxAttempts: number
  // Oldest first; recent enough for the message detectors.
  messages: SnapshotMessage[]
  seats: SnapshotSeat[]
  // The latest merge entry per user story.
  merges: Array<{
    userStoryId: string
    touchedFiles: string[]
    outsideHints: string[]
  }>
}

export interface Finding {
  detector: HealthDetector
  anchor: { kind: HealthAnchorKind; id: string; label: string }
  severity: HealthSeverity
  summary: string
  evidence: HealthEvidence[]
  // The newest thing the finding rests on: after a Refocus lands, newer
  // evidence means the drift continued.
  latestAt: number
  // Whose sessions a Refocus goes to.
  offenders: { addresses: string[]; userStoryIds: string[] }
  // The pod the signal originated in, for routing the alert.
  podKey: string | null
}

function minutes(ms: number): number {
  return Math.round(ms / MINUTE_MS)
}

function clip(text: string, max = 120): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function eventEvidence(event: McEvent): HealthEvidence {
  const spec = HEALTH_EVENTS[event.type as keyof typeof HEALTH_EVENTS]
  const who = event.seatAddress ? ` · ${event.seatAddress}` : ""
  return {
    kind: "event",
    label: `${spec?.label ?? event.type}${who}`,
    at: event.createdAt,
    refId: event.refId ?? event.id,
    ...(event.userStoryId
      ? { link: { kind: "user_story" as const, id: event.userStoryId } }
      : {}),
  }
}

function messageEvidence(message: SnapshotMessage): HealthEvidence {
  return {
    kind: "message",
    label: `${message.from} → ${message.to}: ${clip(message.body)}`,
    at: message.createdAt,
    refId: message.id,
    link: { kind: "thread", id: message.threadId },
  }
}

const isSeat = (address: string) => parseSeatAddress(address) !== null
const podOf = (address: string) => parseSeatAddress(address)?.podKey ?? null
const settled = (status: UserStoryStatus) =>
  status === "done" || status === "cancelled"

// ── ceremony_rising (bureaucracy) ───────────────────────────────────────────

// The last hour's ceremony-to-progress ratio is past the threshold, the
// ceremony in its three 20-minute thirds keeps climbing (present in all
// three: a single burst after a quiet start isn't a trend), and nothing moved
// the map for 30 minutes. Health alerts don't count toward it.
export function ceremonyRising(s: HealthSnapshot): Finding[] {
  if (s.feature.status !== "active") return []
  const hour = between(s.events, s.now - HOUR_MS)
  const rising = hour.filter(
    (e) => e.class === "ceremony" && !CEREMONY_RISING_EXCLUDED.has(e.type)
  )
  const t = tally(hour)
  const ratio = ceremonyRatio(t.ceremonyExAlerts, t.progress)
  if (ratio <= s.settings.healthCeremonyRatio) return []
  const third = HOUR_MS / 3
  const thirds = [0, 1, 2].map((i) =>
    rising
      .filter(
        (e) =>
          e.createdAt >= s.now - HOUR_MS + i * third &&
          e.createdAt < s.now - HOUR_MS + (i + 1) * third
      )
      .reduce((sum, e) => sum + e.weight, 0)
  )
  const [first, second, last] = thirds
  if (!(first > 0 && first <= second && second <= last && last > first))
    return []
  const progress = lastProgress(s.events)
  if (progress && s.now - progress.createdAt < CEREMONY_QUIET_MS) return []
  const bySeat = new Map<string, number>()
  for (const e of rising)
    if (e.seatAddress && isSeat(e.seatAddress))
      bySeat.set(e.seatAddress, (bySeat.get(e.seatAddress) ?? 0) + e.weight)
  const loudest = [...bySeat]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([address]) => address)
  return [
    {
      detector: "ceremony_rising",
      anchor: { kind: "feature", id: s.feature.id, label: "Whole feature" },
      severity: "warn",
      summary: `Ceremony is ${ratio.toFixed(1)}× progress over the last hour and still climbing (${thirds.map((n) => n.toFixed(1)).join(" → ")}), with no progress for ${progress ? `${minutes(s.now - progress.createdAt)} min` : "the whole hour"}.`,
      evidence: rising.slice(-EVIDENCE_MAX).map(eventEvidence),
      latestAt: rising.at(-1)?.createdAt ?? s.now,
      offenders: { addresses: loudest, userStoryIds: [] },
      podKey: loudest[0] ? podOf(loudest[0]) : null,
    },
  ]
}

// ── stalled (stuck coordination loop) ───────────────────────────────────────

// Workers are running, but nothing moved the map for the stall threshold.
// The clock starts at the last progress, or when the drive (re)started.
export function stalled(s: HealthSnapshot): Finding[] {
  if (s.feature.status !== "active" || s.activeWorkers < 1) return []
  const threshold = s.settings.healthStallMinutes * MINUTE_MS
  if (threshold <= 0) return []
  const progress = lastProgress(s.events)
  const resumed = lastOf(s.events, (e) => e.type === "feature_active")
  const since = Math.max(
    progress?.createdAt ?? 0,
    resumed?.createdAt ?? 0,
    s.feature.startedAt ?? 0,
    s.workersSince ?? 0
  )
  if (!since) return []
  const quiet = s.now - since
  if (quiet < threshold) return []
  const running = s.userStories.filter((u) => u.status === "running")
  const evidence: HealthEvidence[] = [
    progress
      ? {
          ...eventEvidence(progress),
          label: `Last progress: ${eventEvidence(progress).label}`,
        }
      : {
          kind: "event",
          label: "No progress since the drive started",
          at: since,
        },
    ...running.map(
      (u): HealthEvidence => ({
        kind: "event",
        label: `${u.key} running (attempt ${u.attempts})`,
        at: null,
        link: { kind: "user_story", id: u.id },
      })
    ),
  ]
  return [
    {
      detector: "stalled",
      anchor: { kind: "feature", id: s.feature.id, label: "Whole feature" },
      severity: quiet >= 2 * threshold ? "critical" : "warn",
      summary: `${s.activeWorkers} worker(s) running, but nothing has moved the map for ${minutes(quiet)} min.`,
      evidence: evidence.slice(0, EVIDENCE_MAX),
      latestAt: s.now,
      offenders: { addresses: [], userStoryIds: running.map((u) => u.id) },
      podKey: running[0]?.podKey ?? null,
    },
  ]
}

// ── proof_polishing (recursive proof loop) ──────────────────────────────────

// A proof re-recorded after it was accepted, or rejected again and again
// across a user story's attempts.
export function proofPolishing(s: HealthSnapshot): Finding[] {
  const findings: Finding[] = []
  for (const story of s.userStories) {
    if (story.status === "cancelled") continue
    const mine = s.events.filter((e) => e.userStoryId === story.id)
    const after = mine.filter((e) => e.type === "proof_after_acceptance")
    const rejected = mine.filter((e) => e.type === "proof_rejected")
    if (!after.length && rejected.length < PROOF_REJECTIONS) continue
    const evidence = [...after, ...rejected]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-EVIDENCE_MAX)
    const summary = after.length
      ? `${story.key}'s proof was recorded ${after.length} more time(s) after it was accepted and frozen.`
      : `${story.key}'s proof was rejected ${rejected.length} times across ${story.attempts} attempt(s).`
    findings.push({
      detector: "proof_polishing",
      anchor: { kind: "user_story", id: story.id, label: story.key },
      severity: settled(story.status) ? "info" : "warn",
      summary,
      evidence: evidence.map(eventEvidence),
      latestAt: evidence.at(-1)!.createdAt,
      offenders: {
        addresses: [
          ...new Set(
            evidence
              .map((e) => e.seatAddress)
              .filter((a): a is string => !!a && isSeat(a))
          ),
        ],
        userStoryIds: [story.id],
      },
      podKey: story.podKey,
    })
  }
  return findings
}

// ── ping_pong (coordination loop) ───────────────────────────────────────────

// The tail of one thread alternating between the same two seats, with no
// progress anywhere in between.
export function pingPong(s: HealthSnapshot): Finding[] {
  const threshold = s.settings.healthPingPongMessages
  if (threshold <= 1) return []
  const progressAt = s.events
    .filter((e) => e.class === "progress")
    .map((e) => e.createdAt)
  const threads = new Map<string, SnapshotMessage[]>()
  for (const m of s.messages) {
    if (m.kind !== "message" || m.status === "refused") continue
    if (!isSeat(m.from) || !isSeat(m.to)) continue
    const list = threads.get(m.threadId)
    if (list) list.push(m)
    else threads.set(m.threadId, [m])
  }
  const findings: Finding[] = []
  for (const [threadId, list] of threads) {
    const last = list.at(-1)!
    if (s.now - last.createdAt > MESSAGE_LOOKBACK_MS) continue
    const run = [last]
    for (let i = list.length - 2; i >= 0; i--) {
      const next = run[0]
      const m = list[i]
      if (m.from !== next.to || m.to !== next.from) break
      if (progressAt.some((t) => t > m.createdAt && t <= next.createdAt)) break
      run.unshift(m)
    }
    if (run.length < threshold) continue
    const pair = [last.from, last.to].sort()
    findings.push({
      detector: "ping_pong",
      anchor: {
        kind: "thread",
        id: threadId,
        label: `${pair[0]} ↔ ${pair[1]}`,
      },
      severity: "warn",
      summary: `${pair[0]} and ${pair[1]} have traded ${run.length} messages in one thread with no progress in between.`,
      evidence: run.slice(-EVIDENCE_MAX).map(messageEvidence),
      latestAt: last.createdAt,
      offenders: { addresses: pair, userStoryIds: [] },
      podKey: podOf(run[0].from),
    })
  }
  return findings
}

// ── scope_drift (moonbase) ──────────────────────────────────────────────────

// A user story changed more than twice the files its touch hints name, or
// more files outside them than the threshold, or keeps proposing follow-ups.
export function scopeDrift(s: HealthSnapshot): Finding[] {
  const findings: Finding[] = []
  const merges = new Map(s.merges.map((m) => [m.userStoryId, m]))
  for (const story of s.userStories) {
    if (story.status === "cancelled") continue
    const merge = merges.get(story.id)
    const followups = s.events.filter(
      (e) => e.type === "followup_proposed" && e.userStoryId === story.id
    )
    const reasons: string[] = []
    const evidence: HealthEvidence[] = []
    if (merge) {
      const hints = story.touchHints.length
      const touched = merge.touchedFiles.length
      const outside = merge.outsideHints.length
      if (hints > 0 && touched > 2 * hints)
        reasons.push(`changed ${touched} files against ${hints} touch hint(s)`)
      if (outside > s.settings.healthOutsideHintFiles)
        reasons.push(`changed ${outside} files outside its touch hints`)
      if (reasons.length)
        evidence.push(
          ...merge.outsideHints.slice(0, EVIDENCE_MAX).map(
            (file): HealthEvidence => ({
              kind: "file",
              label: `Outside the hints: ${file}`,
              at: null,
              link: { kind: "user_story", id: story.id },
            })
          )
        )
    }
    if (followups.length >= FOLLOWUPS_PER_STORY) {
      reasons.push(`proposed ${followups.length} follow-ups`)
      evidence.push(...followups.slice(-EVIDENCE_MAX).map(eventEvidence))
    }
    if (!reasons.length) continue
    findings.push({
      detector: "scope_drift",
      anchor: { kind: "user_story", id: story.id, label: story.key },
      severity: settled(story.status) ? "info" : "warn",
      summary: `${story.key} ${reasons.join(", and ")}.`,
      evidence: evidence.slice(0, EVIDENCE_MAX),
      latestAt: followups.at(-1)?.createdAt ?? s.now,
      offenders: { addresses: [], userStoryIds: [story.id] },
      podKey: story.podKey,
    })
  }
  return findings
}

// ── approval_by_proxy (just following orders) ───────────────────────────────

const APPROVAL =
  /\b(approve|approval|authori[sz]e|authori[sz]ation|sign[- ]?off|green[- ]?light)\b/i

// The decision right an approval request is about, when the words say.
export function rightAskedFor(body: string): RigDecisionRight | null {
  if (/\bmerg/i.test(body)) return "merge"
  if (/\bproof\b|\baccept/i.test(body)) return "accept_proof"
  if (/\bfollow[- ]?ups?\b/i.test(body)) return "approve_followup"
  if (/\bplan\b|\bscope\b|\buser stor/i.test(body)) return "revise_plan"
  if (/\bassign|\bstart\b/i.test(body)) return "assign_user_story"
  return null
}

// A seat asks another seat to approve or authorize something that seat holds
// no decision right over: authority borrowed from someone who has none.
export function approvalByProxy(s: HealthSnapshot): Finding[] {
  const seats = new Map(s.seats.map((seat) => [seat.address, seat]))
  const asks = new Map<string, SnapshotMessage[]>()
  for (const m of s.messages) {
    if (m.kind !== "message" || m.status === "refused") continue
    if (s.now - m.createdAt > MESSAGE_LOOKBACK_MS) continue
    const target = seats.get(m.to)
    if (!target || !isSeat(m.from) || !APPROVAL.test(m.body)) continue
    const right = m.needsDecision ?? rightAskedFor(m.body)
    const holds = right
      ? target.decisionRights.includes(right)
      : target.decisionRights.length > 0
    if (holds) continue
    const list = asks.get(m.from)
    if (list) list.push(m)
    else asks.set(m.from, [m])
  }
  return [...asks].map(([from, list]) => {
    const last = list.at(-1)!
    return {
      detector: "approval_by_proxy" as const,
      anchor: { kind: "seat" as const, id: from, label: from },
      severity: "warn" as const,
      summary: `${from} asked ${[...new Set(list.map((m) => m.to))].join(", ")} to approve something ${list.length > 1 ? "they hold" : "it holds"} no decision right over.`,
      evidence: list.slice(-EVIDENCE_MAX).map(messageEvidence),
      latestAt: last.createdAt,
      offenders: { addresses: [from], userStoryIds: [] },
      podKey: podOf(from),
    }
  })
}

// ── retry_churn (thrash) ────────────────────────────────────────────────────

export function normalizeFailure(reason: string): string {
  return reason
    .toLowerCase()
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      "<id>"
    )
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)
}

// A user story used every attempt, or its last two attempts failed the same
// way.
export function retryChurn(s: HealthSnapshot): Finding[] {
  const findings: Finding[] = []
  for (const story of s.userStories) {
    if (settled(story.status)) continue
    const failures = s.events.filter(
      (e) => e.type === "user_story_failed" && e.userStoryId === story.id
    )
    const reasonOf = (e: McEvent) => String(e.detail?.reason ?? "")
    const exhausted =
      story.status === "failed" && story.attempts >= s.maxAttempts
    const [previous, last] = failures.slice(-2)
    const repeated =
      !!previous &&
      !!last &&
      !!reasonOf(last) &&
      normalizeFailure(reasonOf(previous)) === normalizeFailure(reasonOf(last))
    if (!exhausted && !repeated) continue
    findings.push({
      detector: "retry_churn",
      anchor: { kind: "user_story", id: story.id, label: story.key },
      severity: "critical",
      summary: exhausted
        ? `${story.key} failed all ${story.attempts} of its attempts.`
        : `${story.key} failed the same way twice in a row: ${clip(reasonOf(last!), 160)}`,
      evidence: failures.slice(-EVIDENCE_MAX).map(
        (e): HealthEvidence => ({
          kind: "failure",
          label: `Attempt ${String(e.detail?.attempt ?? "?")}: ${clip(reasonOf(e) || "failed", 160)}`,
          at: e.createdAt,
          refId: e.refId ?? e.id,
          link: { kind: "user_story", id: story.id },
        })
      ),
      latestAt: failures.at(-1)?.createdAt ?? s.now,
      offenders: { addresses: [], userStoryIds: [] },
      podKey: story.podKey,
    })
  }
  return findings
}

// ── setup_failed (broken environment, plan 106.11) ─────────────────────────

// The latest worktree setup in the window failed: stories there run without
// the environment the workspace's setup steps were meant to give them.
export function setupFailed(s: HealthSnapshot): Finding[] {
  const setups = s.events.filter(
    (e) => e.type === "worktree_setup_failed" || e.type === "worktree_setup_ok"
  )
  const last = setups.at(-1)
  if (!last || last.type !== "worktree_setup_failed") return []
  const failures = setups.filter((e) => e.type === "worktree_setup_failed")
  const step = String(last.detail?.step ?? "a setup step")
  const reason = String(last.detail?.error ?? "failed")
  return [
    {
      detector: "setup_failed",
      anchor: { kind: "feature", id: s.feature.id, label: "Workspace setup" },
      severity: "warn",
      summary: `The setup step "${step}" failed in a new worktree: ${clip(reason, 160)}`,
      evidence: failures.slice(-EVIDENCE_MAX).map(
        (e): HealthEvidence => ({
          kind: "failure",
          label: `${String(e.detail?.step ?? "Setup")}: ${clip(String(e.detail?.error ?? "failed"), 160)}${e.detail?.outputTail ? ` · ${clip(String(e.detail.outputTail), 120)}` : ""}`,
          at: e.createdAt,
          refId: e.refId ?? e.id,
          ...(e.userStoryId
            ? { link: { kind: "user_story" as const, id: e.userStoryId } }
            : {}),
        })
      ),
      latestAt: last.createdAt,
      offenders: { addresses: [], userStoryIds: [] },
      podKey: null,
    },
  ]
}

// refocus_ignored needs signal history (when a Refocus was requested and
// delivered), so the monitor raises it; see refocusIgnored in monitor.ts.
export const DETECTORS: ReadonlyArray<
  [HealthDetector, (s: HealthSnapshot) => Finding[]]
> = [
  ["ceremony_rising", ceremonyRising],
  ["stalled", stalled],
  ["proof_polishing", proofPolishing],
  ["ping_pong", pingPong],
  ["scope_drift", scopeDrift],
  ["approval_by_proxy", approvalByProxy],
  ["retry_churn", retryChurn],
  ["setup_failed", setupFailed],
]

export function runDetectors(
  snapshot: HealthSnapshot,
  muted: ReadonlySet<string> = new Set()
): Finding[] {
  return DETECTORS.filter(([key]) => !muted.has(key)).flatMap(([, detect]) =>
    detect(snapshot)
  )
}

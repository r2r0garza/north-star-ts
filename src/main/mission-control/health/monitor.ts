import { getDb } from "../../db/connection"
import * as features from "../../db/repositories/features"
import * as mergeQueue from "../../db/repositories/merge-queue"
import * as events from "../../db/repositories/mc-events"
import * as playbooks from "../../db/repositories/playbooks"
import * as comms from "../../db/repositories/seat-comms"
import * as signals from "../../db/repositories/health-signals"
import { hasActiveFeatureTask } from "../../db/repositories/tasks"
import type {
  Feature,
  HealthSeverity,
  HealthSignal,
  HealthSignalStatus,
  McEvent,
} from "../../db/types"
import {
  HEALTH_DETECTORS,
  healthSettings,
  SIGNAL_COOLDOWN_MS,
  type HealthSettings,
} from "../../../shared/mission-control/health-weights"
import { seatDirectory } from "../comms"
import type { DriftSignal } from "../refocus"
import { SEAT_WAKE_KIND } from "../sessions"
import { maxUserStoryAttempts } from "../user-story-runner"
import {
  contextSeat,
  renderAlert,
  renderNotification,
  type AlertContent,
} from "./alerts"
import { runDetectors, type Finding, type HealthSnapshot } from "./detectors"
import {
  breakdown,
  lastProgress,
  series,
  throughput,
  windows,
  type BreakdownRow,
  type HealthWindow,
  type SeriesPoint,
  type Throughput,
} from "./metrics"

// The health monitor (plan 106.8). Re-evaluates a feature's detectors after
// every recorded event (debounced) and on a 60 s timer while it is active,
// turns findings into durable signals, and responds:
//
//   info      shown on the Health tab only.
//   warn      the user is notified; the context-bearing seat gets an alert
//             asking for analysis and continue / replan / escalate; the
//             offending seats get a Refocus.
//   critical  the feature auto-pauses and the user is notified with the
//             evidence. A warning nobody acknowledges or resolves for the
//             escalation window becomes critical.
//
// Each response runs once per signal, so alerting never becomes ceremony of
// its own. The monitor never calls a model.

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DEFAULT_DEBOUNCE_MS = 2000
const DEFAULT_INTERVAL_MS = 60 * 1000
const MESSAGE_WINDOW_MS = 2 * HOUR_MS
const LIVE: HealthSignalStatus[] = ["open", "acknowledged"]
const RANK: Record<HealthSeverity, number> = { info: 0, warn: 1, critical: 2 }

export interface HealthMonitorDeps {
  notifyUser(title: string, body: string): void
  // Post a health alert to a seat (SeatComms.alert).
  alert(input: {
    featureId: string
    to: string
    body: string
    anchor: { kind: "user_story" | "milestone"; id: string } | null
  }): void
  // Pause the feature (Navigator pause semantics, by "health").
  pause(featureId: string, reason: string): void
  // Queue a drift Refocus for a seat conversation (refocus.signalDrift).
  refocus(conversationId: string, signal: DriftSignal): void
  onChanged?(featureId: string): void
  now?: () => number
  debounceMs?: number
  intervalMs?: number
}

export type HealthStatus =
  | "idle"
  | "healthy"
  | "watch"
  | "degraded"
  | "paused_by_health"

export interface HealthReport {
  featureId: string
  generatedAt: number
  status: HealthStatus
  windows: HealthWindow[]
  lastProgress: { label: string; at: number } | null
  sinceProgressMs: number | null
  series: { hour: SeriesPoint[]; lifetime: SeriesPoint[] }
  throughput: Throughput
  activeMs: number
  pods: BreakdownRow[]
  seats: BreakdownRow[]
  signals: HealthSignal[]
  muted: string[]
  settings: HealthSettings
  pauseReason: string | null
}

// User story and milestone ids with a live signal, and the worst severity.
export type HealthAnchors = Record<string, HealthSeverity>

// ── durable state → snapshot ────────────────────────────────────────────────

function workersSince(featureId: string): number | null {
  const runs = playbooks.listPlaybookRuns({ featureId, status: "running" })
  return runs.length ? Math.min(...runs.map((r) => r.createdAt)) : null
}

function activeWorkers(featureId: string): number {
  return (
    playbooks.listPlaybookRuns({ featureId, status: "running" }).length +
    (hasActiveFeatureTask(SEAT_WAKE_KIND, featureId) ? 1 : 0)
  )
}

export function loadSnapshot(feature: Feature, now: number): HealthSnapshot {
  const milestones = features.listMilestones(feature.id)
  const userStories = milestones.flatMap((m) => features.listUserStories(m.id))
  const latestMerge = new Map<
    string,
    { userStoryId: string; touchedFiles: string[]; outsideHints: string[] }
  >()
  for (const entry of mergeQueue.listMergeEntries({ featureId: feature.id }))
    if (entry.status !== "cancelled")
      latestMerge.set(entry.userStoryId, {
        userStoryId: entry.userStoryId,
        touchedFiles: entry.touchedFiles,
        outsideHints: entry.outsideHints,
      })
  return {
    now,
    feature: {
      id: feature.id,
      status: feature.status,
      startedAt: feature.startedAt,
    },
    settings: healthSettings(feature.budgets),
    events: events.listEvents(feature.id),
    activeWorkers: activeWorkers(feature.id),
    workersSince: workersSince(feature.id),
    userStories: userStories.map((u) => ({
      id: u.id,
      key: u.key,
      title: u.title,
      status: u.status,
      attempts: u.attempts,
      podKey: u.podKey ?? feature.defaultPodKey,
      touchHints: u.spec.touchHints,
    })),
    maxAttempts: maxUserStoryAttempts(feature),
    messages: comms
      .listMessages({ featureId: feature.id, limit: 500 })
      .filter((m) => m.createdAt >= now - MESSAGE_WINDOW_MS)
      .map((m) => ({
        id: m.id,
        threadId: m.threadId,
        from: m.fromAddress,
        to: m.toAddress,
        kind: m.kind,
        status: m.status,
        body: m.body,
        needsDecision: m.needsDecision,
        createdAt: m.createdAt,
      })),
    seats: feature.rigSnapshot
      ? seatDirectory(feature.rigSnapshot)
          .filter((s) => !s.vacant)
          .map((s) => ({
            address: s.address,
            podKey: s.podKey,
            isLead: s.isLead,
            decisionRights: s.decisionRights,
          }))
      : [],
    merges: [...latestMerge.values()],
  }
}

// The seat conversations a Refocus reaches: live seat sessions and running
// playbook steps of the offending seats, and every running step of the
// offending user stories.
export function offenderConversations(
  featureId: string,
  offenders: Finding["offenders"]
): string[] {
  const db = getDb()
  const found = new Set<string>()
  const add = (rows: unknown[]) => {
    for (const id of rows) if (typeof id === "string" && id) found.add(id)
  }
  for (const address of offenders.addresses) {
    add(
      db
        .prepare(
          "SELECT conversation_id FROM seat_sessions WHERE feature_id = ? AND seat_address = ? AND status IN ('idle', 'busy') AND conversation_id IS NOT NULL"
        )
        .pluck()
        .all(featureId, address)
    )
    add(
      db
        .prepare(
          `SELECT t.conversation_id FROM playbook_runs r
           JOIN process_phase_runs p ON p.run_id = r.process_run_id
           JOIN tasks t ON t.id = p.task_id
           WHERE r.feature_id = ? AND r.status = 'running' AND p.status = 'running' AND p.seat_address = ?`
        )
        .pluck()
        .all(featureId, address)
    )
  }
  for (const userStoryId of offenders.userStoryIds) {
    add(
      db
        .prepare(
          `SELECT t.conversation_id FROM playbook_runs r
           JOIN process_phase_runs p ON p.run_id = r.process_run_id
           JOIN tasks t ON t.id = p.task_id
           WHERE r.user_story_id = ? AND r.status = 'running' AND p.status = 'running' AND p.seat_address IS NOT NULL`
        )
        .pluck()
        .all(userStoryId)
    )
    add(
      db
        .prepare(
          `SELECT s.conversation_id FROM seat_sessions s
           JOIN playbook_runs r ON r.id = s.playbook_run_id
           WHERE r.user_story_id = ? AND r.status = 'running' AND s.status IN ('idle', 'busy') AND s.conversation_id IS NOT NULL`
        )
        .pluck()
        .all(userStoryId)
    )
  }
  return [...found]
}

// Time each seat spent running playbook steps in this feature.
function busyBySeat(featureId: string, now: number): Map<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT p.seat_address AS address, SUM(COALESCE(p.finished_at, ?) - p.started_at) AS ms
       FROM playbook_runs r JOIN process_phase_runs p ON p.run_id = r.process_run_id
       WHERE r.feature_id = ? AND p.seat_address IS NOT NULL AND p.started_at IS NOT NULL
       GROUP BY p.seat_address`
    )
    .all(now, featureId) as Array<{ address: string; ms: number }>
  return new Map(rows.map((r) => [r.address, Math.max(0, r.ms)]))
}

// ── refocus_ignored ─────────────────────────────────────────────────────────

// A drift signal's Refocus was ignored when one of its Refocus reminders was
// delivered after the last request and the drift has newer evidence than
// that delivery. Returns the delivery, or null.
export function ignoredDelivery(
  signal: Pick<HealthSignal, "lastRefocusAt" | "refocusConversations">,
  finding: Pick<Finding, "latestAt">,
  stream: readonly McEvent[]
): McEvent | null {
  if (signal.lastRefocusAt === null) return null
  const delivered = stream.find(
    (e) =>
      e.type === "refocus_delivered" &&
      e.createdAt >= signal.lastRefocusAt! &&
      signal.refocusConversations.includes(String(e.detail?.conversationId))
  )
  return delivered && finding.latestAt > delivered.createdAt ? delivered : null
}

// ── the service ─────────────────────────────────────────────────────────────

export class HealthMonitor {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private interval: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(private readonly deps: HealthMonitorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  start(): void {
    this.stopped = false
    const every = this.deps.intervalMs ?? DEFAULT_INTERVAL_MS
    if (every > 0) {
      this.interval = setInterval(() => {
        for (const feature of features.listFeatures())
          if (feature.status === "active") this.safeEvaluate(feature.id)
      }, every)
      this.interval.unref?.()
    }
  }

  stop(): void {
    this.stopped = true
    if (this.interval) clearInterval(this.interval)
    this.interval = null
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  // Something was recorded for this feature: re-evaluate soon.
  poke(featureId: string): void {
    if (this.stopped || this.timers.has(featureId)) return
    const timer = setTimeout(() => {
      this.timers.delete(featureId)
      this.safeEvaluate(featureId)
    }, this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS)
    timer.unref?.()
    this.timers.set(featureId, timer)
  }

  private safeEvaluate(featureId: string): void {
    try {
      this.evaluate(featureId)
    } catch (err) {
      console.error(`[health] ${featureId}:`, err)
    }
  }

  // One evaluation: detectors → signals → responses. Returns the live
  // signals.
  evaluate(featureId: string): HealthSignal[] {
    const feature = features.getFeature(featureId)
    if (!feature) return []
    const before = this.fingerprint(featureId)
    if (["completed", "cancelled", "failed"].includes(feature.status)) {
      const now = this.now()
      for (const signal of signals.listSignals(featureId, { statuses: LIVE }))
        signals.updateSignal(signal.id, {
          status: "resolved",
          resolvedAt: now,
        })
      this.changedSince(featureId, before)
      return []
    }
    if (feature.status !== "active") return this.live(featureId)
    const now = this.now()
    const snapshot = loadSnapshot(feature, now)
    const muted = new Set(feature.drive.healthMuted)
    const found = runDetectors(snapshot, muted)

    // Findings → signals, and refocus_ignored from the drift signals' history.
    const pairs: Array<{ finding: Finding; signal: HealthSignal }> = []
    const refocusAgain = new Set<string>()
    getDb().transaction(() => {
      for (const finding of found)
        pairs.push({ finding, signal: this.upsert(featureId, finding, now) })
      if (!muted.has("refocus_ignored"))
        for (const { finding, signal } of [...pairs]) {
          if (!LIVE.includes(signal.status)) continue
          let current = signal
          const delivery = ignoredDelivery(signal, finding, snapshot.events)
          if (delivery) {
            current = signals.updateSignal(signal.id, {
              ignoredCount: signal.ignoredCount + 1,
            })
            refocusAgain.add(signal.id)
          }
          if (!current.ignoredCount) continue
          const ignored: Finding = {
            detector: "refocus_ignored",
            anchor: finding.anchor,
            severity: current.ignoredCount >= 2 ? "critical" : "warn",
            summary: `${HEALTH_DETECTORS.find((d) => d.key === finding.detector)?.label ?? finding.detector} kept firing after ${current.ignoredCount} Refocus reminder(s): ${finding.summary}`,
            evidence: finding.evidence,
            latestAt: finding.latestAt,
            offenders: { addresses: [], userStoryIds: [] },
            podKey: finding.podKey,
          }
          pairs.push({
            finding: ignored,
            signal: this.upsert(featureId, ignored, now),
          })
        }
      const seen = new Set(pairs.map((p) => p.signal.id))
      for (const signal of signals.listSignals(featureId, { statuses: LIVE }))
        if (!seen.has(signal.id))
          signals.updateSignal(signal.id, {
            status: "resolved",
            resolvedAt: now,
          })
    })()

    this.respond(feature, pairs, refocusAgain, snapshot.settings, now)
    this.changedSince(featureId, before)
    return this.live(featureId)
  }

  private upsert(featureId: string, f: Finding, now: number): HealthSignal {
    const latest = signals.latestSignal(
      featureId,
      f.detector,
      f.anchor.kind,
      f.anchor.id
    )
    const fields = {
      summary: f.summary,
      anchorLabel: f.anchor.label,
      evidence: f.evidence,
      lastSeenAt: now,
    }
    const fresh = (s: HealthSignal) =>
      JSON.stringify(s.evidence) !== JSON.stringify(f.evidence)
    if (latest && latest.status !== "resolved")
      return signals.updateSignal(latest.id, {
        ...fields,
        // An escalated signal stays critical while it lasts.
        severity: latest.criticalAt ? "critical" : f.severity,
        fireCount: latest.fireCount + (fresh(latest) ? 1 : 0),
      })
    // Cleared and back within the cooldown: the same episode, not a new one.
    if (
      latest?.resolvedAt != null &&
      now - latest.resolvedAt < SIGNAL_COOLDOWN_MS
    )
      return signals.updateSignal(latest.id, {
        ...fields,
        status: "open",
        resolvedAt: null,
        severity: latest.criticalAt ? "critical" : f.severity,
        fireCount: latest.fireCount + 1,
      })
    return signals.createSignal({
      featureId,
      detector: f.detector,
      anchorKind: f.anchor.kind,
      anchorId: f.anchor.id,
      anchorLabel: f.anchor.label,
      severity: f.severity,
      summary: f.summary,
      evidence: f.evidence,
      now,
    })
  }

  // Alerts, Refocus, and auto-pause: each at most once per signal.
  private respond(
    feature: Feature,
    pairs: Array<{ finding: Finding; signal: HealthSignal }>,
    refocusAgain: ReadonlySet<string>,
    settings: HealthSettings,
    now: number
  ): void {
    const critical: AlertContent[] = []
    const escalateMs = settings.healthEscalateMinutes * MINUTE_MS
    for (const { finding } of pairs) {
      // Re-read: an earlier pair in this pass may have updated it.
      const signal = signals.getSignal(
        pairs.find((p) => p.finding === finding)!.signal.id
      )!
      if (!LIVE.includes(signal.status)) continue
      const content: AlertContent = {
        detector: finding.detector,
        severity: finding.severity,
        summary: finding.summary,
        anchorLabel: finding.anchor.label,
        evidence: finding.evidence,
      }
      const escalate =
        finding.severity === "critical" ||
        (finding.severity === "warn" &&
          signal.status === "open" &&
          escalateMs > 0 &&
          now - signal.firstSeenAt >= escalateMs)
      if (RANK[finding.severity] >= RANK.warn && signal.alertedAt === null) {
        const to = feature.rigSnapshot
          ? contextSeat(feature.rigSnapshot, {
              podKey: finding.podKey,
              offenders: finding.offenders.addresses,
              defaultPodKey: feature.defaultPodKey,
            })
          : null
        if (to)
          try {
            this.deps.alert({
              featureId: feature.id,
              to,
              body: renderAlert(content),
              anchor:
                finding.anchor.kind === "user_story" ||
                finding.anchor.kind === "milestone"
                  ? { kind: finding.anchor.kind, id: finding.anchor.id }
                  : null,
            })
          } catch (err) {
            console.warn("[health] alert not delivered:", err)
          }
        // A critical signal's notification comes with the pause below.
        if (!escalate) {
          const note = renderNotification(content)
          this.deps.notifyUser(note.title, note.body)
        }
        signals.updateSignal(signal.id, { alertedAt: now, alertedTo: to })
      }
      const offenders =
        finding.offenders.addresses.length ||
        finding.offenders.userStoryIds.length
      if (
        offenders &&
        RANK[finding.severity] >= RANK.warn &&
        (signal.refocusCount === 0 || refocusAgain.has(signal.id))
      ) {
        const conversations = offenderConversations(
          feature.id,
          finding.offenders
        )
        for (const conversationId of conversations)
          this.deps.refocus(conversationId, {
            code: finding.detector,
            message: finding.summary,
          })
        if (conversations.length)
          signals.updateSignal(signal.id, {
            refocusCount: signal.refocusCount + 1,
            lastRefocusAt: now,
            refocusConversations: [
              ...new Set([...signal.refocusConversations, ...conversations]),
            ],
          })
      }
      if (escalate && signal.criticalAt === null) {
        signals.updateSignal(signal.id, {
          criticalAt: now,
          severity: "critical",
        })
        critical.push({
          ...content,
          severity: "critical",
          summary:
            finding.severity === "critical"
              ? finding.summary
              : `Unresolved for ${Math.round((now - signal.firstSeenAt) / MINUTE_MS)} min: ${finding.summary}`,
        })
      }
    }
    if (!critical.length) return
    const reason = `Paused by health: ${critical
      .map(
        (c) =>
          `${HEALTH_DETECTORS.find((d) => d.key === c.detector)?.label ?? c.detector} (${c.anchorLabel})`
      )
      .join(", ")}. Check the Health tab, then resume.`
    try {
      if (features.getFeature(feature.id)?.status === "active")
        this.deps.pause(feature.id, reason)
    } catch (err) {
      console.warn("[health] auto-pause failed:", err)
    }
    const evidence = critical
      .flatMap((c) => [
        c.summary,
        ...c.evidence.slice(0, 2).map((e) => `· ${e.label}`),
      ])
      .join("\n")
    this.deps.notifyUser(
      `Mission Control paused “${feature.name}” (health)`,
      evidence.slice(0, 400)
    )
  }

  private live(featureId: string): HealthSignal[] {
    return signals.listSignals(featureId, { statuses: LIVE })
  }

  private fingerprint(featureId: string): string {
    return signals
      .listSignals(featureId)
      .slice(0, 100)
      .map((s) => `${s.id}:${s.status}:${s.severity}:${s.fireCount}`)
      .join("|")
  }

  private changedSince(featureId: string, before: string): void {
    if (this.fingerprint(featureId) !== before) this.deps.onChanged?.(featureId)
  }

  // ── the user surface ──────────────────────────────────────────────────────

  setSignalStatus(
    signalId: string,
    action: "acknowledge" | "resolve" | "mute" | "unmute"
  ): HealthSignal {
    const signal = signals.getSignal(signalId)
    if (!signal) throw new Error("Health signal not found.")
    const now = this.now()
    const updated =
      action === "acknowledge"
        ? signals.updateSignal(signalId, {
            status: signal.status === "open" ? "acknowledged" : signal.status,
            acknowledgedAt: now,
          })
        : action === "resolve"
          ? signals.updateSignal(signalId, {
              status: "resolved",
              resolvedAt: now,
            })
          : action === "mute"
            ? signals.updateSignal(signalId, { status: "muted" })
            : signals.updateSignal(signalId, {
                status: signal.status === "muted" ? "open" : signal.status,
              })
    this.deps.onChanged?.(signal.featureId)
    return updated
  }

  setDetectorMuted(featureId: string, detector: string, muted: boolean): void {
    const feature = features.getFeature(featureId)
    if (!feature) throw new Error(`Feature not found: ${featureId}`)
    if (!HEALTH_DETECTORS.some((d) => d.key === detector))
      throw new Error(`Unknown health detector: ${detector}`)
    const set = new Set(feature.drive.healthMuted)
    if (muted) set.add(detector)
    else set.delete(detector)
    features.setFeatureDrive(featureId, { healthMuted: [...set] })
    if (muted)
      for (const signal of signals.listSignals(featureId, { statuses: LIVE }))
        if (signal.detector === detector)
          signals.updateSignal(signal.id, { status: "muted" })
    this.deps.onChanged?.(featureId)
    this.poke(featureId)
  }

  // The user resumed the feature: they have seen what was open, so nothing
  // escalates on age alone, and the stall clock restarts.
  onResumed(featureId: string): void {
    const now = this.now()
    for (const signal of signals.listSignals(featureId, { statuses: ["open"] }))
      signals.updateSignal(signal.id, {
        status: "acknowledged",
        acknowledgedAt: now,
      })
    this.deps.onChanged?.(featureId)
    this.poke(featureId)
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  report(featureId: string): HealthReport {
    const feature = features.getFeature(featureId)
    if (!feature) throw new Error(`Feature not found: ${featureId}`)
    const now = this.now()
    const stream = events.listEvents(featureId)
    const all = signals.listSignals(featureId).slice(0, 200)
    const live = all.filter((s) => LIVE.includes(s.status))
    const progress = lastProgress(stream)
    const storyPod = new Map<string, string | null>()
    for (const milestone of features.listMilestones(featureId))
      for (const story of features.listUserStories(milestone.id))
        storyPod.set(story.id, story.podKey ?? feature.defaultPodKey)
    const split = breakdown(stream, {
      storyPod,
      busyMs: busyBySeat(featureId, now),
    })
    const start = feature.startedAt ?? stream[0]?.createdAt ?? now
    const worst = Math.max(-1, ...live.map((s) => RANK[s.severity]))
    const status: HealthStatus =
      feature.status === "draft"
        ? "idle"
        : feature.status === "paused" && feature.drive.pausedBy === "health"
          ? "paused_by_health"
          : worst >= RANK.critical
            ? "degraded"
            : worst >= RANK.warn
              ? "watch"
              : "healthy"
    const label = progress
      ? `${progress.type.replace(/_/g, " ")}${progress.seatAddress ? ` · ${progress.seatAddress}` : ""}`
      : null
    return {
      featureId,
      generatedAt: now,
      status,
      windows: windows(stream, now),
      lastProgress: progress ? { label: label!, at: progress.createdAt } : null,
      sinceProgressMs: progress ? now - progress.createdAt : null,
      series: {
        hour: series(stream, now - HOUR_MS, now, 12),
        lifetime: series(stream, start, Math.max(now, start + 1), 24),
      },
      throughput: throughput(stream, now, feature.drive.activeMs),
      activeMs: feature.drive.activeMs,
      pods: split.pods,
      seats: split.seats,
      signals: all,
      muted: feature.drive.healthMuted,
      settings: healthSettings(feature.budgets),
      pauseReason:
        feature.status === "paused" ? feature.drive.pauseReason : null,
    }
  }

  // For the health dots on user story and milestone views.
  anchors(featureId: string): HealthAnchors {
    const out: HealthAnchors = {}
    const mark = (id: string, severity: HealthSeverity) => {
      if (!out[id] || RANK[severity] > RANK[out[id]]) out[id] = severity
    }
    for (const signal of this.live(featureId)) {
      if (signal.anchorKind === "user_story") {
        mark(signal.anchorId, signal.severity)
        const story = features.getUserStory(signal.anchorId)
        if (story) mark(story.milestoneId, signal.severity)
      } else if (signal.anchorKind === "milestone")
        mark(signal.anchorId, signal.severity)
    }
    return out
  }
}

let installed: HealthMonitor | null = null

export function installHealthMonitor(instance: HealthMonitor | null): void {
  installed = instance
}

export function getHealthMonitor(): HealthMonitor | null {
  return installed
}

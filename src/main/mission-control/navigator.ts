import * as features from "../db/repositories/features"
import * as mergeQueue from "../db/repositories/merge-queue"
import * as ticks from "../db/repositories/navigator-ticks"
import * as processes from "../db/repositories/processes"
import { listApprovals } from "../db/repositories/approvals"
import * as playbooks from "../db/repositories/playbooks"
import * as proposalsRepo from "../db/repositories/proposals"
import * as comms from "../db/repositories/seat-comms"
import type {
  DriveMode,
  Feature,
  Milestone,
  NavigatorTick,
  NavigatorTickAction,
  NavigatorTickState,
  PlaybookHookName,
  PlanProposal,
  PlaybookRun,
  UserStory,
  RigGraph,
  UserStoryProof,
} from "../db/types"
import {
  budgetLimit,
  budgetMeters,
  type BudgetUsage,
} from "../../shared/mission-control/budgets"
import { describePlanChange } from "../../shared/mission-control/plan-changes"
import {
  computePosition,
  positionFingerprint,
  type Decision,
  type HookName,
  type Position,
  type PositionInput,
  type PositionUserStoryInput,
} from "../../shared/mission-control/position"
import type { OverlapPolicy } from "../../shared/mission-control/waves"
import { NAVIGATOR_ADDRESS, seatDirectory, USER_ADDRESS } from "./comms"
import type { WorkspaceMode } from "./integration"
import { activeMilestoneOf, applyProposal } from "./map-tools"
import {
  activePlaybookRunForWorkspace,
  maxConcurrentUserStories,
  maxUserStoryAttempts,
  playbookFor,
  processRunFailure,
} from "./user-story-runner"
import { SEAT_WAKE_KIND } from "./sessions"
import { hasActiveFeatureTask } from "../db/repositories/tasks"

// The Navigator (plan 106.6): GPS for a feature. Deterministic and
// restart-safe — it keeps no state of its own beyond the tick log. On every
// relevant durable event it recomputes the position from SQLite, compares its
// fingerprint with the last recorded tick, and only when the position changed
// acts according to the drive mode:
//
//   manual     records the position; dispatches nothing, directs no one.
//   copilot    posts a direction to the lead after every change; the lead acts
//              with map tools. Nothing dispatches without a lead action.
//   autopilot  starts ready user stories and due hooks, completes milestones with
//              nothing to land, and hands judgment calls to the lead as a
//              decision direction.
//
// Re-running a tick against the same position does nothing new. Ticks for an
// feature are serialized and debounced; the Navigator never calls a model.

// Accrue drive time in steps of at most this much, so time the app was closed
// or asleep never counts toward the wall-clock budget.
const MAX_ACCRUAL_STEP_MS = 2 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const DEFAULT_DEBOUNCE_MS = 1000
const DEFAULT_HEARTBEAT_MS = 60 * 1000
// A mechanical action that failed is retried on the heartbeat, at most this
// many more times for the same position, at least this far apart.
const MAX_ACTION_RETRIES = 3
const ACTION_RETRY_MS = 60 * 1000
const MECHANICAL: ReadonlySet<NavigatorTickAction["kind"]> = new Set([
  "start_user_story",
  "retry_user_story",
  "run_hook",
  "apply_plan",
  "complete_milestone",
])

export interface NavigatorDeps {
  startUserStory(
    userStoryId: string,
    options: { note?: string; actor: string }
  ): Promise<PlaybookRun>
  startHook(input: {
    featureId: string
    milestoneId: string | null
    hook: PlaybookHookName
  }): Promise<PlaybookRun>
  cancelPlaybookRun(playbookRunId: string): void
  workspaceMode(feature: Feature): Promise<WorkspaceMode>
  advanceMilestone(milestoneId: string): void
  kickMerges(milestoneId: string): void
  completeMilestone(milestoneId: string): Promise<void>
  // Post a direction to a seat (SeatComms.direct).
  direct(input: { featureId: string; to: string; body: string }): void
  notifyUser(title: string, body: string): void
  // Paused mail can move again (seat sessions).
  onResumed?(featureId: string): void
  onCancelled?(featureId: string): void
  onChanged?(featureId: string): void
  // A feature just started (before planning): e.g. index its workspace so
  // seats can query it instead of searching file by file.
  onFeatureStarted?(feature: Feature): void
  debounceMs?: number
  heartbeatMs?: number
  now?: () => number
}

// ── position input from durable state ───────────────────────────────────────

// The seat the Navigator directs: the lead of the top-most pod above the
// feature's default pod (the orchestration pod oversees implementation),
// falling back down the chain, then to any pod lead.
export function drivingLead(
  rig: RigGraph,
  defaultPodKey: string | null
): { address: string; rights: string[] } | null {
  const directory = seatDirectory(rig)
  const pods = [...rig.pods].sort((a, b) => a.position - b.position)
  const start = pods.find((p) => p.key === defaultPodKey) ?? pods[0]
  if (!start) return null
  const chain = [start]
  for (let depth = 0; depth < pods.length; depth++) {
    const current = chain[chain.length - 1]
    const overseer = rig.oversight
      .filter((edge) => edge.overseenPodId === current.id)
      .map((edge) => pods.find((p) => p.id === edge.overseerPodId))
      .filter((p): p is NonNullable<typeof p> => !!p && !chain.includes(p))
      .sort((a, b) => a.position - b.position)[0]
    if (!overseer) break
    chain.push(overseer)
  }
  const order = [...chain.reverse(), ...pods.filter((p) => !chain.includes(p))]
  for (const pod of order) {
    const lead = directory.find(
      (s) => s.podKey === pod.key && s.isLead && !s.vacant
    )
    if (lead) return { address: lead.address, rights: lead.decisionRights }
  }
  return null
}

function hookNames(
  playbookId: string | null,
  altitude: "feature" | "milestone"
): HookName[] {
  return playbookFor(altitude, playbookId).hooks.map((h) => h.hook as HookName)
}

// Per-milestone budgets measure the active milestone; once every milestone has
// finished they show the last one's final numbers (never acted on).
export function budgetUsage(
  feature: Feature,
  milestone: Milestone | null,
  now: number,
  final = false
): BudgetUsage {
  const runs = playbooks.listPlaybookRuns({
    featureId: feature.id,
    status: "running",
  })
  const userStories = milestone ? features.listUserStories(milestone.id) : []
  return {
    maxConcurrentUserStories: runs.filter(
      (r) => r.userStoryId && r.hook === "run"
    ).length,
    maxUserStoryAttempts: userStories
      .filter((s) => final || !["done", "cancelled"].includes(s.status))
      .reduce((max, s) => Math.max(max, s.attempts), 0),
    maxPlanRevisionsPerMilestone: milestone
      ? features.countRevisions(feature.id, milestone.id, "revise_plan")
      : 0,
    maxAgentUserStoriesPerMilestone: milestone
      ? features.countSeatCreatedUserStories(milestone.id)
      : 0,
    maxMessagesPerHour: comms.countSeatMessagesSince(feature.id, now - HOUR_MS),
    maxActiveHours: Math.round((feature.drive.activeMs / HOUR_MS) * 100) / 100,
    maxPhaseMinutes: longestRunningPhaseMinutes(feature.id, now),
  }
}

export function positionInput(
  feature: Feature,
  workspace: PositionInput["workspace"],
  now: number
): PositionInput {
  const milestones = features.listMilestones(feature.id)
  const userStories = milestones.flatMap((m) => features.listUserStories(m.id))
  const rig = feature.rigSnapshot
  const active =
    milestones.find((m) => !["completed", "cancelled"].includes(m.status)) ??
    null
  const measured =
    active ?? milestones.filter((m) => m.status === "completed").at(-1) ?? null
  const final = !active && !!measured
  const playbookRuns = playbooks.listPlaybookRuns({ featureId: feature.id })
  // A failed user story's latest run: why it failed, and whether the model
  // request (not the user story's work) is what failed.
  const lastFailure = (
    userStoryId: string
  ): PositionUserStoryInput["lastFailure"] => {
    const run = playbookRuns
      .filter(
        (r) =>
          r.userStoryId === userStoryId &&
          r.hook === "run" &&
          r.status === "failed"
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!run) return null
    const failure = run.processRunId
      ? processRunFailure(run.processRunId)
      : null
    return {
      reason: failure?.reason ?? run.outcomeReason ?? "The run failed.",
      infrastructure: failure?.infrastructure ?? false,
    }
  }
  return {
    feature: {
      id: feature.id,
      status: feature.status,
      driveMode: feature.driveMode,
      hooks: hookNames(feature.playbookId, "feature"),
      defaultPodKey: feature.defaultPodKey,
      overlapPolicy: feature.drive.overlapPolicy,
    },
    milestones: milestones.map((m) => ({
      id: m.id,
      key: m.key,
      name: m.name,
      status: m.status,
      position: m.position,
      integrationBranch: m.integrationBranch,
      mergePolicy: m.mergePolicy.mode,
      dodReviewed: !!m.dodReview,
      finishedAt: m.finishedAt,
      hooks: hookNames(m.playbookId, "milestone"),
    })),
    userStories: userStories.map((s) => ({
      id: s.id,
      milestoneId: s.milestoneId,
      key: s.key,
      title: s.title,
      status: s.status,
      attempts: s.attempts,
      podKey: s.podKey,
      position: s.position,
      touchHints: s.spec.touchHints,
      acceptanceCount: s.spec.acceptance.length,
      proofVerdict: (s.proof as UserStoryProof | null)?.verdict ?? null,
      runsLast: s.spec.runsLast,
      lastFailure: s.status === "failed" ? lastFailure(s.id) : null,
    })),
    edges: milestones.flatMap((m) =>
      features.listEdges(m.id).map((e) => ({
        milestoneId: e.milestoneId,
        fromUserStoryId: e.fromUserStoryId,
        toUserStoryId: e.toUserStoryId,
      }))
    ),
    runs: playbookRuns.map((r) => ({
      id: r.id,
      hook: r.hook as HookName,
      milestoneId: r.milestoneId,
      userStoryId: r.userStoryId,
      status: r.status,
      isolated: !!r.worktreePath,
      createdAt: r.createdAt,
    })),
    mergeQueue: milestones.flatMap((m) =>
      mergeQueue.listMergeEntries({ milestoneId: m.id }).map((e) => ({
        id: e.id,
        userStoryId: e.userStoryId,
        milestoneId: e.milestoneId,
        status: e.status,
        escalated: e.escalated,
      }))
    ),
    // Follow-ups (plan 106.7) are ideas for later work: they wait in the
    // inbox and never steer the drive.
    proposals: proposalsRepo
      .listProposals(feature.id, "pending")
      .filter((p) => p.kind !== "followup")
      .map((p) => ({
        id: p.id,
        kind: p.kind,
        proposer: p.proposer,
        summary:
          p.reason ||
          p.changes.slice(0, 2).map(describePlanChange).join("; ") ||
          "(no changes)",
      })),
    runApprovals: runApprovalsOf(playbookRuns, userStories),
    escalations: comms
      .listMessages({
        featureId: feature.id,
        toAddress: USER_ADDRESS,
        statuses: ["delivered"],
      })
      .filter((m) => m.kind === "escalation")
      .map((m) => ({
        id: m.id,
        from: m.fromAddress,
        subject: m.body.split("\n")[0].slice(0, 120),
      })),
    workspace,
    pods: (rig?.pods ?? []).map((pod) => ({
      key: pod.key,
      builderSeats: rig!.seats.filter(
        (seat) =>
          seat.podId === pod.id && seat.role === "builder" && seat.agentRefId
      ).length,
    })),
    lead: rig ? drivingLead(rig, feature.defaultPodKey) : null,
    limits: {
      maxConcurrentUserStories: maxConcurrentUserStories(feature),
      maxUserStoryAttempts: maxUserStoryAttempts(feature),
    },
    budgets: budgetMeters(
      feature.budgets,
      budgetUsage(feature, measured, now, final),
      measured
        ? {
            key: measured.key,
            final,
            userStories: userStories.filter(
              (s) => s.milestoneId === measured.id && s.status !== "cancelled"
            ).length,
          }
        : null
    ),
  }
}

function tickState(position: Position): NavigatorTickState {
  const milestone = position.milestone
  if (!milestone)
    return { milestoneId: null, milestoneStatus: null, userStories: {} }
  const userStories: Record<string, string> = {}
  for (const ref of Object.values(position.userStories))
    if ([...milestone.waves.flat()].includes(ref.id))
      userStories[ref.key] = ref.status
  return {
    milestoneId: milestone.id,
    milestoneStatus: milestone.status,
    userStories,
  }
}

// What changed since the last recorded tick, as short phrases.
function changesSince(
  previous: NavigatorTick | null,
  state: NavigatorTickState
): string[] {
  const before = previous?.state
  if (!before || before.milestoneId !== state.milestoneId)
    return state.milestoneId ? ["The active milestone changed."] : []
  const changes: string[] = []
  if (before.milestoneStatus !== state.milestoneStatus)
    changes.push(
      `milestone ${before.milestoneStatus} → ${state.milestoneStatus}`
    )
  for (const [key, status] of Object.entries(state.userStories ?? {})) {
    const was = before.userStories?.[key]
    if (!was) changes.push(`user story ${key} added (${status})`)
    else if (was !== status) changes.push(`${key} ${was} → ${status}`)
  }
  return changes
}

export function renderDirection(input: {
  position: Position
  mode: DriveMode
  changes: string[]
  decisions: Decision[]
}): string {
  const { position, mode } = input
  const key = (id: string) => position.userStories[id]?.key ?? id
  const lead = input.decisions.filter((d) => d.owner === "lead")
  const user = input.decisions.filter((d) => d.owner === "user")
  const m = position.milestone
  const lines = [
    m
      ? `Position · milestone ${m.key} (${m.status}): ${m.done.length} done, ${m.running.length} running, ${m.integrating.length} merging, ${m.ready.length} ready.`
      : `Position · ${position.feature.complete ? "every milestone is complete" : "no active milestone"}.`,
  ]
  if (input.changes.length) lines.push(`Changed: ${input.changes.join("; ")}.`)
  if (mode === "copilot") {
    lines.push(`Next: ${position.maneuver.text}`)
    if (position.dispatch.length)
      lines.push(
        `Ready to start now (assign_user_story, critical path first): ${position.dispatch.map((d) => `${key(d.userStory)}${d.retry ? " (retry_user_story)" : ""}`).join(", ")}.`
      )
    if (position.feature.nextHook)
      lines.push(
        `The user runs the ${position.feature.nextHook.label}; no action needed from you.`
      )
  }
  if (lead.length) {
    lines.push(
      mode === "autopilot" ? "Decision needed from you:" : "Waiting on you:"
    )
    for (const d of lead) lines.push(`- ${d.summary}`)
  }
  if (user.length) {
    lines.push("Waiting on the user (don't act on these):")
    for (const d of user) lines.push(`- ${d.summary}`)
  }
  lines.push("Call map_status for the full map.")
  return lines.join("\n")
}

// ── the service ─────────────────────────────────────────────────────────────

export class Navigator {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly modes = new Map<
    string,
    { key: string; mode: WorkspaceMode }
  >()
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(private readonly deps: NavigatorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  // Boot: every active feature gets a tick (resuming exactly where the
  // durable state says it is), and a heartbeat accrues drive time.
  start(): void {
    this.stopped = false
    for (const feature of features.listFeatures())
      if (feature.status === "active" || feature.status === "paused")
        this.poke(feature.id)
    const every = this.deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    if (every > 0) {
      this.heartbeat = setInterval(() => {
        for (const feature of features.listFeatures())
          if (feature.status === "active" && feature.driveMode !== "manual")
            this.poke(feature.id)
      }, every)
      this.heartbeat.unref?.()
    }
  }

  stop(): void {
    this.stopped = true
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  // Resolves once every scheduled and running tick has finished (tests).
  async idle(): Promise<void> {
    for (let guard = 0; guard < 100; guard++) {
      if (!this.timers.size && !this.chains.size) return
      if (this.timers.size) {
        for (const [id, timer] of [...this.timers]) {
          clearTimeout(timer)
          this.timers.delete(id)
          void this.enqueue(id)
        }
      }
      await Promise.all([...this.chains.values()])
    }
  }

  // Something durable changed for this feature: tick soon (≤ 1/s).
  poke(featureId: string): void {
    if (this.stopped || this.timers.has(featureId)) return
    const timer = setTimeout(() => {
      this.timers.delete(featureId)
      void this.enqueue(featureId)
    }, this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS)
    timer.unref?.()
    this.timers.set(featureId, timer)
  }

  private enqueue(featureId: string): Promise<unknown> {
    const previous = this.chains.get(featureId) ?? Promise.resolve()
    const next = previous
      .then(() => (this.stopped ? null : this.tick(featureId)))
      .catch((error) => console.error(`[navigator] ${featureId}:`, error))
    this.chains.set(featureId, next)
    void next.finally(() => {
      if (this.chains.get(featureId) === next) this.chains.delete(featureId)
    })
    return next
  }

  private async workspace(
    feature: Feature
  ): Promise<PositionInput["workspace"]> {
    if (!feature.workspaceId)
      return {
        mode: "none",
        busy: false,
        reason: "the feature has no workspace",
      }
    const key = feature.workspaceId
    let cached = this.modes.get(feature.id)
    if (!cached || cached.key !== key) {
      cached = { key, mode: await this.deps.workspaceMode(feature) }
      this.modes.set(feature.id, cached)
    }
    if (cached.mode.mode === "git") return { mode: "git", busy: false }
    const occupant = activePlaybookRunForWorkspace(feature)
    return {
      mode: "single_flight",
      busy: !!occupant && occupant.featureId !== feature.id,
      reason: cached.mode.reason,
    }
  }

  // The current position, without acting (UI and map_status).
  async position(featureId: string): Promise<Position> {
    const feature = features.getFeature(featureId)
    if (!feature) throw new Error(`Feature not found: ${featureId}`)
    return computePosition(
      positionInput(feature, await this.workspace(feature), this.now())
    )
  }

  // Fold elapsed driving time into the feature's active-time budget. Only
  // time with work in flight counts: a user story or hook running, or a seat
  // taking a turn. Waiting on the user (a milestone to land, a proposal to
  // apply) isn't driving; in nav-test-6 a finished milestone waiting
  // overnight to land used up the 8-hour budget.
  private accrue(feature: Feature): Feature {
    const driving =
      feature.status === "active" &&
      feature.driveMode !== "manual" &&
      workInFlight(feature.id)
    const now = this.now()
    const { accountedAt, activeMs } = feature.drive
    if (!driving) {
      return accountedAt === null
        ? feature
        : features.setFeatureDrive(feature.id, { accountedAt: null })
    }
    const step =
      accountedAt === null
        ? 0
        : Math.max(0, Math.min(now - accountedAt, MAX_ACCRUAL_STEP_MS))
    return features.setFeatureDrive(feature.id, {
      activeMs: activeMs + step,
      accountedAt: now,
    })
  }

  // One tick. Returns the recorded tick, or null when the position hadn't
  // changed (nothing new to do).
  async tick(featureId: string): Promise<NavigatorTick | null> {
    let feature = features.getFeature(featureId)
    if (!feature || feature.status === "draft") return null
    feature = this.accrue(feature)
    const active = activeMilestoneOf(feature.id)
    // Bookkeeping, in every mode: the milestone status follows its user stories.
    if (active && feature.status === "active")
      this.deps.advanceMilestone(active.id)

    const position = await this.position(featureId)
    const hash = positionFingerprint(position)
    const previous = ticks.lastTick(featureId)
    // The same position means nothing new to do — unless Autopilot's last
    // mechanical step failed (say, a user story couldn't start), which the
    // heartbeat retries a few times before leaving it to the user.
    let retry = 0
    if (previous?.positionHash === hash) {
      retry = this.retryNumber(feature, previous)
      if (!retry) return null
    }

    const actions: NavigatorTickAction[] = []
    const running = feature.status === "active"
    const mode = feature.driveMode
    const known = new Set(previous?.decisionKeys ?? [])
    const fresh = position.pendingDecisions.filter((d) => !known.has(d.key))

    if (running && mode !== "manual") {
      const hours = position.budgets.find((b) => b.key === "maxActiveHours")
      if (hours?.level === "hard") {
        const reason = `The active-time budget of ${hours.limit} h is used up. Raise it to keep driving.`
        this.pause(featureId, reason, "budget")
        actions.push({
          kind: "auto_pause",
          target: null,
          ok: true,
          detail: reason,
        })
        this.deps.notifyUser(`Mission Control paused “${feature.name}”`, reason)
      } else if (mode === "autopilot") {
        await this.drive(feature, position, actions)
        const failed = actions.filter((a) => MECHANICAL.has(a.kind) && !a.ok)
        if (retry === MAX_ACTION_RETRIES && failed.length)
          this.deps.notifyUser(
            `Mission Control is stuck on “${feature.name}”`,
            `After ${MAX_ACTION_RETRIES} retries: ${failed.map((a) => a.detail).join("; ")}`.slice(
              0,
              400
            )
          )
      }
      if (!actions.some((a) => a.kind === "auto_pause")) {
        this.directLead(feature, position, previous, fresh, actions)
        const forUser = fresh.filter((d) => d.owner === "user")
        if (forUser.length) {
          this.deps.notifyUser(
            `Mission Control: “${feature.name}” is waiting on you`,
            forUser
              .map((d) => d.summary)
              .join("\n")
              .slice(0, 400)
          )
          actions.push({
            kind: "notify",
            target: USER_ADDRESS,
            ok: true,
            detail: `${forUser.length} new decision(s) for the user`,
          })
        }
      }
    }

    const tick = ticks.recordTick({
      featureId,
      positionHash: hash,
      summary: `${position.milestone ? `${position.milestone.key}: ` : ""}${position.maneuver.text}`,
      actions,
      decisionKeys: position.pendingDecisions.map((d) => d.key),
      state: tickState(position),
      createdAt: this.now(),
    })
    this.deps.onChanged?.(featureId)
    // Actions changed durable state; their events poke the next tick.
    return tick
  }

  // Which retry this tick would be (1-based), or 0 when it shouldn't retry.
  private retryNumber(feature: Feature, previous: NavigatorTick): number {
    if (feature.status !== "active" || feature.driveMode !== "autopilot")
      return 0
    if (!previous.actions.some((a) => MECHANICAL.has(a.kind) && !a.ok)) return 0
    if (this.now() - previous.createdAt < ACTION_RETRY_MS) return 0
    let streak = 0
    for (const tick of ticks.listTicks(feature.id, MAX_ACTION_RETRIES + 1)) {
      if (tick.positionHash !== previous.positionHash) break
      streak++
    }
    return streak <= MAX_ACTION_RETRIES ? streak : 0
  }

  // Autopilot milestones land by an approved local merge (the approval is
  // unchanged). Milestones not started yet switch when the mode is chosen; the
  // user can move any of them back to manual.
  private autopilotMergePolicy(featureId: string): void {
    for (const milestone of features.listMilestones(featureId))
      if (
        milestone.status === "planned" &&
        !milestone.integrationBranch &&
        milestone.mergePolicy.mode === "manual"
      )
        features.setMilestoneMergePolicy(
          milestone.id,
          "local_merge",
          NAVIGATOR_ADDRESS
        )
  }

  // Autopilot's mechanical steps.
  private async drive(
    feature: Feature,
    position: Position,
    actions: NavigatorTickAction[]
  ): Promise<void> {
    const actor = NAVIGATOR_ADDRESS
    // The planning proposal, when the user opted into applying it unreviewed,
    // and what the milestone's planning review adds to it: that review is part
    // of planning (every run so far, it added the stories the plan missed).
    if (feature.drive.autoApplyPlan) {
      for (const proposal of proposalsRepo.listProposals(
        feature.id,
        "pending"
      )) {
        if (
          proposal.kind === "followup" ||
          (proposal.kind !== "plan" &&
            !fromPlanningReview(proposal, feature.id))
        )
          continue
        try {
          applyProposal(proposal.id, actor)
          actions.push({
            kind: "apply_plan",
            target: proposal.id,
            ok: true,
            detail: "Applied the planning proposal (auto-apply is on)",
          })
        } catch (error) {
          actions.push({
            kind: "apply_plan",
            target: proposal.id,
            ok: false,
            detail: errorText(error),
          })
        }
        return
      }
    }
    const maneuver = position.maneuver
    if (maneuver.kind === "run_hook" && !position.feature.runningHook) {
      try {
        await this.deps.startHook({
          featureId: feature.id,
          milestoneId: maneuver.hook.milestoneId,
          hook: maneuver.hook.hook as PlaybookHookName,
        })
        actions.push({
          kind: "run_hook",
          target: maneuver.hook.hook,
          ok: true,
          detail: `Started the ${maneuver.hook.label}`,
        })
      } catch (error) {
        actions.push({
          kind: "run_hook",
          target: maneuver.hook.hook,
          ok: false,
          detail: errorText(error),
        })
      }
      return
    }
    if (maneuver.kind === "dispatch") {
      for (const item of position.dispatch) {
        const key = position.userStories[item.userStory]?.key ?? item.userStory
        try {
          await this.deps.startUserStory(item.userStory, {
            actor,
            ...(item.retry
              ? {
                  note: "Automatic retry by the Navigator: the previous attempt stopped without a rejected proof. Check what interrupted it before repeating the same approach.",
                }
              : {}),
          })
          actions.push({
            kind: item.retry ? "retry_user_story" : "start_user_story",
            target: key,
            ok: true,
            detail: `Started ${key}`,
          })
        } catch (error) {
          actions.push({
            kind: item.retry ? "retry_user_story" : "start_user_story",
            target: key,
            ok: false,
            detail: errorText(error),
          })
        }
      }
      return
    }
    if (maneuver.kind === "complete_milestone") {
      try {
        await this.deps.completeMilestone(maneuver.milestoneId)
        actions.push({
          kind: "complete_milestone",
          target: maneuver.milestoneId,
          ok: true,
          detail: maneuver.text,
        })
      } catch (error) {
        actions.push({
          kind: "complete_milestone",
          target: maneuver.milestoneId,
          ok: false,
          detail: errorText(error),
        })
      }
      return
    }
    if (maneuver.kind === "complete_feature") {
      features.setFeatureStatus(
        feature.id,
        "completed",
        "Every milestone is complete",
        actor
      )
      actions.push({
        kind: "complete_feature",
        target: feature.id,
        ok: true,
        detail: "Feature complete",
      })
      this.deps.notifyUser(
        `Mission Control: “${feature.name}” is complete`,
        "Every milestone landed."
      )
      return
    }
    // Merges queued behind a restart or a busy repository.
    const milestoneId = position.milestone?.id
    if (milestoneId && position.milestone!.integrating.length)
      this.deps.kickMerges(milestoneId)
  }

  // Directions to the lead: copilot after every change, autopilot only when a
  // new judgment call is waiting for it.
  private directLead(
    feature: Feature,
    position: Position,
    previous: NavigatorTick | null,
    fresh: Decision[],
    actions: NavigatorTickAction[]
  ): void {
    const lead = position.lead
    if (!lead) return
    const mode = feature.driveMode
    const leadDecisions = position.pendingDecisions.filter(
      (d) => d.owner === "lead"
    )
    if (mode === "autopilot" && !fresh.some((d) => d.owner === "lead")) return
    if (mode === "copilot" && position.feature.complete) return
    const body = renderDirection({
      position,
      mode,
      changes: changesSince(previous, tickState(position)),
      decisions:
        mode === "autopilot" ? leadDecisions : position.pendingDecisions,
    })
    try {
      this.deps.direct({ featureId: feature.id, to: lead, body })
      actions.push({
        kind: "direction",
        target: lead,
        ok: true,
        detail: body.split("\n")[0],
      })
    } catch (error) {
      actions.push({
        kind: "direction",
        target: lead,
        ok: false,
        detail: errorText(error),
      })
    }
  }

  // ── controls ──────────────────────────────────────────────────────────────

  // Start (from draft) in a drive mode. With nothing planned yet, planning
  // runs right away; in autopilot the drive then waits for the user to apply
  // the planning proposal unless auto-apply is on.
  async startDrive(
    featureId: string,
    options: { mode: DriveMode; autoApplyPlan?: boolean }
  ): Promise<{ planning: PlaybookRun | null; planningError: string | null }> {
    const feature = features.getFeature(featureId)
    if (!feature) throw new Error(`Feature not found: ${featureId}`)
    if (feature.status !== "draft")
      throw new Error("Only a draft feature can be started.")
    features.setDriveMode(featureId, options.mode)
    if (options.mode === "autopilot") this.autopilotMergePolicy(featureId)
    features.setFeatureDrive(featureId, {
      autoApplyPlan: options.autoApplyPlan === true,
      accountedAt: null,
      pauseReason: null,
      pausedBy: null,
    })
    features.startFeature(featureId)
    features.setFeatureDrive(featureId, {
      accountedAt: options.mode === "manual" ? null : this.now(),
    })
    try {
      this.deps.onFeatureStarted?.(features.getFeature(featureId)!)
    } catch (err) {
      console.error("[navigator] onFeatureStarted failed:", err)
    }
    let planning: PlaybookRun | null = null
    let planningError: string | null = null
    const planned = features
      .listMilestones(featureId)
      .some((m) => features.listUserStories(m.id).length > 0)
    if (!planned && hookNames(feature.playbookId, "feature").includes("plan")) {
      try {
        planning = await this.deps.startHook({
          featureId,
          milestoneId: null,
          hook: "plan",
        })
      } catch (error) {
        planningError = errorText(error)
      }
    }
    this.poke(featureId)
    return { planning, planningError }
  }

  // In-flight worker turns finish (or pause through their own semantics);
  // nothing new starts — launches, wakes, and hooks all require an active
  // feature — until the user resumes.
  pause(
    featureId: string,
    reason: string,
    by: "user" | "budget" = "user"
  ): Feature {
    const before = features.getFeature(featureId)
    if (!before) throw new Error(`Feature not found: ${featureId}`)
    if (before.status !== "active")
      throw new Error("Only an active feature can be paused.")
    const accrued = this.accrue(before)
    features.setFeatureDrive(featureId, {
      accountedAt: null,
      activeMs: accrued.drive.activeMs,
      pauseReason: reason,
      pausedBy: by,
    })
    const after = features.setFeatureStatus(
      featureId,
      "paused",
      reason,
      by === "user" ? "user" : NAVIGATOR_ADDRESS
    )
    this.poke(featureId)
    return after
  }

  resume(featureId: string): Feature {
    const before = features.getFeature(featureId)
    if (!before) throw new Error(`Feature not found: ${featureId}`)
    if (before.status !== "paused")
      throw new Error("Only a paused feature can be resumed.")
    // Resuming into an exhausted time budget would pause again at once.
    if (before.driveMode !== "manual") {
      const limit = budgetLimit(before.budgets, "maxActiveHours")
      if (before.drive.activeMs >= limit * HOUR_MS)
        throw new Error(
          `The drive has used its ${limit} h active-time budget. Raise the budget before resuming.`
        )
    }
    features.setFeatureDrive(featureId, {
      pauseReason: null,
      pausedBy: null,
      accountedAt: before.driveMode === "manual" ? null : this.now(),
    })
    const after = features.setFeatureStatus(
      featureId,
      "active",
      "Resumed by the user"
    )
    this.deps.onResumed?.(featureId)
    this.poke(featureId)
    return after
  }

  // Cancel the whole feature: running playbook runs are cancelled and
  // queued mail expires. Branches and worktrees stay until it is deleted.
  cancel(featureId: string, reason = "Cancelled by the user"): Feature {
    const before = features.getFeature(featureId)
    if (!before) throw new Error(`Feature not found: ${featureId}`)
    const after = features.setFeatureStatus(featureId, "cancelled", reason)
    for (const run of playbooks.listPlaybookRuns({
      featureId,
      status: "running",
    }))
      this.deps.cancelPlaybookRun(run.id)
    features.setFeatureDrive(featureId, { accountedAt: null })
    this.deps.onCancelled?.(featureId)
    this.poke(featureId)
    return after
  }

  // A completed feature takes more milestones (the next sprint). It reopens
  // paused: the user adds milestones, checks the mode and budgets (drive time
  // keeps accruing against the same budget), then resumes. The Navigator runs
  // the release for the last finished milestone before the new one starts.
  reopen(featureId: string): Feature {
    const before = features.getFeature(featureId)
    if (!before) throw new Error(`Feature not found: ${featureId}`)
    if (before.status !== "completed")
      throw new Error("Only a completed feature can be reopened.")
    features.setFeatureDrive(featureId, {
      accountedAt: null,
      pauseReason: "Reopened. Add the next milestones, then resume.",
      pausedBy: "user",
    })
    const after = features.setFeatureStatus(
      featureId,
      "paused",
      "Reopened by the user for more milestones"
    )
    this.poke(featureId)
    return after
  }

  setMode(featureId: string, mode: DriveMode): Feature {
    const after = features.setDriveMode(featureId, mode)
    if (mode === "autopilot") this.autopilotMergePolicy(featureId)
    this.poke(featureId)
    return after
  }

  // Takes effect at the next dispatch, so it can change while the feature runs.
  setOverlapPolicy(featureId: string, value: OverlapPolicy): Feature {
    const feature = features.getFeature(featureId)
    if (!feature) throw new Error(`Feature not found: ${featureId}`)
    const after = features.setFeatureDrive(featureId, { overlapPolicy: value })
    this.poke(featureId)
    return after
  }

  setAutoApplyPlan(featureId: string, value: boolean): Feature {
    const feature = features.getFeature(featureId)
    if (!feature) throw new Error(`Feature not found: ${featureId}`)
    if (!["draft", "paused"].includes(feature.status))
      throw new Error(
        "Pause the feature before changing how planning is applied."
      )
    const after = features.setFeatureDrive(featureId, { autoApplyPlan: value })
    this.poke(featureId)
    return after
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^touch_overlap: /,
    ""
  )
}

// A proposal the lead made while a milestone's planning review
// (before_user_stories) was running.
function fromPlanningReview(
  proposal: PlanProposal,
  featureId: string
): boolean {
  return playbooks
    .listPlaybookRuns({ featureId })
    .some(
      (run) =>
        run.hook === "before_user_stories" &&
        proposal.createdAt >= run.createdAt &&
        proposal.createdAt <= (run.finishedAt ?? Number.POSITIVE_INFINITY)
    )
}

// Approvals a running user story or hook's Process run is waiting on, for
// Waiting on you: they live on the run's task, which Mission Control doesn't
// otherwise show (a QA send-back outside Autopilot waited unseen).
function runApprovalsOf(
  runs: PlaybookRun[],
  userStories: UserStory[]
): NonNullable<PositionInput["runApprovals"]> {
  const keyOf = new Map(userStories.map((s) => [s.id, s.key]))
  return runs.flatMap((run) => {
    if (run.status !== "running" || !run.processRunId) return []
    const taskId = processes.getProcessRun(run.processRunId)?.taskId
    if (!taskId) return []
    const what = run.userStoryId
      ? `User story ${keyOf.get(run.userStoryId) ?? "?"}`
      : `The ${run.hook.replace(/_/g, " ")} hook`
    return listApprovals({ taskId, status: "pending" }).map((approval) => {
      const request = (approval.request ?? {}) as {
        kind?: string
        phaseKey?: string
        flagTargetKey?: string
        flagReason?: string
      }
      const summary =
        request.kind === "process_flag_gate"
          ? `${what}: ${request.phaseKey || "a phase"} wants to send it back to ${request.flagTargetKey || "an earlier phase"}. ${request.flagReason ?? ""}`.trim()
          : request.kind === "process_validator_gate"
            ? `${what}: ${request.phaseKey || "a phase"}'s reviewer didn't approve it after its retries; decide what happens next.`
            : `${what} is waiting for your approval at ${request.phaseKey || "a phase"}.`
      return {
        id: approval.id,
        userStoryId: run.userStoryId,
        summary: summary.slice(0, 400),
      }
    })
  })
}

// How long the longest-running phase of the feature has been going, in
// minutes: the "Minutes per phase" meter.
function longestRunningPhaseMinutes(featureId: string, now: number): number {
  let longest = 0
  for (const run of playbooks.listPlaybookRuns({
    featureId,
    status: "running",
  })) {
    if (!run.processRunId) continue
    for (const phaseRun of processes.listPhaseRuns({ runId: run.processRunId }))
      if (phaseRun.status === "running" && phaseRun.startedAt)
        longest = Math.max(longest, now - phaseRun.startedAt)
  }
  return Math.round(longest / 60_000)
}

function workInFlight(featureId: string): boolean {
  return (
    playbooks.listPlaybookRuns({ featureId, status: "running" }).length > 0 ||
    hasActiveFeatureTask(SEAT_WAKE_KIND, featureId)
  )
}

// The installed Navigator; map tools reach position() through here.
let installed: Navigator | null = null

export function installNavigator(instance: Navigator | null): void {
  installed = instance
}

export function getNavigator(): Navigator | null {
  return installed
}

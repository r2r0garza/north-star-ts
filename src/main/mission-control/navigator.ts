import * as initiatives from "../db/repositories/initiatives"
import * as mergeQueue from "../db/repositories/merge-queue"
import * as ticks from "../db/repositories/navigator-ticks"
import * as playbooks from "../db/repositories/playbooks"
import * as proposalsRepo from "../db/repositories/proposals"
import * as comms from "../db/repositories/seat-comms"
import type {
  DriveMode,
  Initiative,
  Mission,
  NavigatorTick,
  NavigatorTickAction,
  NavigatorTickState,
  PlaybookHookName,
  PlaybookRun,
  RigGraph,
  SliceProof,
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
} from "../../shared/mission-control/position"
import { NAVIGATOR_ADDRESS, seatDirectory, USER_ADDRESS } from "./comms"
import type { WorkspaceMode } from "./integration"
import { activeMissionOf, applyProposal } from "./map-tools"
import {
  activePlaybookRunForWorkspace,
  maxConcurrentSlices,
  maxSliceAttempts,
  playbookFor,
} from "./slice-runner"

// The Navigator (plan 106.6): GPS for an initiative. Deterministic and
// restart-safe — it keeps no state of its own beyond the tick log. On every
// relevant durable event it recomputes the position from SQLite, compares its
// fingerprint with the last recorded tick, and only when the position changed
// acts according to the drive mode:
//
//   manual     records the position; dispatches nothing, directs no one.
//   copilot    posts a direction to the lead after every change; the lead acts
//              with map tools. Nothing dispatches without a lead action.
//   autopilot  starts ready slices and due hooks, completes missions with
//              nothing to land, and hands judgment calls to the lead as a
//              decision direction.
//
// Re-running a tick against the same position does nothing new. Ticks for an
// initiative are serialized and debounced; the Navigator never calls a model.

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
  "start_slice",
  "retry_slice",
  "run_hook",
  "apply_plan",
  "complete_mission",
])

export interface NavigatorDeps {
  startSlice(
    sliceId: string,
    options: { note?: string; actor: string }
  ): Promise<PlaybookRun>
  startHook(input: {
    initiativeId: string
    missionId: string | null
    hook: PlaybookHookName
  }): Promise<PlaybookRun>
  cancelPlaybookRun(playbookRunId: string): void
  workspaceMode(initiative: Initiative): Promise<WorkspaceMode>
  advanceMission(missionId: string): void
  kickMerges(missionId: string): void
  completeMission(missionId: string): Promise<void>
  // Post a direction to a seat (SeatComms.direct).
  direct(input: { initiativeId: string; to: string; body: string }): void
  notifyUser(title: string, body: string): void
  // Paused mail can move again (seat sessions).
  onResumed?(initiativeId: string): void
  onCancelled?(initiativeId: string): void
  onChanged?(initiativeId: string): void
  debounceMs?: number
  heartbeatMs?: number
  now?: () => number
}

// ── position input from durable state ───────────────────────────────────────

// The seat the Navigator directs: the lead of the top-most pod above the
// initiative's default pod (the orchestration pod oversees implementation),
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
    const lead = directory.find((s) => s.podKey === pod.key && s.isLead && !s.vacant)
    if (lead) return { address: lead.address, rights: lead.decisionRights }
  }
  return null
}

function hookNames(playbookId: string | null, altitude: "initiative" | "mission"): HookName[] {
  return playbookFor(altitude, playbookId).hooks.map((h) => h.hook as HookName)
}

// Per-mission budgets measure the active mission; once every mission has
// finished they show the last one's final numbers (never acted on).
export function budgetUsage(
  initiative: Initiative,
  mission: Mission | null,
  now: number,
  final = false
): BudgetUsage {
  const runs = playbooks.listPlaybookRuns({ initiativeId: initiative.id, status: "running" })
  const slices = mission ? initiatives.listSlices(mission.id) : []
  return {
    maxConcurrentSlices: runs.filter((r) => r.sliceId && r.hook === "run").length,
    maxSliceAttempts: slices
      .filter((s) => final || !["done", "cancelled"].includes(s.status))
      .reduce((max, s) => Math.max(max, s.attempts), 0),
    maxPlanRevisionsPerMission: mission
      ? initiatives.countRevisions(initiative.id, mission.id, "revise_plan")
      : 0,
    maxAgentSlicesPerMission: mission ? initiatives.countSeatCreatedSlices(mission.id) : 0,
    maxMessagesPerHour: comms.countSeatMessagesSince(initiative.id, now - HOUR_MS),
    maxActiveHours: Math.round((initiative.drive.activeMs / HOUR_MS) * 100) / 100,
  }
}

export function positionInput(
  initiative: Initiative,
  workspace: PositionInput["workspace"],
  now: number
): PositionInput {
  const missions = initiatives.listMissions(initiative.id)
  const slices = missions.flatMap((m) => initiatives.listSlices(m.id))
  const rig = initiative.rigSnapshot
  const active = missions.find((m) => !["completed", "cancelled"].includes(m.status)) ?? null
  const measured = active ?? missions.filter((m) => m.status === "completed").at(-1) ?? null
  const final = !active && !!measured
  return {
    initiative: {
      id: initiative.id,
      status: initiative.status,
      driveMode: initiative.driveMode,
      hooks: hookNames(initiative.playbookId, "initiative"),
      defaultPodKey: initiative.defaultPodKey,
    },
    missions: missions.map((m) => ({
      id: m.id,
      key: m.key,
      name: m.name,
      status: m.status,
      position: m.position,
      integrationBranch: m.integrationBranch,
      mergePolicy: m.mergePolicy.mode,
      dodReviewed: !!m.dodReview,
      finishedAt: m.finishedAt,
      hooks: hookNames(m.playbookId, "mission"),
    })),
    slices: slices.map((s) => ({
      id: s.id,
      missionId: s.missionId,
      key: s.key,
      title: s.title,
      status: s.status,
      attempts: s.attempts,
      podKey: s.podKey,
      position: s.position,
      touchHints: s.spec.touchHints,
      acceptanceCount: s.spec.acceptance.length,
      proofVerdict: (s.proof as SliceProof | null)?.verdict ?? null,
    })),
    edges: missions.flatMap((m) =>
      initiatives.listEdges(m.id).map((e) => ({
        missionId: e.missionId,
        fromSliceId: e.fromSliceId,
        toSliceId: e.toSliceId,
      }))
    ),
    runs: playbooks.listPlaybookRuns({ initiativeId: initiative.id }).map((r) => ({
      id: r.id,
      hook: r.hook as HookName,
      missionId: r.missionId,
      sliceId: r.sliceId,
      status: r.status,
      isolated: !!r.worktreePath,
      createdAt: r.createdAt,
    })),
    mergeQueue: missions.flatMap((m) =>
      mergeQueue.listMergeEntries({ missionId: m.id }).map((e) => ({
        id: e.id,
        sliceId: e.sliceId,
        missionId: e.missionId,
        status: e.status,
        escalated: e.escalated,
      }))
    ),
    proposals: proposalsRepo.listProposals(initiative.id, "pending").map((p) => ({
      id: p.id,
      kind: p.kind,
      proposer: p.proposer,
      summary:
        p.reason ||
        p.changes.slice(0, 2).map(describePlanChange).join("; ") ||
        "(no changes)",
    })),
    escalations: comms
      .listMessages({ initiativeId: initiative.id, toAddress: USER_ADDRESS, statuses: ["delivered"] })
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
        (seat) => seat.podId === pod.id && seat.role === "builder" && seat.agentRefId
      ).length,
    })),
    lead: rig ? drivingLead(rig, initiative.defaultPodKey) : null,
    limits: {
      maxConcurrentSlices: maxConcurrentSlices(initiative),
      maxSliceAttempts: maxSliceAttempts(initiative),
    },
    budgets: budgetMeters(
      initiative.budgets,
      budgetUsage(initiative, measured, now, final),
      measured ? { key: measured.key, final } : null
    ),
  }
}

function tickState(position: Position): NavigatorTickState {
  const mission = position.mission
  if (!mission) return { missionId: null, missionStatus: null, slices: {} }
  const slices: Record<string, string> = {}
  for (const ref of Object.values(position.slices))
    if (
      [...mission.waves.flat()].includes(ref.id)
    )
      slices[ref.key] = ref.status
  return { missionId: mission.id, missionStatus: mission.status, slices }
}

// What changed since the last recorded tick, as short phrases.
function changesSince(previous: NavigatorTick | null, state: NavigatorTickState): string[] {
  const before = previous?.state
  if (!before || before.missionId !== state.missionId)
    return state.missionId ? ["The active mission changed."] : []
  const changes: string[] = []
  if (before.missionStatus !== state.missionStatus)
    changes.push(`mission ${before.missionStatus} → ${state.missionStatus}`)
  for (const [key, status] of Object.entries(state.slices ?? {})) {
    const was = before.slices?.[key]
    if (!was) changes.push(`slice ${key} added (${status})`)
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
  const key = (id: string) => position.slices[id]?.key ?? id
  const lead = input.decisions.filter((d) => d.owner === "lead")
  const user = input.decisions.filter((d) => d.owner === "user")
  const m = position.mission
  const lines = [
    m
      ? `Position · mission ${m.key} (${m.status}): ${m.done.length} done, ${m.running.length} running, ${m.integrating.length} merging, ${m.ready.length} ready.`
      : `Position · ${position.initiative.complete ? "every mission is complete" : "no active mission"}.`,
  ]
  if (input.changes.length) lines.push(`Changed: ${input.changes.join("; ")}.`)
  if (mode === "copilot") {
    lines.push(`Next: ${position.maneuver.text}`)
    if (position.dispatch.length)
      lines.push(
        `Ready to start now (assign_slice, critical path first): ${position.dispatch.map((d) => `${key(d.slice)}${d.retry ? " (retry_slice)" : ""}`).join(", ")}.`
      )
    if (position.initiative.nextHook)
      lines.push(`The user runs the ${position.initiative.nextHook.label}; no action needed from you.`)
  }
  if (lead.length) {
    lines.push(mode === "autopilot" ? "Decision needed from you:" : "Waiting on you:")
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
  private readonly modes = new Map<string, { key: string; mode: WorkspaceMode }>()
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(private readonly deps: NavigatorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  // Boot: every active initiative gets a tick (resuming exactly where the
  // durable state says it is), and a heartbeat accrues drive time.
  start(): void {
    this.stopped = false
    for (const initiative of initiatives.listInitiatives())
      if (initiative.status === "active" || initiative.status === "paused")
        this.poke(initiative.id)
    const every = this.deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    if (every > 0) {
      this.heartbeat = setInterval(() => {
        for (const initiative of initiatives.listInitiatives())
          if (initiative.status === "active" && initiative.driveMode !== "manual")
            this.poke(initiative.id)
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

  // Something durable changed for this initiative: tick soon (≤ 1/s).
  poke(initiativeId: string): void {
    if (this.stopped || this.timers.has(initiativeId)) return
    const timer = setTimeout(() => {
      this.timers.delete(initiativeId)
      void this.enqueue(initiativeId)
    }, this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS)
    timer.unref?.()
    this.timers.set(initiativeId, timer)
  }

  private enqueue(initiativeId: string): Promise<unknown> {
    const previous = this.chains.get(initiativeId) ?? Promise.resolve()
    const next = previous
      .then(() => (this.stopped ? null : this.tick(initiativeId)))
      .catch((error) => console.error(`[navigator] ${initiativeId}:`, error))
    this.chains.set(initiativeId, next)
    void next.finally(() => {
      if (this.chains.get(initiativeId) === next) this.chains.delete(initiativeId)
    })
    return next
  }

  private async workspace(initiative: Initiative): Promise<PositionInput["workspace"]> {
    if (!initiative.workspaceId)
      return { mode: "none", busy: false, reason: "the initiative has no workspace" }
    const key = initiative.workspaceId
    let cached = this.modes.get(initiative.id)
    if (!cached || cached.key !== key) {
      cached = { key, mode: await this.deps.workspaceMode(initiative) }
      this.modes.set(initiative.id, cached)
    }
    if (cached.mode.mode === "git") return { mode: "git", busy: false }
    const occupant = activePlaybookRunForWorkspace(initiative)
    return {
      mode: "single_flight",
      busy: !!occupant && occupant.initiativeId !== initiative.id,
      reason: cached.mode.reason,
    }
  }

  // The current position, without acting (UI and map_status).
  async position(initiativeId: string): Promise<Position> {
    const initiative = initiatives.getInitiative(initiativeId)
    if (!initiative) throw new Error(`Initiative not found: ${initiativeId}`)
    return computePosition(
      positionInput(initiative, await this.workspace(initiative), this.now())
    )
  }

  // Fold elapsed driving time into the initiative's active-time budget.
  private accrue(initiative: Initiative): Initiative {
    const driving = initiative.status === "active" && initiative.driveMode !== "manual"
    const now = this.now()
    const { accountedAt, activeMs } = initiative.drive
    if (!driving) {
      return accountedAt === null
        ? initiative
        : initiatives.setInitiativeDrive(initiative.id, { accountedAt: null })
    }
    const step = accountedAt === null ? 0 : Math.max(0, Math.min(now - accountedAt, MAX_ACCRUAL_STEP_MS))
    return initiatives.setInitiativeDrive(initiative.id, {
      activeMs: activeMs + step,
      accountedAt: now,
    })
  }

  // One tick. Returns the recorded tick, or null when the position hadn't
  // changed (nothing new to do).
  async tick(initiativeId: string): Promise<NavigatorTick | null> {
    let initiative = initiatives.getInitiative(initiativeId)
    if (!initiative || initiative.status === "draft") return null
    initiative = this.accrue(initiative)
    const active = activeMissionOf(initiative.id)
    // Bookkeeping, in every mode: the mission status follows its slices.
    if (active && initiative.status === "active") this.deps.advanceMission(active.id)

    const position = await this.position(initiativeId)
    const hash = positionFingerprint(position)
    const previous = ticks.lastTick(initiativeId)
    // The same position means nothing new to do — unless Autopilot's last
    // mechanical step failed (say, a slice couldn't start), which the
    // heartbeat retries a few times before leaving it to the user.
    let retry = 0
    if (previous?.positionHash === hash) {
      retry = this.retryNumber(initiative, previous)
      if (!retry) return null
    }

    const actions: NavigatorTickAction[] = []
    const running = initiative.status === "active"
    const mode = initiative.driveMode
    const known = new Set(previous?.decisionKeys ?? [])
    const fresh = position.pendingDecisions.filter((d) => !known.has(d.key))

    if (running && mode !== "manual") {
      const hours = position.budgets.find((b) => b.key === "maxActiveHours")
      if (hours?.level === "hard") {
        const reason = `The active-time budget of ${hours.limit} h is used up. Raise it to keep driving.`
        this.pause(initiativeId, reason, "budget")
        actions.push({ kind: "auto_pause", target: null, ok: true, detail: reason })
        this.deps.notifyUser(`Mission Control paused “${initiative.name}”`, reason)
      } else if (mode === "autopilot") {
        await this.drive(initiative, position, actions)
        const failed = actions.filter((a) => MECHANICAL.has(a.kind) && !a.ok)
        if (retry === MAX_ACTION_RETRIES && failed.length)
          this.deps.notifyUser(
            `Mission Control is stuck on “${initiative.name}”`,
            `After ${MAX_ACTION_RETRIES} retries: ${failed.map((a) => a.detail).join("; ")}`.slice(0, 400)
          )
      }
      if (!actions.some((a) => a.kind === "auto_pause")) {
        this.directLead(initiative, position, previous, fresh, actions)
        const forUser = fresh.filter((d) => d.owner === "user")
        if (forUser.length) {
          this.deps.notifyUser(
            `Mission Control: “${initiative.name}” is waiting on you`,
            forUser.map((d) => d.summary).join("\n").slice(0, 400)
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
      initiativeId,
      positionHash: hash,
      summary: `${position.mission ? `${position.mission.key}: ` : ""}${position.maneuver.text}`,
      actions,
      decisionKeys: position.pendingDecisions.map((d) => d.key),
      state: tickState(position),
      createdAt: this.now(),
    })
    this.deps.onChanged?.(initiativeId)
    // Actions changed durable state; their events poke the next tick.
    return tick
  }

  // Which retry this tick would be (1-based), or 0 when it shouldn't retry.
  private retryNumber(initiative: Initiative, previous: NavigatorTick): number {
    if (initiative.status !== "active" || initiative.driveMode !== "autopilot") return 0
    if (!previous.actions.some((a) => MECHANICAL.has(a.kind) && !a.ok)) return 0
    if (this.now() - previous.createdAt < ACTION_RETRY_MS) return 0
    let streak = 0
    for (const tick of ticks.listTicks(initiative.id, MAX_ACTION_RETRIES + 1)) {
      if (tick.positionHash !== previous.positionHash) break
      streak++
    }
    return streak <= MAX_ACTION_RETRIES ? streak : 0
  }

  // Autopilot missions land by an approved local merge (the approval is
  // unchanged). Missions not started yet switch when the mode is chosen; the
  // user can move any of them back to manual.
  private autopilotMergePolicy(initiativeId: string): void {
    for (const mission of initiatives.listMissions(initiativeId))
      if (
        mission.status === "planned" &&
        !mission.integrationBranch &&
        mission.mergePolicy.mode === "manual"
      )
        initiatives.setMissionMergePolicy(mission.id, "local_merge", NAVIGATOR_ADDRESS)
  }

  // Autopilot's mechanical steps.
  private async drive(
    initiative: Initiative,
    position: Position,
    actions: NavigatorTickAction[]
  ): Promise<void> {
    const actor = NAVIGATOR_ADDRESS
    // The planning proposal, when the user opted into applying it unreviewed.
    if (initiative.drive.autoApplyPlan) {
      for (const proposal of proposalsRepo.listProposals(initiative.id, "pending")) {
        if (proposal.kind !== "plan") continue
        try {
          applyProposal(proposal.id, actor)
          actions.push({ kind: "apply_plan", target: proposal.id, ok: true, detail: "Applied the planning proposal (auto-apply is on)" })
        } catch (error) {
          actions.push({ kind: "apply_plan", target: proposal.id, ok: false, detail: errorText(error) })
        }
        return
      }
    }
    const maneuver = position.maneuver
    if (maneuver.kind === "run_hook" && !position.initiative.runningHook) {
      try {
        await this.deps.startHook({
          initiativeId: initiative.id,
          missionId: maneuver.hook.missionId,
          hook: maneuver.hook.hook as PlaybookHookName,
        })
        actions.push({ kind: "run_hook", target: maneuver.hook.hook, ok: true, detail: `Started the ${maneuver.hook.label}` })
      } catch (error) {
        actions.push({ kind: "run_hook", target: maneuver.hook.hook, ok: false, detail: errorText(error) })
      }
      return
    }
    if (maneuver.kind === "dispatch") {
      for (const item of position.dispatch) {
        const key = position.slices[item.slice]?.key ?? item.slice
        try {
          await this.deps.startSlice(item.slice, {
            actor,
            ...(item.retry
              ? { note: "Automatic retry by the Navigator: the previous attempt stopped without a rejected proof. Check what interrupted it before repeating the same approach." }
              : {}),
          })
          actions.push({ kind: item.retry ? "retry_slice" : "start_slice", target: key, ok: true, detail: `Started ${key}` })
        } catch (error) {
          actions.push({ kind: item.retry ? "retry_slice" : "start_slice", target: key, ok: false, detail: errorText(error) })
        }
      }
      return
    }
    if (maneuver.kind === "complete_mission") {
      try {
        await this.deps.completeMission(maneuver.missionId)
        actions.push({ kind: "complete_mission", target: maneuver.missionId, ok: true, detail: maneuver.text })
      } catch (error) {
        actions.push({ kind: "complete_mission", target: maneuver.missionId, ok: false, detail: errorText(error) })
      }
      return
    }
    if (maneuver.kind === "complete_initiative") {
      initiatives.setInitiativeStatus(initiative.id, "completed", "Every mission is complete", actor)
      actions.push({ kind: "complete_initiative", target: initiative.id, ok: true, detail: "Initiative complete" })
      this.deps.notifyUser(`Mission Control: “${initiative.name}” is complete`, "Every mission landed.")
      return
    }
    // Merges queued behind a restart or a busy repository.
    const missionId = position.mission?.id
    if (missionId && position.mission!.integrating.length) this.deps.kickMerges(missionId)
  }

  // Directions to the lead: copilot after every change, autopilot only when a
  // new judgment call is waiting for it.
  private directLead(
    initiative: Initiative,
    position: Position,
    previous: NavigatorTick | null,
    fresh: Decision[],
    actions: NavigatorTickAction[]
  ): void {
    const lead = position.lead
    if (!lead) return
    const mode = initiative.driveMode
    const leadDecisions = position.pendingDecisions.filter((d) => d.owner === "lead")
    if (mode === "autopilot" && !fresh.some((d) => d.owner === "lead")) return
    if (mode === "copilot" && position.initiative.complete) return
    const body = renderDirection({
      position,
      mode,
      changes: changesSince(previous, tickState(position)),
      decisions: mode === "autopilot" ? leadDecisions : position.pendingDecisions,
    })
    try {
      this.deps.direct({ initiativeId: initiative.id, to: lead, body })
      actions.push({ kind: "direction", target: lead, ok: true, detail: body.split("\n")[0] })
    } catch (error) {
      actions.push({ kind: "direction", target: lead, ok: false, detail: errorText(error) })
    }
  }

  // ── controls ──────────────────────────────────────────────────────────────

  // Start (from draft) in a drive mode. With nothing planned yet, planning
  // runs right away; in autopilot the drive then waits for the user to apply
  // the planning proposal unless auto-apply is on.
  async startDrive(
    initiativeId: string,
    options: { mode: DriveMode; autoApplyPlan?: boolean }
  ): Promise<{ planning: PlaybookRun | null; planningError: string | null }> {
    const initiative = initiatives.getInitiative(initiativeId)
    if (!initiative) throw new Error(`Initiative not found: ${initiativeId}`)
    if (initiative.status !== "draft") throw new Error("Only a draft initiative can be started.")
    initiatives.setDriveMode(initiativeId, options.mode)
    if (options.mode === "autopilot") this.autopilotMergePolicy(initiativeId)
    initiatives.setInitiativeDrive(initiativeId, {
      autoApplyPlan: options.autoApplyPlan === true,
      accountedAt: null,
      pauseReason: null,
      pausedBy: null,
    })
    initiatives.startInitiative(initiativeId)
    initiatives.setInitiativeDrive(initiativeId, {
      accountedAt: options.mode === "manual" ? null : this.now(),
    })
    let planning: PlaybookRun | null = null
    let planningError: string | null = null
    const planned = initiatives
      .listMissions(initiativeId)
      .some((m) => initiatives.listSlices(m.id).length > 0)
    if (!planned && hookNames(initiative.playbookId, "initiative").includes("plan")) {
      try {
        planning = await this.deps.startHook({ initiativeId, missionId: null, hook: "plan" })
      } catch (error) {
        planningError = errorText(error)
      }
    }
    this.poke(initiativeId)
    return { planning, planningError }
  }

  // In-flight worker turns finish (or pause through their own semantics);
  // nothing new starts — launches, wakes, and hooks all require an active
  // initiative — until the user resumes.
  pause(initiativeId: string, reason: string, by: "user" | "budget" = "user"): Initiative {
    const before = initiatives.getInitiative(initiativeId)
    if (!before) throw new Error(`Initiative not found: ${initiativeId}`)
    if (before.status !== "active") throw new Error("Only an active initiative can be paused.")
    const accrued = this.accrue(before)
    initiatives.setInitiativeDrive(initiativeId, {
      accountedAt: null,
      activeMs: accrued.drive.activeMs,
      pauseReason: reason,
      pausedBy: by,
    })
    const after = initiatives.setInitiativeStatus(
      initiativeId,
      "paused",
      reason,
      by === "user" ? "user" : NAVIGATOR_ADDRESS
    )
    this.poke(initiativeId)
    return after
  }

  resume(initiativeId: string): Initiative {
    const before = initiatives.getInitiative(initiativeId)
    if (!before) throw new Error(`Initiative not found: ${initiativeId}`)
    if (before.status !== "paused") throw new Error("Only a paused initiative can be resumed.")
    // Resuming into an exhausted time budget would pause again at once.
    if (before.driveMode !== "manual") {
      const limit = budgetLimit(before.budgets, "maxActiveHours")
      if (before.drive.activeMs >= limit * HOUR_MS)
        throw new Error(
          `The drive has used its ${limit} h active-time budget. Raise the budget before resuming.`
        )
    }
    initiatives.setInitiativeDrive(initiativeId, {
      pauseReason: null,
      pausedBy: null,
      accountedAt: before.driveMode === "manual" ? null : this.now(),
    })
    const after = initiatives.setInitiativeStatus(initiativeId, "active", "Resumed by the user")
    this.deps.onResumed?.(initiativeId)
    this.poke(initiativeId)
    return after
  }

  // Cancel the whole initiative: running playbook runs are cancelled and
  // queued mail expires. Branches and worktrees stay until it is deleted.
  cancel(initiativeId: string, reason = "Cancelled by the user"): Initiative {
    const before = initiatives.getInitiative(initiativeId)
    if (!before) throw new Error(`Initiative not found: ${initiativeId}`)
    const after = initiatives.setInitiativeStatus(initiativeId, "cancelled", reason)
    for (const run of playbooks.listPlaybookRuns({ initiativeId, status: "running" }))
      this.deps.cancelPlaybookRun(run.id)
    initiatives.setInitiativeDrive(initiativeId, { accountedAt: null })
    this.deps.onCancelled?.(initiativeId)
    this.poke(initiativeId)
    return after
  }

  // A completed initiative takes more missions (the next sprint). It reopens
  // paused: the user adds missions, checks the mode and budgets (drive time
  // keeps accruing against the same budget), then resumes. The Navigator runs
  // the release for the last finished mission before the new one starts.
  reopen(initiativeId: string): Initiative {
    const before = initiatives.getInitiative(initiativeId)
    if (!before) throw new Error(`Initiative not found: ${initiativeId}`)
    if (before.status !== "completed")
      throw new Error("Only a completed initiative can be reopened.")
    initiatives.setInitiativeDrive(initiativeId, {
      accountedAt: null,
      pauseReason: "Reopened. Add the next missions, then resume.",
      pausedBy: "user",
    })
    const after = initiatives.setInitiativeStatus(
      initiativeId,
      "paused",
      "Reopened by the user for more missions"
    )
    this.poke(initiativeId)
    return after
  }

  setMode(initiativeId: string, mode: DriveMode): Initiative {
    const after = initiatives.setDriveMode(initiativeId, mode)
    if (mode === "autopilot") this.autopilotMergePolicy(initiativeId)
    this.poke(initiativeId)
    return after
  }

  setAutoApplyPlan(initiativeId: string, value: boolean): Initiative {
    const initiative = initiatives.getInitiative(initiativeId)
    if (!initiative) throw new Error(`Initiative not found: ${initiativeId}`)
    if (!["draft", "paused"].includes(initiative.status))
      throw new Error("Pause the initiative before changing how planning is applied.")
    const after = initiatives.setInitiativeDrive(initiativeId, { autoApplyPlan: value })
    this.poke(initiativeId)
    return after
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^touch_overlap: /, "")
}

// The installed Navigator; map tools reach position() through here.
let installed: Navigator | null = null

export function installNavigator(instance: Navigator | null): void {
  installed = instance
}

export function getNavigator(): Navigator | null {
  return installed
}

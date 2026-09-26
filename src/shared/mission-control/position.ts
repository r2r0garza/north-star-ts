import { deriveWaves, touchHintsOverlap } from "./waves"
import type { BudgetMeter } from "./budgets"

// The Navigator's position (plan 106.6): a PURE function of durable state.
// Given the same snapshot it always returns the same position, so the
// Navigator can recompute it after any event or a restart and never needs
// in-memory memory of where it was. It never calls a model: it says where the
// initiative is, what the next mechanical step is, and which decisions only a
// seat or the user can make.

export type DriveMode = "manual" | "copilot" | "autopilot"
export type HookName =
  | "plan"
  | "between_missions"
  | "on_complete"
  | "before_slices"
  | "after_each_slice"
  | "after_all_slices"
  | "run"

export interface PositionSliceInput {
  id: string
  missionId: string
  key: string
  title: string
  status: string
  attempts: number
  podKey: string | null
  position: number
  touchHints: string[]
  acceptanceCount: number
  proofVerdict: "accepted" | "rejected" | null
}

export interface PositionMissionInput {
  id: string
  key: string
  name: string
  status: string
  position: number
  integrationBranch: string | null
  mergePolicy: "manual" | "local_merge" | "open_pr"
  dodReviewed: boolean
  finishedAt?: number | null
  // The hooks the mission's playbook defines.
  hooks: HookName[]
}

export interface PositionRunInput {
  id: string
  hook: HookName
  missionId: string | null
  sliceId: string | null
  status: "running" | "completed" | "failed" | "cancelled"
  // Runs in its own worktree (slice runs in a git workspace).
  isolated: boolean
  createdAt: number
}

export interface PositionInput {
  initiative: {
    id: string
    status: string
    driveMode: DriveMode
    // The hooks the initiative's playbook defines.
    hooks: HookName[]
    defaultPodKey: string | null
  }
  missions: PositionMissionInput[]
  slices: PositionSliceInput[]
  edges: Array<{ missionId: string; fromSliceId: string; toSliceId: string }>
  runs: PositionRunInput[]
  mergeQueue: Array<{
    id: string
    sliceId: string
    missionId: string
    status: string
    escalated: boolean
  }>
  proposals: Array<{ id: string; kind: string; proposer: string; summary: string }>
  // Escalations addressed to the user that nobody has acknowledged.
  escalations: Array<{ id: string; from: string; subject: string }>
  workspace: {
    mode: "git" | "single_flight" | "none"
    // Another playbook run occupies the (non-git) workspace.
    busy: boolean
    reason?: string
  }
  pods: Array<{ key: string; builderSeats: number }>
  // The seat the Navigator directs: the driving pod's lead.
  lead: { address: string; rights: string[] } | null
  limits: { maxConcurrentSlices: number; maxSliceAttempts: number }
  budgets: BudgetMeter[]
}

export type DecisionKind =
  | "no_plan"
  | "plan_proposal"
  | "proposal"
  | "escalation"
  | "hook_failed"
  | "hook_due"
  | "mission_empty"
  | "slice_unspecified"
  | "slice_blocked"
  | "slice_failed"
  | "proof_rejected"
  | "merge_conflict"
  | "mission_dod"
  | "mission_landing"
  | "budget"

export interface Decision {
  // Stable identity: the same pending decision keeps its key across ticks, and
  // a new occurrence (e.g. another failed attempt) gets a new one.
  key: string
  kind: DecisionKind
  owner: "lead" | "user"
  target: { kind: string; id: string }
  summary: string
  // What the user can do about it from the inbox, when it is theirs.
  action?: DecisionAction
}

export type DecisionAction =
  | { kind: "run_hook"; hook: HookName; missionId: string | null }
  | { kind: "judge_mission"; missionId: string }
  | { kind: "open_mission"; missionId: string }
  | { kind: "open_slice"; sliceId: string }
  | { kind: "edit_budgets" }

export interface HookRef {
  hook: HookName
  missionId: string | null
  label: string
}

export interface SliceRef {
  id: string
  key: string
  title: string
  status: string
}

export interface Position {
  initiative: {
    id: string
    status: string
    driveMode: DriveMode
    activeMissionId: string | null
    nextHook: HookRef | null
    // A hook the Navigator is waiting on.
    runningHook: HookRef | null
    complete: boolean
  }
  mission: {
    id: string
    key: string
    name: string
    status: string
    waves: string[][]
    criticalPath: string[]
    ready: string[]
    running: string[]
    integrating: string[]
    done: string[]
    // Waiting on predecessors that are not merged yet.
    waiting: Array<{ slice: string; on: string[] }>
    blocked: Array<{ slice: string; reason: string }>
    // Failed slices the Navigator may retry mechanically.
    retryable: string[]
    doneConditionMet: boolean
  } | null
  capacity: {
    concurrencyFree: number
    podsFree: Record<string, number>
    mode: "git" | "single_flight" | "none"
    reason: string | null
  }
  // What Autopilot would start now, in order, and why the rest wait.
  dispatch: Array<{ slice: string; retry: boolean }>
  deferred: Array<{ slice: string; reason: string }>
  // Mechanical steps other than slices, in order.
  maneuver: Maneuver
  budgets: BudgetMeter[]
  pendingDecisions: Decision[]
  lead: string | null
  slices: Record<string, SliceRef>
}

export type Maneuver =
  | { kind: "run_hook"; hook: HookRef; text: string }
  | { kind: "dispatch"; text: string }
  | { kind: "complete_mission"; missionId: string; text: string }
  | { kind: "complete_initiative"; text: string }
  | { kind: "wait"; text: string }
  | { kind: "decide"; text: string }
  | { kind: "idle"; text: string }

const TERMINAL_MISSION = new Set(["completed", "cancelled"])
const HOOK_LABEL: Record<string, string> = {
  plan: "planning",
  between_missions: "release",
  on_complete: "completion",
  before_slices: "milestone planning review",
  after_all_slices: "milestone review",
  after_each_slice: "conflict resolution",
  run: "user story run",
}

function hookRef(hook: HookName, missionId: string | null, missionKey?: string): HookRef {
  return {
    hook,
    missionId,
    label: `${HOOK_LABEL[hook] ?? hook} hook${missionKey ? ` for ${missionKey}` : ""}`,
  }
}

// The latest run of a hook on a container: none / running / completed / ...
function hookState(
  runs: PositionRunInput[],
  hook: HookName,
  missionId: string | null
): PositionRunInput["status"] | "none" {
  const latest = runs
    .filter((run) => run.hook === hook && run.missionId === missionId && !run.sliceId)
    .sort((a, b) => b.createdAt - a.createdAt)[0]
  return latest?.status ?? "none"
}

export function computePosition(input: PositionInput): Position {
  const { initiative } = input
  const manual = initiative.driveMode === "manual"
  const leadRights = new Set(input.lead?.rights ?? [])
  // Who a judgment call goes to: the lead when it holds a right that lets it
  // act on the decision (and the drive isn't manual), else the user.
  const ownerFor = (...rights: string[]): "lead" | "user" =>
    !manual && input.lead && rights.some((right) => leadRights.has(right))
      ? "lead"
      : "user"
  const decisions: Decision[] = []
  const decide = (d: Decision) => {
    if (decisions.some((existing) => existing.key === d.key)) return
    decisions.push({ ...d, action: d.action ?? defaultAction(d) })
  }

  const sliceRefs: Record<string, SliceRef> = {}
  for (const slice of input.slices)
    sliceRefs[slice.id] = {
      id: slice.id,
      key: slice.key,
      title: slice.title,
      status: slice.status,
    }
  const keyOf = (id: string) => sliceRefs[id]?.key ?? id

  // ── waiting on the user regardless of where we are ──────────────────────
  for (const proposal of input.proposals)
    decide({
      key: `proposal:${proposal.id}`,
      kind: proposal.kind === "plan" ? "plan_proposal" : "proposal",
      owner: "user",
      target: { kind: "proposal", id: proposal.id },
      summary: `Review ${proposal.kind === "plan" ? "the planning proposal" : "a plan proposal"} from ${proposal.proposer}: ${proposal.summary}`,
    })
  for (const escalation of input.escalations)
    decide({
      key: `escalation:${escalation.id}`,
      kind: "escalation",
      owner: "user",
      target: { kind: "message", id: escalation.id },
      summary: `Escalation from ${escalation.from}: ${escalation.subject}`,
    })
  for (const meter of input.budgets) {
    if (meter.key === "maxConcurrentSlices" || meter.level === "ok" || meter.final) continue
    if (meter.key === "maxSliceAttempts") continue // per slice, below
    const lead =
      meter.key === "maxPlanRevisionsPerMission" ||
      meter.key === "maxAgentSlicesPerMission"
    decide({
      key: `budget:${meter.key}:${meter.level}`,
      kind: "budget",
      owner: lead && !manual && input.lead ? "lead" : "user",
      target: { kind: "budget", id: meter.key },
      summary: `${meter.label} at ${meter.level === "hard" ? "its limit" : "80%"}: ${formatAmount(meter.used)} of ${meter.limit} ${meter.unit}.`,
    })
  }

  const missions = [...input.missions].sort((a, b) => a.position - b.position)
  const liveSlices = (missionId: string) =>
    input.slices.filter((s) => s.missionId === missionId && s.status !== "cancelled")
  const anySlices = input.slices.some((s) => s.status !== "cancelled")
  const running = input.runs.filter((run) => run.status === "running")
  const runningHookRun = running.find((run) => !run.sliceId)
  const runningHook = runningHookRun
    ? hookRef(
        runningHookRun.hook,
        runningHookRun.missionId,
        missions.find((m) => m.id === runningHookRun.missionId)?.key
      )
    : null

  const capacity = computeCapacity(input)
  const empty = {
    initiative: {
      id: initiative.id,
      status: initiative.status,
      driveMode: initiative.driveMode,
      activeMissionId: null as string | null,
      nextHook: null as HookRef | null,
      runningHook,
      complete: false,
    },
    mission: null as Position["mission"],
    capacity,
    dispatch: [] as Position["dispatch"],
    deferred: [] as Position["deferred"],
    budgets: input.budgets,
    pendingDecisions: decisions,
    lead: input.lead?.address ?? null,
    slices: sliceRefs,
  }
  const finish = (maneuver: Maneuver, extra: Partial<typeof empty> = {}): Position => {
    // Only Autopilot runs hooks itself; otherwise a due hook waits on the user.
    if (maneuver.kind === "run_hook" && initiative.driveMode !== "autopilot")
      decide({
        key: `hook_due:${maneuver.hook.hook}:${maneuver.hook.missionId ?? ""}`,
        kind: "hook_due",
        owner: "user",
        target: { kind: "hook", id: maneuver.hook.hook },
        summary: `${maneuver.text}`,
        action: { kind: "run_hook", hook: maneuver.hook.hook, missionId: maneuver.hook.missionId },
      })
    const merged = { ...empty, ...extra }
    return { ...merged, maneuver, pendingDecisions: decisions }
  }

  // ── planning: nothing to work on yet ────────────────────────────────────
  if (!anySlices) {
    const pendingPlan = input.proposals.some((p) => p.kind === "plan")
    if (pendingPlan)
      return finish({ kind: "decide", text: "Waiting for the planning proposal to be applied." })
    if (!initiative.hooks.includes("plan")) {
      decide({
        key: "no_plan",
        kind: "no_plan",
        owner: "user",
        target: { kind: "initiative", id: initiative.id },
        summary: "There are no user stories to work on. Add user stories, or add a planning hook to the feature playbook.",
      })
      return finish({ kind: "decide", text: "Waiting for a plan: add milestones and user stories." })
    }
    const state = hookState(input.runs, "plan", null)
    if (state === "running")
      return finish({ kind: "wait", text: "Planning is running." })
    if (state === "failed") {
      decide({
        key: "hook_failed:plan",
        kind: "hook_failed",
        owner: "user",
        target: { kind: "hook", id: "plan" },
        summary: "The planning hook failed. Run it again or write the plan by hand.",
        action: { kind: "run_hook", hook: "plan", missionId: null },
      })
      return finish({ kind: "decide", text: "Planning failed." })
    }
    if (state === "completed") {
      decide({
        key: "no_plan",
        kind: "no_plan",
        owner: "user",
        target: { kind: "initiative", id: initiative.id },
        summary: "Planning finished without a proposal. Run it again or add user stories by hand.",
        action: { kind: "run_hook", hook: "plan", missionId: null },
      })
      return finish({ kind: "decide", text: "Planning produced no plan." })
    }
    const hook = hookRef("plan", null)
    return finish(
      { kind: "run_hook", hook, text: "Run the planning hook." },
      { initiative: { ...empty.initiative, nextHook: hook } }
    )
  }

  // ── the active mission: the first one not finished (missions run in order)
  const activeIndex = missions.findIndex((m) => !TERMINAL_MISSION.has(m.status))
  if (activeIndex < 0) {
    // Everything finished: completion hook, then the initiative is done.
    const last = missions.filter((m) => m.status === "completed").at(-1)
    if (!last)
      return finish({ kind: "idle", text: "Every milestone was cancelled." })
    if (initiative.hooks.includes("on_complete")) {
      // A reopened initiative (more missions) earns its completion hook again:
      // only a run after the last mission finished counts.
      const since = last.finishedAt ?? 0
      const state = hookState(
        input.runs.filter((run) => run.hook !== "on_complete" || run.createdAt >= since),
        "on_complete",
        null
      )
      if (state === "running")
        return finish({ kind: "wait", text: "The completion hook is running." })
      if (state === "failed") {
        decide({
          key: "hook_failed:on_complete",
          kind: "hook_failed",
          owner: "user",
          target: { kind: "hook", id: "on_complete" },
          summary: "The completion hook failed. Run it again to finish the feature.",
          action: { kind: "run_hook", hook: "on_complete", missionId: null },
        })
        return finish({ kind: "decide", text: "The completion hook failed." })
      }
      if (state === "none" || state === "cancelled") {
        const hook = hookRef("on_complete", null)
        return finish(
          { kind: "run_hook", hook, text: "Run the completion hook." },
          { initiative: { ...empty.initiative, nextHook: hook } }
        )
      }
    }
    return finish(
      { kind: "complete_initiative", text: "Every milestone is complete." },
      { initiative: { ...empty.initiative, complete: true } }
    )
  }
  const mission = missions[activeIndex]
  const initiativeState = { ...empty.initiative, activeMissionId: mission.id }

  // Release for the previous mission before the next one starts.
  const previous = missions
    .slice(0, activeIndex)
    .filter((m) => m.status === "completed")
    .at(-1)
  if (
    previous &&
    mission.status === "planned" &&
    initiative.hooks.includes("between_missions")
  ) {
    const state = hookState(input.runs, "between_missions", previous.id)
    if (state === "running")
      return finish(
        { kind: "wait", text: `The release hook for ${previous.key} is running.` },
        { initiative: initiativeState }
      )
    if (state === "failed") {
      decide({
        key: `hook_failed:between_missions:${previous.id}`,
        kind: "hook_failed",
        owner: "user",
        target: { kind: "mission", id: previous.id },
        summary: `The release hook for ${previous.key} failed. Run it again, or start ${mission.key} yourself.`,
        action: { kind: "run_hook", hook: "between_missions", missionId: previous.id },
      })
      return finish(
        { kind: "decide", text: `The release for ${previous.key} failed.` },
        { initiative: initiativeState }
      )
    }
    if (state === "none") {
      const hook = hookRef("between_missions", previous.id, previous.key)
      return finish(
        { kind: "run_hook", hook, text: `Run the release hook for ${previous.key}.` },
        { initiative: { ...initiativeState, nextHook: hook } }
      )
    }
  }

  const slices = liveSlices(mission.id)
  const allMissionSlices = input.slices.filter((s) => s.missionId === mission.id)
  const edges = input.edges.filter((e) => e.missionId === mission.id)
  let waves: string[][] = []
  let criticalPath: string[] = []
  try {
    const all = deriveWaves(allMissionSlices, edges)
    waves = all.waves.map((wave) => wave.map((s) => s.id))
    criticalPath = deriveWaves(slices, edges).criticalPath
  } catch {
    // A cyclic graph can't be stored, but stay total if one is read mid-edit.
  }

  const byId = new Map(allMissionSlices.map((s) => [s.id, s]))
  const predecessors = (id: string) =>
    edges.filter((e) => e.toSliceId === id).map((e) => e.fromSliceId)
  const ready: string[] = []
  const runningSlices: string[] = []
  const integrating: string[] = []
  const done: string[] = []
  const waiting: Array<{ slice: string; on: string[] }> = []
  const blocked: Array<{ slice: string; reason: string }> = []
  const retryable: string[] = []
  const soft = Math.max(1, Math.floor(input.limits.maxSliceAttempts * 0.8))

  for (const slice of [...allMissionSlices].sort((a, b) => a.position - b.position)) {
    const preds = predecessors(slice.id).map((id) => byId.get(id)).filter(Boolean) as PositionSliceInput[]
    const cancelledPred = preds.find((p) => p.status === "cancelled")
    const unmet = preds.filter((p) => p.status !== "done")
    switch (slice.status) {
      case "running":
      case "proving":
        runningSlices.push(slice.id)
        break
      case "integrating":
        integrating.push(slice.id)
        break
      case "done":
        done.push(slice.id)
        break
      case "cancelled":
        break
      case "blocked": {
        const reason = cancelledPred
          ? `depends on cancelled user story ${cancelledPred.key}`
          : "blocked"
        blocked.push({ slice: slice.id, reason })
        decide({
          key: `slice_blocked:${slice.id}`,
          kind: "slice_blocked",
          owner: ownerFor("revise_plan"),
          target: { kind: "slice", id: slice.id },
          summary: `User story ${slice.key} is blocked: ${reason}. Remove the dependency, cancel it, or replace the work.`,
        })
        break
      }
      case "failed": {
        if (slice.attempts >= input.limits.maxSliceAttempts) {
          decide({
            key: `slice_failed:${slice.id}:${slice.attempts}`,
            kind: "slice_failed",
            owner: ownerFor("revise_plan", "assign_slice"),
            target: { kind: "slice", id: slice.id },
            summary: `User story ${slice.key} failed and used all ${input.limits.maxSliceAttempts} attempts. Split it, cancel it, or ask the user for more attempts.`,
          })
        } else if (slice.proofVerdict === "rejected") {
          decide({
            key: `proof_rejected:${slice.id}:${slice.attempts}`,
            kind: "proof_rejected",
            owner: ownerFor("assign_slice", "revise_plan"),
            target: { kind: "slice", id: slice.id },
            summary: `User story ${slice.key}'s proof was rejected on attempt ${slice.attempts}. Retry it with a note, revise it, or cancel it.`,
          })
        } else if (slice.attempts >= soft) {
          decide({
            key: `slice_failed:${slice.id}:${slice.attempts}`,
            kind: "slice_failed",
            owner: ownerFor("assign_slice", "revise_plan"),
            target: { kind: "slice", id: slice.id },
            summary: `User story ${slice.key} failed on attempt ${slice.attempts} of ${input.limits.maxSliceAttempts}. Retry it with a note, or revise the plan.`,
          })
        } else if (!unmet.length) retryable.push(slice.id)
        break
      }
      default: {
        // draft / ready: runnable once every predecessor has merged.
        if (cancelledPred) {
          blocked.push({
            slice: slice.id,
            reason: `depends on cancelled user story ${cancelledPred.key}`,
          })
          decide({
            key: `slice_blocked:${slice.id}`,
            kind: "slice_blocked",
            owner: ownerFor("revise_plan"),
            target: { kind: "slice", id: slice.id },
            summary: `User story ${slice.key} depends on cancelled user story ${cancelledPred.key}.`,
          })
        } else if (unmet.length) {
          waiting.push({ slice: slice.id, on: unmet.map((p) => p.id) })
        } else if (slice.acceptanceCount === 0) {
          blocked.push({ slice: slice.id, reason: "has no acceptance criteria" })
          decide({
            key: `slice_unspecified:${slice.id}`,
            kind: "slice_unspecified",
            owner: ownerFor("revise_plan"),
            target: { kind: "slice", id: slice.id },
            summary: `User story ${slice.key} has no acceptance criteria, so it can't be proven. Add criteria before it runs.`,
          })
        } else ready.push(slice.id)
      }
    }
  }

  for (const entry of input.mergeQueue)
    if (entry.missionId === mission.id && entry.status === "conflict" && entry.escalated)
      decide({
        key: `merge_conflict:${entry.id}`,
        kind: "merge_conflict",
        owner: "user",
        target: { kind: "slice", id: entry.sliceId },
        summary: `User story ${keyOf(entry.sliceId)}'s merge conflict needs you: retry, run the integrator, or abandon it.`,
      })

  const allSettled =
    slices.length > 0 && slices.every((s) => s.status === "done")
  const missionState: NonNullable<Position["mission"]> = {
    id: mission.id,
    key: mission.key,
    name: mission.name,
    status: mission.status,
    waves,
    criticalPath,
    ready,
    running: runningSlices,
    integrating,
    done,
    waiting,
    blocked,
    retryable,
    doneConditionMet: false,
  }
  const withMission = (
    maneuver: Maneuver,
    extra: { nextHook?: HookRef | null; dispatch?: Position["dispatch"]; deferred?: Position["deferred"] } = {}
  ) =>
    finish(maneuver, {
      initiative: { ...initiativeState, nextHook: extra.nextHook ?? null },
      mission: missionState,
      dispatch: extra.dispatch ?? [],
      deferred: extra.deferred ?? [],
    })

  if (!slices.length) {
    decide({
      key: `mission_empty:${mission.id}`,
      kind: "mission_empty",
      owner: ownerFor("revise_plan"),
      target: { kind: "mission", id: mission.id },
      summary: `Milestone ${mission.key} has no user stories. Add or propose user stories for it.`,
    })
    return withMission({ kind: "decide", text: `Milestone ${mission.key} has no user stories yet.` })
  }

  // Review the slice set before the first slice starts.
  if (mission.status === "planned" && mission.hooks.includes("before_slices")) {
    const state = hookState(input.runs, "before_slices", mission.id)
    if (state === "running")
      return withMission({ kind: "wait", text: `The planning review for ${mission.key} is running.` })
    if (state === "failed") {
      decide({
        key: `hook_failed:before_slices:${mission.id}`,
        kind: "hook_failed",
        owner: "user",
        target: { kind: "mission", id: mission.id },
        summary: `The planning review for ${mission.key} failed. Run it again, or start its user stories yourself.`,
        action: { kind: "run_hook", hook: "before_slices", missionId: mission.id },
      })
      return withMission({ kind: "decide", text: `The planning review for ${mission.key} failed.` })
    }
    if (state === "none") {
      const hook = hookRef("before_slices", mission.id, mission.key)
      return withMission(
        { kind: "run_hook", hook, text: `Run the planning review for ${mission.key}.` },
        { nextHook: hook }
      )
    }
  }

  // ── the mission's work is merged: review, judgment, landing ─────────────
  if (allSettled && ["review", "active", "integrating"].includes(mission.status)) {
    if (mission.hooks.includes("after_all_slices")) {
      const state = hookState(input.runs, "after_all_slices", mission.id)
      if (state === "running")
        return withMission({ kind: "wait", text: `The milestone review for ${mission.key} is running.` })
      if (state === "failed") {
        decide({
          key: `hook_failed:after_all_slices:${mission.id}`,
          kind: "hook_failed",
          owner: "user",
          target: { kind: "mission", id: mission.id },
          summary: `The milestone review for ${mission.key} failed. Run it again.`,
          action: { kind: "run_hook", hook: "after_all_slices", missionId: mission.id },
        })
        return withMission({ kind: "decide", text: `The milestone review for ${mission.key} failed.` })
      }
      if (state === "none" && mission.status === "review") {
        const hook = hookRef("after_all_slices", mission.id, mission.key)
        return withMission(
          { kind: "run_hook", hook, text: `Run the milestone review for ${mission.key}.` },
          { nextHook: hook }
        )
      }
    }
    if (mission.status !== "review")
      return withMission({ kind: "wait", text: `Every user story in ${mission.key} is done; the milestone is moving to review.` })
    if (!mission.dodReviewed && !manual) {
      decide({
        key: `mission_dod:${mission.id}`,
        kind: "mission_dod",
        owner: ownerFor("accept_proof"),
        target: { kind: "mission", id: mission.id },
        summary: `Every user story in ${mission.key} is merged. Judge whether the milestone meets its definition of done, then complete it.`,
      })
      return withMission({ kind: "decide", text: `Milestone ${mission.key} needs its definition-of-done judgment.` })
    }
    missionState.doneConditionMet = true
    if (!mission.integrationBranch && !manual)
      return withMission({
        kind: "complete_mission",
        missionId: mission.id,
        text: `Complete milestone ${mission.key}.`,
      })
    decide({
      key: `mission_landing:${mission.id}`,
      kind: "mission_landing",
      owner: "user",
      target: { kind: "mission", id: mission.id },
      summary: !mission.integrationBranch
        ? `Milestone ${mission.key} is done. Mark it complete.`
        : mission.mergePolicy === "manual"
          ? `Milestone ${mission.key} is ready to land: merge ${mission.integrationBranch} and mark it merged.`
          : `Milestone ${mission.key} is ready to land: review and approve the ${mission.mergePolicy === "open_pr" ? "pull request" : "merge"}.`,
    })
    return withMission({ kind: "decide", text: `Milestone ${mission.key} is waiting to land.` })
  }

  // ── dispatch: ready slices, critical path first, then position ──────────
  const critical = new Set(criticalPath)
  const order = (id: string) => byId.get(id)?.position ?? 0
  const candidates = [
    ...ready.map((id) => ({ id, retry: false })),
    ...retryable.map((id) => ({ id, retry: true })),
  ].sort(
    (a, b) =>
      Number(critical.has(b.id)) - Number(critical.has(a.id)) || order(a.id) - order(b.id)
  )
  const dispatch: Position["dispatch"] = []
  const deferred: Position["deferred"] = []
  const podsFree = { ...capacity.podsFree }
  let free = capacity.concurrencyFree
  const building = allMissionSlices.filter((s) => s.status === "running" || s.status === "proving")
  for (const candidate of candidates) {
    const slice = byId.get(candidate.id)!
    const pod = slice.podKey ?? initiative.defaultPodKey
    if (free <= 0) {
      deferred.push({
        slice: slice.id,
        reason:
          capacity.reason ??
          (capacity.mode === "git"
            ? `the budget allows ${input.limits.maxConcurrentSlices} user stories at once`
            : "the workspace isn't a git repository, so one run at a time"),
      })
      continue
    }
    if (pod && (podsFree[pod] ?? 1) <= 0) {
      deferred.push({ slice: slice.id, reason: `pod ${pod} is busy` })
      continue
    }
    const overlap = [
      ...building,
      ...dispatch.map((d) => byId.get(d.slice)!),
    ].find((other) => touchHintsOverlap(slice.touchHints, other.touchHints))
    if (overlap) {
      deferred.push({
        slice: slice.id,
        reason: `touch hints overlap ${overlap.key}`,
      })
      continue
    }
    dispatch.push({ slice: slice.id, retry: candidate.retry })
    free--
    if (pod) podsFree[pod] = (podsFree[pod] ?? 1) - 1
  }

  if (dispatch.length)
    return withMission(
      {
        kind: "dispatch",
        text: `Start ${dispatch.map((d) => keyOf(d.slice)).join(", ")}.`,
      },
      { dispatch, deferred }
    )
  const waitingOn = [
    runningSlices.length ? `${runningSlices.length} running` : "",
    integrating.length ? `${integrating.length} merging` : "",
  ].filter(Boolean)
  if (waitingOn.length)
    return withMission(
      { kind: "wait", text: `Waiting on user stories: ${waitingOn.join(", ")}.` },
      { deferred }
    )
  return withMission(
    {
      kind: decisions.length ? "decide" : "idle",
      text: decisions.length
        ? "Waiting on a decision before work can continue."
        : "Nothing can move right now.",
    },
    { deferred }
  )
}

// The inbox action for a decision that didn't name one.
function defaultAction(d: Decision): DecisionAction | undefined {
  if (d.owner !== "user") return undefined
  if (d.kind === "budget") return { kind: "edit_budgets" }
  if (d.target.kind === "slice") return { kind: "open_slice", sliceId: d.target.id }
  if (d.target.kind === "mission")
    return d.kind === "mission_dod"
      ? { kind: "judge_mission", missionId: d.target.id }
      : { kind: "open_mission", missionId: d.target.id }
  return undefined
}

function computeCapacity(input: PositionInput): Position["capacity"] {
  const runningSliceRuns = input.runs.filter(
    (run) => run.status === "running" && run.sliceId && run.hook === "run"
  )
  const podsFree: Record<string, number> = {}
  const sliceById = new Map(input.slices.map((s) => [s.id, s]))
  for (const pod of input.pods) {
    const busy = runningSliceRuns.filter((run) => {
      const slice = sliceById.get(run.sliceId!)
      return (slice?.podKey ?? input.initiative.defaultPodKey) === pod.key
    }).length
    podsFree[pod.key] = Math.max(1, pod.builderSeats) - busy
  }
  if (input.workspace.mode === "none")
    return {
      concurrencyFree: 0,
      podsFree,
      mode: "none",
      reason: input.workspace.reason ?? "the feature has no workspace",
    }
  if (input.workspace.mode === "single_flight") {
    const busy =
      input.workspace.busy ||
      input.runs.some((run) => run.status === "running" && !run.isolated)
    return {
      concurrencyFree: busy ? 0 : 1,
      podsFree,
      mode: "single_flight",
      reason: busy
        ? "the workspace isn't a git repository, so one run at a time"
        : null,
    }
  }
  const isolated = runningSliceRuns.filter((run) => run.isolated).length
  const free = Math.max(0, input.limits.maxConcurrentSlices - isolated)
  return {
    concurrencyFree: free,
    podsFree,
    mode: "git",
    reason: free ? null : `the budget allows ${input.limits.maxConcurrentSlices} user stories at once`,
  }
}

function formatAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

// ── identity: what counts as "the position changed" ─────────────────────────

// Everything a tick may act on, and nothing time-varying: two positions with
// the same fingerprint lead to the same actions, so an unchanged fingerprint
// means the tick has nothing new to do.
export function positionFingerprint(position: Position): string {
  const stable = {
    i: [
      position.initiative.status,
      position.initiative.driveMode,
      position.initiative.activeMissionId,
      position.initiative.nextHook?.hook ?? null,
      position.initiative.nextHook?.missionId ?? null,
      position.initiative.runningHook?.hook ?? null,
      position.initiative.complete,
    ],
    m: position.mission
      ? [
          position.mission.id,
          position.mission.status,
          position.mission.doneConditionMet,
          position.mission.ready,
          position.mission.running,
          position.mission.integrating,
          position.mission.done,
          position.mission.blocked.map((b) => b.slice),
          position.mission.retryable,
          position.mission.waiting.map((w) => w.slice),
        ]
      : null,
    s: Object.values(position.slices)
      .map((s) => `${s.id}:${s.status}`)
      .sort(),
    d: position.dispatch.map((d) => d.slice),
    c: position.capacity.concurrencyFree,
    b: position.budgets.map((b) => `${b.key}:${b.level}`),
    p: position.pendingDecisions.map((d) => d.key).sort(),
    x: position.maneuver.kind,
  }
  return fnv1a(JSON.stringify(stable))
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

// ── rendering for a seat ────────────────────────────────────────────────────

export function renderPosition(position: Position): string {
  const key = (id: string) => position.slices[id]?.key ?? id
  const keys = (ids: string[]) => (ids.length ? ids.map(key).join(", ") : "none")
  const lines = [
    `Feature: ${position.initiative.status}, ${position.initiative.driveMode} drive.`,
  ]
  const m = position.mission
  if (m) {
    lines.push(
      `Active milestone: ${m.key} "${m.name}" (${m.status}).`,
      `Waves: ${m.waves.map((wave, i) => `${i + 1}) ${keys(wave)}`).join("  ") || "none"}`,
      `Critical path: ${keys(m.criticalPath)}`,
      `Ready: ${keys(m.ready)} · Running: ${keys(m.running)} · Merging: ${keys(m.integrating)} · Done: ${keys(m.done)}`
    )
    if (m.waiting.length)
      lines.push(
        `Waiting: ${m.waiting.map((w) => `${key(w.slice)} (on ${keys(w.on)})`).join("; ")}`
      )
    if (m.blocked.length)
      lines.push(`Blocked: ${m.blocked.map((b) => `${key(b.slice)} (${b.reason})`).join("; ")}`)
    if (m.retryable.length) lines.push(`Retryable: ${keys(m.retryable)}`)
  } else if (position.initiative.complete) lines.push("Every milestone is complete.")
  else lines.push("No active milestone.")
  lines.push(
    `Capacity: ${position.capacity.concurrencyFree} slot(s) free${position.capacity.reason ? ` (${position.capacity.reason})` : ""}.`
  )
  if (position.initiative.runningHook)
    lines.push(`Running: the ${position.initiative.runningHook.label}.`)
  lines.push(`Next: ${position.maneuver.text}`)
  if (position.deferred.length)
    lines.push(
      `Deferred: ${position.deferred.map((d) => `${key(d.slice)} (${d.reason})`).join("; ")}`
    )
  const budgets = position.budgets.filter((b) => b.level !== "ok" && b.key !== "maxConcurrentSlices")
  if (budgets.length)
    lines.push(
      `Budgets: ${budgets.map((b) => `${b.label} ${formatAmount(b.used)}/${b.limit} (${b.level})`).join("; ")}`
    )
  if (position.pendingDecisions.length) {
    lines.push("Pending decisions:")
    for (const d of position.pendingDecisions)
      lines.push(`- [${d.owner === "lead" ? "you" : "user"}] ${d.summary}`)
  }
  return lines.join("\n")
}

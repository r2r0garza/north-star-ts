import {
  deriveWaves,
  touchHintsOverlap,
  withRunsLastEdges,
  type OverlapPolicy,
} from "./waves"
import type { BudgetMeter } from "./budgets"

// The Navigator's position (plan 106.6): a PURE function of durable state.
// Given the same snapshot it always returns the same position, so the
// Navigator can recompute it after any event or a restart and never needs
// in-memory memory of where it was. It never calls a model: it says where the
// feature is, what the next mechanical step is, and which decisions only a
// seat or the user can make.

export type DriveMode = "manual" | "copilot" | "autopilot"
export type HookName =
  | "plan"
  | "between_milestones"
  | "on_complete"
  | "before_user_stories"
  | "after_each_user_story"
  | "after_all_user_stories"
  | "run"

export interface PositionUserStoryInput {
  id: string
  milestoneId: string
  key: string
  title: string
  status: string
  attempts: number
  podKey: string | null
  position: number
  touchHints: string[]
  acceptanceCount: number
  proofVerdict: "accepted" | "rejected" | null
  // Waits for every other user story in the milestone (implicit edges).
  runsLast?: boolean
  // Set for a failed user story: why its latest run failed, and whether the
  // model request failed rather than the user story's own work.
  lastFailure?: { reason: string; infrastructure: boolean } | null
}

export interface PositionMilestoneInput {
  id: string
  key: string
  name: string
  status: string
  position: number
  integrationBranch: string | null
  mergePolicy: "manual" | "local_merge" | "open_pr"
  dodReviewed: boolean
  finishedAt?: number | null
  // The hooks the milestone's playbook defines.
  hooks: HookName[]
}

export interface PositionRunInput {
  id: string
  hook: HookName
  milestoneId: string | null
  userStoryId: string | null
  status: "running" | "completed" | "failed" | "cancelled"
  // Runs in its own worktree (user story runs in a git workspace).
  isolated: boolean
  createdAt: number
}

export interface PositionInput {
  feature: {
    id: string
    status: string
    driveMode: DriveMode
    // The hooks the feature's playbook defines.
    hooks: HookName[]
    defaultPodKey: string | null
    // Absent means "wait", the default.
    overlapPolicy?: OverlapPolicy
  }
  milestones: PositionMilestoneInput[]
  userStories: PositionUserStoryInput[]
  edges: Array<{
    milestoneId: string
    fromUserStoryId: string
    toUserStoryId: string
  }>
  runs: PositionRunInput[]
  mergeQueue: Array<{
    id: string
    userStoryId: string
    milestoneId: string
    status: string
    escalated: boolean
  }>
  proposals: Array<{
    id: string
    kind: string
    proposer: string
    summary: string
  }>
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
  limits: { maxConcurrentUserStories: number; maxUserStoryAttempts: number }
  budgets: BudgetMeter[]
}

export type DecisionKind =
  | "no_plan"
  | "plan_proposal"
  | "proposal"
  | "escalation"
  | "hook_failed"
  | "hook_due"
  | "milestone_empty"
  | "user_story_unspecified"
  | "user_story_blocked"
  | "user_story_failed"
  | "proof_rejected"
  | "merge_conflict"
  | "milestone_dod"
  | "milestone_landing"
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
  | { kind: "run_hook"; hook: HookName; milestoneId: string | null }
  | { kind: "judge_milestone"; milestoneId: string }
  | { kind: "open_milestone"; milestoneId: string }
  | { kind: "open_user_story"; userStoryId: string }
  | { kind: "edit_budgets" }

export interface HookRef {
  hook: HookName
  milestoneId: string | null
  label: string
}

export interface UserStoryRef {
  id: string
  key: string
  title: string
  status: string
}

export interface Position {
  feature: {
    id: string
    status: string
    driveMode: DriveMode
    activeMilestoneId: string | null
    nextHook: HookRef | null
    // A hook the Navigator is waiting on.
    runningHook: HookRef | null
    complete: boolean
  }
  milestone: {
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
    waiting: Array<{ userStory: string; on: string[] }>
    blocked: Array<{ userStory: string; reason: string }>
    // Failed user stories the Navigator may retry mechanically.
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
  dispatch: Array<{ userStory: string; retry: boolean }>
  deferred: Array<{ userStory: string; reason: string }>
  // Mechanical steps other than user stories, in order.
  maneuver: Maneuver
  budgets: BudgetMeter[]
  pendingDecisions: Decision[]
  lead: string | null
  userStories: Record<string, UserStoryRef>
}

export type Maneuver =
  | { kind: "run_hook"; hook: HookRef; text: string }
  | { kind: "dispatch"; text: string }
  | { kind: "complete_milestone"; milestoneId: string; text: string }
  | { kind: "complete_feature"; text: string }
  | { kind: "wait"; text: string }
  | { kind: "decide"; text: string }
  | { kind: "idle"; text: string }

const TERMINAL_MILESTONE = new Set(["completed", "cancelled"])
const HOOK_LABEL: Record<string, string> = {
  plan: "planning",
  between_milestones: "release",
  on_complete: "completion",
  before_user_stories: "milestone planning review",
  after_all_user_stories: "milestone review",
  after_each_user_story: "conflict resolution",
  run: "user story run",
}

function hookRef(
  hook: HookName,
  milestoneId: string | null,
  milestoneKey?: string
): HookRef {
  return {
    hook,
    milestoneId,
    label: `${HOOK_LABEL[hook] ?? hook} hook${milestoneKey ? ` for ${milestoneKey}` : ""}`,
  }
}

// The latest run of a hook on a container: none / running / completed / ...
function hookState(
  runs: PositionRunInput[],
  hook: HookName,
  milestoneId: string | null
): PositionRunInput["status"] | "none" {
  const latest = runs
    .filter(
      (run) =>
        run.hook === hook && run.milestoneId === milestoneId && !run.userStoryId
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0]
  return latest?.status ?? "none"
}

export function computePosition(input: PositionInput): Position {
  const { feature } = input
  const manual = feature.driveMode === "manual"
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

  const userStoryRefs: Record<string, UserStoryRef> = {}
  for (const userStory of input.userStories)
    userStoryRefs[userStory.id] = {
      id: userStory.id,
      key: userStory.key,
      title: userStory.title,
      status: userStory.status,
    }
  const keyOf = (id: string) => userStoryRefs[id]?.key ?? id

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
    // Full concurrency is normal operation, and a long phase is handled by
    // the phase itself (told to wrap up, then stopped): neither is a decision.
    if (
      meter.key === "maxConcurrentUserStories" ||
      meter.key === "maxPhaseMinutes" ||
      meter.level === "ok" ||
      meter.final
    )
      continue
    if (meter.key === "maxUserStoryAttempts") continue // per user story, below
    const lead =
      meter.key === "maxPlanRevisionsPerMilestone" ||
      meter.key === "maxAgentUserStoriesPerMilestone"
    decide({
      key: `budget:${meter.key}:${meter.level}`,
      kind: "budget",
      owner: lead && !manual && input.lead ? "lead" : "user",
      target: { kind: "budget", id: meter.key },
      summary: `${meter.label} at ${meter.level === "hard" ? "its limit" : "80%"}: ${formatAmount(meter.used)} of ${meter.limit} ${meter.unit}.`,
    })
  }

  const milestones = [...input.milestones].sort(
    (a, b) => a.position - b.position
  )
  const liveUserStories = (milestoneId: string) =>
    input.userStories.filter(
      (s) => s.milestoneId === milestoneId && s.status !== "cancelled"
    )
  const anyUserStories = input.userStories.some((s) => s.status !== "cancelled")
  const running = input.runs.filter((run) => run.status === "running")
  const runningHookRun = running.find((run) => !run.userStoryId)
  const runningHook = runningHookRun
    ? hookRef(
        runningHookRun.hook,
        runningHookRun.milestoneId,
        milestones.find((m) => m.id === runningHookRun.milestoneId)?.key
      )
    : null

  const capacity = computeCapacity(input)
  const empty = {
    feature: {
      id: feature.id,
      status: feature.status,
      driveMode: feature.driveMode,
      activeMilestoneId: null as string | null,
      nextHook: null as HookRef | null,
      runningHook,
      complete: false,
    },
    milestone: null as Position["milestone"],
    capacity,
    dispatch: [] as Position["dispatch"],
    deferred: [] as Position["deferred"],
    budgets: input.budgets,
    pendingDecisions: decisions,
    lead: input.lead?.address ?? null,
    userStories: userStoryRefs,
  }
  const finish = (
    maneuver: Maneuver,
    extra: Partial<typeof empty> = {}
  ): Position => {
    // Only Autopilot runs hooks itself; otherwise a due hook waits on the user.
    if (maneuver.kind === "run_hook" && feature.driveMode !== "autopilot")
      decide({
        key: `hook_due:${maneuver.hook.hook}:${maneuver.hook.milestoneId ?? ""}`,
        kind: "hook_due",
        owner: "user",
        target: { kind: "hook", id: maneuver.hook.hook },
        summary: `${maneuver.text}`,
        action: {
          kind: "run_hook",
          hook: maneuver.hook.hook,
          milestoneId: maneuver.hook.milestoneId,
        },
      })
    const merged = { ...empty, ...extra }
    return { ...merged, maneuver, pendingDecisions: decisions }
  }

  // ── planning: nothing to work on yet ────────────────────────────────────
  if (!anyUserStories) {
    const pendingPlan = input.proposals.some((p) => p.kind === "plan")
    if (pendingPlan)
      return finish({
        kind: "decide",
        text: "Waiting for the planning proposal to be applied.",
      })
    if (!feature.hooks.includes("plan")) {
      decide({
        key: "no_plan",
        kind: "no_plan",
        owner: "user",
        target: { kind: "feature", id: feature.id },
        summary:
          "There are no user stories to work on. Add user stories, or add a planning hook to the feature playbook.",
      })
      return finish({
        kind: "decide",
        text: "Waiting for a plan: add milestones and user stories.",
      })
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
        summary:
          "The planning hook failed. Run it again or write the plan by hand.",
        action: { kind: "run_hook", hook: "plan", milestoneId: null },
      })
      return finish({ kind: "decide", text: "Planning failed." })
    }
    if (state === "completed") {
      decide({
        key: "no_plan",
        kind: "no_plan",
        owner: "user",
        target: { kind: "feature", id: feature.id },
        summary:
          "Planning finished without a proposal. Run it again or add user stories by hand.",
        action: { kind: "run_hook", hook: "plan", milestoneId: null },
      })
      return finish({ kind: "decide", text: "Planning produced no plan." })
    }
    const hook = hookRef("plan", null)
    return finish(
      { kind: "run_hook", hook, text: "Run the planning hook." },
      { feature: { ...empty.feature, nextHook: hook } }
    )
  }

  // ── the active milestone: the first one not finished (milestones run in order)
  const activeIndex = milestones.findIndex(
    (m) => !TERMINAL_MILESTONE.has(m.status)
  )
  if (activeIndex < 0) {
    // Everything finished: completion hook, then the feature is done.
    const last = milestones.filter((m) => m.status === "completed").at(-1)
    if (!last)
      return finish({ kind: "idle", text: "Every milestone was cancelled." })
    if (feature.hooks.includes("on_complete")) {
      // A reopened feature (more milestones) earns its completion hook again:
      // only a run after the last milestone finished counts.
      const since = last.finishedAt ?? 0
      const state = hookState(
        input.runs.filter(
          (run) => run.hook !== "on_complete" || run.createdAt >= since
        ),
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
          summary:
            "The completion hook failed. Run it again to finish the feature.",
          action: { kind: "run_hook", hook: "on_complete", milestoneId: null },
        })
        return finish({ kind: "decide", text: "The completion hook failed." })
      }
      if (state === "none" || state === "cancelled") {
        const hook = hookRef("on_complete", null)
        return finish(
          { kind: "run_hook", hook, text: "Run the completion hook." },
          { feature: { ...empty.feature, nextHook: hook } }
        )
      }
    }
    return finish(
      { kind: "complete_feature", text: "Every milestone is complete." },
      { feature: { ...empty.feature, complete: true } }
    )
  }
  const milestone = milestones[activeIndex]
  const featureState = { ...empty.feature, activeMilestoneId: milestone.id }

  // Release for the previous milestone before the next one starts.
  const previous = milestones
    .slice(0, activeIndex)
    .filter((m) => m.status === "completed")
    .at(-1)
  if (
    previous &&
    milestone.status === "planned" &&
    feature.hooks.includes("between_milestones")
  ) {
    const state = hookState(input.runs, "between_milestones", previous.id)
    if (state === "running")
      return finish(
        {
          kind: "wait",
          text: `The release hook for ${previous.key} is running.`,
        },
        { feature: featureState }
      )
    if (state === "failed") {
      decide({
        key: `hook_failed:between_milestones:${previous.id}`,
        kind: "hook_failed",
        owner: "user",
        target: { kind: "milestone", id: previous.id },
        summary: `The release hook for ${previous.key} failed. Run it again, or start ${milestone.key} yourself.`,
        action: {
          kind: "run_hook",
          hook: "between_milestones",
          milestoneId: previous.id,
        },
      })
      return finish(
        { kind: "decide", text: `The release for ${previous.key} failed.` },
        { feature: featureState }
      )
    }
    if (state === "none") {
      const hook = hookRef("between_milestones", previous.id, previous.key)
      return finish(
        {
          kind: "run_hook",
          hook,
          text: `Run the release hook for ${previous.key}.`,
        },
        { feature: { ...featureState, nextHook: hook } }
      )
    }
  }

  const userStories = liveUserStories(milestone.id)
  const allMilestoneUserStories = input.userStories.filter(
    (s) => s.milestoneId === milestone.id
  )
  const edges = withRunsLastEdges(
    allMilestoneUserStories,
    input.edges.filter((e) => e.milestoneId === milestone.id)
  )
  let waves: string[][] = []
  let criticalPath: string[] = []
  try {
    const all = deriveWaves(allMilestoneUserStories, edges)
    waves = all.waves.map((wave) => wave.map((s) => s.id))
    criticalPath = deriveWaves(userStories, edges).criticalPath
  } catch {
    // A cyclic graph can't be stored, but stay total if one is read mid-edit.
  }

  const byId = new Map(allMilestoneUserStories.map((s) => [s.id, s]))
  const predecessors = (id: string) =>
    edges.filter((e) => e.toUserStoryId === id).map((e) => e.fromUserStoryId)
  const ready: string[] = []
  const runningUserStories: string[] = []
  const integrating: string[] = []
  const done: string[] = []
  const waiting: Array<{ userStory: string; on: string[] }> = []
  const blocked: Array<{ userStory: string; reason: string }> = []
  const retryable: string[] = []
  const soft = Math.max(1, Math.floor(input.limits.maxUserStoryAttempts * 0.8))

  for (const userStory of [...allMilestoneUserStories].sort(
    (a, b) => a.position - b.position
  )) {
    const preds = predecessors(userStory.id)
      .map((id) => byId.get(id))
      .filter(Boolean) as PositionUserStoryInput[]
    const cancelledPred = preds.find((p) => p.status === "cancelled")
    const unmet = preds.filter((p) => p.status !== "done")
    switch (userStory.status) {
      case "running":
      case "proving":
        runningUserStories.push(userStory.id)
        break
      case "integrating":
        integrating.push(userStory.id)
        break
      case "done":
        done.push(userStory.id)
        break
      case "cancelled":
        break
      case "blocked": {
        const reason = cancelledPred
          ? `depends on cancelled user story ${cancelledPred.key}`
          : "blocked"
        blocked.push({ userStory: userStory.id, reason })
        decide({
          key: `user_story_blocked:${userStory.id}`,
          kind: "user_story_blocked",
          owner: ownerFor("revise_plan"),
          target: { kind: "user_story", id: userStory.id },
          summary: `User story ${userStory.key} is blocked: ${reason}. Remove the dependency, cancel it, or replace the work.`,
        })
        break
      }
      case "failed": {
        const failure = userStory.lastFailure
        const why = failure ? ` Cause: ${failure.reason}` : ""
        // A failed model request says nothing about the user story's work, so
        // it doesn't wait on a decision until the attempts run out.
        const infrastructure = failure?.infrastructure === true
        const hint = infrastructure
          ? " The model request failed, not the user story's work; splitting or rewriting it won't help."
          : ""
        if (userStory.attempts >= input.limits.maxUserStoryAttempts) {
          decide({
            key: `user_story_failed:${userStory.id}:${userStory.attempts}`,
            kind: "user_story_failed",
            owner: ownerFor("revise_plan", "assign_user_story"),
            target: { kind: "user_story", id: userStory.id },
            summary: `User story ${userStory.key} failed and used all ${input.limits.maxUserStoryAttempts} attempts. Split it, cancel it, or ask the user for more attempts.${why}${hint}`,
          })
        } else if (userStory.proofVerdict === "rejected") {
          decide({
            key: `proof_rejected:${userStory.id}:${userStory.attempts}`,
            kind: "proof_rejected",
            owner: ownerFor("assign_user_story", "revise_plan"),
            target: { kind: "user_story", id: userStory.id },
            summary: `User story ${userStory.key}'s proof was rejected on attempt ${userStory.attempts}. Retry it with a note, revise it, or cancel it.${why}`,
          })
        } else if (userStory.attempts >= soft && !infrastructure) {
          decide({
            key: `user_story_failed:${userStory.id}:${userStory.attempts}`,
            kind: "user_story_failed",
            owner: ownerFor("assign_user_story", "revise_plan"),
            target: { kind: "user_story", id: userStory.id },
            summary: `User story ${userStory.key} failed on attempt ${userStory.attempts} of ${input.limits.maxUserStoryAttempts}. Retry it with a note, or revise the plan.${why}`,
          })
        } else if (!unmet.length) retryable.push(userStory.id)
        break
      }
      default: {
        // draft / ready: runnable once every predecessor has merged.
        if (cancelledPred) {
          blocked.push({
            userStory: userStory.id,
            reason: `depends on cancelled user story ${cancelledPred.key}`,
          })
          decide({
            key: `user_story_blocked:${userStory.id}`,
            kind: "user_story_blocked",
            owner: ownerFor("revise_plan"),
            target: { kind: "user_story", id: userStory.id },
            summary: `User story ${userStory.key} depends on cancelled user story ${cancelledPred.key}.`,
          })
        } else if (unmet.length) {
          waiting.push({ userStory: userStory.id, on: unmet.map((p) => p.id) })
        } else if (userStory.acceptanceCount === 0) {
          blocked.push({
            userStory: userStory.id,
            reason: "has no acceptance criteria",
          })
          decide({
            key: `user_story_unspecified:${userStory.id}`,
            kind: "user_story_unspecified",
            owner: ownerFor("revise_plan"),
            target: { kind: "user_story", id: userStory.id },
            summary: `User story ${userStory.key} has no acceptance criteria, so it can't be proven. Add criteria before it runs.`,
          })
        } else ready.push(userStory.id)
      }
    }
  }

  for (const entry of input.mergeQueue)
    if (
      entry.milestoneId === milestone.id &&
      entry.status === "conflict" &&
      entry.escalated
    )
      decide({
        key: `merge_conflict:${entry.id}`,
        kind: "merge_conflict",
        owner: "user",
        target: { kind: "user_story", id: entry.userStoryId },
        summary: `User story ${keyOf(entry.userStoryId)}'s merge conflict needs you: retry, run the integrator, or abandon it.`,
      })

  const allSettled =
    userStories.length > 0 && userStories.every((s) => s.status === "done")
  const milestoneState: NonNullable<Position["milestone"]> = {
    id: milestone.id,
    key: milestone.key,
    name: milestone.name,
    status: milestone.status,
    waves,
    criticalPath,
    ready,
    running: runningUserStories,
    integrating,
    done,
    waiting,
    blocked,
    retryable,
    doneConditionMet: false,
  }
  const withMilestone = (
    maneuver: Maneuver,
    extra: {
      nextHook?: HookRef | null
      dispatch?: Position["dispatch"]
      deferred?: Position["deferred"]
    } = {}
  ) =>
    finish(maneuver, {
      feature: { ...featureState, nextHook: extra.nextHook ?? null },
      milestone: milestoneState,
      dispatch: extra.dispatch ?? [],
      deferred: extra.deferred ?? [],
    })

  if (!userStories.length) {
    decide({
      key: `milestone_empty:${milestone.id}`,
      kind: "milestone_empty",
      owner: ownerFor("revise_plan"),
      target: { kind: "milestone", id: milestone.id },
      summary: `Milestone ${milestone.key} has no user stories. Add or propose user stories for it.`,
    })
    return withMilestone({
      kind: "decide",
      text: `Milestone ${milestone.key} has no user stories yet.`,
    })
  }

  // Review the user story set before the first user story starts.
  if (
    milestone.status === "planned" &&
    milestone.hooks.includes("before_user_stories")
  ) {
    const state = hookState(input.runs, "before_user_stories", milestone.id)
    if (state === "running")
      return withMilestone({
        kind: "wait",
        text: `The planning review for ${milestone.key} is running.`,
      })
    if (state === "failed") {
      decide({
        key: `hook_failed:before_user_stories:${milestone.id}`,
        kind: "hook_failed",
        owner: "user",
        target: { kind: "milestone", id: milestone.id },
        summary: `The planning review for ${milestone.key} failed. Run it again, or start its user stories yourself.`,
        action: {
          kind: "run_hook",
          hook: "before_user_stories",
          milestoneId: milestone.id,
        },
      })
      return withMilestone({
        kind: "decide",
        text: `The planning review for ${milestone.key} failed.`,
      })
    }
    if (state === "none") {
      const hook = hookRef("before_user_stories", milestone.id, milestone.key)
      return withMilestone(
        {
          kind: "run_hook",
          hook,
          text: `Run the planning review for ${milestone.key}.`,
        },
        { nextHook: hook }
      )
    }
  }

  // ── the milestone's work is merged: review, judgment, landing ─────────────
  if (
    allSettled &&
    ["review", "active", "integrating"].includes(milestone.status)
  ) {
    if (milestone.hooks.includes("after_all_user_stories")) {
      const state = hookState(
        input.runs,
        "after_all_user_stories",
        milestone.id
      )
      if (state === "running")
        return withMilestone({
          kind: "wait",
          text: `The milestone review for ${milestone.key} is running.`,
        })
      if (state === "failed") {
        decide({
          key: `hook_failed:after_all_user_stories:${milestone.id}`,
          kind: "hook_failed",
          owner: "user",
          target: { kind: "milestone", id: milestone.id },
          summary: `The milestone review for ${milestone.key} failed. Run it again.`,
          action: {
            kind: "run_hook",
            hook: "after_all_user_stories",
            milestoneId: milestone.id,
          },
        })
        return withMilestone({
          kind: "decide",
          text: `The milestone review for ${milestone.key} failed.`,
        })
      }
      if (state === "none" && milestone.status === "review") {
        const hook = hookRef(
          "after_all_user_stories",
          milestone.id,
          milestone.key
        )
        return withMilestone(
          {
            kind: "run_hook",
            hook,
            text: `Run the milestone review for ${milestone.key}.`,
          },
          { nextHook: hook }
        )
      }
    }
    if (milestone.status !== "review")
      return withMilestone({
        kind: "wait",
        text: `Every user story in ${milestone.key} is done; the milestone is moving to review.`,
      })
    if (!milestone.dodReviewed && !manual) {
      decide({
        key: `milestone_dod:${milestone.id}`,
        kind: "milestone_dod",
        owner: ownerFor("accept_proof"),
        target: { kind: "milestone", id: milestone.id },
        summary: `Every user story in ${milestone.key} is merged. Judge whether the milestone meets its definition of done, then complete it.`,
      })
      return withMilestone({
        kind: "decide",
        text: `Milestone ${milestone.key} needs its definition-of-done judgment.`,
      })
    }
    milestoneState.doneConditionMet = true
    if (!milestone.integrationBranch && !manual)
      return withMilestone({
        kind: "complete_milestone",
        milestoneId: milestone.id,
        text: `Complete milestone ${milestone.key}.`,
      })
    decide({
      key: `milestone_landing:${milestone.id}`,
      kind: "milestone_landing",
      owner: "user",
      target: { kind: "milestone", id: milestone.id },
      summary: !milestone.integrationBranch
        ? `Milestone ${milestone.key} is done. Mark it complete.`
        : milestone.mergePolicy === "manual"
          ? `Milestone ${milestone.key} is ready to land: merge ${milestone.integrationBranch} and mark it merged.`
          : `Milestone ${milestone.key} is ready to land: review and approve the ${milestone.mergePolicy === "open_pr" ? "pull request" : "merge"}.`,
    })
    return withMilestone({
      kind: "decide",
      text: `Milestone ${milestone.key} is waiting to land.`,
    })
  }

  // ── dispatch: ready user stories, critical path first, then position ──────────
  const critical = new Set(criticalPath)
  const order = (id: string) => byId.get(id)?.position ?? 0
  const candidates = [
    ...ready.map((id) => ({ id, retry: false })),
    ...retryable.map((id) => ({ id, retry: true })),
  ].sort(
    (a, b) =>
      Number(critical.has(b.id)) - Number(critical.has(a.id)) ||
      order(a.id) - order(b.id)
  )
  const dispatch: Position["dispatch"] = []
  const deferred: Position["deferred"] = []
  const podsFree = { ...capacity.podsFree }
  let free = capacity.concurrencyFree
  const building = allMilestoneUserStories.filter(
    (s) => s.status === "running" || s.status === "proving"
  )
  for (const candidate of candidates) {
    const userStory = byId.get(candidate.id)!
    const pod = userStory.podKey ?? feature.defaultPodKey
    if (free <= 0) {
      deferred.push({
        userStory: userStory.id,
        reason:
          capacity.reason ??
          (capacity.mode === "git"
            ? `the budget allows ${input.limits.maxConcurrentUserStories} user stories at once`
            : "the workspace isn't a git repository, so one run at a time"),
      })
      continue
    }
    if (pod && (podsFree[pod] ?? 1) <= 0) {
      deferred.push({ userStory: userStory.id, reason: `pod ${pod} is busy` })
      continue
    }
    const overlap =
      input.feature.overlapPolicy === "parallel"
        ? undefined
        : [...building, ...dispatch.map((d) => byId.get(d.userStory)!)].find(
            (other) => touchHintsOverlap(userStory.touchHints, other.touchHints)
          )
    if (overlap) {
      deferred.push({
        userStory: userStory.id,
        reason: `touch hints overlap ${overlap.key}`,
      })
      continue
    }
    dispatch.push({ userStory: userStory.id, retry: candidate.retry })
    free--
    if (pod) podsFree[pod] = (podsFree[pod] ?? 1) - 1
  }

  if (dispatch.length)
    return withMilestone(
      {
        kind: "dispatch",
        text: `Start ${dispatch.map((d) => keyOf(d.userStory)).join(", ")}.`,
      },
      { dispatch, deferred }
    )
  const waitingOn = [
    runningUserStories.length ? `${runningUserStories.length} running` : "",
    integrating.length ? `${integrating.length} merging` : "",
  ].filter(Boolean)
  if (waitingOn.length)
    return withMilestone(
      {
        kind: "wait",
        text: `Waiting on user stories: ${waitingOn.join(", ")}.`,
      },
      { deferred }
    )
  return withMilestone(
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
  if (d.target.kind === "user_story")
    return { kind: "open_user_story", userStoryId: d.target.id }
  if (d.target.kind === "milestone")
    return d.kind === "milestone_dod"
      ? { kind: "judge_milestone", milestoneId: d.target.id }
      : { kind: "open_milestone", milestoneId: d.target.id }
  return undefined
}

function computeCapacity(input: PositionInput): Position["capacity"] {
  const runningUserStoryRuns = input.runs.filter(
    (run) => run.status === "running" && run.userStoryId && run.hook === "run"
  )
  const podsFree: Record<string, number> = {}
  const userStoryById = new Map(input.userStories.map((s) => [s.id, s]))
  for (const pod of input.pods) {
    const busy = runningUserStoryRuns.filter((run) => {
      const userStory = userStoryById.get(run.userStoryId!)
      return (userStory?.podKey ?? input.feature.defaultPodKey) === pod.key
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
  const isolated = runningUserStoryRuns.filter((run) => run.isolated).length
  const free = Math.max(0, input.limits.maxConcurrentUserStories - isolated)
  return {
    concurrencyFree: free,
    podsFree,
    mode: "git",
    reason: free
      ? null
      : `the budget allows ${input.limits.maxConcurrentUserStories} user stories at once`,
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
      position.feature.status,
      position.feature.driveMode,
      position.feature.activeMilestoneId,
      position.feature.nextHook?.hook ?? null,
      position.feature.nextHook?.milestoneId ?? null,
      position.feature.runningHook?.hook ?? null,
      position.feature.complete,
    ],
    m: position.milestone
      ? [
          position.milestone.id,
          position.milestone.status,
          position.milestone.doneConditionMet,
          position.milestone.ready,
          position.milestone.running,
          position.milestone.integrating,
          position.milestone.done,
          position.milestone.blocked.map((b) => b.userStory),
          position.milestone.retryable,
          position.milestone.waiting.map((w) => w.userStory),
        ]
      : null,
    s: Object.values(position.userStories)
      .map((s) => `${s.id}:${s.status}`)
      .sort(),
    d: position.dispatch.map((d) => d.userStory),
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
  const key = (id: string) => position.userStories[id]?.key ?? id
  const keys = (ids: string[]) =>
    ids.length ? ids.map(key).join(", ") : "none"
  const lines = [
    `Feature: ${position.feature.status}, ${position.feature.driveMode} drive.`,
  ]
  const m = position.milestone
  if (m) {
    lines.push(
      `Active milestone: ${m.key} "${m.name}" (${m.status}).`,
      `Waves: ${m.waves.map((wave, i) => `${i + 1}) ${keys(wave)}`).join("  ") || "none"}`,
      `Critical path: ${keys(m.criticalPath)}`,
      `Ready: ${keys(m.ready)} · Running: ${keys(m.running)} · Merging: ${keys(m.integrating)} · Done: ${keys(m.done)}`
    )
    if (m.waiting.length)
      lines.push(
        `Waiting: ${m.waiting.map((w) => `${key(w.userStory)} (on ${keys(w.on)})`).join("; ")}`
      )
    if (m.blocked.length)
      lines.push(
        `Blocked: ${m.blocked.map((b) => `${key(b.userStory)} (${b.reason})`).join("; ")}`
      )
    if (m.retryable.length) lines.push(`Retryable: ${keys(m.retryable)}`)
  } else if (position.feature.complete)
    lines.push("Every milestone is complete.")
  else lines.push("No active milestone.")
  lines.push(
    `Capacity: ${position.capacity.concurrencyFree} slot(s) free${position.capacity.reason ? ` (${position.capacity.reason})` : ""}.`
  )
  if (position.feature.runningHook)
    lines.push(`Running: the ${position.feature.runningHook.label}.`)
  lines.push(`Next: ${position.maneuver.text}`)
  if (position.deferred.length)
    lines.push(
      `Deferred: ${position.deferred.map((d) => `${key(d.userStory)} (${d.reason})`).join("; ")}`
    )
  const budgets = position.budgets.filter(
    (b) => b.level !== "ok" && b.key !== "maxConcurrentUserStories"
  )
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

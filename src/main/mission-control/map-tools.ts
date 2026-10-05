import { getDb } from "../db/connection"
import * as features from "../db/repositories/features"
import * as proposalsRepo from "../db/repositories/proposals"
import type {
  Feature,
  Milestone,
  PlanProposal,
  PlaybookRun,
  RigDecisionRight,
  UserStory,
} from "../db/types"
import { budgetLimit } from "../../shared/mission-control/budgets"
import {
  describePlanChange,
  parseMilestoneDraft,
  parsePlanChange,
  parseUserStoryDraft,
  type PlanChange,
  type ProposalKind,
} from "../../shared/mission-control/plan-changes"
import { renderPosition, type Position } from "../../shared/mission-control/position"
import { seatDirectory, type SeatDirectoryEntry } from "./comms"
import {
  applyPlanChanges,
  refreshBlocked,
  seatScopeRefusal,
} from "./plan-edits"
import type { SeatTurnIdentity } from "./seat-turns"
import {
  changeLimitRefusal,
  coverageRefusal,
  describeCoverage,
  extractRequirements,
  parseCoverage,
  parseRequirementChecks,
  planLimitRefusal,
  requirementCheckRefusal,
} from "./intent-requirements"

// The lead seat's map tools (plan 106.6). Every tool re-derives the seat, its
// decision rights, and the active milestone from durable state: the model names
// user stories and milestones by key, never by id, and its arguments grant nothing.
// Rights are enforced HERE, server-side. Anything outside a seat's rights or
// the active milestone becomes a proposal for the user instead of an edit.

export interface MapToolRuntime {
  position(featureId: string): Promise<Position>
  startUserStory(
    userStoryId: string,
    options: { note?: string; actor: string }
  ): Promise<PlaybookRun>
  cancelUserStory(userStoryId: string): void
  // Complete a milestone with nothing to land (no integration branch).
  completeMilestone(milestoneId: string): Promise<void>
}

export type MapResult =
  | { ok: true; message: string; data?: Record<string, unknown> }
  | { ok: false; code: string; message: string }

const REVISE_OP = "revise_plan"
const NOT_FINISHED = new Set(["draft", "ready", "blocked", "failed", "running", "proving"])

function fail(code: string, message: string): MapResult {
  return { ok: false, code, message }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface SeatContext {
  feature: Feature
  seat: SeatDirectoryEntry
  activeMilestone: Milestone | null
}

export function activeMilestoneOf(featureId: string): Milestone | null {
  return (
    features
      .listMilestones(featureId)
      .find((m) => !["completed", "cancelled"].includes(m.status)) ?? null
  )
}

// Whether a seat turn is offered map tools at all: pod leads only.
export function isLeadSeat(turn: SeatTurnIdentity): boolean {
  const feature = features.getFeature(turn.featureId)
  if (!feature?.rigSnapshot) return false
  return seatDirectory(feature.rigSnapshot).some(
    (seat) => seat.address === turn.address && seat.isLead && !seat.vacant
  )
}

export class MapToolService {
  constructor(private readonly runtime: MapToolRuntime) {}

  private context(turn: SeatTurnIdentity): SeatContext | MapResult {
    const feature = features.getFeature(turn.featureId)
    if (!feature?.rigSnapshot)
      return fail("unavailable", "This feature is no longer available.")
    const seat = seatDirectory(feature.rigSnapshot).find(
      (s) => s.address === turn.address
    )
    if (!seat?.isLead)
      return fail(
        "not_a_lead",
        "Map tools are for pod leads. Use `escalate` to raise plan changes with your lead."
      )
    return { feature, seat, activeMilestone: activeMilestoneOf(feature.id) }
  }

  private requireRight(ctx: SeatContext, right: RigDecisionRight): MapResult | null {
    if (ctx.seat.decisionRights.includes(right)) return null
    return fail(
      "lacks_decision_right",
      `${ctx.seat.address} does not hold the "${right}" decision right. Use propose_user_story or revise_plan (which becomes a proposal), or escalate.`
    )
  }

  private requireActive(ctx: SeatContext): MapResult | null {
    return ctx.feature.status === "active"
      ? null
      : fail(
          "not_active",
          `The feature is ${ctx.feature.status}; nothing can start until the user resumes it.`
        )
  }

  // The wave gate's barrier (plan 110): while merged stories await their
  // acceptance gate (or its fix stories run), nothing else starts — from the
  // Navigator or from here. Null when the story may start.
  private async gateHold(featureId: string, userStory: UserStory): Promise<string | null> {
    const position = await this.runtime.position(featureId)
    const held = position.deferred.find((d) => d.userStory === userStory.id && d.gate)
    return held
      ? `User story ${userStory.key} can't start now: it is ${held.reason}. The gate proves the merged stories before anything else starts; the Navigator starts ${userStory.key} when it's done.`
      : null
  }

  // A user story by key: in the active milestone, or a clear error naming where it is.
  private activeUserStory(ctx: SeatContext, key: string): UserStory | MapResult {
    if (!ctx.activeMilestone)
      return fail("no_active_milestone", "There is no active milestone.")
    const userStory = features
      .listUserStories(ctx.activeMilestone.id)
      .find((s) => s.key === key.trim())
    if (userStory) return userStory
    for (const milestone of features.listMilestones(ctx.feature.id))
      if (features.listUserStories(milestone.id).some((s) => s.key === key.trim()))
        return fail(
          "not_active_milestone",
          `User story ${key} belongs to milestone ${milestone.key}, not the active milestone ${ctx.activeMilestone.key}. Only the active milestone's user stories can be changed; propose changes to others.`
        )
    return fail(
      "unknown_user_story",
      `No user story "${key}" in the active milestone ${ctx.activeMilestone.key}. Call map_status for the user story keys.`
    )
  }

  // ── map_status ───────────────────────────────────────────────────────────

  async status(turn: SeatTurnIdentity): Promise<MapResult> {
    const ctx = this.context(turn)
    if ("ok" in ctx) return ctx
    const position = await this.runtime.position(ctx.feature.id)
    return {
      ok: true,
      message: [
        renderPosition(position),
        "",
        `Your decision rights: ${ctx.seat.decisionRights.join(", ") || "none"}.`,
      ].join("\n"),
    }
  }

  // ── assign_user_story / retry_user_story ───────────────────────────────────────────

  async assignUserStory(
    turn: SeatTurnIdentity,
    args: { userStory: string; pod?: string | null }
  ): Promise<MapResult> {
    const ctx = this.context(turn)
    if ("ok" in ctx) return ctx
    const refused = this.requireRight(ctx, "assign_user_story") ?? this.requireActive(ctx)
    if (refused) return refused
    const userStory = this.activeUserStory(ctx, args.userStory)
    if ("ok" in userStory) return userStory
    if (args.pod) {
      const pods = ctx.feature.rigSnapshot!.pods
      if (!pods.some((p) => p.key === args.pod))
        return fail(
          "unknown_pod",
          `No pod "${args.pod}". Pods: ${pods.map((p) => p.key).join(", ")}.`
        )
      if (!["draft", "ready", "blocked", "failed"].includes(userStory.status))
        return fail("started", `User story ${userStory.key} is ${userStory.status}; its pod can't change now.`)
      if (userStory.podKey !== args.pod)
        features.updateUserStory(
          userStory.id,
          { podKey: args.pod },
          turn.address,
          `Assigned to pod ${args.pod}`
        )
    }
    if (userStory.status === "failed")
      return fail("use_retry", `User story ${userStory.key} failed; use retry_user_story with a note on what to do differently.`)
    if (!["draft", "ready"].includes(userStory.status))
      return args.pod
        ? { ok: true, message: `User story ${userStory.key} will run in pod ${args.pod}.` }
        : fail("not_ready", `User story ${userStory.key} is ${userStory.status} and can't be started.`)
    const held = await this.gateHold(ctx.feature.id, userStory)
    if (held) return fail("gate_barrier", held)
    try {
      const run = await this.runtime.startUserStory(userStory.id, { actor: turn.address })
      return {
        ok: true,
        message: `Started user story ${userStory.key}${args.pod ? ` in pod ${args.pod}` : ""}.`,
        data: { playbook_run_id: run.id },
      }
    } catch (error) {
      return fail("start_failed", message(error).replace(/^(touch_overlap|app_launch_required): /, ""))
    }
  }

  async retryUserStory(
    turn: SeatTurnIdentity,
    args: { userStory: string; note: string }
  ): Promise<MapResult> {
    const ctx = this.context(turn)
    if ("ok" in ctx) return ctx
    const refused = this.requireRight(ctx, "assign_user_story") ?? this.requireActive(ctx)
    if (refused) return refused
    const userStory = this.activeUserStory(ctx, args.userStory)
    if ("ok" in userStory) return userStory
    if (userStory.status !== "failed")
      return fail("not_failed", `User story ${userStory.key} is ${userStory.status}; only a failed user story can be retried.`)
    const cap = budgetLimit(ctx.feature.budgets, "maxUserStoryAttempts")
    if (userStory.attempts >= cap)
      return fail(
        "attempts_exhausted",
        `User story ${userStory.key} has used all ${cap} attempts. Split it, cancel it, or escalate to ask the user for more attempts.`
      )
    const held = await this.gateHold(ctx.feature.id, userStory)
    if (held) return fail("gate_barrier", held)
    try {
      const run = await this.runtime.startUserStory(userStory.id, {
        note: args.note,
        actor: turn.address,
      })
      return {
        ok: true,
        message: `Retrying user story ${userStory.key} (attempt ${userStory.attempts + 1} of ${cap}) with your note.`,
        data: { playbook_run_id: run.id },
      }
    } catch (error) {
      return fail("start_failed", message(error).replace(/^(touch_overlap|app_launch_required): /, ""))
    }
  }

  // ── cancel_user_story ─────────────────────────────────────────────────────────

  cancelUserStory(turn: SeatTurnIdentity, args: { userStory: string; reason: string }): MapResult {
    const ctx = this.context(turn)
    if ("ok" in ctx) return ctx
    const refused = this.requireRight(ctx, "revise_plan")
    if (refused) return refused
    const userStory = this.activeUserStory(ctx, args.userStory)
    if ("ok" in userStory) return userStory
    if (!NOT_FINISHED.has(userStory.status))
      return fail(
        "cannot_cancel",
        userStory.status === "integrating"
          ? `User story ${userStory.key} is merging; only the user can abandon a merge.`
          : `User story ${userStory.key} is ${userStory.status}.`
      )
    const budget = this.revisionBudget(ctx)
    if (budget.exhausted)
      return fail(
        "revision_budget",
        `This milestone has used its ${budget.limit} plan revisions. Escalate to the user to cancel ${userStory.key}.`
      )
    const milestone = ctx.activeMilestone!
    const dependents = getDb().transaction(() => {
      features.setUserStoryExecution(
        userStory.id,
        { status: "cancelled", finishedAt: Date.now() },
        args.reason,
        turn.address
      )
      refreshBlocked(milestone.id, turn.address)
      features.recordRevision(
        ctx.feature.id,
        "milestone",
        milestone.id,
        REVISE_OP,
        { changes: [`✕ cancel ${userStory.key}`] },
        turn.address,
        args.reason
      )
      return features
        .listEdges(milestone.id)
        .filter((e) => e.fromUserStoryId === userStory.id)
        .map((e) => features.getUserStory(e.toUserStoryId)?.key)
        .filter(Boolean)
    })()
    // The user story is already cancelled, so the run settling won't touch it.
    if (["running", "proving"].includes(userStory.status)) this.runtime.cancelUserStory(userStory.id)
    return {
      ok: true,
      message: `Cancelled user story ${userStory.key}.${dependents.length ? ` Blocked until you replan: ${dependents.join(", ")}.` : ""}`,
    }
  }

  // ── complete_milestone ─────────────────────────────────────────────────────

  async completeMilestone(
    turn: SeatTurnIdentity,
    args: { milestone: string; summary: string; requirements?: unknown }
  ): Promise<MapResult> {
    const ctx = this.context(turn)
    if ("ok" in ctx) return ctx
    const refused = this.requireRight(ctx, "accept_proof")
    if (refused) return refused
    const milestone = ctx.activeMilestone
    if (!milestone || milestone.key !== args.milestone.trim())
      return fail(
        "not_active_milestone",
        `Only the active milestone${milestone ? ` (${milestone.key})` : ""} can be completed.`
      )
    const notDone = milestoneJudgeRefusal(milestone)
    if (notDone) return fail("not_done", notDone + stillInFlight(milestone))
    if (!args.summary.trim())
      return fail("bad_args", "complete_milestone needs a summary of how the milestone meets its definition of done.")
    // Judged against the user's intent, not only the definition of done the
    // plan derived from it (which can drop requirements).
    const checks = parseRequirementChecks(args.requirements)
    if (typeof checks === "string") return fail("bad_args", checks)
    const requirements = extractRequirements(ctx.feature.intent)
    const isLast = !features
      .listMilestones(ctx.feature.id)
      .some((m) => m.position > milestone.position && !["completed", "cancelled"].includes(m.status))
    const unmet = requirementCheckRefusal(requirements, checks, isLast)
    if (unmet) return fail("intent_not_met", unmet)
    features.setMilestoneDodReview(
      milestone.id,
      {
        by: turn.address,
        summary: args.summary.trim(),
        at: Date.now(),
        ...(requirements.length ? { intentCheck: checks } : {}),
      },
      turn.address
    )
    if (!milestone.integrationBranch) {
      try {
        await this.runtime.completeMilestone(milestone.id)
      } catch (error) {
        return fail("complete_failed", message(error))
      }
      return { ok: true, message: `Milestone ${milestone.key} is complete.` }
    }
    return {
      ok: true,
      message: `Recorded your definition-of-done judgment. The user lands ${milestone.integrationBranch} with the milestone's ${milestone.mergePolicy.mode.replace(/_/g, " ")} policy; the Navigator moves on once it lands.`,
    }
  }

  // ── plan changes ─────────────────────────────────────────────────────────

  private revisionBudget(ctx: SeatContext) {
    const limit = budgetLimit(ctx.feature.budgets, "maxPlanRevisionsPerMilestone")
    const used = ctx.activeMilestone
      ? features.countRevisions(ctx.feature.id, ctx.activeMilestone.id, REVISE_OP)
      : 0
    return { limit, used, exhausted: used >= limit }
  }

  private propose(
    ctx: SeatContext,
    turn: SeatTurnIdentity,
    kind: ProposalKind,
    changes: PlanChange[],
    reason: string,
    why: string | null
  ): MapResult {
    const proposal = proposalsRepo.createProposal({
      featureId: ctx.feature.id,
      milestoneId: ctx.activeMilestone?.id ?? null,
      kind,
      changes,
      proposer: turn.address,
      reason,
    })
    return {
      ok: true,
      message: `${why ? `${why} ` : ""}Proposed for the user's review (proposal ${proposal.id.slice(0, 8)}): ${changes.map(describePlanChange).join("; ")}. You'll hear back if it's rejected; don't build it until it's applied.`,
      data: { proposal_id: proposal.id, status: "pending" },
    }
  }

  revisePlan(
    turn: SeatTurnIdentity,
    args: { changes: unknown; reason: string }
  ): MapResult {
    const ctx = this.context(turn)
    if ("ok" in ctx) return ctx
    if (!args.reason?.trim())
      return fail("bad_args", "revise_plan needs a `reason`; it goes in the revision log.")
    const parsed = parseChanges(args.changes)
    if (typeof parsed === "string") return fail("bad_args", parsed)
    const reason = args.reason.trim()

    const scope = seatScopeRefusal(parsed, ctx.activeMilestone)
    if (scope) return this.propose(ctx, turn, "revise_plan", parsed, reason, scope)
    if (!ctx.seat.decisionRights.includes("revise_plan"))
      return this.propose(
        ctx,
        turn,
        "revise_plan",
        parsed,
        reason,
        `${ctx.seat.address} doesn't hold the "revise_plan" right.`
      )
    const budget = this.revisionBudget(ctx)
    if (budget.exhausted)
      return this.propose(
        ctx,
        turn,
        "revise_plan",
        parsed,
        reason,
        `This milestone has used its ${budget.limit} plan revisions.`
      )
    const milestone = ctx.activeMilestone!
    const overLimit = changeLimitRefusal(ctx.feature, milestone.id, parsed)
    if (overLimit) return this.propose(ctx, turn, "revise_plan", parsed, reason, overLimit)
    const adds = parsed.reduce(
      (n, c) => n + (c.op === "add_user_story" ? 1 : c.op === "split_user_story" ? c.into.length : 0),
      0
    )
    const agentLimit = budgetLimit(ctx.feature.budgets, "maxAgentUserStoriesPerMilestone")
    const agentUserStories = features.countSeatCreatedUserStories(milestone.id)
    if (adds && agentUserStories + adds > agentLimit)
      return this.propose(
        ctx,
        turn,
        "revise_plan",
        parsed,
        reason,
        `Seats may add ${agentLimit} user stories to a milestone on their own and ${agentUserStories} were added already.`
      )
    try {
      const result = applyPlanChanges({
        featureId: ctx.feature.id,
        milestoneId: milestone.id,
        changes: parsed,
        actor: turn.address,
        reason,
        origin: "agent",
      })
      features.recordRevision(
        ctx.feature.id,
        "milestone",
        milestone.id,
        REVISE_OP,
        { changes: result.applied },
        turn.address,
        reason
      )
      const used = budget.used + 1
      return {
        ok: true,
        message: [
          `Applied to ${milestone.key}:`,
          ...result.applied.map((line) => `- ${line}`),
          `Plan revisions used: ${used} of ${budget.limit}.`,
        ].join("\n"),
      }
    } catch (error) {
      // The change set applies in one transaction, so nothing partial remains.
      return fail("invalid_change", `Nothing was changed. ${message(error)}`)
    }
  }

  proposeUserStory(
    turn: SeatTurnIdentity,
    args: { milestone?: string | null; userStory: unknown; reason: string }
  ): MapResult {
    const ctx = this.context(turn)
    if ("ok" in ctx) return ctx
    const draft = parseUserStoryDraft(args.userStory)
    if (typeof draft === "string") return fail("bad_args", draft)
    const milestoneKey = args.milestone?.trim() || ctx.activeMilestone?.key
    if (!milestoneKey) return fail("bad_args", "Name the milestone the user story belongs to.")
    if (!features.listMilestones(ctx.feature.id).some((m) => m.key === milestoneKey))
      return fail("unknown_milestone", `No milestone "${milestoneKey}" in this feature.`)
    if (!args.reason?.trim()) return fail("bad_args", "propose_user_story needs a `reason`.")
    return this.propose(
      ctx,
      turn,
      "user_story",
      [{ op: "add_user_story", milestone: milestoneKey, userStory: draft }],
      args.reason.trim(),
      null
    )
  }

  proposePlan(
    turn: SeatTurnIdentity,
    args: { milestones: unknown; reason?: string; coverage?: unknown }
  ): MapResult {
    const ctx = this.context(turn)
    if ("ok" in ctx) return ctx
    if (!Array.isArray(args.milestones) || !args.milestones.length)
      return fail("bad_args", "propose_plan needs `milestones`: at least one milestone with its user stories.")
    const changes: PlanChange[] = []
    for (const [index, value] of args.milestones.entries()) {
      const draft = parseMilestoneDraft(value)
      if (typeof draft === "string") return fail("bad_args", `Milestone ${index + 1}: ${draft}`)
      changes.push({ op: "add_milestone", milestone: draft })
    }
    const drafts = changes.flatMap((c) => (c.op === "add_milestone" ? [c.milestone] : []))
    const overLimit = planLimitRefusal(ctx.feature.intent, drafts)
    if (overLimit) return fail("exceeds_intent_limits", `Nothing was proposed. ${overLimit}`)
    const coverage = parseCoverage(args.coverage)
    if (typeof coverage === "string") return fail("bad_args", coverage)
    const uncovered = coverageRefusal(extractRequirements(ctx.feature.intent), drafts, coverage)
    if (uncovered) return fail("intent_not_covered", `Nothing was proposed. ${uncovered}`)
    const reason = args.reason?.trim() || "Feature plan"
    return this.propose(
      ctx,
      turn,
      "plan",
      changes,
      coverage.length ? `${reason}\nCoverage: ${describeCoverage(coverage)}` : reason,
      null
    )
  }
}

function parseChanges(value: unknown): PlanChange[] | string {
  if (!Array.isArray(value) || !value.length)
    return "`changes` must be a non-empty list of changes."
  const changes: PlanChange[] = []
  for (const [index, item] of value.entries()) {
    const change = parsePlanChange(item)
    if (typeof change === "string") return `Change ${index + 1}: ${change}`
    changes.push(change)
  }
  return changes
}

// Why a milestone can't be judged done yet, or null: every user story must be
// merged (or cancelled) and the milestone in review.
export function milestoneJudgeRefusal(milestone: Milestone): string | null {
  const open = features
    .listUserStories(milestone.id)
    .filter((s) => s.status !== "done" && s.status !== "cancelled")
  if (open.length)
    return `Milestone ${milestone.key} still has unfinished user stories: ${open.map((s) => `${s.key} (${s.status})`).join(", ")}.`
  if (milestone.status !== "review")
    return `Milestone ${milestone.key} is ${milestone.status}; it can be completed once every user story has merged.`
  return null
}

// Stories whose runs are still going finish and merge on their own. A lead
// that judged early read "running" as Mission Control being stuck, and
// escalated it to the user.
const IN_FLIGHT = new Set(["running", "proving", "integrating", "merged"])

function stillInFlight(milestone: Milestone): string {
  const open = features
    .listUserStories(milestone.id)
    .filter((s) => s.status !== "done" && s.status !== "cancelled")
  if (!open.length || !open.every((s) => IN_FLIGHT.has(s.status))) return ""
  return " Their runs are still in progress and merge (and pass their acceptance gate) on their own; the Navigator asks you to judge the milestone once every user story is done. Nothing is stuck, so there's nothing to escalate: wait for that direction."
}

// The user's definition-of-done judgment (when the lead doesn't hold
// accept_proof, or the user decides first). A milestone with nothing to land is
// completed; one with an integration branch then waits for its landing.
export async function judgeMilestoneDone(
  milestoneId: string,
  summary: string,
  complete: (milestoneId: string) => Promise<void>
): Promise<void> {
  const milestone = features.getMilestone(milestoneId)
  if (!milestone) throw new Error("That milestone no longer exists.")
  const refusal = milestoneJudgeRefusal(milestone)
  if (refusal) throw new Error(refusal)
  features.setMilestoneDodReview(
    milestone.id,
    { by: "user", summary: summary.trim() || "Judged done by the user.", at: Date.now() },
    "user"
  )
  if (!milestone.integrationBranch) await complete(milestone.id)
}

// ── the user's side of proposals ────────────────────────────────────────────

function proposalInput(proposal: PlanProposal, by: string) {
  const feature = features.getFeature(proposal.featureId)
  if (!feature) throw new Error("The feature no longer exists.")
  if (["completed", "cancelled"].includes(feature.status))
    throw new Error(`The feature is ${feature.status}; its plan can't change.`)
  // The proposal's milestone may have finished since; user story ops then target the
  // current active milestone only if the change named no milestone.
  const milestoneId =
    proposal.milestoneId &&
    !["completed", "cancelled"].includes(features.getMilestone(proposal.milestoneId)?.status ?? "cancelled")
      ? proposal.milestoneId
      : (activeMilestoneOf(feature.id)?.id ?? null)
  return {
    featureId: feature.id,
    milestoneId,
    changes: proposal.changes,
    actor: by,
    reason: `Applied ${proposal.kind === "plan" ? "the planning proposal" : "a proposal"} from ${proposal.proposer}${proposal.reason ? `: ${proposal.reason}` : ""}`,
    origin: (proposal.proposer.includes("@") && !proposal.proposer.endsWith("@rig")
      ? "agent"
      : "user") as UserStory["origin"],
  }
}

// Which of a pending proposal's changes no longer apply to the plan as it is
// now (e.g. an edit to a user story that has started since), without changing
// anything.
export function checkProposal(proposal: PlanProposal): PlanProposal["problems"] {
  if (proposal.status !== "pending") return []
  try {
    return applyPlanChanges(proposalInput(proposal, "user"), { dryRun: true }).skipped.map(
      ({ index, error }) => ({ index, error })
    )
  } catch (error) {
    return proposal.changes.map((_, index) => ({ index, error: message(error) }))
  }
}

// Apply a proposal. `partial` applies the changes that still apply and skips
// the rest; the proposer is told what was skipped and why.
export function applyProposal(
  id: string,
  by = "user",
  options: {
    partial?: boolean
    deliver?: (proposal: PlanProposal, body: string) => void
  } = {}
): PlanProposal {
  const proposal = proposalsRepo.getProposal(id)
  if (!proposal) throw new Error("That proposal no longer exists.")
  if (proposal.status !== "pending")
    throw new Error(`That proposal was already ${proposal.status}.`)
  const result = applyPlanChanges(proposalInput(proposal, by), {
    partial: options.partial,
  })
  if (options.partial && !result.applied.length)
    throw new Error("None of this proposal's changes apply to the plan anymore. Reject it instead.")
  const note = result.skipped.length
    ? `Applied ${result.applied.length} of ${proposal.changes.length}; skipped ${result.skipped.map((s) => `${s.description} (${s.error})`).join("; ")}`
    : null
  const resolved = proposalsRepo.resolveProposal(id, "applied", by, note)
  if (!resolved) throw new Error("That proposal was resolved by someone else.")
  if (result.skipped.length)
    options.deliver?.(
      resolved,
      [
        `The user applied part of your proposal. Applied:`,
        ...result.applied.map((line) => `- ${line}`),
        "Skipped, because the plan moved on:",
        ...result.skipped.map((s) => `- ${s.description}: ${s.error}`),
        "",
        "Re-propose any skipped change that still matters, against the plan as it is now.",
      ].join("\n")
    )
  return resolved
}

export function rejectProposal(
  id: string,
  note: string,
  deliver: (proposal: PlanProposal, body: string) => void,
  by = "user"
): PlanProposal {
  const resolved = proposalsRepo.resolveProposal(id, "rejected", by, note)
  if (!resolved) {
    const current = proposalsRepo.getProposal(id)
    throw new Error(
      current ? `That proposal was already ${current.status}.` : "That proposal no longer exists."
    )
  }
  deliver(
    resolved,
    [
      `The user rejected your ${resolved.kind === "plan" ? "planning proposal" : resolved.kind === "followup" ? "follow-up" : "proposal"}${note.trim() ? `: ${note.trim()}` : "."}`,
      "",
      "It proposed:",
      ...(resolved.followup
        ? [`- follow-up: ${resolved.followup.title}`]
        : resolved.changes.map((change) => `- ${describePlanChange(change)}`)),
      "",
      "Don't build or re-propose it unchanged.",
    ].join("\n")
  )
  return resolved
}

// The installed service; the agent tools reach it through here.
let installed: MapToolService | null = null

export function installMapTools(instance: MapToolService | null): void {
  installed = instance
}

export function getMapTools(): MapToolService | null {
  return installed
}

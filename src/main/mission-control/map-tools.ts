import { getDb } from "../db/connection"
import * as initiatives from "../db/repositories/initiatives"
import * as proposalsRepo from "../db/repositories/proposals"
import type {
  Initiative,
  Mission,
  PlanProposal,
  PlaybookRun,
  RigDecisionRight,
  WorkSlice,
} from "../db/types"
import { budgetLimit } from "../../shared/mission-control/budgets"
import {
  describePlanChange,
  parseMissionDraft,
  parsePlanChange,
  parseSliceDraft,
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

// The lead seat's map tools (plan 106.6). Every tool re-derives the seat, its
// decision rights, and the active mission from durable state: the model names
// slices and missions by key, never by id, and its arguments grant nothing.
// Rights are enforced HERE, server-side. Anything outside a seat's rights or
// the active mission becomes a proposal for the user instead of an edit.

export interface MapToolRuntime {
  position(initiativeId: string): Promise<Position>
  startSlice(
    sliceId: string,
    options: { note?: string; actor: string }
  ): Promise<PlaybookRun>
  cancelSlice(sliceId: string): void
  // Complete a mission with nothing to land (no integration branch).
  completeMission(missionId: string): Promise<void>
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
  initiative: Initiative
  seat: SeatDirectoryEntry
  activeMission: Mission | null
}

export function activeMissionOf(initiativeId: string): Mission | null {
  return (
    initiatives
      .listMissions(initiativeId)
      .find((m) => !["completed", "cancelled"].includes(m.status)) ?? null
  )
}

// Whether a seat turn is offered map tools at all: pod leads only.
export function isLeadSeat(turn: SeatTurnIdentity): boolean {
  const initiative = initiatives.getInitiative(turn.initiativeId)
  if (!initiative?.rigSnapshot) return false
  return seatDirectory(initiative.rigSnapshot).some(
    (seat) => seat.address === turn.address && seat.isLead && !seat.vacant
  )
}

export class MapToolService {
  constructor(private readonly runtime: MapToolRuntime) {}

  private context(turn: SeatTurnIdentity): SeatContext | MapResult {
    const initiative = initiatives.getInitiative(turn.initiativeId)
    if (!initiative?.rigSnapshot)
      return fail("unavailable", "This initiative is no longer available.")
    const seat = seatDirectory(initiative.rigSnapshot).find(
      (s) => s.address === turn.address
    )
    if (!seat?.isLead)
      return fail(
        "not_a_lead",
        "Map tools are for pod leads. Use `escalate` to raise plan changes with your lead."
      )
    return { initiative, seat, activeMission: activeMissionOf(initiative.id) }
  }

  private requireRight(ctx: SeatContext, right: RigDecisionRight): MapResult | null {
    if (ctx.seat.decisionRights.includes(right)) return null
    return fail(
      "lacks_decision_right",
      `${ctx.seat.address} does not hold the "${right}" decision right. Use propose_slice or revise_plan (which becomes a proposal), or escalate.`
    )
  }

  private requireActive(ctx: SeatContext): MapResult | null {
    return ctx.initiative.status === "active"
      ? null
      : fail(
          "not_active",
          `The initiative is ${ctx.initiative.status}; nothing can start until the user resumes it.`
        )
  }

  // A slice by key: in the active mission, or a clear error naming where it is.
  private activeSlice(ctx: SeatContext, key: string): WorkSlice | MapResult {
    if (!ctx.activeMission)
      return fail("no_active_mission", "There is no active mission.")
    const slice = initiatives
      .listSlices(ctx.activeMission.id)
      .find((s) => s.key === key.trim())
    if (slice) return slice
    for (const mission of initiatives.listMissions(ctx.initiative.id))
      if (initiatives.listSlices(mission.id).some((s) => s.key === key.trim()))
        return fail(
          "not_active_mission",
          `Slice ${key} belongs to mission ${mission.key}, not the active mission ${ctx.activeMission.key}. Only the active mission's slices can be changed; propose changes to others.`
        )
    return fail(
      "unknown_slice",
      `No slice "${key}" in the active mission ${ctx.activeMission.key}. Call map_status for the slice keys.`
    )
  }

  // ── map_status ───────────────────────────────────────────────────────────

  async status(turn: SeatTurnIdentity): Promise<MapResult> {
    const ctx = this.context(turn)
    if ("ok" in ctx) return ctx
    const position = await this.runtime.position(ctx.initiative.id)
    return {
      ok: true,
      message: [
        renderPosition(position),
        "",
        `Your decision rights: ${ctx.seat.decisionRights.join(", ") || "none"}.`,
      ].join("\n"),
    }
  }

  // ── assign_slice / retry_slice ───────────────────────────────────────────

  async assignSlice(
    turn: SeatTurnIdentity,
    args: { slice: string; pod?: string | null }
  ): Promise<MapResult> {
    const ctx = this.context(turn)
    if ("ok" in ctx) return ctx
    const refused = this.requireRight(ctx, "assign_slice") ?? this.requireActive(ctx)
    if (refused) return refused
    const slice = this.activeSlice(ctx, args.slice)
    if ("ok" in slice) return slice
    if (args.pod) {
      const pods = ctx.initiative.rigSnapshot!.pods
      if (!pods.some((p) => p.key === args.pod))
        return fail(
          "unknown_pod",
          `No pod "${args.pod}". Pods: ${pods.map((p) => p.key).join(", ")}.`
        )
      if (!["draft", "ready", "blocked", "failed"].includes(slice.status))
        return fail("started", `Slice ${slice.key} is ${slice.status}; its pod can't change now.`)
      if (slice.podKey !== args.pod)
        initiatives.updateSlice(
          slice.id,
          { podKey: args.pod },
          turn.address,
          `Assigned to pod ${args.pod}`
        )
    }
    if (slice.status === "failed")
      return fail("use_retry", `Slice ${slice.key} failed; use retry_slice with a note on what to do differently.`)
    if (!["draft", "ready"].includes(slice.status))
      return args.pod
        ? { ok: true, message: `Slice ${slice.key} will run in pod ${args.pod}.` }
        : fail("not_ready", `Slice ${slice.key} is ${slice.status} and can't be started.`)
    try {
      const run = await this.runtime.startSlice(slice.id, { actor: turn.address })
      return {
        ok: true,
        message: `Started slice ${slice.key}${args.pod ? ` in pod ${args.pod}` : ""}.`,
        data: { playbook_run_id: run.id },
      }
    } catch (error) {
      return fail("start_failed", message(error).replace(/^touch_overlap: /, ""))
    }
  }

  async retrySlice(
    turn: SeatTurnIdentity,
    args: { slice: string; note: string }
  ): Promise<MapResult> {
    const ctx = this.context(turn)
    if ("ok" in ctx) return ctx
    const refused = this.requireRight(ctx, "assign_slice") ?? this.requireActive(ctx)
    if (refused) return refused
    const slice = this.activeSlice(ctx, args.slice)
    if ("ok" in slice) return slice
    if (slice.status !== "failed")
      return fail("not_failed", `Slice ${slice.key} is ${slice.status}; only a failed slice can be retried.`)
    const cap = budgetLimit(ctx.initiative.budgets, "maxSliceAttempts")
    if (slice.attempts >= cap)
      return fail(
        "attempts_exhausted",
        `Slice ${slice.key} has used all ${cap} attempts. Split it, cancel it, or escalate to ask the user for more attempts.`
      )
    try {
      const run = await this.runtime.startSlice(slice.id, {
        note: args.note,
        actor: turn.address,
      })
      return {
        ok: true,
        message: `Retrying slice ${slice.key} (attempt ${slice.attempts + 1} of ${cap}) with your note.`,
        data: { playbook_run_id: run.id },
      }
    } catch (error) {
      return fail("start_failed", message(error).replace(/^touch_overlap: /, ""))
    }
  }

  // ── cancel_slice ─────────────────────────────────────────────────────────

  cancelSlice(turn: SeatTurnIdentity, args: { slice: string; reason: string }): MapResult {
    const ctx = this.context(turn)
    if ("ok" in ctx) return ctx
    const refused = this.requireRight(ctx, "revise_plan")
    if (refused) return refused
    const slice = this.activeSlice(ctx, args.slice)
    if ("ok" in slice) return slice
    if (!NOT_FINISHED.has(slice.status))
      return fail(
        "cannot_cancel",
        slice.status === "integrating"
          ? `Slice ${slice.key} is merging; only the user can abandon a merge.`
          : `Slice ${slice.key} is ${slice.status}.`
      )
    const budget = this.revisionBudget(ctx)
    if (budget.exhausted)
      return fail(
        "revision_budget",
        `This mission has used its ${budget.limit} plan revisions. Escalate to the user to cancel ${slice.key}.`
      )
    const mission = ctx.activeMission!
    const dependents = getDb().transaction(() => {
      initiatives.setSliceExecution(
        slice.id,
        { status: "cancelled", finishedAt: Date.now() },
        args.reason,
        turn.address
      )
      refreshBlocked(mission.id, turn.address)
      initiatives.recordRevision(
        ctx.initiative.id,
        "mission",
        mission.id,
        REVISE_OP,
        { changes: [`✕ cancel ${slice.key}`] },
        turn.address,
        args.reason
      )
      return initiatives
        .listEdges(mission.id)
        .filter((e) => e.fromSliceId === slice.id)
        .map((e) => initiatives.getSlice(e.toSliceId)?.key)
        .filter(Boolean)
    })()
    // The slice is already cancelled, so the run settling won't touch it.
    if (["running", "proving"].includes(slice.status)) this.runtime.cancelSlice(slice.id)
    return {
      ok: true,
      message: `Cancelled slice ${slice.key}.${dependents.length ? ` Blocked until you replan: ${dependents.join(", ")}.` : ""}`,
    }
  }

  // ── complete_mission ─────────────────────────────────────────────────────

  async completeMission(
    turn: SeatTurnIdentity,
    args: { mission: string; summary: string }
  ): Promise<MapResult> {
    const ctx = this.context(turn)
    if ("ok" in ctx) return ctx
    const refused = this.requireRight(ctx, "accept_proof")
    if (refused) return refused
    const mission = ctx.activeMission
    if (!mission || mission.key !== args.mission.trim())
      return fail(
        "not_active_mission",
        `Only the active mission${mission ? ` (${mission.key})` : ""} can be completed.`
      )
    const notDone = missionJudgeRefusal(mission)
    if (notDone) return fail("not_done", notDone)
    if (!args.summary.trim())
      return fail("bad_args", "complete_mission needs a summary of how the mission meets its definition of done.")
    initiatives.setMissionDodReview(
      mission.id,
      { by: turn.address, summary: args.summary.trim(), at: Date.now() },
      turn.address
    )
    if (!mission.integrationBranch) {
      try {
        await this.runtime.completeMission(mission.id)
      } catch (error) {
        return fail("complete_failed", message(error))
      }
      return { ok: true, message: `Mission ${mission.key} is complete.` }
    }
    return {
      ok: true,
      message: `Recorded your definition-of-done judgment. The user lands ${mission.integrationBranch} with the mission's ${mission.mergePolicy.mode.replace(/_/g, " ")} policy; the Navigator moves on once it lands.`,
    }
  }

  // ── plan changes ─────────────────────────────────────────────────────────

  private revisionBudget(ctx: SeatContext) {
    const limit = budgetLimit(ctx.initiative.budgets, "maxPlanRevisionsPerMission")
    const used = ctx.activeMission
      ? initiatives.countRevisions(ctx.initiative.id, ctx.activeMission.id, REVISE_OP)
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
      initiativeId: ctx.initiative.id,
      missionId: ctx.activeMission?.id ?? null,
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

    const scope = seatScopeRefusal(parsed, ctx.activeMission)
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
        `This mission has used its ${budget.limit} plan revisions.`
      )
    const mission = ctx.activeMission!
    const adds = parsed.reduce(
      (n, c) => n + (c.op === "add_slice" ? 1 : c.op === "split_slice" ? c.into.length : 0),
      0
    )
    const agentLimit = budgetLimit(ctx.initiative.budgets, "maxAgentSlicesPerMission")
    const agentSlices = initiatives.countSeatCreatedSlices(mission.id)
    if (adds && agentSlices + adds > agentLimit)
      return this.propose(
        ctx,
        turn,
        "revise_plan",
        parsed,
        reason,
        `Seats may add ${agentLimit} slices to a mission on their own and ${agentSlices} were added already.`
      )
    try {
      const result = applyPlanChanges({
        initiativeId: ctx.initiative.id,
        missionId: mission.id,
        changes: parsed,
        actor: turn.address,
        reason,
        origin: "agent",
      })
      initiatives.recordRevision(
        ctx.initiative.id,
        "mission",
        mission.id,
        REVISE_OP,
        { changes: result.applied },
        turn.address,
        reason
      )
      const used = budget.used + 1
      return {
        ok: true,
        message: [
          `Applied to ${mission.key}:`,
          ...result.applied.map((line) => `- ${line}`),
          `Plan revisions used: ${used} of ${budget.limit}.`,
        ].join("\n"),
      }
    } catch (error) {
      // The change set applies in one transaction, so nothing partial remains.
      return fail("invalid_change", `Nothing was changed. ${message(error)}`)
    }
  }

  proposeSlice(
    turn: SeatTurnIdentity,
    args: { mission?: string | null; slice: unknown; reason: string }
  ): MapResult {
    const ctx = this.context(turn)
    if ("ok" in ctx) return ctx
    const draft = parseSliceDraft(args.slice)
    if (typeof draft === "string") return fail("bad_args", draft)
    const missionKey = args.mission?.trim() || ctx.activeMission?.key
    if (!missionKey) return fail("bad_args", "Name the mission the slice belongs to.")
    if (!initiatives.listMissions(ctx.initiative.id).some((m) => m.key === missionKey))
      return fail("unknown_mission", `No mission "${missionKey}" in this initiative.`)
    if (!args.reason?.trim()) return fail("bad_args", "propose_slice needs a `reason`.")
    return this.propose(
      ctx,
      turn,
      "slice",
      [{ op: "add_slice", mission: missionKey, slice: draft }],
      args.reason.trim(),
      null
    )
  }

  proposePlan(
    turn: SeatTurnIdentity,
    args: { missions: unknown; reason?: string }
  ): MapResult {
    const ctx = this.context(turn)
    if ("ok" in ctx) return ctx
    if (!Array.isArray(args.missions) || !args.missions.length)
      return fail("bad_args", "propose_plan needs `missions`: at least one mission with its slices.")
    const changes: PlanChange[] = []
    for (const [index, value] of args.missions.entries()) {
      const draft = parseMissionDraft(value)
      if (typeof draft === "string") return fail("bad_args", `Mission ${index + 1}: ${draft}`)
      changes.push({ op: "add_mission", mission: draft })
    }
    return this.propose(
      ctx,
      turn,
      "plan",
      changes,
      args.reason?.trim() || "Initiative plan",
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

// Why a mission can't be judged done yet, or null: every slice must be
// merged (or cancelled) and the mission in review.
export function missionJudgeRefusal(mission: Mission): string | null {
  const open = initiatives
    .listSlices(mission.id)
    .filter((s) => s.status !== "done" && s.status !== "cancelled")
  if (open.length)
    return `Mission ${mission.key} still has unfinished slices: ${open.map((s) => `${s.key} (${s.status})`).join(", ")}.`
  if (mission.status !== "review")
    return `Mission ${mission.key} is ${mission.status}; it can be completed once every slice has merged.`
  return null
}

// The user's definition-of-done judgment (when the lead doesn't hold
// accept_proof, or the user decides first). A mission with nothing to land is
// completed; one with an integration branch then waits for its landing.
export async function judgeMissionDone(
  missionId: string,
  summary: string,
  complete: (missionId: string) => Promise<void>
): Promise<void> {
  const mission = initiatives.getMission(missionId)
  if (!mission) throw new Error("That mission no longer exists.")
  const refusal = missionJudgeRefusal(mission)
  if (refusal) throw new Error(refusal)
  initiatives.setMissionDodReview(
    mission.id,
    { by: "user", summary: summary.trim() || "Judged done by the user.", at: Date.now() },
    "user"
  )
  if (!mission.integrationBranch) await complete(mission.id)
}

// ── the user's side of proposals ────────────────────────────────────────────

function proposalInput(proposal: PlanProposal, by: string) {
  const initiative = initiatives.getInitiative(proposal.initiativeId)
  if (!initiative) throw new Error("The initiative no longer exists.")
  if (["completed", "cancelled"].includes(initiative.status))
    throw new Error(`The initiative is ${initiative.status}; its plan can't change.`)
  // The proposal's mission may have finished since; slice ops then target the
  // current active mission only if the change named no mission.
  const missionId =
    proposal.missionId &&
    !["completed", "cancelled"].includes(initiatives.getMission(proposal.missionId)?.status ?? "cancelled")
      ? proposal.missionId
      : (activeMissionOf(initiative.id)?.id ?? null)
  return {
    initiativeId: initiative.id,
    missionId,
    changes: proposal.changes,
    actor: by,
    reason: `Applied ${proposal.kind === "plan" ? "the planning proposal" : "a proposal"} from ${proposal.proposer}${proposal.reason ? `: ${proposal.reason}` : ""}`,
    origin: (proposal.proposer.includes("@") && !proposal.proposer.endsWith("@rig")
      ? "agent"
      : "user") as WorkSlice["origin"],
  }
}

// Which of a pending proposal's changes no longer apply to the plan as it is
// now (e.g. an edit to a slice that has started since), without changing
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
      `The user rejected your ${resolved.kind === "plan" ? "planning proposal" : "proposal"}${note.trim() ? `: ${note.trim()}` : "."}`,
      "",
      "It proposed:",
      ...resolved.changes.map((change) => `- ${describePlanChange(change)}`),
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

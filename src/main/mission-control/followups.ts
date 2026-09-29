import * as features from "../db/repositories/features"
import * as proposalsRepo from "../db/repositories/proposals"
import type { PlanProposal } from "../db/types"
import {
  describePlanChange,
  type FollowupAltitude,
  type FollowupTarget,
  type PlanChange,
  type ProposalFollowup,
} from "../../shared/mission-control/plan-changes"
import { activeMilestoneOf } from "./map-tools"
import { applyPlanChanges } from "./plan-edits"
import type { SeatTurnIdentity } from "./seat-turns"

// Follow-up proposals (plan 106.7): a place for a good idea that is out of
// scope, so the "should the doghouse have a light?" instinct gets recorded
// instead of built. Any working seat may propose one; it changes nothing until
// the user applies it, and then it lands in a later milestone by default —
// never the milestone in flight without the user choosing it explicitly.

export const FOLLOWUP_RECORDED =
  "Recorded as a follow-up for the user and your lead. Continue with your current work; do not build it."

const ALTITUDES: readonly FollowupAltitude[] = [
  "user_story",
  "milestone",
  "feature",
]
const TITLE_MAX = 120
const RATIONALE_MAX = 1200

export type FollowupResult =
  | { ok: true; message: string; proposal: PlanProposal }
  | { ok: false; code: string; message: string }

function altitudeOf(value: unknown): FollowupAltitude | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : ""
  // Accept the plan's older words for the same altitudes.
  const mapped =
    raw === "slice"
      ? "user_story"
      : raw === "mission"
        ? "milestone"
        : raw === "initiative"
          ? "feature"
          : raw
  return ALTITUDES.includes(mapped as FollowupAltitude)
    ? (mapped as FollowupAltitude)
    : null
}

export function proposeFollowup(
  turn: SeatTurnIdentity,
  args: { title?: unknown; rationale?: unknown; suggested_altitude?: unknown }
): FollowupResult {
  const feature = features.getFeature(turn.featureId)
  if (!feature)
    return {
      ok: false,
      code: "unavailable",
      message: "This feature is no longer available.",
    }
  const title =
    typeof args.title === "string" ? args.title.replace(/\s+/g, " ").trim() : ""
  const rationale =
    typeof args.rationale === "string" ? args.rationale.trim() : ""
  if (!title)
    return {
      ok: false,
      code: "bad_args",
      message: "propose_followup needs a short `title`.",
    }
  if (!rationale)
    return {
      ok: false,
      code: "bad_args",
      message:
        "propose_followup needs a `rationale`: why it's worth doing later.",
    }
  const altitude = altitudeOf(args.suggested_altitude) ?? "user_story"

  let anchor: ProposalFollowup["anchor"] = null
  let milestoneId: string | null = null
  if (turn.anchor?.kind === "user_story") {
    const userStory = features.getUserStory(turn.anchor.id)
    if (userStory) {
      anchor = { kind: "user_story", id: userStory.id, key: userStory.key }
      milestoneId = userStory.milestoneId
    }
  } else if (turn.anchor?.kind === "milestone") {
    const milestone = features.getMilestone(turn.anchor.id)
    if (milestone) {
      anchor = { kind: "milestone", id: milestone.id, key: milestone.key }
      milestoneId = milestone.id
    }
  }
  milestoneId ??= activeMilestoneOf(feature.id)?.id ?? null

  const duplicate = proposalsRepo
    .listProposals(feature.id, "pending")
    .find(
      (p) =>
        p.kind === "followup" &&
        p.followup?.title.toLowerCase() ===
          title.slice(0, TITLE_MAX).toLowerCase()
    )
  if (duplicate)
    return {
      ok: true,
      message: `${FOLLOWUP_RECORDED} (It was already recorded.)`,
      proposal: duplicate,
    }

  const proposal = proposalsRepo.createProposal({
    featureId: feature.id,
    milestoneId,
    kind: "followup",
    changes: [],
    proposer: turn.address,
    reason: rationale.slice(0, RATIONALE_MAX),
    followup: {
      title: title.slice(0, TITLE_MAX),
      rationale: rationale.slice(0, RATIONALE_MAX),
      altitude,
      anchor,
    },
  })
  return { ok: true, message: FOLLOWUP_RECORDED, proposal }
}

// Where an accepted follow-up lands unless the user picks otherwise: the first
// planned milestone after the one it came from, else a new milestone.
export function defaultFollowupTarget(proposal: PlanProposal): FollowupTarget {
  const milestones = features.listMilestones(proposal.featureId)
  const origin = proposal.milestoneId
    ? milestones.find((m) => m.id === proposal.milestoneId)
    : null
  const later = milestones.find(
    (m) =>
      m.status === "planned" &&
      m.id !== proposal.milestoneId &&
      (!origin || m.position > origin.position)
  )
  if (proposal.followup?.altitude !== "user_story" || !later)
    return { kind: "milestone" }
  return { kind: "user_story", milestone: later.key }
}

// The plan changes a follow-up becomes at a target.
export function followupChanges(
  proposal: PlanProposal,
  target: FollowupTarget
): PlanChange[] {
  const followup = proposal.followup
  if (!followup) throw new Error("That proposal is not a follow-up.")
  const notes = [
    followup.rationale,
    `Proposed by ${proposal.proposer}${followup.anchor ? ` while working on ${followup.anchor.kind.replace("_", " ")} ${followup.anchor.key}` : ""}.`,
  ].join("\n\n")
  const userStory = { title: followup.title, goal: followup.title, notes }
  if (target.kind === "user_story")
    return [{ op: "add_user_story", milestone: target.milestone, userStory }]
  return [
    {
      op: "add_milestone",
      milestone: {
        name: followup.title,
        outcome: followup.rationale.split("\n")[0].slice(0, 300),
        userStories: [userStory],
      },
    },
  ]
}

// Apply a follow-up (the user). Landing it in the milestone in flight needs
// `allowCurrent`: the default is always a later milestone.
export function applyFollowup(
  id: string,
  target: FollowupTarget | null,
  options: { by?: string; allowCurrent?: boolean } = {}
): PlanProposal {
  const proposal = proposalsRepo.getProposal(id)
  if (!proposal || proposal.kind !== "followup")
    throw new Error("That follow-up no longer exists.")
  if (proposal.status !== "pending")
    throw new Error(`That follow-up was already ${proposal.status}.`)
  const chosen = target ?? defaultFollowupTarget(proposal)
  const active = activeMilestoneOf(proposal.featureId)
  if (chosen.kind === "user_story") {
    const milestone = features
      .listMilestones(proposal.featureId)
      .find((m) => m.key === chosen.milestone)
    if (!milestone)
      throw new Error(`No milestone "${chosen.milestone}" in this feature.`)
    if (["completed", "cancelled"].includes(milestone.status))
      throw new Error(`Milestone ${milestone.key} is ${milestone.status}.`)
    if (active && milestone.id === active.id && !options.allowCurrent)
      throw new Error(
        `Milestone ${milestone.key} is in flight. Choose it explicitly to add the follow-up to the current milestone.`
      )
  }
  const changes = followupChanges(proposal, chosen)
  const by = options.by ?? "user"
  applyPlanChanges({
    featureId: proposal.featureId,
    milestoneId: active?.id ?? proposal.milestoneId,
    changes,
    actor: by,
    reason: `Follow-up from ${proposal.proposer}: ${proposal.followup!.title}`,
    // The user chose where it lands, so it doesn't spend the seats' budget.
    origin: "user",
  })
  proposalsRepo.setProposalChanges(id, changes)
  const resolved = proposalsRepo.resolveProposal(
    id,
    "applied",
    by,
    changes.map(describePlanChange).join("; ")
  )
  if (!resolved) throw new Error("That follow-up was resolved by someone else.")
  return resolved
}

// For the milestone review (after_all_user_stories): the follow-ups seats
// recorded while building the milestone, so the lead weighs them.
export function renderFollowupsForReview(
  featureId: string,
  milestoneId: string
): string | null {
  const pending = proposalsRepo.listPendingFollowups(featureId, milestoneId)
  if (!pending.length) return null
  return [
    `## Follow-ups proposed during this milestone (${pending.length})`,
    "Seats recorded these out-of-scope ideas instead of building them. They wait for the user; none is part of this milestone. In your review, say which deserve a later user story or milestone and which to drop, and why.",
    ...pending.map(
      (p) =>
        `- "${p.followup!.title}" (${p.followup!.altitude.replace("_", " ")}, from ${p.proposer}${p.followup!.anchor ? ` on ${p.followup!.anchor.key}` : ""}): ${p.followup!.rationale.replace(/\s+/g, " ").slice(0, 300)}`
    ),
  ].join("\n")
}

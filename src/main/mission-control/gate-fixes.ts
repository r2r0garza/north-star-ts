import * as features from "../db/repositories/features"
import { recordEvent } from "../db/repositories/mc-events"
import * as proposalsRepo from "../db/repositories/proposals"
import * as waveGates from "../db/repositories/wave-gates"
import { getWorkspace } from "../db/repositories/workspaces"
import type {
  Feature,
  GateCriterionResult,
  GateEscalation,
  GateEscalationAction,
  GateFix,
  Milestone,
  UserStory,
  UserStoryFixTarget,
  WaveGate,
  WaveGateReport,
} from "../db/types"
import { budgetLimit } from "../../shared/mission-control/budgets"
import { userStoryRef } from "../../shared/mission-control/checks"
import type {
  PlanChange,
  UserStoryDraft,
} from "../../shared/mission-control/plan-changes"
import { DEFAULT_CHECKS_DIR } from "../../shared/mission-control/checks"
import { isWaveGateReport } from "./gate-record"
import { applyPlanChanges } from "./plan-edits"

// Fix stories and the fix-round cap (plan 110.03, decisions 8 and 9). When a
// gate finishes, every app_bug becomes a follow-up user story in the
// milestone: applied at once in Copilot and Autopilot (a repair, not scope),
// proposed in Manual. The bug is counted against the criterion it traces back
// to — a fix story's bug is its original's — and once that criterion has had
// maxGateFixRounds fix stories, the gate asks the user instead: accept it as
// is, fix it yourself, or drop the criterion.

export const GATE_PROPOSER = "acceptance-gate"

export type FixRoot = UserStoryFixTarget & { key: string }

const sameRoot = (a: UserStoryFixTarget, b: UserStoryFixTarget) =>
  a.userStoryId === b.userStoryId && a.criterion === b.criterion

// The criterion a gate result traces back to: a fix story's bug is its
// original story's criterion; anything else is its own.
export function fixRootOf(
  story: UserStory,
  criterionId: string,
  criterion: string
): FixRoot {
  if (story.fixes) {
    const original = features.getUserStory(story.fixes.userStoryId)
    if (original)
      return {
        ...story.fixes,
        // The original's current id for the same words, if it was renumbered.
        criterionId:
          idOfText(original, story.fixes.criterion) ?? story.fixes.criterionId,
        key: original.key,
      }
  }
  return { userStoryId: story.id, criterionId, criterion, key: story.key }
}

function idOfText(story: UserStory, text: string): string | null {
  const index = story.spec.acceptance.indexOf(text)
  return index < 0 ? null : `AC-${index + 1}`
}

// ── waivers ─────────────────────────────────────────────────────────────────

export interface GateWaiver {
  userStoryId: string
  criterion: string
  note: string
  gateRound: number
}

// Criteria the user accepted as is at one of the feature's gates. Matched by
// the criterion's words, so a later renumbering doesn't move a waiver.
export function gateWaivers(
  featureId: string,
  exceptGateId?: string
): GateWaiver[] {
  const waivers: GateWaiver[] = []
  for (const gate of waveGates.listFeatureWaveGates(featureId)) {
    if (gate.id === exceptGateId || !isWaveGateReport(gate.report)) continue
    for (const escalation of gate.report.escalations ?? [])
      if (escalation.resolution?.action === "accept")
        waivers.push({
          userStoryId: escalation.root.userStoryId,
          criterion: escalation.root.criterion,
          note: escalation.resolution.note,
          gateRound: gate.round,
        })
  }
  return waivers
}

// The ids of a story's waived criteria, as the story reads now.
export function waivedCriteria(
  story: UserStory,
  waivers: readonly GateWaiver[]
): string[] {
  return story.spec.acceptance.flatMap((text, index) =>
    waivers.some((w) => w.userStoryId === story.id && w.criterion === text)
      ? [`AC-${index + 1}`]
      : []
  )
}

// ── fix rounds ──────────────────────────────────────────────────────────────

// How many earlier gates of the feature turned this root's bug into a fix
// story (or proposed one).
export function fixRoundsSpent(
  featureId: string,
  root: UserStoryFixTarget,
  exceptGateId: string
): number {
  let rounds = 0
  for (const gate of waveGates.listFeatureWaveGates(featureId)) {
    if (gate.id === exceptGateId || !isWaveGateReport(gate.report)) continue
    if ((gate.report.fixes ?? []).some((fix) => sameRoot(fix.root, root)))
      rounds++
  }
  return rounds
}

// The most fix rounds any one criterion has needed at a milestone's gates,
// for the budget meter.
export function maxFixRoundsUsed(milestoneId: string): number {
  const counts = new Map<string, number>()
  for (const gate of waveGates.listWaveGates(milestoneId)) {
    if (!isWaveGateReport(gate.report)) continue
    const roots = new Set(
      (gate.report.fixes ?? []).map(
        (fix) => `${fix.root.userStoryId}\0${fix.root.criterion}`
      )
    )
    for (const root of roots) counts.set(root, (counts.get(root) ?? 0) + 1)
  }
  return Math.max(0, ...counts.values())
}

export function maxGateFixRounds(feature: Feature): number {
  return budgetLimit(feature.budgets, "maxGateFixRounds")
}

// ── turning app_bugs into fix stories ───────────────────────────────────────

function checksDirOf(feature: Feature): string {
  const workspace = feature.workspaceId
    ? getWorkspace(feature.workspaceId)
    : null
  return workspace?.missionControl.checksDir ?? DEFAULT_CHECKS_DIR
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

function fixKey(rootKey: string, criterionId: string): string {
  const suffix = `-${criterionId.toLowerCase().replace(/[^a-z0-9]+/g, "")}`
  const base = `fix-${rootKey}`.slice(0, 32 - suffix.length).replace(/-+$/, "")
  return `${base}${suffix}`
}

interface Bug {
  story: UserStory
  result: GateCriterionResult
  root: FixRoot
}

function fixDraft(input: {
  feature: Feature
  milestone: Milestone
  gate: WaveGate
  bug: Bug
}): UserStoryDraft {
  const { feature, gate, bug } = input
  const { root, result } = bug
  const rootStory = features.getUserStory(root.userStoryId) ?? bug.story
  const rootMilestone = features.getMilestone(rootStory.milestoneId)
  const ref = userStoryRef({
    featureKey: feature.key,
    milestoneKey: rootMilestone?.key ?? input.milestone.key,
    userStoryKey: rootStory.key,
  })
  const checksDir = checksDirOf(feature)
  const failing = result.checks.filter((c) => c.status === "failed")
  const checkIds = (failing.length ? failing : result.checks).map(
    (c) => c.checkId
  )
  const problem = result.problem ?? "the app doesn't meet the criterion"
  const acceptance = [
    root.criterion,
    checkIds.length
      ? `The acceptance gate's ${checkIds.length === 1 ? "check" : "checks"} ${checkIds.map((id) => `\`${id}\``).join(", ")} for ${root.key} ${root.criterionId} ${checkIds.length === 1 ? "passes" : "pass"} on the integrated app.`
      : `The acceptance gate confirms ${root.key} ${root.criterionId} in the running integrated app.`,
  ]
  const via =
    bug.story.id === root.userStoryId
      ? ""
      : ` (it showed up on fix story ${bug.story.key} ${result.id})`
  const notes = [
    `Acceptance gate round ${gate.round} found ${root.key} ${root.criterionId} broken on the integration branch${via}: ${problem}`,
    `What QA observed: ${result.evidence}`,
    result.checks.length
      ? `Checks: ${result.checks.map((c) => `${c.checkId} (${c.status})`).join(", ")}.`
      : "",
    `The gate committed its suite to the integration branch, so this worktree has it in \`${checksDir}/\`: the manifest \`${checksDir}/stories/${ref}.json\` maps ${root.criterionId} to its checks, tagged \`@${ref} @${root.criterionId}\`. Run them to reproduce the failure, and again when it's fixed.`,
    "Fix the app, not the checks: they're the contract the next gate runs. If a check asserts something the criterion doesn't ask for, say so in your proof; QA corrects over-specified checks at the gate.",
  ]
    .filter(Boolean)
    .join("\n\n")
  return {
    key: fixKey(root.key, root.criterionId),
    title: oneLine(`Fix ${root.key} ${root.criterionId}: ${problem}`, 100),
    goal: `Make ${root.key}'s ${root.criterionId} hold in the integrated app: ${oneLine(problem, 300)}`,
    acceptance,
    outOfScope: [
      `Editing the acceptance suite in \`${checksDir}/\`.`,
      `Other criteria of ${root.key}, unless fixing this one breaks them.`,
    ],
    touchHints: [...rootStory.spec.touchHints],
    notes,
    ...(rootStory.podKey ? { pod: rootStory.podKey } : {}),
    fix: {
      gateId: gate.id,
      target: {
        userStoryId: root.userStoryId,
        criterionId: root.criterionId,
        criterion: root.criterion,
      },
    },
  }
}

export interface GateFollowups {
  fixes: GateFix[]
  escalations: GateEscalation[]
}

// Inside the gate's conclusion transaction: every app_bug becomes a fix story
// (proposed in Manual), or, past the cap, an escalation. One per root
// criterion, however many stories it showed up on.
export function createGateFollowups(input: {
  feature: Feature
  milestone: Milestone
  gate: WaveGate
  report: WaveGateReport
}): GateFollowups {
  const { feature, milestone, gate, report } = input
  const cap = maxGateFixRounds(feature)
  const bugs = new Map<string, Bug>()
  for (const story of report.stories) {
    const userStory = features.getUserStory(story.userStoryId)
    if (!userStory || userStory.status === "cancelled") continue
    for (const result of story.criteria) {
      if (result.outcome !== "app_bug" || result.waived) continue
      const text =
        result.text ??
        userStory.spec.acceptance[Number(result.id.replace(/^AC-/, "")) - 1] ??
        result.id
      const root = fixRootOf(userStory, result.id, text)
      const id = `${root.userStoryId}\0${root.criterion}`
      // The original's own failure says the most; prefer it.
      if (!bugs.has(id) || userStory.id === root.userStoryId)
        bugs.set(id, { story: userStory, result, root })
    }
  }
  const fixes: GateFix[] = []
  const escalations: GateEscalation[] = []
  const drafts: UserStoryDraft[] = []
  for (const bug of bugs.values()) {
    const spent = fixRoundsSpent(feature.id, bug.root, gate.id)
    if (spent >= cap) {
      escalations.push({
        id: `${bug.root.userStoryId}:${bug.root.criterionId}:${gate.round}`,
        root: bug.root,
        rounds: spent,
        problem: bug.result.problem ?? "",
        evidence: bug.result.evidence,
        checks: bug.result.checks,
        ...(bug.result.artifacts ? { artifacts: bug.result.artifacts } : {}),
      })
      continue
    }
    const draft = fixDraft({ feature, milestone, gate, bug })
    drafts.push(draft)
    fixes.push({
      userStoryId: bug.story.id,
      key: bug.story.key,
      criterionId: bug.result.id,
      root: bug.root,
      fixRound: spent + 1,
      fixStoryId: null,
      fixStoryKey: null,
      proposalId: null,
    })
  }
  if (!drafts.length) return { fixes, escalations }
  const changes: PlanChange[] = drafts.map((userStory) => ({
    op: "add_user_story",
    milestone: milestone.key,
    userStory,
  }))
  const reason = `Acceptance gate round ${gate.round} for ${milestone.key} found ${drafts.length} app bug${drafts.length === 1 ? "" : "s"}: ${fixes.map((f) => `${f.root.key} ${f.root.criterionId}`).join(", ")}.`
  const propose = (why: string) => {
    const proposal = proposalsRepo.createProposal({
      featureId: feature.id,
      milestoneId: milestone.id,
      kind: "user_story",
      changes,
      proposer: GATE_PROPOSER,
      reason: `${reason} ${why}`,
    })
    for (const fix of fixes) fix.proposalId = proposal.id
  }
  if (feature.driveMode === "manual") {
    propose(
      "Apply to add the fix stories; they run before anything else in the milestone."
    )
    return { fixes, escalations }
  }
  let created: string[]
  try {
    created = applyPlanChanges({
      featureId: feature.id,
      milestoneId: milestone.id,
      changes,
      actor: GATE_PROPOSER,
      reason,
      origin: "gate",
    }).createdUserStoryIds
  } catch (error) {
    // Never leave the gate unfinished: the user applies them instead.
    propose(
      `Adding them automatically failed (${error instanceof Error ? error.message : String(error)}); apply to add them.`
    )
    return { fixes, escalations }
  }
  created.forEach((id, index) => {
    const story = features.getUserStory(id)
    fixes[index].fixStoryId = id
    fixes[index].fixStoryKey = story?.key ?? null
  })
  return { fixes, escalations }
}

// ── the gate's state from durable rows ──────────────────────────────────────

// Fix stories a gate created (directly, or through an applied proposal).
export function gateFixStories(gate: WaveGate): UserStory[] {
  return features
    .listUserStories(gate.milestoneId)
    .filter((story) => story.gateId === gate.id)
}

// The gate's Manual proposal that is still waiting for the user.
export function pendingFixProposal(gate: WaveGate): string | null {
  if (!isWaveGateReport(gate.report)) return null
  const ids = new Set(
    (gate.report.fixes ?? []).flatMap((fix) =>
      fix.proposalId ? [fix.proposalId] : []
    )
  )
  for (const id of ids)
    if (proposalsRepo.getProposal(id)?.status === "pending") return id
  return null
}

export function openEscalations(gate: WaveGate): GateEscalation[] {
  if (gate.status !== "escalated" || !isWaveGateReport(gate.report)) return []
  return (gate.report.escalations ?? []).filter((e) => !e.resolution)
}

// ── the user's decision on an escalation ────────────────────────────────────

export interface EscalationOutcome {
  gate: WaveGate
  // "I'll fix it": the feature pauses until the user resumes it.
  pause: string | null
}

const SETTLED = new Set<UserStory["status"]>(["done", "merged", "cancelled"])

// Whether every criterion of a story passed at this gate, reading it as it
// is now: waived and dropped criteria don't count.
function storyClearAt(
  story: UserStory,
  report: WaveGateReport,
  waivers: readonly GateWaiver[]
): boolean {
  const entry = report.stories.find((s) => s.userStoryId === story.id)
  const current = new Set(story.spec.acceptance)
  const waived = new Set(
    waivers.filter((w) => w.userStoryId === story.id).map((w) => w.criterion)
  )
  const textOf = (c: GateCriterionResult) =>
    c.text ?? story.spec.acceptance[Number(c.id.replace(/^AC-/, "")) - 1]
  if (!entry) return false
  // Every criterion the story still has was triaged here.
  const triaged = new Set(entry.criteria.map(textOf))
  for (const text of current)
    if (!triaged.has(text) && !waived.has(text)) return false
  return entry.criteria.every((c) => {
    const text = textOf(c)
    if (!text || !current.has(text) || waived.has(text)) return true
    return c.outcome === "passed" || c.outcome === "check_fixed"
  })
}

export function resolveGateEscalation(input: {
  gateId: string
  escalationId: string
  action: GateEscalationAction
  note?: string
  by?: string
}): EscalationOutcome {
  const by = input.by ?? "user"
  const note = input.note?.trim() ?? ""
  const gate = waveGates.getWaveGate(input.gateId)
  if (!gate) throw new Error("That acceptance gate no longer exists.")
  if (gate.status !== "escalated" || !isWaveGateReport(gate.report))
    throw new Error(
      `Acceptance gate round ${gate.round} isn't waiting on a decision.`
    )
  const report = gate.report
  const escalation = (report.escalations ?? []).find(
    (e) => e.id === input.escalationId
  )
  if (!escalation) throw new Error("That escalation isn't on this gate.")
  if (escalation.resolution)
    throw new Error("That escalation was already decided.")
  const root = features.getUserStory(escalation.root.userStoryId)
  if (!root)
    throw new Error(`User story ${escalation.root.key} no longer exists.`)
  const milestone = features.getMilestone(gate.milestoneId)!
  const label = `${escalation.root.key} ${escalation.root.criterionId}`
  const resolution = { action: input.action, note, by, at: Date.now() }

  if (input.action === "drop") {
    const index = root.spec.acceptance.indexOf(escalation.root.criterion)
    if (index < 0)
      throw new Error(`${label} isn't one of ${root.key}'s criteria anymore.`)
    features.setUserStoryExecution(
      root.id,
      {
        spec: {
          ...root.spec,
          acceptance: root.spec.acceptance.filter((_, i) => i !== index),
        },
      },
      `Dropped ${label} at acceptance gate round ${gate.round}${note ? `: ${note}` : ""}`,
      by
    )
  }

  const escalations = (report.escalations ?? []).map((e) =>
    e.id === escalation.id ? { ...e, resolution } : e
  )
  const updated: WaveGateReport = { ...report, escalations }
  const waivers = [
    ...gateWaivers(milestone.featureId, gate.id),
    ...escalations
      .filter((e) => e.resolution?.action === "accept")
      .map((e) => ({
        userStoryId: e.root.userStoryId,
        criterion: e.root.criterion,
        note: e.resolution!.note,
        gateRound: gate.round,
      })),
  ]

  // Accepting or dropping the criterion settles the fix stories that were
  // chasing it; "I'll fix it" leaves them to the next gate.
  if (input.action !== "user_fix")
    for (const story of features.listUserStories(gate.milestoneId))
      if (
        story.status === "merged" &&
        story.fixes &&
        sameRoot(story.fixes, escalation.root)
      )
        features.setUserStoryExecution(
          story.id,
          { status: "done" },
          `${input.action === "accept" ? "Accepted as is" : "Dropped"}: ${label} at acceptance gate round ${gate.round}`,
          by
        )
  // A merged story whose criteria all hold now, the accepted one included, is
  // done. Dropping a criterion re-runs the gate (QA brings the story's
  // manifest in line with its criteria), and so does "I'll fix it".
  if (input.action === "accept") {
    const story = features.getUserStory(root.id)!
    if (story.status === "merged" && storyClearAt(story, updated, waivers))
      features.setUserStoryExecution(
        story.id,
        { status: "done" },
        `Passed acceptance gate round ${gate.round} with ${label} ${input.action === "accept" ? "accepted as is" : "dropped"}`,
        by
      )
  }

  const open = escalations.some((e) => !e.resolution)
  let next: WaveGate["status"] = "escalated"
  if (!open) {
    const stories = features.listUserStories(gate.milestoneId)
    const unsettledFix = stories.some(
      (s) => s.gateId === gate.id && !SETTLED.has(s.status)
    )
    const held = gate.storyIds.some(
      (id) => stories.find((s) => s.id === id)?.status === "merged"
    )
    const rerun = escalations.some((e) => e.resolution?.action !== "accept")
    next =
      unsettledFix || held || rerun || pendingFixProposal(gate)
        ? "fixing"
        : "passed"
  }
  const saved =
    next === "escalated"
      ? waveGates.setWaveGateReport(gate.id, updated, ["escalated"])
      : waveGates.finishWaveGate(gate.id, next, { report: updated }, [
          "escalated",
        ])
  if (!saved) throw new Error("That gate changed while you decided. Try again.")
  // Health's proof-polishing count for the story starts over (plan 110.05).
  recordEvent({
    featureId: milestone.featureId,
    type: "user_decision",
    milestoneId: milestone.id,
    userStoryId: root.id,
    refId: `${gate.id}:${escalation.id}`,
  })
  return {
    gate: saved,
    pause:
      input.action === "user_fix"
        ? `You're fixing ${label} yourself. Resume when it's fixed: the acceptance gate for ${milestone.key} runs again.`
        : null,
  }
}

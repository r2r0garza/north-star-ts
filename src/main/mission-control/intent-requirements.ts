import * as features from "../db/repositories/features"
import type { Feature, UserStory } from "../db/types"
import type { MilestoneDraft, PlanChange } from "../../shared/mission-control/plan-changes"

// What the user's feature intent commits the plan to, read deterministically
// from its text (no model call). The intent is the source of truth: a plan
// must trace every listed requirement to acceptance criteria, stay inside the
// limits it states, and a milestone is only judged done against it.
//
// Requirements are the intent's list items (numbered or bulleted, with their
// indented continuation lines). An intent written as prose has none, and the
// checks built on them don't apply.

export interface IntentRequirement {
  // R1, R2, ... in the order they appear.
  id: string
  text: string
}

export interface PlanLimits {
  maxMilestones?: number
  // Across the whole feature.
  maxUserStories?: number
  maxUserStoriesPerMilestone?: number
}

const ITEM = /^\s*(?:\d{1,3}[.)]|[-*•])\s+(.*)$/

export function extractRequirements(intent: string): IntentRequirement[] {
  const items: string[] = []
  let current: string[] | null = null
  const flush = () => {
    const text = current?.join(" ").replace(/\s+/g, " ").trim()
    if (text) items.push(text)
    current = null
  }
  for (const line of intent.split(/\r?\n/)) {
    const item = ITEM.exec(line)
    if (item) {
      flush()
      current = [item[1]]
    } else if (current && line.trim() && /^\s+/.test(line)) {
      current.push(line.trim())
    } else {
      flush()
    }
  }
  flush()
  return items.map((text, index) => ({ id: `R${index + 1}`, text }))
}

const NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
}

const LIMIT =
  /\b(at most|no more than|up to|a maximum of|maximum of|max(?:imum)?|keep it to|keep this to|limit(?:ed)? to|only|just|exactly|a single|single)\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(milestones?|user[- ]stor(?:y|ies)|stor(?:y|ies))\b/gi
const PER_MILESTONE = /^\s*(?:per|each|in each|for each|in every|every|a)\s+milestone\b/i

export function extractPlanLimits(intent: string): PlanLimits {
  const limits: PlanLimits = {}
  const lower = (key: keyof PlanLimits, value: number) => {
    limits[key] = Math.min(limits[key] ?? Number.POSITIVE_INFINITY, value)
  }
  for (const match of intent.matchAll(LIMIT)) {
    const [whole, phrase, count, noun] = match
    const value = count
      ? (NUMBERS[count.toLowerCase()] ?? Number(count))
      : /single/i.test(phrase)
        ? 1
        : null
    if (!value || !Number.isInteger(value)) continue
    if (/^milestone/i.test(noun)) {
      lower("maxMilestones", value)
      continue
    }
    const after = intent.slice(match.index + whole.length, match.index + whole.length + 30)
    lower(PER_MILESTONE.test(after) ? "maxUserStoriesPerMilestone" : "maxUserStories", value)
  }
  return limits
}

export function describeLimits(limits: PlanLimits): string[] {
  return [
    ...(limits.maxMilestones !== undefined ? [`at most ${limits.maxMilestones} milestone(s)`] : []),
    ...(limits.maxUserStories !== undefined
      ? [`at most ${limits.maxUserStories} user stories in the whole feature`]
      : []),
    ...(limits.maxUserStoriesPerMilestone !== undefined
      ? [`at most ${limits.maxUserStoriesPerMilestone} user stories per milestone`]
      : []),
  ]
}

// The intent in full plus what's read from it, for hook objectives. The
// intent chain clips the intent to stay small; planning and review need all of it.
export function renderIntentRequirements(feature: Feature): string[] {
  const requirements = extractRequirements(feature.intent)
  const limits = describeLimits(extractPlanLimits(feature.intent))
  return [
    "",
    "## The feature's intent, in full",
    feature.intent.trim() || "(no intent stated)",
    ...(requirements.length
      ? [
          "",
          "## Requirements from the intent",
          "Every requirement must be delivered and verified by some user story's acceptance criteria. Cite them by id.",
          ...requirements.map((r) => `- **${r.id}**: ${r.text}`),
        ]
      : []),
    ...(limits.length
      ? [
          "",
          "## Plan limits from the intent",
          "Hard limits: Mission Control refuses a plan or change that exceeds them (acceptance-gate fix stories don't count).",
          ...limits.map((line) => `- ${line}`),
        ]
      : []),
  ]
}

// Stories that count toward the intent's limits: planned work, not gate fixes.
function counted(story: UserStory): boolean {
  return story.status !== "cancelled" && story.origin !== "gate"
}

function draftCount(milestone: MilestoneDraft): number {
  return milestone.userStories?.length ?? 0
}

// Why a whole proposed plan exceeds the intent's limits, or null.
export function planLimitRefusal(intent: string, milestones: MilestoneDraft[]): string | null {
  const limits = extractPlanLimits(intent)
  if (limits.maxMilestones !== undefined && milestones.length > limits.maxMilestones)
    return `The intent allows at most ${limits.maxMilestones} milestone(s); this plan has ${milestones.length}.`
  const total = milestones.reduce((n, m) => n + draftCount(m), 0)
  if (limits.maxUserStories !== undefined && total > limits.maxUserStories)
    return `The intent allows at most ${limits.maxUserStories} user stories; this plan has ${total}. Merge stories (a story can carry several acceptance criteria) rather than splitting them.`
  const per = limits.maxUserStoriesPerMilestone
  const over = per === undefined ? undefined : milestones.find((m) => draftCount(m) > per)
  if (over)
    return `The intent allows at most ${per} user stories per milestone; ${over.name} has ${draftCount(over)}.`
  return null
}

// Why a change set would take the feature past the intent's limits, or null.
// Measured against the plan as it is now.
export function changeLimitRefusal(
  feature: Feature,
  milestoneId: string | null,
  changes: PlanChange[]
): string | null {
  const limits = extractPlanLimits(feature.intent)
  if (!describeLimits(limits).length) return null
  const milestones = features
    .listMilestones(feature.id)
    .filter((m) => m.status !== "cancelled")
  const byKey = new Map(milestones.map((m) => [m.key, m]))
  const stories = new Map(
    milestones.map((m) => [m.id, features.listUserStories(m.id).filter(counted).length])
  )
  let milestoneCount = milestones.length
  for (const change of changes) {
    if (change.op === "add_milestone") {
      milestoneCount += 1
      stories.set(`new:${milestoneCount}`, draftCount(change.milestone))
      continue
    }
    const target =
      change.op === "add_user_story"
        ? (change.milestone ? byKey.get(change.milestone)?.id : milestoneId)
        : milestoneId
    if (!target) continue
    // A split cancels one story and adds the rest.
    const added =
      change.op === "add_user_story" ? 1 : change.op === "split_user_story" ? change.into.length - 1 : 0
    if (added) stories.set(target, (stories.get(target) ?? 0) + added)
  }
  if (limits.maxMilestones !== undefined && milestoneCount > limits.maxMilestones)
    return `The intent allows at most ${limits.maxMilestones} milestone(s); this change makes ${milestoneCount}.`
  const total = [...stories.values()].reduce((n, c) => n + c, 0)
  if (limits.maxUserStories !== undefined && total > limits.maxUserStories)
    return `The intent allows at most ${limits.maxUserStories} user stories; this change makes ${total}. Fold the work into an existing not-started story's acceptance criteria (edit_user_story) instead.`
  const per = limits.maxUserStoriesPerMilestone
  if (per !== undefined && [...stories.values()].some((c) => c > per))
    return `The intent allows at most ${per} user stories per milestone; this change exceeds it.`
  return null
}

// ── coverage: requirement → acceptance criteria ─────────────────────────────

export interface CoverageEntry {
  requirement: string
  userStory: string
  criteria: number[]
}

export function parseCoverage(value: unknown): CoverageEntry[] | string {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return "`coverage` must be a list."
  const entries: CoverageEntry[] = []
  for (const [index, item] of value.entries()) {
    const v = (item ?? {}) as Record<string, unknown>
    const requirement = typeof v.requirement === "string" ? v.requirement.trim().toUpperCase() : ""
    const userStory = typeof (v.user_story ?? v.userStory) === "string"
      ? String(v.user_story ?? v.userStory).trim()
      : ""
    const raw = v.criteria ?? v.acceptance
    const criteria = Array.isArray(raw)
      ? raw.map((c) => (typeof c === "string" ? Number(c.replace(/^AC-/i, "")) : c))
      : []
    if (!requirement || !userStory || !criteria.length || !criteria.every((c) => Number.isInteger(c)))
      return `Coverage entry ${index + 1} needs \`requirement\` (e.g. "R1"), \`user_story\` (a key), and \`criteria\` (1-based acceptance criterion numbers).`
    entries.push({ requirement, userStory, criteria: criteria as number[] })
  }
  return entries
}

function storyKey(draft: { key?: string; title: string }): string {
  return (
    draft.key ??
    draft.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32).replace(/-$/, "")
  )
}

// Why the plan's coverage doesn't trace every requirement to real acceptance
// criteria, or null.
export function coverageRefusal(
  requirements: IntentRequirement[],
  milestones: MilestoneDraft[],
  coverage: CoverageEntry[]
): string | null {
  if (!requirements.length) return null
  const stories = new Map(
    milestones.flatMap((m) => m.userStories ?? []).map((s) => [storyKey(s), s])
  )
  const known = new Set(requirements.map((r) => r.id))
  const problems: string[] = []
  for (const entry of coverage) {
    if (!known.has(entry.requirement)) {
      problems.push(`${entry.requirement} is not a requirement (they are R1–R${requirements.length}).`)
      continue
    }
    const story = stories.get(entry.userStory)
    if (!story) {
      problems.push(`${entry.requirement}: no user story "${entry.userStory}" in this plan.`)
      continue
    }
    const count = story.acceptance?.length ?? 0
    const bad = entry.criteria.filter((c) => c < 1 || c > count)
    if (bad.length)
      problems.push(`${entry.requirement}: ${entry.userStory} has ${count} acceptance criteria, so AC-${bad.join(", AC-")} doesn't exist.`)
  }
  const covered = new Set(coverage.map((e) => e.requirement))
  const missing = requirements.filter((r) => !covered.has(r.id))
  if (missing.length)
    problems.push(
      `Not traced to any acceptance criterion: ${missing.map((r) => `${r.id} (${r.text})`).join("; ")}. Add criteria that deliver and verify them, and list them in \`coverage\`.`
    )
  return problems.length ? `The plan doesn't cover the intent. ${problems.join(" ")}` : null
}

export function describeCoverage(coverage: CoverageEntry[]): string {
  return coverage
    .map((e) => `${e.requirement}→${e.userStory} ${e.criteria.map((c) => `AC-${c}`).join("/")}`)
    .join(", ")
}

// ── the milestone judgment against the intent ───────────────────────────────

export type RequirementStatus = "met" | "later_milestone" | "not_met"

export interface RequirementCheck {
  requirement: string
  status: RequirementStatus
  evidence: string
}

const STATUSES: ReadonlySet<string> = new Set(["met", "later_milestone", "not_met"])

export function parseRequirementChecks(value: unknown): RequirementCheck[] | string {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return "`requirements` must be a list."
  const checks: RequirementCheck[] = []
  for (const [index, item] of value.entries()) {
    const v = (item ?? {}) as Record<string, unknown>
    const requirement = typeof v.requirement === "string" ? v.requirement.trim().toUpperCase() : ""
    const status = typeof v.status === "string" ? v.status.trim() : ""
    const evidence = typeof v.evidence === "string" ? v.evidence.trim() : ""
    if (!requirement || !STATUSES.has(status))
      return `Requirement check ${index + 1} needs \`requirement\` (e.g. "R1") and \`status\` (met, later_milestone, or not_met).`
    checks.push({ requirement, status: status as RequirementStatus, evidence })
  }
  return checks
}

// Why the lead's requirement checks don't let the milestone complete, or null.
export function requirementCheckRefusal(
  requirements: IntentRequirement[],
  checks: RequirementCheck[],
  isLastMilestone: boolean
): string | null {
  if (!requirements.length) return null
  const byId = new Map(checks.map((c) => [c.requirement, c]))
  const list = (rs: IntentRequirement[]) => rs.map((r) => `- ${r.id}: ${r.text}`).join("\n")
  const missing = requirements.filter((r) => !byId.has(r.id))
  if (missing.length)
    return [
      "Judge the milestone against the feature's intent, not only its definition of done. Pass `requirements` with one entry per requirement: status met (cite the evidence: the story and criterion, or what you checked in the code), later_milestone, or not_met. Missing:",
      list(missing),
    ].join("\n")
  const unproven = requirements.filter((r) => byId.get(r.id)!.status === "met" && !byId.get(r.id)!.evidence)
  if (unproven.length)
    return ["Each requirement you mark met needs `evidence`. Missing for:", list(unproven)].join("\n")
  const later = requirements.filter((r) => byId.get(r.id)!.status === "later_milestone")
  if (later.length && isLastMilestone)
    return ["This is the feature's last milestone, so nothing can wait for a later one:", list(later)].join("\n")
  const notMet = requirements.filter((r) => byId.get(r.id)!.status === "not_met")
  if (notMet.length)
    return [
      "The milestone can't complete while requirements from the intent are unmet:",
      list(notMet),
      "Add user stories (or criteria on a not-started story) that deliver and verify them with revise_plan, and judge the milestone again once they merge.",
    ].join("\n")
  return null
}

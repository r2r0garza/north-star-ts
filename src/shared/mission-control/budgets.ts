// Feature budgets (plan 106.6). User-owned limits stored in
// feature.budgets; tools can never raise them. Consumption is computed from
// durable state, and every budget has a soft level (80%) and a hard level.

export type BudgetKey =
  | "maxConcurrentUserStories"
  | "maxUserStoryAttempts"
  | "maxPlanRevisionsPerMilestone"
  | "maxAgentUserStoriesPerMilestone"
  | "maxMessagesPerHour"
  | "maxActiveHours"

export type BudgetLevel = "ok" | "soft" | "hard"

export interface BudgetSpec {
  key: BudgetKey
  label: string
  default: number
  unit: string
  // What happens at the hard level, for the UI.
  onHard: string
}

export const BUDGET_SPECS: readonly BudgetSpec[] = [
  {
    key: "maxConcurrentUserStories",
    label: "Concurrent user story runs",
    default: 3,
    unit: "runs",
    onHard: "Ready user stories queue until one finishes.",
  },
  {
    key: "maxUserStoryAttempts",
    label: "Attempts per user story",
    default: 3,
    unit: "attempts",
    onHard: "The user story fails and the lead decides what to do.",
  },
  {
    key: "maxPlanRevisionsPerMilestone",
    label: "Plan revisions per milestone",
    default: 10,
    unit: "revisions",
    onHard: "revise_plan is refused; changes become proposals.",
  },
  {
    key: "maxAgentUserStoriesPerMilestone",
    label: "Agent-created user stories per milestone",
    default: 5,
    unit: "user_stories",
    onHard: "New user stories can only be proposed.",
  },
  {
    key: "maxMessagesPerHour",
    label: "Messages per hour",
    default: 200,
    unit: "messages",
    onHard: "Comms refuses new seat messages.",
  },
  {
    key: "maxActiveHours",
    label: "Active drive time",
    default: 8,
    unit: "hours",
    onHard: "The feature pauses itself.",
  },
]

export const SOFT_BUDGET_RATIO = 0.8

export function budgetLimit(
  budgets: Record<string, unknown> | null | undefined,
  key: BudgetKey
): number {
  const value = budgets?.[key]
  const spec = BUDGET_SPECS.find((s) => s.key === key)!
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : spec.default
}

export function budgetLevel(used: number, limit: number): BudgetLevel {
  if (used >= limit) return "hard"
  if (limit > 0 && used > 0 && used >= limit * SOFT_BUDGET_RATIO) return "soft"
  return "ok"
}

export interface BudgetMeter {
  key: BudgetKey
  label: string
  used: number
  limit: number
  unit: string
  level: BudgetLevel
  // What the number is measured over, e.g. a milestone key or "last hour".
  scope?: string
  // The milestone it measures is finished: shown for the record, never acted on.
  final?: boolean
}

export type BudgetUsage = Record<BudgetKey, number>

// Budgets measured per milestone (the rest are live, hourly, or cumulative).
export const MILESTONE_BUDGETS: ReadonlySet<BudgetKey> = new Set([
  "maxUserStoryAttempts",
  "maxPlanRevisionsPerMilestone",
  "maxAgentUserStoriesPerMilestone",
])

export function budgetMeters(
  budgets: Record<string, unknown> | null | undefined,
  usage: BudgetUsage,
  // The milestone the per-milestone budgets measure; final when it has finished.
  milestone?: { key: string; final: boolean } | null
): BudgetMeter[] {
  return BUDGET_SPECS.map((spec) => {
    const limit = budgetLimit(budgets, spec.key)
    const used = usage[spec.key] ?? 0
    const perMilestone = MILESTONE_BUDGETS.has(spec.key)
    const scope = perMilestone
      ? milestone
        ? `${milestone.key}${milestone.final ? ", final" : ""}`
        : undefined
      : spec.key === "maxMessagesPerHour"
        ? "last hour"
        : spec.key === "maxConcurrentUserStories"
          ? "now"
          : "total"
    return {
      key: spec.key,
      label: spec.label,
      used,
      limit,
      unit: spec.unit,
      level: budgetLevel(used, limit),
      ...(scope ? { scope } : {}),
      ...(perMilestone && milestone?.final ? { final: true } : {}),
    }
  })
}

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
  | "maxPhaseMinutes"
  | "maxGateFixRounds"

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
  {
    key: "maxPhaseMinutes",
    label: "Minutes per phase",
    default: 20,
    unit: "minutes",
    onHard:
      "The phase is told to wrap up; at twice the limit it stops and the user story retries.",
  },
  {
    key: "maxGateFixRounds",
    label: "Fix rounds per gate criterion",
    default: 2,
    unit: "rounds",
    onHard:
      "The acceptance gate asks you about the criterion instead of adding another fix story.",
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
  // What the number is a part of, when that isn't obvious from the label.
  context?: string
  // A longer explanation of what counts, for a tooltip.
  help?: string
}

export type BudgetUsage = Record<BudgetKey, number>

// Budgets measured per milestone (the rest are live, hourly, or cumulative).
export const MILESTONE_BUDGETS: ReadonlySet<BudgetKey> = new Set([
  "maxUserStoryAttempts",
  "maxPlanRevisionsPerMilestone",
  "maxAgentUserStoriesPerMilestone",
  "maxGateFixRounds",
])

export function budgetMeters(
  budgets: Record<string, unknown> | null | undefined,
  usage: BudgetUsage,
  // The milestone the per-milestone budgets measure; final when it has finished.
  // userStories is its live user story count, for context.
  milestone?: { key: string; final: boolean; userStories?: number } | null
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
    // Agent-added user stories are a subset of the milestone's; showing the
    // total keeps "2 / 5" from reading as over the limit on a 7-story milestone.
    const agentStories = spec.key === "maxAgentUserStoriesPerMilestone"
    const fixRounds = spec.key === "maxGateFixRounds"
    return {
      key: spec.key,
      label: spec.label,
      used,
      limit,
      unit: spec.unit,
      level: budgetLevel(used, limit),
      ...(scope ? { scope } : {}),
      ...(perMilestone && milestone?.final ? { final: true } : {}),
      ...(agentStories && milestone?.userStories !== undefined
        ? { context: `${milestone.userStories} in milestone` }
        : {}),
      ...(agentStories
        ? {
            help: "Counts user stories seats added on their own (such as the lead splitting one). Stories from a plan you applied don't count.",
          }
        : {}),
      ...(fixRounds
        ? {
            help: "The most fix stories any one acceptance criterion has needed at this milestone's gates. At the limit, the gate asks you instead.",
          }
        : {}),
    }
  })
}

// Feature settings that aren't limits (plan 106.7). They live in the same
// user-owned feature.budgets record (whole numbers, set only from the budgets
// editor) but never get a meter.
export type FeatureSettingKey = "refocusEveryRounds" | "autoActivateLessons"

export interface FeatureSettingSpec {
  key: FeatureSettingKey
  label: string
  help: string
  kind: "number" | "toggle"
  default: number
}

export const FEATURE_SETTING_SPECS: readonly FeatureSettingSpec[] = [
  {
    key: "refocusEveryRounds",
    label: "Refocus every N tool rounds",
    help: "Re-show a working seat why its work exists, every N model rounds in one step. 0 turns the interval reminder off; kickoff and after-compaction reminders still happen.",
    kind: "number",
    default: 12,
  },
  {
    key: "autoActivateLessons",
    label: "Auto-activate seat lessons",
    help: "Lessons seats learn here go straight into later sessions instead of waiting for your review.",
    kind: "toggle",
    default: 0,
  },
]

export function featureSetting(
  budgets: Record<string, unknown> | null | undefined,
  key: FeatureSettingKey
): number {
  const value = budgets?.[key]
  const spec = FEATURE_SETTING_SPECS.find((s) => s.key === key)!
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : spec.default
}

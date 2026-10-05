// Mission Control health (plan 106.8). Every durable event is classified as
// progress (it moves the map) or ceremony (ritual around the work); detectors
// watch the stream for known coordination pathologies. The weights and
// thresholds here are the tunable defaults; tests pin them.

export type HealthEventClass = "progress" | "ceremony" | "neutral"

export interface HealthEventSpec {
  class: HealthEventClass
  weight: number
  label: string
}

export const HEALTH_EVENTS = {
  // Progress: the map moved.
  user_story_done: { class: "progress", weight: 5, label: "User story done" },
  proof_accepted: { class: "progress", weight: 3, label: "Proof accepted" },
  milestone_completed: {
    class: "progress",
    weight: 8,
    label: "Milestone completed",
  },
  merge_landed: { class: "progress", weight: 3, label: "Merge landed" },
  criterion_met: {
    class: "progress",
    weight: 1,
    label: "Acceptance criterion met",
  },
  hook_completed: { class: "progress", weight: 2, label: "Hook completed" },
  // Ceremony: the team is busy, the map may not be moving.
  message_sent: { class: "ceremony", weight: 1, label: "Message" },
  message_refused: { class: "ceremony", weight: 1, label: "Message refused" },
  direction: { class: "ceremony", weight: 0.5, label: "Direction" },
  escalation: { class: "ceremony", weight: 1, label: "Escalation" },
  alert: { class: "ceremony", weight: 1, label: "Health alert" },
  validator_round: {
    class: "ceremony",
    weight: 1,
    label: "Validator round",
  },
  rework_round: { class: "ceremony", weight: 2, label: "Rework round" },
  proof_rejected: { class: "ceremony", weight: 2, label: "Proof rejected" },
  proof_after_acceptance: {
    class: "ceremony",
    weight: 3,
    label: "Proof edited after acceptance",
  },
  approval_requested: {
    class: "ceremony",
    weight: 1,
    label: "Approval requested",
  },
  test_browser_needed: {
    class: "ceremony",
    weight: 1,
    label: "Waiting for the test browser",
  },
  plan_revision: { class: "ceremony", weight: 1, label: "Plan revision" },
  proposal_created: {
    class: "ceremony",
    weight: 1,
    label: "Proposal created",
  },
  followup_proposed: {
    class: "ceremony",
    weight: 1,
    label: "Follow-up proposed",
  },
  refocus_delivered: {
    class: "ceremony",
    weight: 0.5,
    label: "Refocus delivered",
  },
  // Neutral: context for the detectors, no weight.
  user_story_started: {
    class: "neutral",
    weight: 0,
    label: "User story started",
  },
  user_story_failed: {
    class: "neutral",
    weight: 0,
    label: "User story attempt failed",
  },
  feature_active: { class: "neutral", weight: 0, label: "Drive started" },
  // A worktree's setup steps (plan 106.11): detail names the failed step.
  worktree_setup_failed: {
    class: "neutral",
    weight: 0,
    label: "Worktree setup failed",
  },
  worktree_setup_ok: {
    class: "neutral",
    weight: 0,
    label: "Worktree setup ran",
  },
  steer: { class: "neutral", weight: 0, label: "Message from the user" },
  // The user decided on a story's escalation (a merge conflict or an
  // acceptance gate): its proof-polishing count starts over (plan 110.05).
  user_decision: { class: "neutral", weight: 0, label: "User decided" },
} as const satisfies Record<string, HealthEventSpec>

export type HealthEventType = keyof typeof HEALTH_EVENTS

// Alerts are ceremony, but never count toward ceremony_rising: an alert that
// raised the ratio would feed the detector that sent it.
export const CEREMONY_RISING_EXCLUDED: ReadonlySet<string> = new Set(["alert"])

// Ratio = ceremony / max(progress, ε). ε is one unit of progress weight, so
// with no progress at all the ratio reads as the raw ceremony weight.
export const RATIO_EPSILON = 1

export type HealthDetector =
  | "ceremony_rising"
  | "stalled"
  | "proof_polishing"
  | "ping_pong"
  | "scope_drift"
  | "approval_by_proxy"
  | "refocus_ignored"
  | "retry_churn"
  | "setup_failed"
  | "weak_proof"

export interface HealthDetectorSpec {
  key: HealthDetector
  label: string
  // The coordination pathology it watches for.
  pathology: string
  description: string
}

export const HEALTH_DETECTORS: readonly HealthDetectorSpec[] = [
  {
    key: "ceremony_rising",
    label: "Ceremony rising",
    pathology: "Bureaucracy",
    description:
      "Ceremony keeps climbing while nothing moves the map: messages, reviews, and revisions without done user stories or merges.",
  },
  {
    key: "stalled",
    label: "Stalled",
    pathology: "Stuck coordination loop",
    description:
      "Workers are running but nothing has moved the map for a long time.",
  },
  {
    key: "proof_polishing",
    label: "Proof polishing",
    pathology: "Recursive proof loop",
    description:
      "A proof keeps being revised: re-recorded after it was accepted, or rejected again and again across attempts. The count starts over when you decide on the user story.",
  },
  {
    key: "ping_pong",
    label: "Ping-pong",
    pathology: "Coordination loop",
    description:
      "Two seats keep answering each other in one thread with no progress in between.",
  },
  {
    key: "scope_drift",
    label: "Scope drift",
    pathology: "Moonbase",
    description:
      "A user story touches far more than its touch hints, works outside them, or keeps proposing follow-ups.",
  },
  {
    key: "approval_by_proxy",
    label: "Approval by proxy",
    pathology: "Just following orders",
    description:
      "A seat asks another seat to approve or authorize something that seat has no decision right over.",
  },
  {
    key: "refocus_ignored",
    label: "Refocus ignored",
    pathology: "Persistent drift",
    description:
      "A drift signal kept firing after its seat was shown a Refocus.",
  },
  {
    key: "retry_churn",
    label: "Retry churn",
    pathology: "Thrash",
    description:
      "A user story used up its attempts, or failed the same way twice in a row.",
  },
  {
    key: "setup_failed",
    label: "Worktree setup failed",
    pathology: "Broken environment",
    description:
      "A workspace setup step failed in a new worktree, so agents there work without the environment they need. Fix the step in Workspace setup.",
  },
  {
    key: "weak_proof",
    label: "Weak proof",
    pathology: "Grading its own homework",
    description:
      "A user story was accepted on criteria verified only by the builder's own tests, or whose proof doesn't say how they were verified. Nothing independent showed they hold.",
  },
]

export function detectorLabel(key: string): string {
  return HEALTH_DETECTORS.find((d) => d.key === key)?.label ?? key
}

// Per-feature thresholds (plan 106.8). They live in the user-owned
// feature.budgets record, like the 106.7 settings, and are edited from the
// Health tab.
export type HealthSettingKey =
  | "healthCeremonyRatio"
  | "healthStallMinutes"
  | "healthPingPongMessages"
  | "healthOutsideHintFiles"
  | "healthEscalateMinutes"

export interface HealthSettingSpec {
  key: HealthSettingKey
  label: string
  help: string
  default: number
}

export const HEALTH_SETTING_SPECS: readonly HealthSettingSpec[] = [
  {
    key: "healthCeremonyRatio",
    label: "Ceremony ratio",
    help: "Ceremony rising fires when the last hour's ceremony-to-progress ratio passes this, keeps rising, and nothing moved for 30 minutes.",
    default: 6,
  },
  {
    key: "healthStallMinutes",
    label: "Stall after (minutes)",
    help: "Stalled fires when workers are running but nothing moved the map for this long. At twice this, the feature pauses.",
    default: 45,
  },
  {
    key: "healthPingPongMessages",
    label: "Ping-pong messages",
    help: "Alternating messages between the same two seats in one thread, with no progress between, before Ping-pong fires.",
    default: 6,
  },
  {
    key: "healthOutsideHintFiles",
    label: "Files outside touch hints",
    help: "Scope drift fires when a user story changed more files than this outside its touch hints.",
    default: 5,
  },
  {
    key: "healthEscalateMinutes",
    label: "Pause on unanswered warnings (minutes)",
    help: "A warning nobody acknowledges or resolves for this long pauses the feature. 0 turns this off.",
    default: 30,
  },
]

export type HealthSettings = Record<HealthSettingKey, number>

export function healthSettings(
  budgets: Record<string, unknown> | null | undefined
): HealthSettings {
  const out = {} as HealthSettings
  for (const spec of HEALTH_SETTING_SPECS) {
    const value = budgets?.[spec.key]
    out[spec.key] =
      typeof value === "number" && Number.isInteger(value) && value >= 0
        ? value
        : spec.default
  }
  return out
}

// A signal that cleared and fires again within this long reopens the same
// row, so it isn't announced twice.
export const SIGNAL_COOLDOWN_MS = 10 * 60 * 1000

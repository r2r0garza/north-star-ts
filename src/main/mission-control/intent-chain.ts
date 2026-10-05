import type { Feature, Milestone, UserStory } from "../db/types"
import { formatStory } from "../../shared/mission-control/story"

// The Refocus intent chain (plan 106.7): why the work in front of a seat
// exists, walked bottom-up from the unit being executed to the feature it
// serves, with the definition of done at the seat's altitude. Deterministic —
// no model call — and bounded, so it can be re-delivered as often as needed
// (at kickoff, after compaction, on an interval, and on a drift signal).

// The rendered chain, including the seat line and the closing question.
export const INTENT_CHAIN_MAX_CHARS = 2048

export interface IntentChainInput {
  feature: Feature
  milestone?: Milestone | null
  userStory?: UserStory | null
}

export interface RefocusSeat {
  address: string
  charter: string
}

// Field budgets, loosest first. Rendering retries at the next level until the
// chain fits; ids (keys, AC-n) are never truncated.
const LEVELS = [
  { field: 320, item: 200, items: 12 },
  { field: 200, item: 120, items: 8 },
  { field: 120, item: 60, items: 6 },
  { field: 80, item: 0, items: 3 },
] as const
type Level = (typeof LEVELS)[number]

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (max <= 0) return ""
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

function listLine(items: string[], level: Level): string {
  if (!items.length) return "(none)"
  const shown = items
    .slice(0, level.items)
    .map((item) => clip(item, level.item))
  const rest = items.length - shown.length
  const text = level.item
    ? shown.join("; ")
    : `${items.length} item${items.length === 1 ? "" : "s"}`
  return rest > 0 && level.item ? `${text}; …and ${rest} more` : text
}

function renderChain(input: IntentChainInput, level: Level): string {
  const { feature, milestone, userStory } = input
  const lines: string[] = []
  let serves = "You are working on:"
  if (userStory) {
    lines.push(
      `${serves} user story ${userStory.key} "${clip(userStory.title, level.field)}"`
    )
    if (userStory.spec.story)
      lines.push(
        `  Story: ${clip(formatStory(userStory.spec.story), level.field)}`
      )
    const goal = userStory.spec.goal.trim()
    if (goal && goal !== userStory.title)
      lines.push(`  Goal: ${clip(goal, level.field)}`)
    // Every criterion id is always listed (they are what the proof cites);
    // only their texts shrink, and past the level's count they go.
    const criteria = userStory.spec.acceptance.map((text, index) =>
      level.item && index < level.items
        ? `AC-${index + 1} ${clip(text, level.item)}`
        : `AC-${index + 1}`
    )
    lines.push(
      `  Acceptance: ${criteria.length ? criteria.join("; ") : "(none)"}`
    )
    lines.push(`  OUT OF SCOPE: ${listLine(userStory.spec.outOfScope, level)}`)
    serves = "which serves:"
  }
  if (milestone) {
    lines.push(
      `${serves} milestone ${milestone.key} "${clip(milestone.name, level.field)}" — ${
        clip(milestone.outcome, level.field) || "(no outcome stated)"
      }`
    )
    if (milestone.definitionOfDone.trim())
      lines.push(
        `  Done when: ${clip(milestone.definitionOfDone, level.field)}`
      )
    serves = "which serves:"
  }
  lines.push(
    `${serves} feature ${feature.key} "${clip(feature.name, level.field)}" — ${
      clip(feature.intent, level.field) || "(no intent stated)"
    }`
  )
  if (feature.definitionOfDone.trim())
    lines.push(`  Done when: ${clip(feature.definitionOfDone, level.field)}`)
  lines.push(
    `Definition of done at your altitude: ${altitudeDone(input, level)}`
  )
  return lines.join("\n")
}

function altitudeDone(input: IntentChainInput, level: Level): string {
  if (input.userStory)
    return "every acceptance criterion above is met and proven — nothing more. When it is, the user story is done: stop."
  if (input.milestone)
    return (
      clip(input.milestone.definitionOfDone, level.field) ||
      "the milestone's outcome above is delivered by its user stories."
    )
  return (
    clip(input.feature.definitionOfDone, level.field) ||
    "the feature's intent above is delivered by its milestones."
  )
}

// The chain alone (no seat line or question): what a run's seat bindings
// snapshot freezes, and what hook objectives show under "Why this work exists".
export function renderIntentChain(input: IntentChainInput): string {
  for (const level of LEVELS) {
    const text = renderChain(input, level)
    if (text.length <= INTENT_CHAIN_MAX_CHARS - 600) return text
  }
  return renderChain(input, LEVELS[LEVELS.length - 1]).slice(
    0,
    INTENT_CHAIN_MAX_CHARS - 600
  )
}

export function refocusQuestion(chain: string): string {
  return chain.startsWith("You are working on: user story")
    ? "Question: Is what you are doing right now necessary for the acceptance criteria above?"
    : "Question: Is what you are doing right now necessary for the definition of done above?"
}
export const REFOCUS_FOLLOWUP_HINT =
  "If you want something not listed, record it with propose_followup and continue the current work."

// The full Refocus block: the chain, the seat reading it, and the question.
// Bounded to INTENT_CHAIN_MAX_CHARS whatever the inputs.
export function renderRefocus(input: {
  chain: string
  seat?: RefocusSeat | null
  // What prompted this reminder, e.g. a drift signal; shown first.
  lead?: string | null
}): string {
  const seatLine = input.seat
    ? `Your seat: ${input.seat.address}${
        input.seat.charter.trim() ? ` — ${clip(input.seat.charter, 240)}` : ""
      }`
    : null
  const lead = input.lead?.trim() ? clip(input.lead, 300) : null
  const tail = [seatLine, refocusQuestion(input.chain), REFOCUS_FOLLOWUP_HINT]
    .filter(Boolean)
    .join("\n")
  const head = lead ? `${lead}\n\n` : ""
  const room = INTENT_CHAIN_MAX_CHARS - head.length - tail.length - 1
  const chain =
    input.chain.length > room
      ? `${input.chain.slice(0, Math.max(0, room - 1)).trimEnd()}…`
      : input.chain
  return `${head}${chain}\n${tail}`
}

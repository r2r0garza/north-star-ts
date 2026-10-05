import { addConversationNote } from "../db/repositories/conversation-notes"
import { getDb } from "../db/connection"
import * as features from "../db/repositories/features"
import { recordEvent } from "../db/repositories/mc-events"
import type { Feature, Milestone, UserStory } from "../db/types"
import { featureSetting } from "../../shared/mission-control/budgets"
import {
  refocusEventHeader,
  type RefocusTriggerKind,
} from "../../shared/runtime-messages"
import { renderIntentChain, renderRefocus } from "./intent-chain"
import type { SeatTurnIdentity } from "./seat-turns"

// Refocus (plan 106.7): re-show a seat why its work exists, at the moments the
// local picture takes over. The kickoff chain rides in the seat context
// section (seat-context.ts); this module owns the dynamic reminders, delivered
// into the seat's transcript before its next model round:
//   - compaction: the summary service folded the seat's older turns away;
//   - interval: every N model rounds in one step (feature setting);
//   - drift: a detector (plan 106.8) saw the work wander.
// Refocus never blocks or cancels. It reframes.

// A detector's finding, as 106.8 will emit it. `message` is shown to the seat
// verbatim ("You have modified 14 files outside the user story's expected area").
export interface DriftSignal {
  code: string
  message: string
}

export type RefocusTrigger =
  | { kind: "compaction" }
  | { kind: "interval"; rounds: number }
  | { kind: "drift"; signal: DriftSignal }

export const REFOCUS_NOTE_SOURCE = "refocus"

// Queue a reminder for a conversation's next model round (durable: a turn
// that starts later, even after a restart, still gets it).
export function requestRefocus(
  conversationId: string,
  trigger: RefocusTrigger
): void {
  addConversationNote(
    conversationId,
    JSON.stringify(trigger),
    REFOCUS_NOTE_SOURCE
  )
}

// The drift hook for 106.8's detectors. A no-op path until they emit.
export function signalDrift(conversationId: string, signal: DriftSignal): void {
  requestRefocus(conversationId, { kind: "drift", signal })
}

export function parseRefocusTrigger(body: string): RefocusTrigger | null {
  try {
    const value = JSON.parse(body) as Partial<RefocusTrigger> & {
      rounds?: unknown
      signal?: Partial<DriftSignal>
    }
    if (value.kind === "compaction") return { kind: "compaction" }
    if (value.kind === "interval")
      return {
        kind: "interval",
        rounds: typeof value.rounds === "number" ? value.rounds : 0,
      }
    if (value.kind === "drift" && typeof value.signal?.message === "string")
      return {
        kind: "drift",
        signal: {
          code: String(value.signal.code ?? "drift"),
          message: value.signal.message,
        },
      }
  } catch {
    // Not a trigger we wrote.
  }
  return null
}

function leadFor(trigger: RefocusTrigger): string {
  switch (trigger.kind) {
    case "compaction":
      return "Your earlier turns in this conversation were just compacted into a summary. Before you continue, re-read why this work exists."
    case "interval":
      return `Refocus check (every ${trigger.rounds} rounds). Step back from the detail for a moment.`
    case "drift":
      return `Drift signal: ${trigger.signal.message}`
  }
}

// Where a seat turn is working: the user story (and its milestone) or the
// milestone its anchor names, and the seat's charter from the rig snapshot.
function workOf(identity: SeatTurnIdentity): {
  feature: Feature
  milestone: Milestone | null
  userStory: UserStory | null
  charter: string
} | null {
  const feature = features.getFeature(identity.featureId)
  if (!feature) return null
  let milestone: Milestone | null = null
  let userStory: UserStory | null = null
  if (identity.anchor?.kind === "user_story") {
    userStory = features.getUserStory(identity.anchor.id)
    milestone = userStory ? features.getMilestone(userStory.milestoneId) : null
  } else if (identity.anchor?.kind === "milestone") {
    milestone = features.getMilestone(identity.anchor.id)
  }
  const rig = feature.rigSnapshot
  let charter = ""
  if (rig)
    for (const pod of rig.pods)
      for (const seat of rig.seats)
        if (
          seat.podId === pod.id &&
          `${seat.key}@${pod.key}` === identity.address
        )
          charter = seat.charter
  return { feature, milestone, userStory, charter }
}

// The reminder as it lands in the transcript, or null when the seat's work
// can no longer be found (the feature was deleted).
export function renderRefocusEvent(
  identity: SeatTurnIdentity,
  trigger: RefocusTrigger
): string | null {
  const work = workOf(identity)
  if (!work) return null
  const chain = renderIntentChain(work)
  return `${refocusEventHeader(trigger.kind as RefocusTriggerKind)}\n\n${renderRefocus(
    {
      chain,
      seat: { address: identity.address, charter: work.charter },
      lead: leadFor(trigger),
    }
  )}`
}

// A reminder landed in a seat's transcript: ceremony on the health stream,
// and the moment a drift signal's "was the Refocus ignored?" clock starts
// (plan 106.8). `noteId` keys a queued reminder, so a replay records once.
export function recordRefocusDelivered(
  identity: SeatTurnIdentity,
  trigger: RefocusTrigger,
  conversationId: string,
  noteId: string | null
): void {
  recordEvent({
    featureId: identity.featureId,
    type: "refocus_delivered",
    userStoryId:
      identity.anchor?.kind === "user_story" ? identity.anchor.id : null,
    milestoneId:
      identity.anchor?.kind === "milestone" ? identity.anchor.id : null,
    seatAddress: identity.address,
    refId: noteId,
    detail: {
      trigger: trigger.kind,
      conversationId,
      ...(trigger.kind === "drift" ? { code: trigger.signal.code } : {}),
    },
  })
}

// How many model rounds a working seat runs between interval reminders
// (0 = off).
export function refocusInterval(featureId: string): number {
  const feature = features.getFeature(featureId)
  return feature ? featureSetting(feature.budgets, "refocusEveryRounds") : 0
}

// Whether a conversation belongs to a Mission Control seat: a seat session,
// or a playbook step's worker bound to a seat.
export function isSeatConversation(conversationId: string): boolean {
  const db = getDb()
  if (
    db
      .prepare("SELECT 1 FROM seat_sessions WHERE conversation_id = ? LIMIT 1")
      .get(conversationId)
  )
    return true
  return !!db
    .prepare(
      `SELECT 1 FROM process_phase_runs pr JOIN tasks t ON t.id = pr.task_id
       WHERE t.conversation_id = ? AND pr.seat_address IS NOT NULL LIMIT 1`
    )
    .get(conversationId)
}

// The summary service compacted a conversation: a seat's next turn re-reads
// the chain, because compaction is exactly when the local picture takes over.
export function onConversationCompacted(conversationId: string): void {
  try {
    if (isSeatConversation(conversationId))
      requestRefocus(conversationId, { kind: "compaction" })
  } catch (err) {
    console.warn("[refocus] compaction hook failed:", err)
  }
}

// Seat conversations are summarized like chats (so long sessions compact);
// the summary service is installed by the main process.
let summarize: ((conversationId: string) => void) | null = null

export function installSeatSummarizer(
  fn: ((conversationId: string) => void) | null
): void {
  summarize = fn
}

export function afterSeatTurn(conversationId: string): void {
  try {
    summarize?.(conversationId)
  } catch (err) {
    console.warn("[refocus] summarize trigger failed:", err)
  }
}

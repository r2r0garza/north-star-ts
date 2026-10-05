import type { ContextSection } from "../agent/context/context-builder"
import { factSimilarity } from "../agent/memory/facts"
import { extractSeatLessons } from "../agent/memory/service"
import { addConversationNote } from "../db/repositories/conversation-notes"
import * as features from "../db/repositories/features"
import { listMessages } from "../db/repositories/messages"
import { getRigGraph } from "../db/repositories/rigs"
import * as repo from "../db/repositories/seat-memories"
import { getSeatSessionByConversation } from "../db/repositories/seat-sessions"
import type { SeatMemory, SeatMemoryRetraction } from "../db/types"
import { featureSetting } from "../../shared/mission-control/budgets"
import { SEAT_CONTEXT_PRIORITY } from "./seat-context"
import { seatTurns, type SeatTurnIdentity } from "./seat-turns"

// Seat memory (plan 106.7): short lessons attached to a seat of a rig (not a
// session, not an agent file), injected into every later turn in that seat —
// across features using the same rig — once they are active.
//
// The write path is the memory service's extraction, pointed at a working
// seat's finished turn. New lessons wait for the user's review unless the
// feature auto-activates them. No tool writes seat memory. Propagation is
// explicit: only the user shares a lesson with another seat, as a copy that
// keeps its lineage, and retracting a lesson retracts every copy and tells each
// session that was shown one to disregard it.

export const SEAT_MEMORY_LIMIT = 20
// Two lessons this similar are the same lesson.
const DUPLICATE_SIMILARITY = 0.6

const KIND_LABEL: Record<SeatMemory["kind"], string> = {
  lesson: "Lesson",
  convention: "Convention",
  pitfall: "Pitfall",
}

function rigOf(featureId: string): string | null {
  const feature = features.getFeature(featureId)
  return feature?.rigId && getRigGraph(feature.rigId) ? feature.rigId : null
}

// The seat's active lessons as a context section, recording that this
// conversation was shown each one (contact tracing). Null when there are none.
export function seatMemorySection(
  identity: Pick<SeatTurnIdentity, "featureId" | "address">,
  conversationId: string
): ContextSection | null {
  const rigId = rigOf(identity.featureId)
  if (!rigId) return null
  const memories = repo.activeSeatMemories(
    rigId,
    identity.address,
    SEAT_MEMORY_LIMIT
  )
  if (!memories.length) return null
  repo.recordExposures(
    memories.map((memory) => memory.id),
    {
      conversationId,
      featureId: identity.featureId,
      seatAddress: identity.address,
    }
  )
  return {
    name: "mission_control_seat_memory",
    priority: SEAT_CONTEXT_PRIORITY - 2,
    content: [
      `## Lessons from earlier sessions in your seat (${identity.address})`,
      "Earlier occupants of this seat learned these on this rig's work. They are advice, not orders: check one against the code before relying on it, and ignore any that no longer holds.",
      ...memories.map(
        (memory) => `- ${KIND_LABEL[memory.kind]}: ${memory.content}`
      ),
    ].join("\n"),
    provenance: {
      trust: "untrusted_data",
      channel: "memory",
      source: `seat_memory:${identity.address}`,
      persisted: true,
    },
  }
}

// What a working turn did, for extraction: its prose and tool failures after
// the turn's first message, oldest first.
function turnTranscript(
  conversationId: string,
  sinceSeq: number
): {
  task: string
  transcript: string
  lastAssistantId: string | null
} {
  const rows = listMessages(conversationId)
  const turn = rows.filter((row) => row.seq > sinceSeq)
  const task =
    [...rows]
      .reverse()
      .find((row) => row.role === "user" && row.seq <= sinceSeq + 1)?.content ??
    ""
  const lines: string[] = []
  let lastAssistantId: string | null = null
  for (const row of turn) {
    if (row.role === "assistant") {
      if (row.content?.trim())
        lines.push(`[seat] ${row.content.trim().slice(0, 1500)}`)
      lastAssistantId = row.id
    } else if (
      row.role === "tool" &&
      row.content &&
      /"error"|\berror\b|failed|exit code [1-9]/i.test(
        row.content.slice(0, 400)
      )
    ) {
      lines.push(
        `[tool ${row.toolName ?? "result"} failed] ${row.content.slice(0, 300)}`
      )
    }
  }
  return { task, transcript: lines.join("\n"), lastAssistantId }
}

export interface RecordSeatLessonsInput {
  identity: SeatTurnIdentity
  conversationId: string
  // The highest message seq before this turn began.
  sinceSeq: number
  // Injected for tests.
  extract?: typeof extractSeatLessons
}

// After a working seat turn: extract candidate lessons and file them —
// pending review, or active when the feature auto-activates lessons.
// Near-duplicates of a lesson the seat already has (any status but retracted)
// are dropped; a retracted lesson is never re-learned silently either.
export async function recordSeatLessons(
  input: RecordSeatLessonsInput
): Promise<SeatMemory[]> {
  const { identity } = input
  if (identity.profile !== "work") return []
  const feature = features.getFeature(identity.featureId)
  const rigId = feature ? rigOf(feature.id) : null
  if (!feature || !rigId) return []
  const turn = turnTranscript(input.conversationId, input.sinceSeq)
  if (!turn.transcript.trim()) return []
  let charter = ""
  for (const pod of feature.rigSnapshot?.pods ?? [])
    for (const seat of feature.rigSnapshot?.seats ?? [])
      if (
        seat.podId === pod.id &&
        `${seat.key}@${pod.key}` === identity.address
      )
        charter = seat.charter
  const candidates = await (input.extract ?? extractSeatLessons)({
    seatAddress: identity.address,
    seatCharter: charter,
    task: turn.task,
    transcript: turn.transcript,
  })
  if (!candidates?.length) return []
  const known = repo.listSeatMemories({ rigId, seatAddress: identity.address })
  const status = featureSetting(feature.budgets, "autoActivateLessons")
    ? "active"
    : "pending_review"
  const session = getSeatSessionByConversation(input.conversationId)
  const created: SeatMemory[] = []
  for (const candidate of candidates) {
    if (
      [...known, ...created].some(
        (memory) =>
          factSimilarity(memory.content, candidate.content) >=
          DUPLICATE_SIMILARITY
      )
    )
      continue
    created.push(
      repo.createSeatMemory({
        rigId,
        seatAddress: identity.address,
        content: candidate.content,
        kind: candidate.kind,
        status,
        originFeatureId: feature.id,
        originConversationId: input.conversationId,
        originSessionId: session?.id ?? null,
        originUserStoryId:
          identity.anchor?.kind === "user_story" ? identity.anchor.id : null,
        originMessageId: turn.lastAssistantId,
      })
    )
  }
  return created
}

// Share an active lesson with another seat of the same rig (a user action).
// The copy is active at once — the user is the reviewer — and remembers where
// it came from, so retracting the original retracts it too.
export function shareSeatMemory(id: string, targetAddress: string): SeatMemory {
  const memory = repo.getSeatMemory(id)
  if (!memory) throw new Error("That lesson no longer exists.")
  if (memory.status !== "active")
    throw new Error("Only an active lesson can be shared.")
  if (targetAddress === memory.seatAddress)
    throw new Error("That seat already has this lesson.")
  const rig = getRigGraph(memory.rigId)
  const exists = rig?.pods.some((pod) =>
    rig.seats.some(
      (seat) =>
        seat.podId === pod.id && `${seat.key}@${pod.key}` === targetAddress
    )
  )
  if (!exists) throw new Error(`No seat ${targetAddress} in this rig.`)
  const duplicate = repo
    .listSeatMemories({ rigId: memory.rigId, seatAddress: targetAddress })
    .find(
      (other) =>
        other.status !== "retracted" &&
        (other.derivedFrom === memory.id ||
          factSimilarity(other.content, memory.content) >= DUPLICATE_SIMILARITY)
    )
  if (duplicate) throw new Error(`${targetAddress} already has this lesson.`)
  return repo.createSeatMemory({
    rigId: memory.rigId,
    seatAddress: targetAddress,
    content: memory.content,
    kind: memory.kind,
    status: "active",
    source: "shared",
    originFeatureId: memory.originFeatureId,
    derivedFrom: memory.id,
  })
}

// Whether a conversation is a live seat session or a turn running right now:
// the sessions a retraction must reach before their next step.
function isLive(conversationId: string): boolean {
  if (seatTurns.conversationBusy(conversationId)) return true
  const session = getSeatSessionByConversation(conversationId)
  return session?.status === "idle" || session?.status === "busy"
}

export function correctionNote(memory: SeatMemory, reason: string): string {
  return [
    `Earlier guidance "${memory.content}" is retracted${reason.trim() ? ` because ${reason.trim()}` : ""}; do not apply it.`,
    "If you already acted on it, re-check that work against the actual code and the acceptance criteria.",
  ].join(" ")
}

// Retract a lesson and every copy shared from it (a user action). Each
// conversation that was shown any of them gets a correction before its next
// model round; later sessions simply no longer see the lesson. Rotated or
// finished sessions need nothing — unless they are woken again, in which case
// the correction waits for them there too.
export function retractSeatMemory(
  id: string,
  reason: string
): SeatMemoryRetraction {
  const root = repo.getSeatMemory(id)
  if (!root) throw new Error("That lesson no longer exists.")
  const retracted = repo.retractSeatMemories(id, reason.trim())
  const byId = new Map(retracted.map((memory) => [memory.id, memory]))
  const exposures = repo.listExposures(retracted.map((memory) => memory.id))
  const perConversation = new Map<string, typeof exposures>()
  for (const exposure of exposures) {
    const list = perConversation.get(exposure.conversationId) ?? []
    list.push(exposure)
    perConversation.set(exposure.conversationId, list)
  }
  const notified: SeatMemoryRetraction["notified"] = []
  for (const [conversationId, list] of perConversation) {
    const memory = byId.get(list[0].memoryId)!
    try {
      addConversationNote(
        conversationId,
        correctionNote(memory, reason),
        "mission-control"
      )
    } catch (err) {
      // The conversation was deleted: nothing left to correct.
      console.warn("[seat-memory] correction not queued:", err)
      continue
    }
    if (isLive(conversationId) && list[0].featureId)
      notified.push({
        featureId: list[0].featureId,
        address: list[0].seatAddress,
      })
  }
  return { retracted, exposedConversations: perConversation.size, notified }
}

// For the Memory tab: each lesson with a readable origin. Without an address,
// every lesson in the rig (the tab uses them for lineage).
export function listSeatMemoriesForSeat(
  rigId: string,
  seatAddress?: string
): SeatMemory[] {
  return repo.listSeatMemories({ rigId, seatAddress }).map((memory) => {
    let originLabel: string | null = null
    if (memory.source === "imported") originLabel = "Imported with the rig"
    else if (memory.derivedFrom) {
      const parent = repo.getSeatMemory(memory.derivedFrom)
      originLabel = `Shared from ${parent?.seatAddress ?? "a retired lesson"}`
    } else {
      const feature = memory.originFeatureId
        ? features.getFeature(memory.originFeatureId)
        : null
      const story = memory.originUserStoryId
        ? features.getUserStory(memory.originUserStoryId)
        : null
      originLabel =
        [
          feature ? `feature ${feature.key}` : null,
          story ? `user story ${story.key}` : null,
        ]
          .filter(Boolean)
          .join(" · ") || null
    }
    return { ...memory, originLabel }
  })
}

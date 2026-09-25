// Which Mission Control seat turns are in flight right now (plan 106.4). A seat
// is "busy" while any turn runs on its behalf — a fresh playbook worker, a
// seat-session step, or a wake turn — and mail for a busy seat waits in its
// inbox for the next turn boundary instead of waking another turn. The registry
// also serializes turns on one conversation: a seat-session step and a wake
// turn never append to the same transcript at once.
//
// In memory on purpose: after a restart nothing is mid-turn, and queued mail is
// re-dispatched from the durable seat_messages table.

// What a seat turn may do with Comms and the workspace:
// - work:        a playbook step. Its seat's full narrowed toolset + messaging.
// - consult:     a turn woken by a message. Read/search tools + messaging only,
//                so a message can never cause a side effect (plan decision 4).
// - answer_only: a finished fresh worker woken to answer. Read/search only; its
//                final answer becomes the reply.
export type SeatTurnProfile = "work" | "consult" | "answer_only"

export interface SeatTurnIdentity {
  initiativeId: string
  address: string
  profile: SeatTurnProfile
  // The work this turn belongs to, for anchoring new threads by default.
  anchor: { kind: "slice" | "mission"; id: string } | null
  // Hop depth of the mail that woke this turn (null for playbook steps). New
  // messages sent from a wake turn continue that chain's depth.
  wakeHop: number | null
}

interface ActiveTurn extends SeatTurnIdentity {
  conversationId: string
}

type ReleaseListener = (turn: ActiveTurn) => void

export class SeatTurnRegistry {
  private active = new Map<string, ActiveTurn>()
  private waiters = new Map<string, Array<() => void>>()
  private listeners = new Set<ReleaseListener>()

  // Wait until no other seat turn holds this conversation, then hold it.
  // Resolves with a release function; call it exactly once when the turn ends.
  async acquire(
    conversationId: string,
    identity: SeatTurnIdentity,
    signal?: AbortSignal
  ): Promise<() => void> {
    while (this.active.has(conversationId)) {
      if (signal?.aborted) throw new Error("Seat turn aborted while waiting")
      await new Promise<void>((resolve) => {
        const queue = this.waiters.get(conversationId) ?? []
        queue.push(resolve)
        this.waiters.set(conversationId, queue)
        signal?.addEventListener("abort", () => resolve(), { once: true })
      })
    }
    const turn = { ...identity, conversationId }
    this.active.set(conversationId, turn)
    let released = false
    return () => {
      if (released) return
      released = true
      this.active.delete(conversationId)
      const next = this.waiters.get(conversationId)?.shift()
      if (next) next()
      else this.waiters.delete(conversationId)
      for (const listener of this.listeners) {
        try {
          listener(turn)
        } catch (err) {
          console.error("Seat turn release listener failed:", err)
        }
      }
    }
  }

  seatBusy(initiativeId: string, address: string): boolean {
    for (const turn of this.active.values())
      if (turn.initiativeId === initiativeId && turn.address === address)
        return true
    return false
  }

  conversationBusy(conversationId: string): boolean {
    return this.active.has(conversationId)
  }

  onRelease(listener: ReleaseListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export const seatTurns = new SeatTurnRegistry()

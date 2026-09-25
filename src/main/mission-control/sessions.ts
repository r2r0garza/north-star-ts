import { existsSync } from "fs"
import type { AgentDefinition } from "../agent/agents/types"
import type { ContextSection } from "../agent/context/context-builder"
import { getDb } from "../db/connection"
import { createConversation } from "../db/repositories/conversations"
import { getConversationSummary } from "../db/repositories/conversation-summaries"
import * as initiatives from "../db/repositories/initiatives"
import { listMessages } from "../db/repositories/messages"
import * as playbooks from "../db/repositories/playbooks"
import * as processes from "../db/repositories/processes"
import * as comms from "../db/repositories/seat-comms"
import * as sessions from "../db/repositories/seat-sessions"
import { createTask } from "../db/repositories/tasks"
import { getWorkspace } from "../db/repositories/workspaces"
import type {
  Initiative,
  SeatBinding,
  SeatBindingsSnapshot,
  SeatMessage,
  SeatSession,
} from "../db/types"
import type { TaskExecContext, TaskExecResult } from "../tasks/runner"
import {
  commsContextSection,
  getSeatComms,
  seatDirectory,
  USER_ADDRESS,
} from "./comms"
import { emitCommsChanged } from "./comms-events"
import { deliverQueued } from "./inbox"
import {
  narrowedSeatAgent,
  SEAT_CONTEXT_PRIORITY,
  seatContextSection,
} from "./seat-context"
import { resolveSingleSeat } from "./seat-resolver"
import { renderIntentChain } from "./slice-objective"
import {
  seatTurns,
  type SeatTurnIdentity,
  type SeatTurnRegistry,
} from "./seat-turns"

// Seat sessions and mail delivery (plan 106.4).
//
// A seat session is one hidden conversation for a seat in one scope: a slice
// session lives for one playbook run (a slice attempt or a hook run) and is
// closed when the run ends; an initiative session is long-lived and rotates
// into generations. Each playbook step picks its scope (step / slice /
// initiative). Mail for an idle seat wakes it through a durable `seat_wake`
// task that runs ONE turn in the seat's home; mail for a busy seat waits for
// the running turn's next tool-round boundary (inbox.ts).
//
// One seat, one mind. A seat never runs two turns at once, and mail follows
// the seat's work instead of opening a parallel conversation:
//   - While a running playbook still has STEP-scoped (fresh worker) steps for
//     the seat, its mail is HELD and delivered into its next step (at turn
//     start and at every tool-round boundary). Waking elsewhere would split the
//     seat into two agents that cannot see each other.
//   - While it still has slice-scoped steps, a wake lands in that run's slice
//     session: the same conversation those steps use, serialized by the turn
//     lock.
//   - Otherwise a wake lands where the seat last worked: a step worker or a
//     closed slice session is woken answer-only (the old 039 consultation);
//     otherwise the live initiative session, else a new one.
//
// Wake turns never mutate: the consult and answer-only profiles offer only
// read/search tools, so a message cannot cause a side effect.

export const SEAT_WAKE_KIND = "seat_wake"
export const SEAT_SESSION_TASK_KIND = "seat_session"
// Consecutive failed turns before a session is rotated automatically.
export const MAX_SESSION_FAILURES = 3
const HANDOFF_MAX_CHARS = 6000

export interface SeatTurnRunInput {
  conversationId: string
  workspace: string
  signal: AbortSignal
  agentOverride: AgentDefinition
  contextSections: ContextSection[]
  seat: SeatTurnIdentity
}

export interface SeatTurnRunResult {
  content?: string
  error?: string
  stopped?: boolean
}

export interface SeatSessionDeps {
  // One agent turn over an already-persisted transcript (runAgentLoop).
  runTurn(input: SeatTurnRunInput): Promise<SeatTurnRunResult>
  loadAgents(workspace: string): Promise<AgentDefinition[]>
  enqueueWake(input: {
    initiativeId: string
    address: string
    workspaceId: string | null
    title: string
  }): { id: string }
  cancelTask(taskId: string): void
}

interface Home {
  conversationId: string
  identity: SeatTurnIdentity
  session: SeatSession | null
  agentOverride: AgentDefinition
  contextSections: ContextSection[]
}

interface WakeInput {
  initiativeId?: string
  address?: string
}

function wakeKey(initiativeId: string, address: string): string {
  return `${initiativeId}\u0000${address}`
}

function workspacePathOf(initiative: Initiative): string | null {
  return initiative.workspaceId
    ? (getWorkspace(initiative.workspaceId)?.path ?? null)
    : null
}

// The seat as the rig snapshot defines it, without loading agent files: enough
// to create a session conversation.
function snapshotSeat(initiative: Initiative, address: string) {
  const rig = initiative.rigSnapshot
  if (!rig) return null
  for (const pod of rig.pods)
    for (const seat of rig.seats.filter((s) => s.podId === pod.id))
      if (`${seat.key}@${pod.key}` === address) return { seat, pod }
  return null
}

// A bounded digest of a retired generation for its successor. Reuses the
// rolling summary (plan 019) when one exists; otherwise the transcript tail.
// Never the raw transcript.
export function buildHandoffSummary(previous: SeatSession): string | null {
  if (!previous.conversationId) return null
  const header = `Generation ${previous.generation} was rotated${previous.rotationReason ? ` (${previous.rotationReason})` : ""}.`
  const summary = getConversationSummary(previous.conversationId)?.summary
  let body = summary?.trim() ?? ""
  if (!body) {
    const tail: string[] = []
    let size = 0
    const rows = listMessages(previous.conversationId)
    for (let i = rows.length - 1; i >= 0 && size < HANDOFF_MAX_CHARS; i--) {
      const row = rows[i]
      if ((row.role !== "assistant" && row.role !== "user") || !row.content?.trim())
        continue
      const line = `[${row.role === "assistant" ? "you" : "incoming"}] ${row.content.trim()}`
      tail.unshift(line)
      size += line.length
    }
    body = tail.join("\n\n")
  }
  if (!body) return header
  const bounded =
    body.length > HANDOFF_MAX_CHARS
      ? `…${body.slice(body.length - HANDOFF_MAX_CHARS)}`
      : body
  return `${header}\n\n${bounded}`
}

function handoffSection(session: SeatSession): ContextSection | null {
  if (!session.handoffSummary) return null
  return {
    name: "seat_session_handoff",
    priority: SEAT_CONTEXT_PRIORITY - 1,
    content: `## Handoff from your previous session\nYou are generation ${session.generation} of this seat's session. What your predecessor was working on:\n\n${session.handoffSummary}`,
    provenance: {
      trust: "untrusted_data",
      channel: "agent",
      source: `seat_session_handoff:${session.seatAddress}`,
      persisted: true,
    },
  }
}

export interface SeatOverview {
  address: string
  role: string
  podKey: string
  podName: string
  isLead: boolean
  vacant: boolean
  agentLabel: string | null
  busy: boolean
  inboxDepth: number
  // A wake task for this seat is waiting in the task queue, or running.
  wake: "queued" | "running" | null
  // Mail is waiting on purpose: the seat has fresh playbook steps still to
  // run, and the mail will be delivered into the next one.
  held: boolean
  // The most recent wake's failure, when it failed.
  lastWakeError: string | null
  // The live session a wake or step would use now: the running slice's session
  // when there is one, else the initiative session.
  session: LabeledSeatSession | null
  // Every session this seat has had in the initiative, newest first.
  generations: LabeledSeatSession[]
}

export type LabeledSeatSession = SeatSession & { label: string }

export class SeatSessionService {
  // Wake executors currently running, so dispatch never enqueues a second
  // wake for a seat whose wake is already mid-flight.
  private inFlight = new Set<string>()

  constructor(
    private readonly deps: SeatSessionDeps,
    private readonly registry: SeatTurnRegistry = seatTurns
  ) {
    // A turn that ends may leave mail behind (it arrived after the last
    // boundary): deliver it with a wake.
    registry.onRelease((turn) => this.dispatch(turn.initiativeId, turn.address))
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  // The seat's live session in a scope (the initiative, or one playbook run),
  // creating the next generation (with a handoff from the last retired one in
  // that scope) when none is live.
  ensureSession(
    initiative: Initiative,
    address: string,
    playbookRunId: string | null = null
  ): SeatSession {
    const live = sessions.getLiveSeatSession(initiative.id, address, playbookRunId)
    if (live?.conversationId) return live
    const found = snapshotSeat(initiative, address)
    if (!found) throw new Error(`No seat ${address} in this initiative's rig.`)
    if (!found.seat.agentRefId) throw new Error(`${address} is vacant.`)
    const created = getDb().transaction(() => {
      if (live) sessions.retireSeatSession(live.id, "closed", "Its conversation was deleted")
      const previous = sessions.listSeatSessions({
        initiativeId: initiative.id,
        seatAddress: address,
        playbookRunId,
      })[0]
      const generation = (previous?.generation ?? 0) + 1
      const runtime = found.seat.runtimeConfig?.worker ?? null
      const conversation = createConversation({
        mode: "interactive",
        workspaceId: initiative.workspaceId,
        accountId: runtime?.accountId ?? null,
        modelId: runtime?.modelId ?? null,
        agentName: found.seat.agentRefId,
        title: `${address} · ${playbookRunId ? scopeLabel(playbookRunId) : initiative.key} · gen ${generation}`,
      })
      // A task row hides the session from the chat sidebar, like a Process
      // worker; it is self-sourced, so the orphan reaper leaves it alone.
      createTask({
        conversationId: conversation.id,
        sourceConversationId: conversation.id,
        status: "completed",
        title: `${address} seat session`,
        input: {
          kind: SEAT_SESSION_TASK_KIND,
          initiativeId: initiative.id,
          address,
        },
      })
      return sessions.createSeatSession({
        initiativeId: initiative.id,
        seatAddress: address,
        conversationId: conversation.id,
        handoffSummary: previous ? buildHandoffSummary(previous) : null,
        playbookRunId,
      })
    })()
    emitCommsChanged(initiative.id)
    return created
  }

  // Retire the live generation and start the next one, carrying a bounded
  // handoff (never the raw transcript). Refused while a turn is running in it.
  rotate(sessionId: string, reason: string): SeatSession | null {
    const session = sessions.getSeatSession(sessionId)
    if (!session || !["idle", "busy"].includes(session.status)) return null
    if (session.conversationId && this.registry.conversationBusy(session.conversationId))
      throw new Error(
        `${session.seatAddress} is mid-turn. Rotate it after the turn ends.`
      )
    if (!sessions.retireSeatSession(session.id, "rotated", reason)) return null
    const initiative = initiatives.getInitiative(session.initiativeId)
    emitCommsChanged(session.initiativeId)
    if (!initiative) return null
    const found = snapshotSeat(initiative, session.seatAddress)
    // A seat that left the rig (or went vacant) has no successor, and neither
    // does a slice session whose run already ended.
    if (!found?.seat.agentRefId) return null
    if (session.playbookRunId && !runStillRunning(session.playbookRunId)) return null
    return this.ensureSession(initiative, session.seatAddress, session.playbookRunId)
  }

  // A rig Re-seat: every live initiative session starts a new generation
  // against the new snapshot, and seats that left the rig are closed. Slice
  // sessions follow their run's frozen bindings and are left alone.
  rotateInitiative(initiativeId: string, reason: string): void {
    const initiative = initiatives.getInitiative(initiativeId)
    for (const session of sessions.listSeatSessions({
      initiativeId,
      liveOnly: true,
      playbookRunId: null,
    })) {
      const stillSeated = initiative
        ? snapshotSeat(initiative, session.seatAddress)?.seat.agentRefId
        : null
      if (!stillSeated) {
        sessions.retireSeatSession(session.id, "closed", "The seat left the rig")
        continue
      }
      try {
        this.rotate(session.id, reason)
      } catch (err) {
        console.warn(`[comms] could not rotate ${session.seatAddress}:`, err)
      }
    }
    emitCommsChanged(initiativeId)
  }

  // A slice- or initiative-scoped playbook step runs in this conversation.
  // `playbookRunId` selects the slice scope; null is the initiative scope.
  sessionConversationForStep(
    initiativeId: string,
    address: string,
    playbookRunId: string | null
  ): string {
    const initiative = initiatives.getInitiative(initiativeId)
    if (!initiative) throw new Error("The initiative is no longer available.")
    return this.ensureSession(initiative, address, playbookRunId).conversationId!
  }

  // Close the slice sessions of every playbook run that is no longer running
  // (their transcripts stay readable and answerable).
  closeFinishedRunSessions(initiativeId?: string): void {
    const rows = getDb()
      .prepare(
        `SELECT DISTINCT s.scope_key AS runId, s.initiative_id AS initiativeId
         FROM seat_sessions s LEFT JOIN playbook_runs r ON r.id = s.scope_key
         WHERE s.scope = 'slice' AND s.status IN ('idle', 'busy')
           AND (r.id IS NULL OR r.status <> 'running')
           ${initiativeId ? "AND s.initiative_id = ?" : ""}`
      )
      .all(...(initiativeId ? [initiativeId] : [])) as Array<{
      runId: string
      initiativeId: string
    }>
    for (const row of rows) {
      sessions.closeRunSessions(row.runId)
      emitCommsChanged(row.initiativeId)
    }
  }

  markSessionActivity(conversationId: string, busy: boolean): void {
    const session = sessions.getSeatSessionByConversation(conversationId)
    if (!session) return
    sessions.setSeatSessionStatus(session.id, busy ? "busy" : "idle")
    emitCommsChanged(session.initiativeId)
  }

  overview(initiativeId: string): SeatOverview[] {
    const initiative = initiatives.getInitiative(initiativeId)
    if (!initiative?.rigSnapshot) return []
    const all = sessions
      .listSeatSessions({ initiativeId })
      .map((session) => ({ ...session, label: sessionLabel(session) }))
    return seatDirectory(initiative.rigSnapshot).map((seat) => {
      const generations = all.filter((s) => s.seatAddress === seat.address)
      const live = generations.filter(
        (s) => s.status === "idle" || s.status === "busy"
      )
      const inboxDepth = comms.countQueued(initiativeId, seat.address)
      const lastWake = latestWakeTask(initiativeId, seat.address)
      return {
        ...seat,
        busy: this.registry.seatBusy(initiativeId, seat.address),
        inboxDepth,
        wake: this.inFlight.has(wakeKey(initiativeId, seat.address))
          ? "running"
          : lastWake?.status === "queued"
            ? "queued"
            : lastWake?.status === "running"
              ? "running"
              : null,
        held: inboxDepth > 0 && pendingRunWork(initiativeId, seat.address),
        lastWakeError:
          lastWake?.status === "failed" ? (lastWake.error ?? "The wake failed.") : null,
        session:
          live.find((s) => s.scope === "slice") ??
          live.find((s) => s.scope === "initiative") ??
          null,
        generations,
      }
    })
  }

  // ── dispatch ──────────────────────────────────────────────────────────────

  // Get a seat's queued mail moving: a busy seat picks it up at its next turn
  // boundary; an idle one gets exactly one wake task.
  dispatch(initiativeId: string, address: string): void {
    if (address === USER_ADDRESS) return
    if (this.registry.seatBusy(initiativeId, address)) return
    if (pendingRunWork(initiativeId, address)) return
    if (this.inFlight.has(wakeKey(initiativeId, address))) return
    if (comms.countQueued(initiativeId, address) === 0) return
    if (this.queuedWake(initiativeId, address)) return
    const initiative = initiatives.getInitiative(initiativeId)
    // Mail for a paused or finished initiative waits; nothing wakes.
    if (!initiative || initiative.status !== "active") return
    this.deps.enqueueWake({
      initiativeId,
      address,
      workspaceId: initiative.workspaceId,
      title: `Wake ${address}`,
    })
    emitCommsChanged(initiativeId)
  }

  // Re-dispatch every seat in one initiative, e.g. when a playbook step or run
  // settles and mail held for its seats may now wake them.
  dispatchInitiative(initiativeId: string): void {
    for (const recipient of comms.listQueuedRecipients())
      if (recipient.initiativeId === initiativeId)
        this.dispatch(initiativeId, recipient.toAddress)
  }

  // A Process run (or a phase inside it) settled: release mail held for its
  // initiative's seats. Nested sub-process runs resolve to their root.
  onProcessRunActivity(processRunId: string): void {
    const initiativeId = missionControlInitiative(processRunId)
    if (!initiativeId) return
    this.closeFinishedRunSessions(initiativeId)
    this.dispatchInitiative(initiativeId)
  }

  // Boot: re-dispatch every seat with undelivered mail. Wakes interrupted
  // mid-turn resume through the task runner.
  dispatchAll(): void {
    sessions.resetBusySeatSessions()
    // Runs that ended while the app was down leave their slice sessions open.
    this.closeFinishedRunSessions()
    for (const { initiativeId, toAddress } of comms.listQueuedRecipients())
      this.dispatch(initiativeId, toAddress)
  }

  // A cancelled run stops its initiative's chatter: queued mail expires and
  // pending wakes are cancelled.
  cancelInitiative(initiativeId: string): void {
    getSeatComms()?.expireQueued(initiativeId)
    for (const taskId of this.wakeTasks(initiativeId)) this.deps.cancelTask(taskId)
  }

  private queuedWake(initiativeId: string, address: string): boolean {
    return !!getDb()
      .prepare(
        "SELECT 1 FROM tasks WHERE status = 'queued' AND json_extract(input, '$.kind') = ? AND json_extract(input, '$.initiativeId') = ? AND json_extract(input, '$.address') = ? LIMIT 1"
      )
      .get(SEAT_WAKE_KIND, initiativeId, address)
  }

  private wakeTasks(initiativeId: string): string[] {
    return getDb()
      .prepare(
        "SELECT id FROM tasks WHERE status IN ('queued', 'running') AND json_extract(input, '$.kind') = ? AND json_extract(input, '$.initiativeId') = ?"
      )
      .pluck()
      .all(SEAT_WAKE_KIND, initiativeId) as string[]
  }

  // ── the wake executor (task kind seat_wake) ──────────────────────────────

  execute = async (ctx: TaskExecContext): Promise<TaskExecResult> => {
    const input = (ctx.task.input ?? {}) as WakeInput
    if (!input.initiativeId || !input.address)
      return { error: "A seat wake needs an initiative and an address." }
    const key = wakeKey(input.initiativeId, input.address)
    this.inFlight.add(key)
    emitCommsChanged(input.initiativeId)
    try {
      return await this.wake(ctx, input.initiativeId, input.address)
    } finally {
      this.inFlight.delete(key)
      emitCommsChanged(input.initiativeId)
      // Mail that arrived during this wake (or while it waited) goes next.
      this.dispatch(input.initiativeId, input.address)
    }
  }

  private async wake(
    ctx: TaskExecContext,
    initiativeId: string,
    address: string
  ): Promise<TaskExecResult> {
    const initiative = initiatives.getInitiative(initiativeId)
    const workspace = initiative ? workspacePathOf(initiative) : null
    if (!initiative?.rigSnapshot || !workspace)
      return { content: "The initiative is no longer runnable; nothing woke." }

    // A crash after the claim left this task's delivery in a transcript already;
    // resume that turn instead of claiming (or appending) anything again.
    let delivered = comms.listByWakeTask(ctx.task.id)
    const resuming = delivered.length > 0
    if (!resuming && this.registry.seatBusy(initiativeId, address))
      return { content: `${address} is busy; its mail waits for the next turn boundary.` }
    if (!resuming && pendingRunWork(initiativeId, address))
      return {
        content: `${address} has playbook steps still to run; its mail waits for its next step.`,
      }

    const home = resuming
      ? await this.resumeHome(initiative, workspace, address, delivered[0])
      : await this.chooseHome(initiative, workspace, address)
    if (!home) return { content: `${address} has no usable seat to wake.` }

    const release = await this.registry.acquire(
      home.conversationId,
      home.identity,
      ctx.signal
    )
    try {
      if (!resuming) {
        const fresh = deliverQueued({
          identity: home.identity,
          conversationId: home.conversationId,
          wakeTaskId: ctx.task.id,
        })
        if (!fresh) return { content: "Nothing was queued." }
        delivered = fresh.messages
      }
      const identity: SeatTurnIdentity = {
        ...home.identity,
        wakeHop: Math.max(...delivered.map((m) => m.hop)),
        anchor: home.identity.anchor ?? threadAnchor(delivered[0]),
      }

      let content: string | undefined
      if (resuming && turnCompleted(home.conversationId, delivered[0])) {
        content = lastAssistantAfter(home.conversationId, delivered[0])
      } else {
        if (home.session) this.markSessionActivity(home.conversationId, true)
        const result = await this.deps.runTurn({
          conversationId: home.conversationId,
          workspace: homeWorkspace(home, workspace),
          signal: ctx.signal,
          agentOverride: home.agentOverride,
          contextSections: home.contextSections,
          seat: identity,
        })
        if (home.session) {
          this.markSessionActivity(home.conversationId, false)
          const after = sessions.recordSeatSessionTurn(home.session.id, !!result.error)
          if (result.error && after.failureCount >= MAX_SESSION_FAILURES)
            this.rotateAfterTurn(after, "repeated failures")
        }
        if (result.stopped) return { stopped: true }
        if (result.error) {
          this.settleDelivered(identity, delivered, undefined)
          return { error: result.error, retryable: false }
        }
        content = result.content
      }
      this.settleDelivered(identity, delivered, content)
      return { content: content ?? "" }
    } finally {
      release()
    }
  }

  // After the turn: a message that expected a reply and got none is answered
  // with the turn's final message; everything else delivered is acknowledged.
  private settleDelivered(
    identity: SeatTurnIdentity,
    delivered: SeatMessage[],
    finalContent: string | undefined
  ): void {
    const bus = getSeatComms()
    for (const original of delivered) {
      const message = comms.getMessage(original.id)
      if (!message || message.status !== "delivered") continue
      if (
        message.expectsReply &&
        finalContent?.trim() &&
        bus &&
        !comms.hasReplyFrom(message.id, identity.address)
      ) {
        const answer = bus.reply(identity, message.id, finalContent.trim(), {
          truncate: true,
        })
        if (answer.ok) continue
      }
      comms.transitionMessage(message.id, "acknowledged", ["delivered"])
    }
    emitCommsChanged(identity.initiativeId)
  }

  private rotateAfterTurn(session: SeatSession, reason: string): void {
    // Our own turn still holds the conversation; retire without the busy check.
    if (!sessions.retireSeatSession(session.id, "rotated", reason)) return
    emitCommsChanged(session.initiativeId)
  }

  // ── homes ─────────────────────────────────────────────────────────────────

  private async chooseHome(
    initiative: Initiative,
    workspace: string,
    address: string
  ): Promise<Home | null> {
    // Mid-run with slice-scoped steps still to come: the run's slice session,
    // the conversation those steps share.
    const sliceRun = pendingSteps(initiative.id, address).sliceRun
    if (sliceRun)
      return this.sessionHome(
        initiative,
        workspace,
        this.ensureSession(initiative, address, sliceRun)
      )
    // Done with its steps: where it last did playbook work holds its freshest
    // context, woken answer-only unless that was its initiative session.
    const worker = lastFinishedWork(initiative.id, address)
    if (worker) {
      const home = await this.workerHome(initiative, workspace, address, worker)
      if (home) return home
    }
    const live = sessions.getLiveSeatSession(initiative.id, address)
    if (live?.conversationId)
      return this.sessionHome(initiative, workspace, live)
    const found = snapshotSeat(initiative, address)
    if (!found?.seat.agentRefId) return null
    return this.sessionHome(
      initiative,
      workspace,
      this.ensureSession(initiative, address)
    )
  }

  private async resumeHome(
    initiative: Initiative,
    workspace: string,
    address: string,
    first: SeatMessage
  ): Promise<Home | null> {
    const conversationId = first.deliveredConversationId
    if (!conversationId) return null
    const session = sessions.getSeatSessionByConversation(conversationId)
    if (session && (session.status === "idle" || session.status === "busy"))
      return this.sessionHome(initiative, workspace, session)
    const worker = workerByConversation(conversationId)
    return worker
      ? this.workerHome(initiative, workspace, address, worker)
      : null
  }

  private async sessionHome(
    initiative: Initiative,
    workspace: string,
    session: SeatSession
  ): Promise<Home | null> {
    let bound: { snapshot: SeatBindingsSnapshot; seat: SeatBinding }
    let agents: AgentDefinition[]
    try {
      agents = await this.deps.loadAgents(workspace)
      // A slice session reads its run's frozen bindings, like the run's steps.
      const frozen = session.playbookRunId
        ? runBindings(session.playbookRunId)
        : null
      const seat = frozen?.seats[session.seatAddress]
      bound =
        frozen && seat
          ? { snapshot: frozen, seat }
          : resolveSingleSeat({
              rig: initiative.rigSnapshot!,
              address: session.seatAddress,
              agents,
              intentChain: renderIntentChain({ initiative }),
            })
    } catch (err) {
      console.warn(`[comms] cannot wake ${session.seatAddress}:`, err)
      return null
    }
    const agent = agents.find((a) => a.refId === bound.seat.agentName)
    if (!agent) return null
    const identity: SeatTurnIdentity = {
      initiativeId: initiative.id,
      address: session.seatAddress,
      profile: "consult",
      anchor: session.playbookRunId ? runAnchor(session.playbookRunId) : null,
      wakeHop: null,
    }
    return {
      conversationId: session.conversationId!,
      identity,
      session,
      agentOverride: narrowedSeatAgent(agent, bound.seat),
      contextSections: [
        seatContextSection(bound.snapshot, bound.seat),
        ...[handoffSection(session)].filter((s): s is ContextSection => !!s),
        commsContextSection(initiative, identity),
      ],
    }
  }

  private async workerHome(
    initiative: Initiative,
    workspace: string,
    address: string,
    worker: FinishedWorker
  ): Promise<Home | null> {
    const seat = worker.bindings?.seats[address]
    if (!worker.bindings || !seat) return null
    const agents = await this.deps.loadAgents(workspace).catch(() => [])
    const agent = agents.find((a) => a.refId === seat.agentName)
    if (!agent) return null
    const identity: SeatTurnIdentity = {
      initiativeId: initiative.id,
      address,
      profile: "answer_only",
      anchor: null,
      wakeHop: null,
    }
    return {
      conversationId: worker.conversationId,
      identity,
      session: null,
      agentOverride: narrowedSeatAgent(agent, seat),
      contextSections: [
        seatContextSection(worker.bindings, seat),
        commsContextSection(initiative, identity),
      ],
    }
  }
}

// ── lookups ─────────────────────────────────────────────────────────────────

// Where a wake turn looks at files: the folder the seat's work happened in.
// A slice built in its own worktree (plan 106.5) is read there while the
// worktree exists; otherwise the initiative workspace.
function homeWorkspace(home: Home, fallback: string): string {
  const row = (
    home.session?.playbookRunId
      ? getDb()
          .prepare(
            `SELECT w.path AS path FROM playbook_runs pb
             JOIN process_runs r ON r.id = pb.process_run_id
             JOIN workspaces w ON w.id = r.workspace_id
             WHERE pb.id = ?`
          )
          .get(home.session.playbookRunId)
      : getDb()
          .prepare(
            `SELECT w.path AS path FROM conversations c
             JOIN workspaces w ON w.id = c.workspace_id
             WHERE c.id = ?`
          )
          .get(home.conversationId)
  ) as { path: string } | undefined
  return row?.path && existsSync(row.path) ? row.path : fallback
}

interface FinishedWorker {
  conversationId: string
  bindings: SeatBindingsSnapshot | null
}

function parseBindings(json: string | null): SeatBindingsSnapshot | null {
  if (!json) return null
  try {
    return JSON.parse(json) as SeatBindingsSnapshot
  } catch {
    return null
  }
}

// The seat's most recent completed playbook step in this initiative (top-level
// Mission Control runs), when that step ran as a fresh worker or in a slice
// session: that conversation holds the work, and the seat is woken there
// answer-only. Null when the seat has not worked yet or last worked in its
// initiative session (which a wake then uses directly).
function lastFinishedWork(
  initiativeId: string,
  address: string
): FinishedWorker | null {
  const row = getDb()
    .prepare(
      `SELECT t.conversation_id AS conversationId, r.seat_bindings AS bindings,
              COALESCE(p.context_mode, 'step') AS scope
       FROM process_phase_runs pr
       JOIN process_runs r ON r.id = pr.run_id
       JOIN process_phases p ON p.id = pr.phase_id
       JOIN tasks t ON t.id = pr.task_id
       WHERE pr.seat_address = ? AND pr.status = 'completed'
         AND json_extract(r.mission_control, '$.initiativeId') = ?
       ORDER BY pr.finished_at DESC, pr.rowid DESC LIMIT 1`
    )
    .get(address, initiativeId) as
    | { conversationId: string; bindings: string | null; scope: string }
    | undefined
  // context_mode may still hold the pre-v51 values fresh / seat_session.
  return row && row.scope !== "initiative" && row.scope !== "seat_session"
    ? { conversationId: row.conversationId, bindings: parseBindings(row.bindings) }
    : null
}

const SETTLED_PHASE_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "skipped",
])

// What a running playbook in this initiative still has for this seat: any
// unsettled STEP-scoped step (mail is held for it), and the playbook run whose
// unsettled SLICE-scoped steps a wake should join. A step counts when its seat
// role resolved to this address; it is settled once any phase run for it
// reached a terminal status.
export function pendingSteps(
  initiativeId: string,
  address: string
): { step: boolean; sliceRun: string | null } {
  const pending = { step: false, sliceRun: null as string | null }
  const runIds = getDb()
    .prepare(
      "SELECT process_run_id FROM playbook_runs WHERE initiative_id = ? AND status = 'running' AND process_run_id IS NOT NULL"
    )
    .pluck()
    .all(initiativeId) as string[]
  for (const runId of runIds) {
    const run = processes.getProcessRun(runId)
    if (!run?.processId || !run.seatBindings || !run.missionControl) continue
    const roles = Object.entries(run.seatBindings.roles)
      .filter(([, addresses]) => addresses.includes(address))
      .map(([role]) => role)
    if (!roles.length) continue
    const graph = processes.getProcessGraph(run.processId)
    if (!graph) continue
    const settled = new Set(
      processes
        .listPhaseRuns({ runId: run.id })
        .filter((phaseRun) => SETTLED_PHASE_STATUSES.has(phaseRun.status))
        .map((phaseRun) => phaseRun.phaseId)
    )
    for (const phase of graph.phases) {
      const bound = graph.agents.some(
        (agent) =>
          agent.phaseId === phase.id &&
          !!agent.seatRole &&
          roles.includes(agent.seatRole)
      )
      if (!bound || settled.has(phase.id)) continue
      const scope = phase.contextScope ?? "step"
      if (scope === "step") pending.step = true
      else if (scope === "slice") pending.sliceRun ??= run.missionControl.playbookRunId
    }
  }
  return pending
}

// Mail is held only for a pending fresh-worker step.
export function pendingRunWork(initiativeId: string, address: string): boolean {
  return pendingSteps(initiativeId, address).step
}

function runStillRunning(playbookRunId: string): boolean {
  return playbooks.getPlaybookRun(playbookRunId)?.status === "running"
}

// A playbook run's frozen seat bindings.
function runBindings(playbookRunId: string): SeatBindingsSnapshot | null {
  const run = playbooks.getPlaybookRun(playbookRunId)
  const processRun = run?.processRunId
    ? processes.getProcessRun(run.processRunId)
    : run
      ? processes.getProcessRunByPlaybookRunId(run.id)
      : undefined
  return processRun?.seatBindings ?? null
}

function runAnchor(playbookRunId: string): SeatTurnIdentity["anchor"] {
  const run = playbooks.getPlaybookRun(playbookRunId)
  if (run?.sliceId) return { kind: "slice", id: run.sliceId }
  if (run?.missionId) return { kind: "mission", id: run.missionId }
  return null
}

// "slice add-slugify" / "before slices hook" — which run a slice session is for.
function scopeLabel(playbookRunId: string): string {
  const run = playbooks.getPlaybookRun(playbookRunId)
  if (!run) return "a finished run"
  if (run.sliceId) {
    const slice = initiatives.getSlice(run.sliceId)
    return slice ? `slice ${slice.key}` : "a slice"
  }
  return `${run.hook.replace(/_/g, " ")} hook`
}

function sessionLabel(session: SeatSession): string {
  if (session.scope === "initiative") return `long-lived · gen ${session.generation}`
  const label = scopeLabel(session.playbookRunId!)
  return session.generation > 1 ? `${label} · gen ${session.generation}` : label
}

function latestWakeTask(
  initiativeId: string,
  address: string
): { status: string; error: string | null } | null {
  return (
    (getDb()
      .prepare(
        "SELECT status, error FROM tasks WHERE json_extract(input, '$.kind') = ? AND json_extract(input, '$.initiativeId') = ? AND json_extract(input, '$.address') = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"
      )
      .get(SEAT_WAKE_KIND, initiativeId, address) as
      | { status: string; error: string | null }
      | undefined) ?? null
  )
}

// The initiative a Process run belongs to, through its root run's link.
function missionControlInitiative(processRunId: string): string | null {
  let run = processes.getProcessRun(processRunId)
  for (let depth = 0; run?.parentPhaseRunId && depth < 16; depth++) {
    const parent = processes.getPhaseRun(run.parentPhaseRunId)
    run = parent ? processes.getProcessRun(parent.runId) : undefined
  }
  return run?.missionControl?.initiativeId ?? null
}

function workerByConversation(conversationId: string): FinishedWorker | null {
  const row = getDb()
    .prepare(
      `SELECT r.seat_bindings AS bindings
       FROM process_phase_runs pr
       JOIN process_runs r ON r.id = pr.run_id
       JOIN tasks t ON t.id = pr.task_id
       WHERE t.conversation_id = ? LIMIT 1`
    )
    .get(conversationId) as { bindings: string | null } | undefined
  return row ? { conversationId, bindings: parseBindings(row.bindings) } : null
}

function threadAnchor(message: SeatMessage): SeatTurnIdentity["anchor"] {
  const thread = comms.getThread(message.threadId)
  return thread?.anchorKind === "slice" || thread?.anchorKind === "mission"
    ? { kind: thread.anchorKind, id: thread.anchorId! }
    : null
}

// Transcript rows after the tagged delivery turn.
function rowsAfter(conversationId: string, message: SeatMessage) {
  const rows = listMessages(conversationId)
  const index = rows.findIndex((row) => row.id === message.deliveredMessageId)
  return index < 0 ? [] : rows.slice(index + 1)
}

// The runtime notes the agent loop leaves when a turn does not finish: a stop
// (including an app quit mid-turn) or an early failure. Not an answer.
function isRuntimeNote(content: string | null | undefined): boolean {
  return /^(⚠️ The turn ended early|⏹ Stopped)/.test(content?.trim() ?? "")
}

// Did the wake turn already finish before a crash? Its last row is then a
// tool-free assistant answer. A quit mid-turn leaves a stop note instead,
// and that turn must run again, not be settled as answered.
function turnCompleted(conversationId: string, message: SeatMessage): boolean {
  const last = rowsAfter(conversationId, message).at(-1)
  return (
    !!last &&
    last.role === "assistant" &&
    !last.toolCalls?.length &&
    !isRuntimeNote(last.content)
  )
}

function lastAssistantAfter(
  conversationId: string,
  message: SeatMessage
): string | undefined {
  const last = rowsAfter(conversationId, message).at(-1)
  const content = last?.role === "assistant" ? last.content?.trim() : undefined
  return content && !isRuntimeNote(content) ? content : undefined
}

// The installed service, for the Process engine's seat-session steps and the
// IPC layer (constructed once in the main process).
let installed: SeatSessionService | null = null

export function installSeatSessions(instance: SeatSessionService | null): void {
  installed = instance
}

export function getSeatSessions(): SeatSessionService | null {
  return installed
}

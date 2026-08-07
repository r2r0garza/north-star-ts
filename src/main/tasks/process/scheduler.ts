import { randomUUID } from "crypto"
import {
  createApproval,
  listApprovals,
} from "../../db/repositories/approvals"
import {
  createCheckpoint,
  listCheckpoints,
} from "../../db/repositories/task-checkpoints"
import { getDb } from "../../db/connection"
import * as processes from "../../db/repositories/processes"
import type { TaskEventPayload } from "../runner"
import type {
  ProcessGraph,
  ProcessPhase,
  ProcessPhaseRun,
  ProcessRun,
} from "../../db/types"

// The DAG scheduler (plan 025). A ready-set walk over the process graph:
// dispatch every phase whose upstream dependencies are satisfied, run
// independent phases concurrently (bounded by a per-run pool), gate on
// approvals, and resume from persisted phase-run state after a crash.
//
// Phases run INLINE via an injected `runPhase` (the spawnSubagent precedent) —
// NOT re-enqueued as tasks — so a wide DAG can't deadlock under the runner's
// global concurrency cap. See service.ts for the production runPhase.

// The per-run concurrency budget: at most this many phase workers run at once
// within a single process run, layered UNDER the runner's global cap (the whole
// run holds just one global slot). Open Q #2.
export const PER_RUN_CONCURRENCY = 4

// Bounded retry for a phase whose worker returns a transient (retryable) error.
const MAX_PHASE_ATTEMPTS = 3

// The checkpoint label prefix for a fan-out parent's persisted sub-task prompts
// (plan 025.1). One row per parent phase-run, written atomically with the child
// rows so a crash can't leave prompt-less children. Recovered on resume so
// children re-dispatch with their original briefing.
const FANOUT_CHECKPOINT_LABEL = (parentRunId: string): string =>
  `fanout:${parentRunId}`

// The checkpoint label prefix for an `on_each_subtask` consumer's per-child
// instances (plan 025.2). Unlike the fan-out label (one cumulative row per
// parent, latest-wins), these are APPEND-ONLY — one row per triggered instance —
// so recovery unions all rows for a label. Keyed by the consumer's top-level
// (container) phase-run id. Each row records the source child that triggered it,
// the created instance's run id, and the instance's kickoff prompt.
const EACH_SUBTASK_CHECKPOINT_LABEL = (containerRunId: string): string =>
  `eachsubtask:${containerRunId}`

// Thrown to unwind the scheduler when an `approve` gate blocks the run. The
// service maps it to { paused: true } so the process_run task settles `paused`
// (a durable resume state) and frees its runner slot while awaiting approval.
export class GateBlockedError extends Error {
  constructor() {
    super("process run blocked on an approval gate")
    this.name = "GateBlockedError"
  }
}

// The outcome of running one phase's worker (the injected runPhase resolves it).
export interface PhaseResult {
  content?: string
  error?: string
  stopped?: boolean
  retryable?: boolean
}

// Runs one phase to completion in its own worker. Injected so tests can stub it.
// For a fan-out CHILD, `subtaskPrompt` carries the decomposed briefing; for a
// normal phase it's absent (the service builds the generic kickoff).
export type RunPhase = (input: {
  phaseRun: ProcessPhaseRun
  phase: ProcessPhase
  subtaskPrompt?: string
  // Chained to the run's abort signal by the caller.
  signal: AbortSignal
}) => Promise<PhaseResult>

// The outcome of a fan-out phase's decomposition pass: a list of sub-task
// briefings, or an error/stop like a normal phase (plan 025.1).
export interface DecomposeResult {
  subtasks?: string[]
  error?: string
  stopped?: boolean
  retryable?: boolean
}

// Runs a fan-out phase's decomposition worker. Injected so tests can stub it.
export type Decompose = (input: {
  phaseRun: ProcessPhaseRun
  phase: ProcessPhase
  signal: AbortSignal
}) => Promise<DecomposeResult>

// Builds the kickoff briefing for one `on_each_subtask` consumer instance (plan
// 025.2): the downstream phase V, plus the single completed fan-out child of the
// source phase C that triggered this instance. Injected so tests can stub it.
export type BuildEachSubtaskPrompt = (input: {
  // The downstream (consumer) phase — V.
  phase: ProcessPhase
  // The source phase C's completed child phase-run that triggered this instance.
  sourceChildRun: ProcessPhaseRun
}) => string

export interface SchedulerCtx {
  run: ProcessRun
  graph: ProcessGraph
  // The process_run backing task id — the anchor for approvals + checkpoints.
  taskId: string
  signal: AbortSignal
  emit: (event: TaskEventPayload) => void
  runPhase: RunPhase
  // Fan-out decomposition (plan 025.1). Optional so a graph with no fan-out
  // phases needs no decomposer; a fan-out phase with no decomposer fails loudly.
  decompose?: Decompose
  // Per-sub-task kickoff builder (plan 025.2). Optional so a graph with no
  // `on_each_subtask` edges needs none; absent when an each-subtask instance is
  // dispatched, the child falls back to no stored prompt (service builds one).
  buildEachSubtaskPrompt?: BuildEachSubtaskPrompt
}

// The state persisted in a fan-out parent's checkpoint (plan 025.1).
interface FanoutCheckpointState {
  parentPhaseRunId: string
  subtasks: Array<{ phaseRunId: string; prompt: string }>
}

// The state persisted per `on_each_subtask` instance (plan 025.2). One row per
// triggered instance; recovery unions all rows for a container's label.
interface EachSubtaskCheckpointState {
  // The consumer phase's top-level (container) phase-run id.
  containerPhaseRunId: string
  // The source fan-out child whose completion triggered this instance.
  sourceChildRunId: string
  // The created consumer instance's phase-run id.
  instanceRunId: string
  // The instance's kickoff briefing (persisted so resume needn't rebuild it).
  // Optional — absent when no prompt builder was injected (the run phase then
  // builds a generic kickoff from the graph).
  prompt?: string
}

// A gate's durable approval request blob (stored on the approvals row).
interface GateRequest {
  kind: "process_phase_gate"
  phaseKey: string
  phaseRunId: string
  requestId: string
}

export async function runScheduler(ctx: SchedulerCtx): Promise<void> {
  const { graph, run } = ctx
  const phasesById = new Map(graph.phases.map((p) => [p.id, p]))

  // Phases that are the target of ≥1 `on_each_subtask` edge whose SOURCE is a
  // fan-out phase (plan 025.2). These are "consumer" phases: their top-level run
  // is a CONTAINER (like a fan-out parent) — never dispatched as a monolith;
  // instead one child "instance" per completed source sub-task runs under it.
  // The `source.fanOut` guard means a mis-authored on_each_subtask edge on a
  // non-fan-out source is NOT treated as a consumer (it falls back to
  // on_complete via onCompleteSources below).
  const eachSubtaskConsumerPhaseIds = new Set<string>(
    graph.edges
      .filter((e) => {
        if (e.trigger !== "on_each_subtask") return false
        return phasesById.get(e.fromPhaseId)?.fanOut === true
      })
      .map((e) => e.toPhaseId)
  )

  // A CONTAINER phase's top-level run is settled by deriving from its children,
  // not by an in-flight promise: fan-out parents (025.1) and on_each_subtask
  // consumers (025.2) share this lifecycle (crash-reset, abort sweep, derivation).
  const isContainer = (phase: ProcessPhase): boolean =>
    phase.fanOut || eachSubtaskConsumerPhaseIds.has(phase.id)

  // Ensure a top-level phase_run row exists for every phase (idempotent across
  // resume: only create for phases that have no row yet). Fan-out children
  // (025.1) are created lazily by dispatch, so we only seed parent_id IS NULL.
  const existing = processes.listPhaseRuns({ runId: run.id, parentId: null })
  const runByPhaseId = new Map(existing.map((pr) => [pr.phaseId, pr]))
  for (const phase of graph.phases) {
    if (!runByPhaseId.has(phase.id)) {
      const pr = processes.createPhaseRun({
        runId: run.id,
        phaseId: phase.id,
        status: "pending",
      })
      runByPhaseId.set(phase.id, pr)
    }
  }

  // Recover any fan-out sub-task prompts persisted by a prior run BEFORE the
  // reset, so we know which fan-out parents already decomposed (plan 025.1).
  // createCheckpoint only ever INSERTs, so a re-decomposed parent can have >1 row
  // per label — take the LATEST (listCheckpoints returns created_at ASC).
  const childPrompts = new Map<string, string>() // childRunId → sub-task prompt
  const decomposedParents = new Set<string>() // parent phase-run ids seen fanned
  // Which (sourceChildRunId → consumerPhaseId) pairs already spawned an instance,
  // so an each-subtask trigger is idempotent across re-evaluation and resume (025.2).
  const triggeredPairs = new Set<string>()
  const triggeredKey = (sourceChildRunId: string, consumerPhaseId: string): string =>
    `${sourceChildRunId}->${consumerPhaseId}`
  for (const cp of listCheckpoints(ctx.taskId)) {
    if (cp.label?.startsWith("fanout:")) {
      const state = cp.state as FanoutCheckpointState
      if (!state?.parentPhaseRunId) continue
      decomposedParents.add(state.parentPhaseRunId)
      // Later rows overwrite earlier ones for the same child (ASC → latest wins).
      for (const st of state.subtasks ?? [])
        childPrompts.set(st.phaseRunId, st.prompt)
    } else if (cp.label?.startsWith("eachsubtask:")) {
      // Append-only: one row per instance — UNION all rows (do NOT latest-wins).
      const state = cp.state as EachSubtaskCheckpointState
      if (!state?.instanceRunId) continue
      if (state.prompt !== undefined)
        childPrompts.set(state.instanceRunId, state.prompt)
      const instance = processes.getPhaseRun(state.instanceRunId)
      if (instance)
        triggeredPairs.add(
          triggeredKey(state.sourceChildRunId, instance.phaseId)
        )
    }
  }

  // Reset crash-orphaned rows to `pending` so they re-dispatch. Widened for
  // containers (plan 025.1/025.2): child/instance rows reset too; a CONTAINER
  // top-level run WITH children is left `running` (its completion is derived from
  // the children each iteration); a container with NO children resets to `pending`
  // (a fan-out parent re-decomposes; an each-subtask consumer re-triggers). The
  // atomic child/instance-creation tx guarantees `running` ⇒ ≥1 committed child,
  // so leaving it `running` never strands a childless container.
  for (const pr of processes.listPhaseRuns({ runId: run.id })) {
    if (pr.status !== "running" && pr.status !== "ready") continue
    const phase = phasesById.get(pr.phaseId)
    const isContainerParent =
      pr.parentId === null && phase !== undefined && isContainer(phase)
    if (isContainerParent) {
      const children = processes.listPhaseRuns({ runId: run.id, parentId: pr.id })
      if (children.length > 0) continue // derivation resumes it; leave `running`
    }
    processes.updatePhaseRun(pr.id, { status: "pending" })
  }

  // In-flight phase workers, keyed by phaseRunId → the settle promise. Each
  // resolves to the phaseRunId that finished, so the race can identify it.
  const inFlight = new Map<string, Promise<string>>()

  // A resolved promise-per-abort so the race wakes on cancellation too.
  const abortPromise = new Promise<"__abort__">((resolve) => {
    if (ctx.signal.aborted) resolve("__abort__")
    else
      ctx.signal.addEventListener("abort", () => resolve("__abort__"), {
        once: true,
      })
  })

  const statusOf = (phaseId: string): string =>
    processes.getPhaseRun(runByPhaseId.get(phaseId)!.id)?.status ?? "pending"

  // Incoming dependency sources for a phase's readiness (the "wait for the whole
  // source" predicate). Includes on_complete edges AND on_each_subtask edges whose
  // source is NOT a fan-out phase (graceful fallback: an each-subtask edge only
  // has per-child meaning when the source fans out — otherwise it behaves as a
  // normal on_complete dependency). Genuine on_each_subtask edges (fan-out source)
  // are EXCLUDED here — they drive the consumer per-child via the fan-in trigger,
  // not as a monolithic dependency (plan 025.2).
  const onCompleteSources = (phaseId: string): string[] =>
    graph.edges
      .filter((e) => {
        if (e.toPhaseId !== phaseId) return false
        if (e.trigger !== "on_each_subtask") return true
        // on_each_subtask from a fan-out source → per-child, not a dep here.
        return phasesById.get(e.fromPhaseId)?.fanOut !== true
      })
      .map((e) => e.fromPhaseId)

  // Is the gate on a COMPLETED gated phase resolved? A phase with
  // gate_policy='approve' holds back its dependents until its approval row is
  // 'approved'. Reads the durable approvals table (resume-correct).
  const gateResolved = (phase: ProcessPhase): boolean => {
    if (phase.gatePolicy !== "approve") return true
    const pr = runByPhaseId.get(phase.id)!
    const rows = listApprovals({ taskId: ctx.taskId })
    const gate = rows.find((a) => {
      const req = a.request as GateRequest | null
      return req?.kind === "process_phase_gate" && req.phaseRunId === pr.id
    })
    return gate?.status === "approved"
  }

  // Create (once) the durable gate for a completed gated phase, flip the run to
  // waiting_for_approval, emit, checkpoint, and throw to unwind.
  const raiseGate = (phase: ProcessPhase): never => {
    const pr = runByPhaseId.get(phase.id)!
    const requestId = randomUUID()
    const request: GateRequest = {
      kind: "process_phase_gate",
      phaseKey: phase.key,
      phaseRunId: pr.id,
      requestId,
    }
    createApproval({ taskId: ctx.taskId, request })
    processes.updateProcessRun(run.id, { status: "waiting_for_approval" })
    // The phase itself stays `completed` — the gate is a run-level hold on its
    // dependents, not a change to the phase's own outcome. Keeping it `completed`
    // is also what makes resume correct: gateResolved()/needsGate() key off the
    // phase status + the durable approval row. The event still carries
    // waiting_for_approval so the monitor can render the pending gate.
    ctx.emit({
      type: "process_phase",
      runId: run.id,
      phaseRunId: pr.id,
      phaseKey: phase.key,
      agentName: pr.agentName,
      status: "waiting_for_approval",
      requestId,
    })
    checkpoint()
    throw new GateBlockedError()
  }

  // Does a gated phase need a gate raised? True when it's completed, has an
  // approve policy, at least one dependent, and no gate row exists yet.
  const needsGate = (phase: ProcessPhase): boolean => {
    if (phase.gatePolicy !== "approve") return false
    if (statusOf(phase.id) !== "completed") return false
    const hasDependents = graph.edges.some((e) => e.fromPhaseId === phase.id)
    if (!hasDependents) return false
    const pr = runByPhaseId.get(phase.id)!
    const rows = listApprovals({ taskId: ctx.taskId })
    const gate = rows.find((a) => {
      const req = a.request as GateRequest | null
      return req?.kind === "process_phase_gate" && req.phaseRunId === pr.id
    })
    return !gate // no gate row yet → needs raising
  }

  const checkpoint = (): void => {
    const snapshot = processes
      .listPhaseRuns({ runId: run.id })
      .map((pr) => ({ id: pr.id, phaseId: pr.phaseId, status: pr.status }))
    createCheckpoint({
      taskId: ctx.taskId,
      label: "frontier",
      state: { runId: run.id, phaseRuns: snapshot },
    })
  }

  // Dispatch a normal top-level phase (parentId IS NULL). Keyed in inFlight by
  // the phase's own top-level run id (via runByPhaseId).
  const dispatch = (phase: ProcessPhase): void => {
    const pr = runByPhaseId.get(phase.id)!
    processes.updatePhaseRun(pr.id, {
      status: "running",
      startedAt: Date.now(),
    })
    ctx.emit({
      type: "process_phase",
      runId: run.id,
      phaseRunId: pr.id,
      phaseKey: phase.key,
      agentName: pr.agentName,
      status: "running",
      parentId: pr.parentId,
    })
    const promise = runPhaseWithRetry(phase, pr).then(() => pr.id)
    inFlight.set(pr.id, promise)
  }

  // Dispatch a fan-out CHILD (plan 025.1). Keyed by the child's OWN run id — must
  // NOT go through dispatch()/runByPhaseId, which resolve to the parent (children
  // share the parent's phaseId). The child runs its stored sub-task briefing.
  const dispatchChild = (childRun: ProcessPhaseRun): void => {
    const phase = phasesById.get(childRun.phaseId)
    if (!phase) return
    processes.updatePhaseRun(childRun.id, {
      status: "running",
      startedAt: Date.now(),
    })
    ctx.emit({
      type: "process_phase",
      runId: run.id,
      phaseRunId: childRun.id,
      phaseKey: phase.key,
      agentName: childRun.agentName,
      status: "running",
      parentId: childRun.parentId,
    })
    const prompt = childPrompts.get(childRun.id)
    const promise = runPhaseWithRetry(phase, childRun, prompt).then(
      () => childRun.id
    )
    inFlight.set(childRun.id, promise)
  }

  // Run a fan-out phase's DECOMPOSITION pass (plan 025.1): set the parent
  // `running`, run the injected decomposer, and on success atomically create one
  // pending child per sub-task + persist their prompts (so a crash can't orphan
  // prompt-less children). The parent stays `running`; its completion is derived
  // from the children each iteration. Keyed in inFlight by the parent's run id.
  const dispatchDecompose = (phase: ProcessPhase): void => {
    const pr = runByPhaseId.get(phase.id)!
    processes.updatePhaseRun(pr.id, {
      status: "running",
      startedAt: Date.now(),
    })
    ctx.emit({
      type: "process_phase",
      runId: run.id,
      phaseRunId: pr.id,
      phaseKey: phase.key,
      agentName: pr.agentName,
      status: "running",
      parentId: pr.parentId,
    })
    const promise = runDecomposeWithRetry(phase, pr).then(() => pr.id)
    inFlight.set(pr.id, promise)
  }

  // Create N child phase-runs + persist their sub-task prompts in ONE transaction
  // so a crash between the two can't leave prompt-less children. Populates the
  // in-memory childPrompts map only AFTER the transaction commits.
  const createChildrenAtomic = (
    parentRun: ProcessPhaseRun,
    subtasks: string[]
  ): void => {
    let created: Array<{ phaseRunId: string; prompt: string }> = []
    const tx = getDb().transaction(() => {
      created = subtasks.map((prompt) => {
        const child = processes.createPhaseRun({
          runId: run.id,
          phaseId: parentRun.phaseId,
          parentId: parentRun.id,
          status: "pending",
        })
        return { phaseRunId: child.id, prompt }
      })
      createCheckpoint({
        taskId: ctx.taskId,
        label: FANOUT_CHECKPOINT_LABEL(parentRun.id),
        state: {
          parentPhaseRunId: parentRun.id,
          subtasks: created,
        } satisfies FanoutCheckpointState,
      })
    })
    tx()
    for (const c of created) childPrompts.set(c.phaseRunId, c.prompt)
  }

  // The `on_each_subtask` fan-in trigger (plan 025.2). For every on_each_subtask
  // edge from a fan-out source C to a consumer V, spawn one V "instance" per
  // completed C sub-task that hasn't triggered V yet — so V runs on each piece as
  // it lands, not after C's whole parent completes. Each instance is a child row
  // under V's top-level (container) run, dispatched by the SAME generic
  // pendingChildren loop + dispatchChild that fan-out children use.
  const triggerEachSubtask = (): void => {
    for (const e of graph.edges) {
      if (e.trigger !== "on_each_subtask") continue
      const source = phasesById.get(e.fromPhaseId)
      const consumer = phasesById.get(e.toPhaseId)
      if (!source?.fanOut || !consumer) continue

      // The consumer's container run must be live and its on_complete deps met.
      const containerRun = runByPhaseId.get(consumer.id)!
      const containerStatus = statusOf(consumer.id)
      if (isTerminalStatus(containerStatus)) continue
      const depsSatisfied = onCompleteSources(consumer.id).every((sid) => {
        const src = phasesById.get(sid)
        if (!src) return false
        return statusOf(sid) === "completed" && gateResolved(src)
      })
      if (!depsSatisfied) continue

      // One instance per not-yet-triggered COMPLETED child of the source.
      const srcRun = runByPhaseId.get(source.id)!
      const completed = processes
        .listPhaseRuns({ runId: run.id, parentId: srcRun.id })
        .filter((c) => c.status === "completed")
      for (const child of completed) {
        const key = triggeredKey(child.id, consumer.id)
        if (triggeredPairs.has(key)) continue
        // Fall back to undefined (NOT "") when no builder is injected, so the
        // service's `subtaskPrompt ?? kickoffPrompt(...)` builds a real kickoff —
        // an empty string is not nullish and would run the worker prompt-less.
        const prompt = ctx.buildEachSubtaskPrompt
          ? ctx.buildEachSubtaskPrompt({ phase: consumer, sourceChildRun: child })
          : undefined
        // Create instance + flip the container running (first transition only) +
        // persist the instance's prompt in ONE tx, so a crash can't strand a
        // prompt-less instance or a container without its instance row.
        let instanceId = ""
        const wasPending = statusOf(consumer.id) === "pending"
        const tx = getDb().transaction(() => {
          const instance = processes.createPhaseRun({
            runId: run.id,
            phaseId: consumer.id,
            parentId: containerRun.id,
            status: "pending",
          })
          instanceId = instance.id
          if (wasPending)
            processes.updatePhaseRun(containerRun.id, {
              status: "running",
              startedAt: Date.now(),
            })
          createCheckpoint({
            taskId: ctx.taskId,
            label: EACH_SUBTASK_CHECKPOINT_LABEL(containerRun.id),
            state: {
              containerPhaseRunId: containerRun.id,
              sourceChildRunId: child.id,
              instanceRunId: instance.id,
              prompt,
            } satisfies EachSubtaskCheckpointState,
          })
        })
        tx()
        if (prompt !== undefined) childPrompts.set(instanceId, prompt)
        triggeredPairs.add(key)
        // Emit the container's running transition once, on the first instance.
        if (wasPending) emitContainerRunning(consumer, containerRun.id)
      }
    }
  }

  const emitContainerRunning = (
    phase: ProcessPhase,
    phaseRunId: string
  ): void => {
    const pr = processes.getPhaseRun(phaseRunId)
    ctx.emit({
      type: "process_phase",
      runId: run.id,
      phaseRunId,
      phaseKey: phase.key,
      agentName: pr?.agentName ?? null,
      status: "running",
      parentId: pr?.parentId ?? null,
    })
  }

  const runDecomposeWithRetry = async (
    phase: ProcessPhase,
    parentRun: ProcessPhaseRun
  ): Promise<void> => {
    if (!ctx.decompose) {
      processes.updatePhaseRun(parentRun.id, {
        status: "failed",
        error: "fan-out phase has no decomposer configured",
        finishedAt: Date.now(),
      })
      emitPhase(phase, parentRun.id, "failed")
      return
    }
    let attempt = 0
    while (true) {
      attempt++
      const result = await ctx.decompose({
        phaseRun: parentRun,
        phase,
        signal: ctx.signal,
      })
      if (result.stopped || ctx.signal.aborted) {
        processes.updatePhaseRun(parentRun.id, {
          status: "cancelled",
          finishedAt: Date.now(),
        })
        emitPhase(phase, parentRun.id, "cancelled")
        return
      }
      const subtasks = result.subtasks ?? []
      if (result.error || subtasks.length === 0) {
        const err = result.error ?? "fan-out produced no sub-tasks"
        if (result.retryable && attempt < MAX_PHASE_ATTEMPTS) {
          processes.updatePhaseRun(parentRun.id, { iteration: attempt })
          continue
        }
        processes.updatePhaseRun(parentRun.id, {
          status: "failed",
          error: err,
          finishedAt: Date.now(),
          iteration: attempt,
        })
        emitPhase(phase, parentRun.id, "failed")
        return
      }
      // Success: spawn children. The parent stays `running` — deriveFanoutParents
      // settles it once every child is terminal.
      createChildrenAtomic(parentRun, subtasks)
      processes.updatePhaseRun(parentRun.id, { iteration: attempt })
      return
    }
  }

  const isTerminalStatus = (s: string): boolean =>
    ["completed", "failed", "cancelled", "skipped"].includes(s)

  // The completed fan-out children of the source phases feeding a consumer via
  // `on_each_subtask` edges — the set that each yields exactly one V instance
  // (plan 025.2). Used both to gate the derive count guard and to enumerate the
  // fan-in trigger's work. Also reports whether every such source is terminal.
  const eachSubtaskSourceState = (
    consumerPhaseId: string
  ): { completedChildren: ProcessPhaseRun[]; allSourcesTerminal: boolean } => {
    const completedChildren: ProcessPhaseRun[] = []
    let allSourcesTerminal = true
    for (const e of graph.edges) {
      if (e.toPhaseId !== consumerPhaseId) continue
      if (e.trigger !== "on_each_subtask") continue
      const src = phasesById.get(e.fromPhaseId)
      if (!src?.fanOut) continue
      const srcRun = runByPhaseId.get(src.id)!
      if (!isTerminalStatus(statusOf(src.id))) allSourcesTerminal = false
      const children = processes.listPhaseRuns({
        runId: run.id,
        parentId: srcRun.id,
      })
      for (const c of children)
        if (c.status === "completed") completedChildren.push(c)
    }
    return { completedChildren, allSourcesTerminal }
  }

  // Derive-settle a `running` CONTAINER top-level run from its children (plan
  // 025.1 fan-out parents + plan 025.2 on_each_subtask consumers). Both settle
  // via the same failed→cancelled→completed rule over terminal children.
  //
  // Run to a FIXPOINT: an each-subtask consumer's settle predicate reads its
  // source's status, and a single graph.phases pass might visit the consumer
  // BEFORE the source settles this iteration, leaving the consumer `running`
  // right as the walk's terminal check runs and returns. Repeating until no row
  // changes makes the result order-independent.
  const deriveContainers = (): void => {
    while (deriveContainersOnce()) {
      // settled ≥1 container; repeat so a consumer whose source just settled in
      // this same pass is re-evaluated before the walk's terminal check.
    }
  }

  // One pass; returns whether it settled any container (drives the fixpoint).
  const deriveContainersOnce = (): boolean => {
    let settledAny = false
    for (const phase of graph.phases) {
      if (!isContainer(phase)) continue
      const pr = runByPhaseId.get(phase.id)!
      const status = processes.getPhaseRun(pr.id)?.status
      // Derive from `running` containers; also derive an each-subtask consumer
      // that is still `pending` (never triggered) so it can settle `skipped` when
      // its sources finish with nothing to validate. A pending fan-out parent
      // hasn't decomposed yet — leave it for dispatch.
      const eligible =
        status === "running" ||
        (status === "pending" && !phase.fanOut)
      if (!eligible) continue
      const children = processes.listPhaseRuns({
        runId: run.id,
        parentId: pr.id,
      })

      if (phase.fanOut) {
        // Fan-out parent (025.1). R1 guard: only derive when children EXIST — a
        // parent whose decompose promise is still in flight has zero children, and
        // an empty `.every()` would vacuously settle it, orphaning the children
        // about to be created.
        if (children.length === 0) continue
      } else {
        // on_each_subtask consumer (025.2). A consumer is settled only once its
        // sources are ALL terminal — while a source is still producing sub-tasks,
        // more instances are owed, so an early "all current instances terminal"
        // must NOT settle it. Once sources are terminal: settle `skipped` if there
        // was nothing to validate (no completed children); otherwise wait until
        // one (now-terminal) instance exists per completed child (the count guard
        // closes the race where the last child completed but the fan-in trigger
        // hasn't created its instance yet).
        const { completedChildren, allSourcesTerminal } =
          eachSubtaskSourceState(phase.id)
        if (!allSourcesTerminal) continue // sources still producing → more owed
        if (completedChildren.length === 0) {
          processes.updatePhaseRun(pr.id, {
            status: "skipped",
            finishedAt: Date.now(),
          })
          emitPhase(phase, pr.id, "skipped")
          settledAny = true
          continue
        }
        if (children.length < completedChildren.length) continue // owed a trigger
      }

      if (!children.every((c) => isTerminalStatus(c.status))) continue
      const anyFailed = children.some((c) => c.status === "failed")
      const anyCancelled = children.some((c) => c.status === "cancelled")
      const derived = anyFailed
        ? "failed"
        : anyCancelled
          ? "cancelled"
          : "completed"
      processes.updatePhaseRun(pr.id, {
        status: derived,
        finishedAt: Date.now(),
      })
      emitPhase(phase, pr.id, derived)
      settledAny = true
    }
    return settledAny
  }

  const runPhaseWithRetry = async (
    phase: ProcessPhase,
    phaseRun: ProcessPhaseRun,
    subtaskPrompt?: string
  ): Promise<void> => {
    let attempt = 0
    // Chain a child controller so run-level cancel unwinds the phase worker.
    while (true) {
      attempt++
      const result = await ctx.runPhase({
        phaseRun,
        phase,
        subtaskPrompt,
        signal: ctx.signal,
      })
      const fresh = processes.getPhaseRun(phaseRun.id)!
      if (result.stopped || ctx.signal.aborted) {
        processes.updatePhaseRun(phaseRun.id, {
          status: "cancelled",
          finishedAt: Date.now(),
        })
        emitPhase(phase, phaseRun.id, "cancelled")
        return
      }
      if (result.error) {
        if (result.retryable && attempt < MAX_PHASE_ATTEMPTS) {
          processes.updatePhaseRun(phaseRun.id, { iteration: attempt })
          continue
        }
        processes.updatePhaseRun(phaseRun.id, {
          status: "failed",
          error: result.error,
          finishedAt: Date.now(),
          iteration: attempt,
        })
        emitPhase(phase, phaseRun.id, "failed")
        return
      }
      processes.updatePhaseRun(phaseRun.id, {
        status: "completed",
        finishedAt: Date.now(),
        iteration: attempt,
      })
      emitPhase(phase, phaseRun.id, "completed")
      void fresh
      return
    }
  }

  const emitPhase = (
    phase: ProcessPhase,
    phaseRunId: string,
    status: "completed" | "failed" | "cancelled" | "skipped"
  ): void => {
    const pr = processes.getPhaseRun(phaseRunId)
    ctx.emit({
      type: "process_phase",
      runId: run.id,
      phaseRunId,
      phaseKey: phase.key,
      agentName: pr?.agentName ?? null,
      status,
      parentId: pr?.parentId ?? null,
    })
  }

  // ── the walk ──────────────────────────────────────────────────────────────
  while (true) {
    if (ctx.signal.aborted) {
      // Cancellation: in-flight phase workers observe the same signal and unwind
      // themselves; just stop scheduling. The service maps this to `stopped`.
      // A CONTAINER's status isn't owned by any in-flight promise (a fan-out
      // parent's decompose already resolved; an each-subtask consumer is derived),
      // so settle non-terminal containers to cancelled here so the DAG isn't left
      // with a dangling `running` container (plan 025.1/025.2).
      for (const phase of graph.phases) {
        if (!isContainer(phase)) continue
        const pr = runByPhaseId.get(phase.id)!
        const status = processes.getPhaseRun(pr.id)?.status
        if (status === "running" || status === "pending") {
          processes.updatePhaseRun(pr.id, {
            status: "cancelled",
            finishedAt: Date.now(),
          })
          emitPhase(phase, pr.id, "cancelled")
        }
      }
      return
    }

    // Settle any CONTAINER whose children have all finished BEFORE gates and the
    // ready-set — a container counts as `completed` only via this step, and its
    // dependents key off that completion (plan 025.1 fan-out / 025.2 consumers).
    deriveContainers()

    // Spawn any owed on_each_subtask instances (plan 025.2) BEFORE the ready-set
    // and the terminal check: each completed source sub-task yields one consumer
    // instance, dispatched below by the generic pendingChildren loop.
    triggerEachSubtask()

    // Raise any pending gate BEFORE computing readiness — a gated completed phase
    // blocks its dependents until approved. raiseGate throws (GateBlockedError).
    for (const phase of graph.phases) {
      if (needsGate(phase)) raiseGate(phase)
    }

    // Ready = pending phase whose every on_complete source is completed AND (if a
    // source is gated) its gate is resolved. Multi-dependency joins fall out of
    // the "every source" quantifier — a phase with two parents waits for both.
    // on_each_subtask CONSUMER phases are excluded — they're driven per-child by
    // triggerEachSubtask, never dispatched as a monolith (plan 025.2).
    const ready = graph.phases.filter((phase) => {
      if (statusOf(phase.id) !== "pending") return false
      if (eachSubtaskConsumerPhaseIds.has(phase.id)) return false
      const sources = onCompleteSources(phase.id)
      return sources.every((sid) => {
        const src = phasesById.get(sid)
        if (!src) return false
        return statusOf(sid) === "completed" && gateResolved(src)
      })
    })

    // Dispatch ready phases up to the per-run pool budget. A fan-out phase whose
    // deps are satisfied runs its decomposition pass first (dispatchDecompose);
    // a normal phase runs directly.
    for (const phase of ready) {
      if (inFlight.size >= PER_RUN_CONCURRENCY) break
      if (phase.fanOut) dispatchDecompose(phase)
      else dispatch(phase)
    }

    // Dispatch any pending fan-out CHILD (plan 025.1). Children have no edges —
    // they're ready by construction once decompose created them — and share the
    // per-run pool with sibling phases.
    const pendingChildren = processes
      .listPhaseRuns({ runId: run.id })
      .filter((pr) => pr.parentId !== null && pr.status === "pending")
    for (const child of pendingChildren) {
      if (inFlight.size >= PER_RUN_CONCURRENCY) break
      if (inFlight.has(child.id)) continue
      dispatchChild(child)
    }

    if (inFlight.size === 0) {
      // Nothing running and nothing became ready. Either the run is complete
      // (all phases terminal) or it's wedged (a failed/cancelled phase blocks its
      // dependents forever). Both are terminal for the scheduler.
      const allTerminal = graph.phases.every((p) =>
        ["completed", "failed", "cancelled", "skipped"].includes(
          statusOf(p.id)
        )
      )
      const anyFailed = graph.phases.some((p) =>
        ["failed", "cancelled"].includes(statusOf(p.id))
      )
      if (!allTerminal || anyFailed) {
        // A dependency failed and blocks the rest → surface as a run failure.
        if (anyFailed) throw new Error("a process phase failed")
      }
      return
    }

    // Wake on the FIRST completion (not all) so on_each_subtask (025.2) and
    // greedy re-dispatch work; then re-evaluate the ready-set.
    const finished = await Promise.race([...inFlight.values(), abortPromise])
    if (finished !== "__abort__") {
      inFlight.delete(finished)
    }
    checkpoint()
  }
}

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
}

// The state persisted in a fan-out parent's checkpoint (plan 025.1).
interface FanoutCheckpointState {
  parentPhaseRunId: string
  subtasks: Array<{ phaseRunId: string; prompt: string }>
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
  for (const cp of listCheckpoints(ctx.taskId)) {
    if (!cp.label?.startsWith("fanout:")) continue
    const state = cp.state as FanoutCheckpointState
    if (!state?.parentPhaseRunId) continue
    decomposedParents.add(state.parentPhaseRunId)
    // Later rows overwrite earlier ones for the same child (ASC order → latest wins).
    for (const st of state.subtasks ?? []) childPrompts.set(st.phaseRunId, st.prompt)
  }

  // Reset crash-orphaned rows to `pending` so they re-dispatch. Widened for
  // fan-out (plan 025.1): children reset too; a fan-out parent WITH children is
  // left `running` (its completion is derived from the children each iteration);
  // a fan-out parent with NO children resets to `pending` to re-decompose.
  for (const pr of processes.listPhaseRuns({ runId: run.id })) {
    if (pr.status !== "running" && pr.status !== "ready") continue
    const phase = phasesById.get(pr.phaseId)
    const isFanoutParent =
      pr.parentId === null && phase?.fanOut === true
    if (isFanoutParent) {
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

  // Incoming on_complete edges for a phase (the dependency predicate). Edges with
  // an on_each_subtask trigger are ignored here — they're a 025.2 concern and,
  // absent fan-out, behave as a normal dependency once the source completes.
  const incomingSources = (phaseId: string): string[] =>
    graph.edges
      .filter((e) => e.toPhaseId === phaseId)
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

  // Settle a `running` fan-out parent once all its children are terminal (plan
  // 025.1). R1 guard: only derive when children EXIST — a parent whose decompose
  // promise is still in flight has zero children, and an empty `.every()` would
  // vacuously settle it, orphaning the children about to be created.
  const deriveFanoutParents = (): void => {
    for (const phase of graph.phases) {
      if (!phase.fanOut) continue
      const pr = runByPhaseId.get(phase.id)!
      if (processes.getPhaseRun(pr.id)?.status !== "running") continue
      const children = processes.listPhaseRuns({
        runId: run.id,
        parentId: pr.id,
      })
      if (children.length === 0) continue // not yet decomposed — R1 guard
      const isTerminal = (s: string): boolean =>
        ["completed", "failed", "cancelled", "skipped"].includes(s)
      if (!children.every((c) => isTerminal(c.status))) continue
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
    }
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
    status: "completed" | "failed" | "cancelled"
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
      // A fan-out parent's status isn't owned by any in-flight promise (its
      // decompose already resolved), so settle non-terminal parents to cancelled
      // here so the DAG isn't left with a dangling `running` parent (plan 025.1).
      for (const phase of graph.phases) {
        if (!phase.fanOut) continue
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

    // Settle any fan-out parent whose children have all finished BEFORE gates and
    // the ready-set — a fan-out parent counts as `completed` only via this step,
    // and its dependents key off that completion (plan 025.1).
    deriveFanoutParents()

    // Raise any pending gate BEFORE computing readiness — a gated completed phase
    // blocks its dependents until approved. raiseGate throws (GateBlockedError).
    for (const phase of graph.phases) {
      if (needsGate(phase)) raiseGate(phase)
    }

    // Ready = pending phase whose every on_complete source is completed AND (if a
    // source is gated) its gate is resolved. Multi-dependency joins fall out of
    // the "every source" quantifier — a phase with two parents waits for both.
    const ready = graph.phases.filter((phase) => {
      if (statusOf(phase.id) !== "pending") return false
      const sources = incomingSources(phase.id)
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

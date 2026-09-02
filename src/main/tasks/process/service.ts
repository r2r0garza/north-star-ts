import { createHash } from "crypto"
import { runAgentLoop, generateTitle } from "../../agent"
import { SHUTDOWN_ABORT_REASON, PAUSE_ABORT_REASON } from "../../agent/abort"
import {
  createConversation,
  deleteConversation,
  getConversation,
} from "../../db/repositories/conversations"
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
} from "../../db/repositories/tasks"
import { listMessages } from "../../db/repositories/messages"
import { getWorkspace, upsertWorkspace } from "../../db/repositories/workspaces"
import * as processes from "../../db/repositories/processes"
import { listApprovals, resolveApproval } from "../../db/repositories/approvals"
import { getDb } from "../../db/connection"
import { createCheckpoint } from "../../db/repositories/task-checkpoints"
import {
  SUBPROCESS_CHECKPOINT_LABEL,
  type SubprocessCheckpointState,
} from "./checkpoints"
import type { TaskRunner, TaskExecutor } from "../runner"
import type { LlmSelection } from "../../agent/providers"
import { route } from "./router"
import type {
  ProcessGraph,
  ProcessPhase,
  ProcessPhaseRun,
  ProcessRun,
} from "../../db/types"
import {
  decompositionRetryNote,
  eachSubtaskKickoffPrompt,
  fanOutDecomposePrompt,
  kickoffPrompt,
  parseDecomposition,
  parseVerdict,
  validatorPrompt,
  type UpstreamResult,
} from "./prompts"
import {
  GateBlockedError,
  MAX_PROCESS_DEPTH,
  runScheduler,
  type BuildEachSubtaskPrompt,
  type Decompose,
  type DecomposeResult,
  type PhaseResult,
  type RunPhase,
  type RunSubProcess,
  type Validate,
} from "./scheduler"
import {
  applyFlagBack,
  resetRunRecursive,
  resetSubProcessChild,
} from "./flagback"
import { unknownSideEffectingToolCalls } from "../../agent/repair"

// The DAG orchestrator task kind (plan 025). One ProcessService per app, holding
// the runner reference so startRun can enqueue the process_run task. The executor
// is deterministic (the scheduling logic) — the phases it drives are the LLM work,
// run inline via runAgentLoop in forked worker conversations.
export const PROCESS_RUN_KIND = "process_run"

// The process_run task's input blob (015 producer contract): the run id, so the
// executor finds its run on first run AND on autoResume after a crash.
interface ProcessRunInput {
  processRunId?: string
}

interface ProcessWorkerTaskInput {
  kind?: string
  phaseRunId?: string
  agentName?: string | null
  validatorRound?: number
  reviewTargetOutputIdentity?: string | null
}

// Settle an aborted run's status by WHY it aborted (plan 038.3). A SHUTDOWN (app
// quit) or PAUSE abort is RESUMABLE — leave the run `running` so the next boot's
// reconcile flips it interrupted→queued and the scheduler resumes (the phase-runs
// are likewise left untouched by the scheduler's resumable-abort branch). Only a
// genuine user CANCEL (plain abort, no reason) is terminal → `cancelled`.
function isResumableAbort(signal: AbortSignal): boolean {
  return (
    signal.reason === SHUTDOWN_ABORT_REASON ||
    signal.reason === PAUSE_ABORT_REASON
  )
}

function settleAbortedRun(runId: string, signal: AbortSignal): void {
  if (isResumableAbort(signal)) return
  processes.updateProcessRun(runId, {
    status: "cancelled",
    finishedAt: Date.now(),
  })
}

// Map an aborted executor to a runner result by WHY it aborted (plan 038.3): a
// resumable SHUTDOWN/PAUSE → `paused` (the runner leaves it recoverable — a
// process_run auto-resumes), a genuine cancel → `stopped` (terminal `cancelled`).
function abortedResult(
  signal: AbortSignal
): { paused: true } | { stopped: true } {
  return isResumableAbort(signal) ? { paused: true } : { stopped: true }
}

export class ProcessService {
  constructor(private readonly runner: TaskRunner) {}

  // Start a new run of a definition: create the run row, enqueue the backing
  // process_run task (sourced to the originating conversation so it's user-facing
  // and eligible for a completion notification), and link them. Returns the run.
  async startRun(input: {
    processId: string
    sourceConversationId: string | null
    objective: string
    // The run's working directory (plan 026). A run started from the Process
    // screen has no source conversation to inherit a workspace from, so the
    // picked folder is deduped into the workspaces table and stamped on the run.
    workspacePath?: string | null
  }): Promise<ProcessRun> {
    const definition = processes.getProcessDefinition(input.processId)
    if (!definition) throw new Error(`unknown process '${input.processId}'`)

    const workspaceId = input.workspacePath?.trim()
      ? upsertWorkspace(input.workspacePath.trim()).id
      : null

    const run = processes.createProcessRun({
      processId: input.processId,
      sourceConversationId: input.sourceConversationId,
      workspaceId,
      objective: input.objective,
      status: "queued",
    })

    const task = this.runner.enqueueKind({
      kind: PROCESS_RUN_KIND,
      title: `Process: ${definition.name}`,
      sourceConversationId: input.sourceConversationId,
      input: { processRunId: run.id } satisfies ProcessRunInput,
    })

    // Generate a short display title from the objective (mirrors how a
    // conversation is titled from its first message). The classifier model is
    // inherited from the source conversation's selection; resolveLlm falls back
    // to the global default when it has none. generateTitle never rejects (it
    // falls back to a trimmed objective slice), so awaiting it can't fail the run.
    const source = input.sourceConversationId
      ? getConversation(input.sourceConversationId)
      : null
    const selection: LlmSelection = {
      accountId: source?.accountId ?? null,
      modelId: source?.modelId ?? null,
    }
    const title = input.objective.trim()
      ? await generateTitle(input.objective, selection)
      : null

    return processes.updateProcessRun(run.id, { taskId: task.id, title })
  }

  // Retry a FAILED run from its failure frontier: reset the failed/cancelled
  // phase-runs (and their container children) to re-runnable, flip the run back to
  // running, and re-drive the SAME backing task (runner.restart) so its checkpoints
  // — fan-out child prompts + each-subtask idempotency, keyed by task id — survive.
  // Completed/skipped phases are left alone; the scheduler resumes from the reset
  // frontier. No-op unless the run is `failed` with a backing task.
  //
  // Sub-process phases (plan 038.2): resetRunRecursive descends into a failed
  // sub-process phase-run's CHILD run (linked by parent_phase_run_id) and resets ITS
  // failed frontier too, transitively — 038.1 re-attached to the child but never
  // reset it, so a run that failed INSIDE a sub-process re-failed on every retry.
  restartRun(runId: string): ProcessRun | undefined {
    const run = processes.getProcessRun(runId)
    if (!run || run.status !== "failed" || !run.taskId || !run.processId)
      return run
    const graph = processes.getProcessGraph(run.processId)
    if (!graph) return run
    this.assertNoUnknownProcessWorkerOutcomes(run)

    const tx = getDb().transaction(() => {
      resetRunRecursive({ taskId: run.taskId!, run, graph, mode: "frontier" })
    })
    tx()

    const updated = processes.updateProcessRun(runId, {
      status: "running",
      finishedAt: null,
    })
    this.runner.restart(run.taskId)
    return updated
  }

  // Approve a pending process gate. A validator gate approval is explicitly a
  // human manual override of an unavailable/exhausted review, not a validator
  // approval, so persist that distinction in the decision blob before resuming.
  approve(input: {
    processRunId: string
    requestId: string
  }): ProcessRun | undefined {
    const { processRunId, requestId } = input
    const run = processes.getProcessRun(processRunId)
    if (!run?.taskId) return run

    const approval = listApprovals({ taskId: run.taskId }).find((a) => {
      const req = a.request as { requestId?: string } | null
      return req?.requestId === requestId && a.status === "pending"
    })
    if (!approval) return run

    const req = approval.request as {
      kind?: string
      phaseKey?: string
      phaseRunId?: string
    } | null

    if (req?.kind === "process_validator_gate") {
      const phaseRun = req.phaseRunId
        ? processes.getPhaseRun(req.phaseRunId)
        : undefined
      resolveApproval(approval.id, {
        status: "approved",
        decision: {
          manualOverride: true,
          gateKind: "process_validator_gate",
          requestId,
          phaseKey: req.phaseKey ?? null,
          phaseRunId: req.phaseRunId ?? null,
          failureReason: phaseRun?.error ?? null,
          actor: "user",
        },
      })
      this.runner.markRunning(run.taskId)
      this.runner.resume(run.taskId)
      return processes.getProcessRun(processRunId)
    }

    this.runner.recordApprovalDecision(run.taskId, requestId, "approved")
    this.runner.resume(run.taskId)
    return processes.getProcessRun(processRunId)
  }

  // Request changes on a gated phase (plan 029): the third gate decision beside
  // approve/deny. Settle the pending gate `denied` (feedback stored in the
  // decision blob for the review trail), reset the gated phase-run to `pending`
  // with the feedback stamped as its rework_note + the round counter bumped, flip
  // the run back to `running`, then resume the backing task. The scheduler
  // re-derives from the DB, re-runs the phase's worker (kickoff carries the note),
  // and re-gates once it re-completes (needsGate re-fires off the fresh finishedAt).
  //
  // Plan 038.2: the gated phase may belong to a NESTED sub-process run (a gate raised
  // inside the child surfaces on the shared task). The gate's phase belongs to the
  // OWNING run's graph, not necessarily processRunId's — resolve the owning run from
  // phaseRun.runId and use ITS graph for the container guard. And a SUB-PROCESS phase
  // itself is now sendable-back: reset the phase-run + whole-reset its child run with
  // the feedback injected into the child's entry phases (was rejected in 038.1).
  requestChanges(input: {
    processRunId: string
    requestId: string
    feedback: string
  }): ProcessRun | undefined {
    const { processRunId, requestId, feedback } = input
    const topRun = processes.getProcessRun(processRunId)
    if (!topRun?.taskId) return topRun
    const taskId = topRun.taskId

    // Find the pending gate row by its process-unique requestId, and read the
    // gated phase-run off the durable request blob.
    const approval = listApprovals({ taskId }).find((a) => {
      const req = a.request as { requestId?: string } | null
      return req?.requestId === requestId && a.status === "pending"
    })
    if (!approval) return topRun
    const req = approval.request as { phaseRunId?: string } | null
    const phaseRunId = req?.phaseRunId
    if (!phaseRunId) return topRun

    const phaseRun = processes.getPhaseRun(phaseRunId)
    if (!phaseRun) return topRun
    const phase = processes.getPhase(phaseRun.phaseId)
    if (!phase) return topRun

    // The run that OWNS this phase-run — the top-level run for a top-level gate, or a
    // nested sub-process run for a child-internal gate. Its graph is the correct one
    // for the container guard below.
    const owningRun = processes.getProcessRun(phaseRun.runId)
    if (!owningRun) return topRun
    this.assertNoUnknownPhaseWorkerOutcomes(phaseRun)
    const owningGraph = owningRun.processId
      ? processes.getProcessGraph(owningRun.processId)
      : undefined

    // Reject a container phase (fan-out / on_each_subtask consumer of a fan-out
    // source): resetting it to `pending` would re-decompose / re-trigger and
    // duplicate children — sub-DAG replay is plan 031's concern. Uses the OWNING
    // run's graph so a child-internal container is judged correctly (plan 038.2).
    if (owningGraph) {
      const phasesById = new Map(owningGraph.phases.map((p) => [p.id, p]))
      const isEachSubtaskConsumer = owningGraph.edges.some(
        (e) =>
          e.toPhaseId === phase.id &&
          e.trigger === "on_each_subtask" &&
          phasesById.get(e.fromPhaseId)?.fanOut === true
      )
      if (phase.fanOut || isEachSubtaskConsumer)
        throw new Error(
          "cannot request changes on a fan-out / on_each_subtask phase (v1)"
        )
    }

    // Enforce the per-phase rework cap (0 = unlimited).
    if (
      phase.maxReworkRounds > 0 &&
      phaseRun.reworkRound >= phase.maxReworkRounds
    )
      throw new Error(
        `rework cap reached (${phase.maxReworkRounds}); approve or deny`
      )

    const tx = getDb().transaction(() => {
      resolveApproval(approval.id, {
        status: "denied",
        decision: { feedback, rework: true },
      })
      processes.updatePhaseRun(phaseRunId, {
        status: "pending",
        error: null,
        startedAt: null,
        finishedAt: null,
        reworkNote: feedback,
        reworkRound: phaseRun.reworkRound + 1,
        // Reset the validator's own counter (plan 031.1): a human send-back grants
        // the re-run a fresh budget of automatic validator rounds. Harmless on a
        // non-validator phase (stays 0).
        validatorRound: 0,
        outputIdentity: null,
      })
      // A SUB-PROCESS phase (plan 038.2): the phase's work is a nested run, so the
      // rework_note alone re-runs nothing. Whole-reset the child run with the
      // feedback injected into its entry phases; the re-drive re-attaches to the
      // child and re-executes it top-to-bottom. (v1 limitation: if a child entry
      // phase is itself fan-out/sub-process, the note isn't read by its
      // decompose/sub-process prompt — only plain entry phases surface it, but the
      // whole reset still re-runs the entire child.)
      if (phase.subprocessId) resetSubProcessChild(taskId, phaseRun, feedback)
      // Flip the OWNING run (and every ancestor up to the top-level) running so the
      // nested driveRun re-owns it on resume (plan 038.2). For a top-level gate this
      // is just processRunId.
      this.flipRunningToTop(owningRun)
    })
    tx()

    // better-sqlite3 is synchronous, so the tx has committed — resume re-drives
    // the (paused) backing task, which rebuilds runByPhaseId from the fresh DB.
    const updated = processes.getProcessRun(processRunId)
    this.runner.resume(taskId)
    return updated
  }

  // Retry only the validator reviewer for a validator-unavailable gate (plan 084).
  // The phase worker already completed and its taskId is the stable review input;
  // do not reset that worker, do not bump reworkRound, and do not consume a
  // validatorRound (valid negative verdicts own that counter). Instead, settle the
  // current validator gate with an audit marker, remove the stale reviewer worker
  // for this same validatorRound so makeValidate sends a fresh prompt, flip the
  // phase back to pending, and resume the owning run.
  retryReview(input: {
    processRunId: string
    requestId: string
  }): ProcessRun | undefined {
    const { processRunId, requestId } = input
    const topRun = processes.getProcessRun(processRunId)
    if (!topRun?.taskId) return topRun
    const taskId = topRun.taskId

    const approval = listApprovals({ taskId }).find((a) => {
      const req = a.request as { requestId?: string; kind?: string } | null
      return (
        req?.requestId === requestId &&
        req.kind === "process_validator_gate" &&
        a.status === "pending"
      )
    })
    if (!approval) return topRun
    const req = approval.request as { phaseRunId?: string } | null
    const phaseRunId = req?.phaseRunId
    if (!phaseRunId) return topRun

    const phaseRun = processes.getPhaseRun(phaseRunId)
    if (!phaseRun?.taskId) return topRun
    const phase = processes.getPhase(phaseRun.phaseId)
    if (!phase?.validator) return topRun
    const owningRun = processes.getProcessRun(phaseRun.runId)
    if (!owningRun) return topRun

    const staleReviewTask = this.findProcessWorkerTask(
      phaseRun.id,
      "process_phase_validate",
      phaseRun.validatorRound
    )

    const tx = getDb().transaction(() => {
      resolveApproval(approval.id, {
        status: "denied",
        decision: { retryReview: true },
      })
      if (staleReviewTask) {
        deleteTask(staleReviewTask.id)
        deleteConversation(staleReviewTask.conversationId)
      }
      processes.updatePhaseRun(phaseRun.id, {
        status: "pending",
        error: null,
        startedAt: null,
        finishedAt: null,
        reworkNote: null,
      })
      this.flipRunningToTop(owningRun)
    })
    tx()

    const updated = processes.getProcessRun(processRunId)
    this.runner.resume(taskId)
    return updated
  }

  // Flip a run and every ancestor run (up the parent_phase_run_id chain) to
  // `running` (plan 038.2). A child-internal gate/flag left only the child run
  // waiting_for_approval; on send-back the whole owning chain must be running so the
  // nested driveRun re-derives it. Bounded by MAX_PROCESS_DEPTH (the DAG has no cycle
  // guard). Idempotent on an already-running run.
  private flipRunningToTop(run: ProcessRun): void {
    let cur: ProcessRun | undefined = run
    let depth = 0
    while (cur && depth < MAX_PROCESS_DEPTH) {
      processes.updateProcessRun(cur.id, {
        status: "running",
        finishedAt: null,
      })
      if (!cur.parentPhaseRunId) break
      const parentPhaseRun = processes.getPhaseRun(cur.parentPhaseRunId)
      cur = parentPhaseRun
        ? processes.getProcessRun(parentPhaseRun.runId)
        : undefined
      depth++
    }
  }

  // Confirm a pending cross-phase rework flag (plan 031.2): the human approved the
  // send-back raised by raiseFlagGate. Settle the gate approved, apply the flag's
  // reset (target + downstream → pending, via the shared flagback module), mark the
  // flag applied, flip the run running, then resume — the scheduler re-walks and
  // re-runs the reset phases. Mirrors requestChanges' shape.
  confirmFlag(input: {
    processRunId: string
    requestId: string
  }): ProcessRun | undefined {
    const { processRunId, requestId } = input
    const topRun = processes.getProcessRun(processRunId)
    if (!topRun?.taskId) return topRun
    const taskId = topRun.taskId

    const approval = listApprovals({ taskId }).find((a) => {
      const req = a.request as { requestId?: string } | null
      return req?.requestId === requestId && a.status === "pending"
    })
    if (!approval) return topRun
    const req = approval.request as { flagId?: string } | null
    const flag = req?.flagId ? processes.getFlag(req.flagId) : undefined
    if (!flag || flag.status !== "pending") return topRun
    this.assertNoUnknownProcessWorkerOutcomes(topRun)

    // The flag targets a phase in the run that OWNS it — the top-level run for a
    // top-level flag, or a nested sub-process run for a child-internal flag (plan
    // 038.2). Resolve that run + graph from the durable flag's run_id; applyFlagBack
    // scopes all its resets/checkpoint deletes to the passed runId/graph, so a
    // child-internal flag resets the CHILD's phases (038.1 used the top graph — a
    // genuine wrong-graph bug for a nested flag).
    const owningRun = processes.getProcessRun(flag.runId)
    const owningGraph = owningRun?.processId
      ? processes.getProcessGraph(owningRun.processId)
      : undefined
    if (!owningRun || !owningGraph) return topRun

    const tx = getDb().transaction(() => {
      resolveApproval(approval.id, { status: "approved" })
      applyFlagBack({
        taskId,
        runId: owningRun.id,
        graph: owningGraph,
        target: {
          targetPhaseId: flag.targetPhaseId,
          targetChildRunId: flag.targetChildRunId ?? undefined,
        },
        reason: flag.reason,
      })
      processes.updateFlagStatus(flag.id, "applied")
      this.flipRunningToTop(owningRun)
    })
    tx()

    const updated = processes.getProcessRun(processRunId)
    this.runner.resume(taskId)
    return updated
  }

  // Dismiss a pending cross-phase rework flag (plan 031.2): the human rejected the
  // send-back. Settle the gate denied, mark the flag dismissed, resume — the run
  // continues as if unflagged (the flagging phase's output stands). The scheduler
  // re-routes any OTHER pending flag on the next quiescence.
  dismissFlag(input: {
    processRunId: string
    requestId: string
  }): ProcessRun | undefined {
    const { processRunId, requestId } = input
    const topRun = processes.getProcessRun(processRunId)
    if (!topRun?.taskId) return topRun
    const taskId = topRun.taskId

    const approval = listApprovals({ taskId }).find((a) => {
      const req = a.request as { requestId?: string } | null
      return req?.requestId === requestId && a.status === "pending"
    })
    if (!approval) return topRun
    const req = approval.request as { flagId?: string } | null
    const flag = req?.flagId ? processes.getFlag(req.flagId) : undefined
    // The run that owns the flag (top-level or a nested sub-process run, plan
    // 038.2) — flip it (and its ancestors) running so the owning driveRun resumes.
    const owningRun = flag ? processes.getProcessRun(flag.runId) : topRun

    const tx = getDb().transaction(() => {
      resolveApproval(approval.id, { status: "denied" })
      if (req?.flagId) processes.updateFlagStatus(req.flagId, "dismissed")
      if (owningRun) this.flipRunningToTop(owningRun)
      else
        processes.updateProcessRun(processRunId, {
          status: "running",
          finishedAt: null,
        })
    })
    tx()

    const updated = processes.getProcessRun(processRunId)
    this.runner.resume(taskId)
    return updated
  }

  // The runner-invoked executor for the process_run kind. Registered:
  //   runner.registerKind(PROCESS_RUN_KIND, { autoResume: true, run: svc.execute,
  //                                            hasIndependentSurface: true })
  readonly execute: TaskExecutor = async ({ task, signal, emit }) => {
    const runId = (task.input as ProcessRunInput | null)?.processRunId
    if (!runId) return { error: "process_run task missing processRunId" }
    const run = processes.getProcessRun(runId)
    if (!run) return { error: "process run not found" }
    if (!run.processId)
      return { error: "process definition was deleted; cannot run" }
    const graph = processes.getProcessGraph(run.processId)
    if (!graph) return { error: "process graph not found" }

    // Keep the run's task link fresh (a resumed task may be a new row's driver).
    processes.updateProcessRun(runId, {
      status: "running",
      taskId: task.id,
      startedAt: run.startedAt ?? Date.now(),
    })

    try {
      // The top-level run is at depth 0. A sub-process phase recurses via driveRun
      // with depth+1 (plan 038.1), sharing this task's id/signal/emit.
      await this.driveRun({
        run,
        graph,
        taskId: task.id,
        signal,
        emit,
        depth: 0,
      })
      // driveRun returns (not throws) on abort too (the scheduler stops walking), so
      // a return under an aborted signal is NOT a completion — map it by WHY it
      // aborted (plan 038.3): a SHUTDOWN/PAUSE is resumable → `paused` (a durable
      // resume state; the run row is left running for reconcile), a genuine cancel →
      // `stopped` (terminal). Mirrors driveRun's settleAbortedRun.
      if (signal.aborted) return abortedResult(signal)
      return { content: "process complete" }
    } catch (err) {
      // An approval gate unwinds the scheduler: settle the task `paused` (durable
      // resume). The run is already waiting_for_approval (raiseGate set it). A gate
      // raised INSIDE a nested run (plan 038.1) propagates here the same way.
      if (err instanceof GateBlockedError) return { paused: true }
      // Cancellation: the signal aborted; driveRun already set the run status.
      if (signal.aborted) return abortedResult(signal)
      // Scheduling failures (a failed phase blocking the DAG) are deterministic —
      // a retry re-runs the same graph to the same wall, so don't retry. driveRun
      // already set the run failed.
      const message = err instanceof Error ? err.message : String(err)
      return { error: message, retryable: false }
    }
  }

  // Drive one process run to quiescence via the scheduler (plan 025), reusable for
  // both the top-level run (execute) and a NESTED sub-process run (plan 038.1). All
  // closures are rebuilt bound to THIS run + graph; the taskId/signal/emit are
  // SHARED down the nesting chain (one runner slot, one abort cancels the tree, one
  // event tail). Owns its run's terminal status: completed on clean return, failed
  // on a scheduling error, cancelled on abort. A GateBlockedError is re-thrown
  // WITHOUT setting a status (the phase-run is parked waiting_for_approval by
  // raiseGate) so it propagates to the top-level execute and pauses the whole task.
  private async driveRun(input: {
    run: ProcessRun
    graph: ProcessGraph
    taskId: string
    signal: AbortSignal
    emit: Parameters<TaskExecutor>[0]["emit"]
    depth: number
  }): Promise<void> {
    const { run, graph, taskId, signal, emit, depth } = input
    try {
      await runScheduler({
        run,
        graph,
        taskId,
        signal,
        emit,
        runPhase: this.makeRunPhase(run),
        decompose: this.makeDecompose(run),
        buildEachSubtaskPrompt: this.makeBuildEachSubtaskPrompt(run),
        validate: this.makeValidate(run),
        // Sub-process phases (plan 038.1): run a nested definition inline. The depth
        // rides in so the closure enforces MAX_PROCESS_DEPTH and recurses at depth+1.
        runSubProcess: this.makeRunSubProcess(run, taskId, emit),
        processDepth: depth,
        // Cross-phase flag-back (plan 031.2): the definition's autonomy toggle, and
        // the reset applier (delegated to flagback.ts — one reset code path shared
        // with the confirm route).
        requireFlagApproval: graph.definition.requireFlagApproval,
        applyFlag: (flag) =>
          applyFlagBack({
            taskId,
            runId: run.id,
            graph,
            target: {
              targetPhaseId: flag.targetPhaseId,
              targetChildRunId: flag.targetChildRunId ?? undefined,
            },
            reason: flag.reason,
          }),
      })
      // The scheduler RETURNS on abort (it stops walking), so a clean return under an
      // aborted signal is NOT a completion — stamping `completed` here would corrupt
      // the run (a completed run with cancelled/pending phases; plan 038.3 resume
      // bug). Only a return with a non-aborted signal is a genuine completion.
      if (signal.aborted) settleAbortedRun(run.id, signal)
      else
        processes.updateProcessRun(run.id, {
          status: "completed",
          finishedAt: Date.now(),
        })
    } catch (err) {
      if (err instanceof GateBlockedError) throw err
      if (signal.aborted) settleAbortedRun(run.id, signal)
      else
        processes.updateProcessRun(run.id, {
          status: "failed",
          finishedAt: Date.now(),
        })
      throw err
    }
  }

  // Build the RunSubProcess closure for a run (plan 038.1). When the scheduler
  // dispatches a sub-process phase, this starts (or re-attaches to) a nested run of
  // the phase's referenced definition and drives it inline via driveRun — sharing
  // the parent's taskId/signal/emit, holding one PER_RUN_CONCURRENCY slot, never a
  // second enqueued task (the spawn_subagent no-deadlock ruling). Returns the nested
  // run's outcome as a PhaseResult so runSubProcessWithRetry settles the phase.
  private makeRunSubProcess(
    parentRun: ProcessRun,
    taskId: string,
    emit: Parameters<TaskExecutor>[0]["emit"]
  ): RunSubProcess {
    return async ({
      phase,
      phaseRun,
      depth,
      subtaskPrompt,
      existingChildRunId,
      signal,
    }) => {
      // Runtime cycle/depth backstop: the author-time acyclicity check can't cover a
      // definition edited after a run started, so bound nesting here.
      if (depth >= MAX_PROCESS_DEPTH)
        return {
          error: `max sub-process depth (${MAX_PROCESS_DEPTH}) reached`,
          retryable: false,
        }
      if (!phase.subprocessId)
        return {
          error: "sub-process phase has no subprocess_id",
          retryable: false,
        }
      const childGraph = processes.getProcessGraph(phase.subprocessId)
      if (!childGraph)
        return {
          error: "sub-process definition not found (was it deleted?)",
          retryable: false,
        }

      // Look-up-or-create the nested run linked to THIS phase-run. On crash-resume
      // the phase-run reset to `pending` and re-dispatches; re-attaching to the
      // existing child run (rather than creating a new one) lets its own scheduler
      // resume its completed phases instead of restarting the sub-process. The
      // `subprocess:` checkpoint (plan 038.3) accelerates the re-attach; the FK
      // look-up is the correctness fallback. For a per-fan-out-child sub-process
      // (plan 038.3), `phaseRun` is an individual fan-out child, so each child gets
      // its OWN nested run keyed by its distinct phase-run id.
      let childRun =
        (existingChildRunId
          ? processes.getProcessRun(existingChildRunId)
          : undefined) ?? processes.getProcessRunByParentPhaseRunId(phaseRun.id)
      if (!childRun) {
        childRun = processes.createProcessRun({
          processId: phase.subprocessId,
          sourceConversationId: parentRun.sourceConversationId,
          workspaceId: parentRun.workspaceId,
          // A per-child sub-process is driven by the child's decomposed briefing;
          // a top-level sub-process phase inherits the parent run's objective.
          objective: subtaskPrompt ?? parentRun.objective,
          parentPhaseRunId: phaseRun.id,
          taskId,
          status: "running",
        })
        // Accelerator checkpoint (plan 038.3): record the mapping so resume skips
        // the FK query. Written only on create (not on re-attach) — a fresh row per
        // (re-)created nested run, latest-wins on recovery.
        createCheckpoint({
          taskId,
          label: SUBPROCESS_CHECKPOINT_LABEL(phaseRun.id),
          state: {
            parentPhaseRunId: phaseRun.id,
            childRunId: childRun.id,
          } satisfies SubprocessCheckpointState,
        })
      }

      // Drive the nested run inline at depth+1, sharing the parent's task/signal/emit.
      // A GateBlockedError inside propagates (pauses the whole run). A normal child
      // failure also throws after driveRun stamps the child run `failed`; absorb that
      // throw here so the parent scheduler can settle THIS phase-run failed and keep
      // draining its other in-flight siblings. Letting it escape made the top-level
      // run terminal immediately while parallel sub-process phase-runs stayed forever
      // `running` (there was no scheduler left to observe their completion).
      try {
        await this.driveRun({
          run: childRun,
          graph: childGraph,
          taskId,
          signal,
          emit,
          depth: depth + 1,
        })
      } catch (err) {
        if (err instanceof GateBlockedError) throw err
        if (signal.aborted) return { stopped: true }

        // A child scheduling failure is an expected PhaseResult at this boundary.
        // If the child did not manage to stamp itself failed, preserve the original
        // error instead of hiding an unexpected infrastructure exception behind the
        // generic sub-process message below.
        const settled = processes.getProcessRun(childRun.id)
        if (settled?.status !== "failed")
          return { error: err instanceof Error ? err.message : String(err) }
      }

      const settled = processes.getProcessRun(childRun.id)
      if (signal.aborted || settled?.status === "cancelled")
        return { stopped: true }
      if (settled?.status !== "completed")
        return { error: "sub-process run failed", retryable: false }
      return {
        content: this.aggregateSubProcessContent(phaseRun.id) ?? undefined,
      }
    }
  }

  // The aggregated output of a sub-process phase (plan 038.1): concatenate the final
  // content of the nested run's completed TOP-LEVEL phases, so a downstream phase's
  // upstream digest is real. Reuses the same per-phase rule collectUpstream uses (a
  // container phase → its children's aggregate; a plain phase → its worker's last
  // assistant message). Null if the nested run is missing / not completed.
  private aggregateSubProcessContent(parentPhaseRunId: string): string | null {
    const childRun = processes.getProcessRunByParentPhaseRunId(parentPhaseRunId)
    if (!childRun || childRun.status !== "completed") return null
    const phaseRuns = processes.listPhaseRuns({
      runId: childRun.id,
      parentId: null,
    })
    const childGraph = childRun.processId
      ? processes.getProcessGraph(childRun.processId)
      : undefined
    const phasesById = new Map((childGraph?.phases ?? []).map((p) => [p.id, p]))
    const parts: string[] = []
    for (const pr of phaseRuns) {
      if (pr.status !== "completed") continue
      const hasChildren =
        processes.listPhaseRuns({ runId: childRun.id, parentId: pr.id })
          .length > 0
      const content = hasChildren
        ? this.aggregateChildContent(childRun.id, pr.id)
        : pr.taskId
          ? this.lastAssistantContent(pr)
          : null
      if (content) {
        const label = phasesById.get(pr.phaseId)?.name ?? "Phase"
        parts.push(`#### ${label}\n${content.trim()}`)
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : null
  }

  // Build the production RunPhase closure for a run: fork a worker conversation
  // stamped with the phase's agent, run a nested runAgentLoop (the spawnSubagent
  // precedent), and return the outcome. Phases run in AUTO mode — the phase's
  // gate_policy is the human-in-the-loop control point, not per-tool prompts.
  private makeRunPhase(run: ProcessRun): RunPhase {
    return async ({ phase, phaseRun, subtaskPrompt, signal }) => {
      const source = run.sourceConversationId
        ? getConversation(run.sourceConversationId)
        : undefined

      // Prefer the run's own picked workspace (plan 026), falling back to the
      // source conversation's — so a folder chosen in the New Run modal wins, and
      // runs launched from a conversation keep inheriting its workspace.
      const workspaceId = run.workspaceId ?? source?.workspaceId ?? null
      const workspace = workspaceId
        ? getWorkspace(workspaceId)?.path
        : undefined
      const reworkNote =
        processes.getPhaseRun(phaseRun.id)?.reworkNote ?? undefined

      // A fan-out CHILD runs its decomposed sub-task briefing verbatim; a normal
      // phase gets the generic self-contained kickoff (plan 025.1).
      const prompt =
        subtaskPrompt ??
        kickoffPrompt({
          phase,
          objective: run.objective ?? "",
          upstream: this.collectUpstream(run, phase),
          // A "Request changes" send-back (plan 029) OR a validator rejection
          // (plan 031.1) stamped feedback on the phase-run; surface it so the
          // re-run addresses it. Re-read FRESH from the DB — a validator loop
          // re-runs this closure within one runPhaseWithRetry call and stamps a new
          // note each round, so the passed-in phaseRun object is stale. Null for a
          // first run.
          reworkNote,
        })

      // Resolve the phase's agent BEFORE forking the worker: for a `dispatch`
      // phase this routes over the pool per (sub-)task, using `prompt` as the
      // classification signal (plan 025.3). `single` phases resolve pool[0].
      const agentName = await this.resolveAgent(phase, {
        taskPrompt: prompt,
        selection: {
          accountId: source?.accountId ?? null,
          modelId: source?.modelId ?? null,
        },
        workspace,
        signal,
      })

      const existingWorkerTask =
        !reworkNote && phaseRun.taskId ? getTask(phaseRun.taskId) : undefined
      const existingWorker = existingWorkerTask
        ? getConversation(existingWorkerTask.conversationId)
        : undefined
      const resumingWorker = !!existingWorkerTask && !!existingWorker
      const worker =
        existingWorker ??
        createConversation({
          mode: source?.mode ?? "interactive",
          workspaceId,
          accountId: source?.accountId ?? null,
          modelId: source?.modelId ?? null,
          agentName,
          title: `${phase.name}${agentName ? `: ${agentName}` : ""}`,
        })
      if (!resumingWorker) {
        // Back the worker with a task row so it's not listed as a standalone chat
        // and is cascade-deleted with the source session (spawnSubagent shape).
        const workerTask = createTask({
          conversationId: worker.id,
          sourceConversationId: run.sourceConversationId ?? worker.id,
          status: "completed",
          title: phase.name,
          input: { kind: "process_phase", phaseRunId: phaseRun.id, agentName },
        })
        processes.updatePhaseRun(phaseRun.id, {
          taskId: workerTask.id,
          agentName,
        })
      }

      // Chain a child controller so run-level cancel unwinds the phase worker.
      const childAbort = new AbortController()
      if (signal.aborted) childAbort.abort(signal.reason)
      else
        signal.addEventListener(
          "abort",
          () => childAbort.abort(signal.reason),
          { once: true }
        )

      try {
        const result = await runAgentLoop({
          conversationId: worker.id,
          workspace,
          agentDir: workspace,
          userMessage: resumingWorker ? undefined : prompt,
          abort: childAbort,
          // Phases are autonomous; the phase gate is the HITL point.
          autoMode: true,
          // Cross-phase flag-back context (plan 031.2): lets this worker's
          // flag_for_rework tool reach the run's graph + record a durable flag.
          processRunId: run.id,
          processPhaseRunId: phaseRun.id,
          // Headless worker: no user to answer a clarifying question (it would only
          // stall until interrupted). The kickoff frames the work as self-contained.
          suppressUserQuestions: true,
          onEvent: () => {},
        })
        if (result.stopped || childAbort.signal.aborted)
          return { stopped: true }
        if (result.error)
          return { error: result.error, retryable: result.retryable }
        const output = this.lastAssistantOutput(
          processes.getPhaseRun(phaseRun.id) ?? phaseRun
        )
        const outputIdentity = output?.identity ?? null
        processes.updatePhaseRun(phaseRun.id, { outputIdentity })
        return { content: result.content, outputIdentity } satisfies PhaseResult
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  }

  // Build the DECOMPOSITION closure for a run (plan 025.1). A fan-out phase forks
  // a worker (same shape as makeRunPhase, so it can inspect the workspace), runs
  // an agent loop asking for a JSON array of sub-task briefings, and parses the
  // final assistant message. Each briefing becomes a child phase-run.
  private makeDecompose(run: ProcessRun): Decompose {
    return async ({ phase, phaseRun, attempt, signal }) => {
      const source = run.sourceConversationId
        ? getConversation(run.sourceConversationId)
        : undefined
      // The decomposition (planning) pass runs on pool[0]; each resulting CHILD
      // routes independently over the pool in makeRunPhase (plan 025.3).
      const agentName = await this.resolveAgent(phase)

      // Prefer the run's own picked workspace (plan 026), falling back to the
      // source conversation's — same rule as makeRunPhase.
      const workspaceId = run.workspaceId ?? source?.workspaceId ?? null
      const workspace = workspaceId
        ? getWorkspace(workspaceId)?.path
        : undefined
      const reworkNote =
        processes.getPhaseRun(phaseRun.id)?.reworkNote ?? undefined

      const existingWorkerTask =
        !reworkNote && phaseRun.taskId ? getTask(phaseRun.taskId) : undefined
      const existingWorker = existingWorkerTask
        ? getConversation(existingWorkerTask.conversationId)
        : undefined
      const resumingWorker = !!existingWorkerTask && !!existingWorker
      const worker =
        existingWorker ??
        createConversation({
          mode: source?.mode ?? "interactive",
          workspaceId,
          accountId: source?.accountId ?? null,
          modelId: source?.modelId ?? null,
          agentName,
          title: `${phase.name} (decompose)${agentName ? `: ${agentName}` : ""}`,
        })
      if (!resumingWorker) {
        const workerTask = createTask({
          conversationId: worker.id,
          sourceConversationId: run.sourceConversationId ?? worker.id,
          status: "completed",
          title: `${phase.name} (decompose)`,
          input: {
            kind: "process_phase_decompose",
            phaseRunId: phaseRun.id,
            agentName,
          },
        })
        processes.updatePhaseRun(phaseRun.id, {
          taskId: workerTask.id,
          agentName,
        })
      }

      const childAbort = new AbortController()
      if (signal.aborted) childAbort.abort(signal.reason)
      else
        signal.addEventListener(
          "abort",
          () => childAbort.abort(signal.reason),
          { once: true }
        )

      // On a retry, append a corrective note so the worker is nudged back to the
      // strict parseable format its previous attempt missed.
      const prompt =
        fanOutDecomposePrompt({
          phase,
          objective: run.objective ?? "",
          upstream: this.collectUpstream(run, phase),
          // Whole-container rework stores feedback on the fan-out parent run.
          // Re-read it per attempt so retries and post-reset resumes do not use a
          // stale phaseRun object.
          reworkNote,
        }) + (attempt > 1 ? decompositionRetryNote : "")

      try {
        const result = await runAgentLoop({
          conversationId: worker.id,
          workspace,
          agentDir: workspace,
          userMessage: resumingWorker ? undefined : prompt,
          abort: childAbort,
          autoMode: true,
          // Headless worker — no user to answer a clarifying question.
          suppressUserQuestions: true,
          onEvent: () => {},
        })
        if (result.stopped || childAbort.signal.aborted)
          return { stopped: true }
        if (result.error)
          return { error: result.error, retryable: result.retryable }
        const subtasks = parseDecomposition(result.content ?? "")
        if (subtasks.length === 0)
          // A parse miss is deterministic given the same transcript — a retry
          // re-runs the whole worker, which MAY produce parseable output, so
          // mark it retryable (bounded by MAX_PHASE_ATTEMPTS in the scheduler).
          return {
            error: "decomposition produced no parseable sub-tasks",
            retryable: true,
          }
        return { subtasks } satisfies DecomposeResult
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  }

  // Build the per-sub-task kickoff for an `on_each_subtask` consumer instance
  // (plan 025.2). The consumer runs once per completed source sub-task, so the
  // briefing carries THAT child's output alone — read from its worker's final
  // assistant message — not the source phase's aggregate.
  private makeBuildEachSubtaskPrompt(run: ProcessRun): BuildEachSubtaskPrompt {
    return ({ phase, sourceChildRun }) => {
      const source = sourceChildRun.phaseId
        ? this.phaseName(run, sourceChildRun.phaseId)
        : "upstream"
      return eachSubtaskKickoffPrompt({
        phase,
        objective: run.objective ?? "",
        sourcePhaseName: source,
        // The source fan-out phase's key — the flag_for_rework target if this
        // sub-task's input is defective (plan 031.2).
        sourcePhaseKey: sourceChildRun.phaseId
          ? this.phaseKey(run, sourceChildRun.phaseId)
          : undefined,
        subtaskContent: this.lastAssistantContent(sourceChildRun),
      })
    }
  }

  // Build the VALIDATOR closure for a run (plan 031.1). A validator-enabled
  // phase, after its worker completes, forks a REVIEWER worker (same shape as
  // makeDecompose, so the reviewer can inspect the workspace/files) and asks it to
  // judge the phase's output against the objective. The reviewer's own agent is
  // `phase.validatorAgent` (else the phase's pool[0]); its conversation is
  // separate from the phase worker's, so we do NOT overwrite the phase-run's
  // taskId/agentName. Returns the parsed verdict; an unparseable reply is a failed
  // review boundary and must not approve the phase.
  private makeValidate(run: ProcessRun): Validate {
    return async ({ phase, phaseRun, outputIdentity, signal }) => {
      const source = run.sourceConversationId
        ? getConversation(run.sourceConversationId)
        : undefined

      // The phase worker's output is the review input — read it BEFORE forking the
      // reviewer (the reviewer's conversation would otherwise be the latest).
      const phaseOutput = this.lastAssistantContent(phaseRun)
      const reviewTargetOutputIdentity = outputIdentity

      // The dedicated reviewer agent, falling back to the phase's own resolved
      // agent (pool[0]) when none is configured.
      const pool = processes.listPhaseAgents(phase.id)
      const agentName = phase.validatorAgent ?? pool[0]?.agentName ?? null

      const workspaceId = run.workspaceId ?? source?.workspaceId ?? null
      const workspace = workspaceId
        ? getWorkspace(workspaceId)?.path
        : undefined

      const validatorRound =
        processes.getPhaseRun(phaseRun.id)?.validatorRound ??
        phaseRun.validatorRound
      const existingWorkerTask = this.findProcessWorkerTask(
        phaseRun.id,
        "process_phase_validate",
        validatorRound,
        reviewTargetOutputIdentity
      )
      const existingWorker = existingWorkerTask
        ? getConversation(existingWorkerTask.conversationId)
        : undefined
      const resumingWorker = !!existingWorkerTask && !!existingWorker
      const worker =
        existingWorker ??
        createConversation({
          mode: source?.mode ?? "interactive",
          workspaceId,
          accountId: source?.accountId ?? null,
          modelId: source?.modelId ?? null,
          agentName,
          title: `${phase.name} (review)${agentName ? `: ${agentName}` : ""}`,
        })
      if (!resumingWorker) {
        createTask({
          conversationId: worker.id,
          sourceConversationId: run.sourceConversationId ?? worker.id,
          status: "completed",
          title: `${phase.name} (review)`,
          input: {
            kind: "process_phase_validate",
            phaseRunId: phaseRun.id,
            agentName,
            validatorRound,
            reviewTargetOutputIdentity,
          },
        })
      }

      const childAbort = new AbortController()
      if (signal.aborted) childAbort.abort(signal.reason)
      else
        signal.addEventListener(
          "abort",
          () => childAbort.abort(signal.reason),
          { once: true }
        )

      const prompt = validatorPrompt({
        phase,
        objective: run.objective ?? "",
        upstream: this.collectUpstream(run, phase),
        phaseOutput,
      })

      try {
        const result = await runAgentLoop({
          conversationId: worker.id,
          workspace,
          agentDir: workspace,
          userMessage: resumingWorker ? undefined : prompt,
          abort: childAbort,
          autoMode: true,
          // Headless reviewer — no user to answer a clarifying question.
          suppressUserQuestions: true,
          onEvent: () => {},
        })
        if (result.stopped || childAbort.signal.aborted)
          return { approved: false, stopped: true }
        if (result.error)
          return {
            approved: false,
            error: result.error,
            retryable: result.retryable,
            targetOutputIdentity: reviewTargetOutputIdentity,
          }
        const verdict = parseVerdict(result.content ?? "")
        if (!verdict)
          return {
            approved: false,
            error: "validator returned an unparseable verdict",
            targetOutputIdentity: reviewTargetOutputIdentity,
          }
        return {
          approved: verdict.approved,
          feedback: verdict.feedback,
          targetOutputIdentity: reviewTargetOutputIdentity,
        }
      } catch (err) {
        return {
          approved: false,
          error: err instanceof Error ? err.message : String(err),
          targetOutputIdentity: reviewTargetOutputIdentity,
        }
      }
    }
  }

  // The display name of a phase in this run's graph (for a kickoff briefing).
  private phaseName(run: ProcessRun, phaseId: string): string {
    if (!run.processId) return "upstream"
    const graph = processes.getProcessGraph(run.processId)
    return graph?.phases.find((p) => p.id === phaseId)?.name ?? "upstream"
  }

  // The stable key of a phase in this run's graph — the flag_for_rework target
  // vocabulary (plan 031.2). "" when the phase can't be resolved.
  private phaseKey(run: ProcessRun, phaseId: string): string {
    if (!run.processId) return ""
    const graph = processes.getProcessGraph(run.processId)
    return graph?.phases.find((p) => p.id === phaseId)?.key ?? ""
  }

  // Resolve which agent runs a phase (or one of its sub-tasks). `single` phases
  // use the pool's first agent (position 0). `dispatch` phases (plan 025.3) route
  // over the pool per (sub-)task via an LLM classifier when routing context is
  // supplied; the classifier falls back to pool[0] internally so a dispatch phase
  // never wedges. Without routing context (e.g. a fan-out phase's decomposition
  // pass), or an empty pool, this is the plain pool[0] path.
  private async resolveAgent(
    phase: ProcessPhase,
    routing?: {
      taskPrompt: string
      selection: LlmSelection
      workspace?: string
      signal: AbortSignal
    }
  ): Promise<string | null> {
    const pool = processes.listPhaseAgents(phase.id)
    if (pool.length === 0) return null
    if (phase.routing !== "dispatch" || !routing) return pool[0].agentName
    return route({
      pool,
      taskPrompt: routing.taskPrompt,
      selection: routing.selection,
      workspace: routing.workspace,
      signal: routing.signal,
    })
  }

  // A digest of the completed upstream phases' final output, for the kickoff.
  private collectUpstream(
    run: ProcessRun,
    phase: ProcessPhase
  ): UpstreamResult[] {
    if (!run.processId) return []
    const graph = processes.getProcessGraph(run.processId)
    if (!graph) return []
    const phasesById = new Map(graph.phases.map((p) => [p.id, p]))
    const sourceIds = graph.edges
      .filter((e) => e.toPhaseId === phase.id)
      .map((e) => e.fromPhaseId)
    const phaseRuns = processes.listPhaseRuns({ runId: run.id, parentId: null })
    const runByPhaseId = new Map(phaseRuns.map((pr) => [pr.phaseId, pr]))
    const results: UpstreamResult[] = []
    for (const sid of sourceIds) {
      const src = phasesById.get(sid)
      const pr = runByPhaseId.get(sid)
      if (!src || !pr || pr.status !== "completed") continue
      // A CONTAINER source (its own top-level worker produced no real output — the
      // work lives in its children: fan-out sub-tasks (025.1), on_each_subtask
      // consumer instances (025.2), or a per-child sub-process (038.3)) → aggregate
      // the children (R7). Checked FIRST so a COMBINED fan-out + sub-process source
      // (038.3) — where subprocessId is set but the work lives in per-child nested
      // runs, not a nested run off the container parent — aggregates its children;
      // aggregateChildContent detects and unwraps each sub-process child. A pure
      // SUB-PROCESS source (038.1, no children) produced its work in the NESTED run
      // linked by parent_phase_run_id → aggregate that run's terminal phases. A
      // plain phase has no children → use its own worker's last assistant message.
      const hasChildren =
        processes.listPhaseRuns({ runId: run.id, parentId: pr.id }).length > 0
      const content = hasChildren
        ? this.aggregateChildContent(run.id, pr.id)
        : src.subprocessId
          ? this.aggregateSubProcessContent(pr.id)
          : pr.taskId
            ? this.lastAssistantContent(pr)
            : null
      results.push({ phaseName: src.name, phaseKey: src.key, content })
    }
    return results
  }

  // Concatenate the final assistant content of every child of a fan-out parent
  // phase-run, labeled by index, for a downstream phase's upstream digest (025.1).
  // A per-fan-out-child SUB-PROCESS child (plan 038.3) has no worker message of its
  // own — its output lives in its nested run — so pull the nested run's aggregate
  // (mirroring collectUpstream's src.subprocessId branch).
  private aggregateChildContent(
    runId: string,
    parentPhaseRunId: string
  ): string | null {
    const children = processes.listPhaseRuns({
      runId,
      parentId: parentPhaseRunId,
    })
    const parts: string[] = []
    children.forEach((child, i) => {
      const isSubProcessChild =
        processes.getProcessRunByParentPhaseRunId(child.id) !== undefined
      const content = isSubProcessChild
        ? this.aggregateSubProcessContent(child.id)
        : child.taskId
          ? this.lastAssistantContent(child)
          : null
      if (content) parts.push(`#### Sub-task ${i + 1}\n${content.trim()}`)
    })
    return parts.length > 0 ? parts.join("\n\n") : null
  }

  // The final assistant message of a phase's worker conversation (its "output").
  private lastAssistantContent(phaseRun: ProcessPhaseRun): string | null {
    return this.lastAssistantOutput(phaseRun)?.content ?? null
  }

  private lastAssistantOutput(
    phaseRun: ProcessPhaseRun
  ): { content: string; identity: string } | null {
    if (!phaseRun.taskId) return null
    // The worker conversation id is the phase-run's backing task's conversation.
    const workerTask = getTask(phaseRun.taskId)
    if (!workerTask) return null
    const messages = listMessages(workerTask.conversationId)
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role === "assistant" && message.content) {
        const digest = createHash("sha256")
          .update(message.content)
          .digest("hex")
        return {
          content: message.content,
          identity: `phase-output:v1:${phaseRun.taskId}:${message.id}:${digest}`,
        }
      }
    }
    return null
  }

  private findProcessWorkerTask(
    phaseRunId: string,
    kind: string,
    validatorRound?: number,
    reviewTargetOutputIdentity?: string | null
  ) {
    return listTasks().find((task) => {
      const input = task.input as ProcessWorkerTaskInput | null
      if (input?.kind !== kind || input.phaseRunId !== phaseRunId) return false
      if (validatorRound === undefined) return true
      if (input.validatorRound !== validatorRound) return false
      if (reviewTargetOutputIdentity === undefined) return true
      return (
        (input.reviewTargetOutputIdentity ?? null) ===
        reviewTargetOutputIdentity
      )
    })
  }

  private assertNoUnknownPhaseWorkerOutcomes(phaseRun: ProcessPhaseRun): void {
    const tasks = [
      phaseRun.taskId ? getTask(phaseRun.taskId) : undefined,
      ...listTasks().filter((task) => {
        const input = task.input as ProcessWorkerTaskInput | null
        return (
          input?.phaseRunId === phaseRun.id &&
          (input.kind === "process_phase_validate" ||
            input.kind === "process_phase" ||
            input.kind === "process_phase_decompose")
        )
      }),
    ].filter((task): task is NonNullable<typeof task> => task !== undefined)

    const seen = new Set<string>()
    const unknown: string[] = []
    for (const task of tasks) {
      if (seen.has(task.id)) continue
      seen.add(task.id)
      const calls = unknownSideEffectingToolCalls(task.conversationId)
      for (const call of calls) unknown.push(call.name)
    }
    if (unknown.length === 0) return
    throw new Error(
      `cannot rerun process phase while side-effecting tool outcomes are unknown: ${[...new Set(unknown)].join(", ")}`
    )
  }

  private assertNoUnknownProcessWorkerOutcomes(run: ProcessRun): void {
    const visit = (cur: ProcessRun): void => {
      for (const phaseRun of processes.listPhaseRuns({ runId: cur.id })) {
        this.assertNoUnknownPhaseWorkerOutcomes(phaseRun)
        const child = processes.getProcessRunByParentPhaseRunId(phaseRun.id)
        if (child) visit(child)
      }
    }
    visit(run)
  }
}

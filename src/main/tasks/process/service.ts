import { runAgentLoop } from "../../agent"
import {
  createConversation,
  getConversation,
} from "../../db/repositories/conversations"
import { createTask, getTask } from "../../db/repositories/tasks"
import { listMessages } from "../../db/repositories/messages"
import { getWorkspace } from "../../db/repositories/workspaces"
import * as processes from "../../db/repositories/processes"
import type { TaskRunner, TaskExecutor } from "../runner"
import type {
  ProcessPhase,
  ProcessPhaseRun,
  ProcessRun,
} from "../../db/types"
import { kickoffPrompt, type UpstreamResult } from "./prompts"
import {
  GateBlockedError,
  runScheduler,
  type PhaseResult,
  type RunPhase,
} from "./scheduler"

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

export class ProcessService {
  constructor(private readonly runner: TaskRunner) {}

  // Start a new run of a definition: create the run row, enqueue the backing
  // process_run task (sourced to the originating conversation so it's user-facing
  // and eligible for a completion notification), and link them. Returns the run.
  startRun(input: {
    processId: string
    sourceConversationId: string | null
    objective: string
  }): ProcessRun {
    const definition = processes.getProcessDefinition(input.processId)
    if (!definition) throw new Error(`unknown process '${input.processId}'`)

    const run = processes.createProcessRun({
      processId: input.processId,
      sourceConversationId: input.sourceConversationId,
      objective: input.objective,
      status: "queued",
    })

    const task = this.runner.enqueueKind({
      kind: PROCESS_RUN_KIND,
      title: `Process: ${definition.name}`,
      sourceConversationId: input.sourceConversationId,
      input: { processRunId: run.id } satisfies ProcessRunInput,
    })
    return processes.updateProcessRun(run.id, { taskId: task.id })
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
      await runScheduler({
        run,
        graph,
        taskId: task.id,
        signal,
        emit,
        runPhase: this.makeRunPhase(run),
      })
      processes.updateProcessRun(runId, {
        status: "completed",
        finishedAt: Date.now(),
      })
      return { content: "process complete" }
    } catch (err) {
      // An approval gate unwinds the scheduler: settle the task `paused` (durable
      // resume). The run is already waiting_for_approval (raiseGate set it).
      if (err instanceof GateBlockedError) return { paused: true }
      // Cancellation: the signal aborted; settle `stopped` (→ cancelled).
      if (signal.aborted) {
        processes.updateProcessRun(runId, {
          status: "cancelled",
          finishedAt: Date.now(),
        })
        return { stopped: true }
      }
      const message = err instanceof Error ? err.message : String(err)
      processes.updateProcessRun(runId, {
        status: "failed",
        finishedAt: Date.now(),
      })
      // Scheduling failures (a failed phase blocking the DAG) are deterministic —
      // a retry re-runs the same graph to the same wall, so don't retry.
      return { error: message, retryable: false }
    }
  }

  // Build the production RunPhase closure for a run: fork a worker conversation
  // stamped with the phase's agent, run a nested runAgentLoop (the spawnSubagent
  // precedent), and return the outcome. Phases run in AUTO mode — the phase's
  // gate_policy is the human-in-the-loop control point, not per-tool prompts.
  private makeRunPhase(run: ProcessRun): RunPhase {
    return async ({ phase, phaseRun, signal }) => {
      const source = run.sourceConversationId
        ? getConversation(run.sourceConversationId)
        : undefined
      const agentName = this.resolveAgent(phase)

      const worker = createConversation({
        mode: source?.mode ?? "interactive",
        workspaceId: source?.workspaceId ?? null,
        accountId: source?.accountId ?? null,
        modelId: source?.modelId ?? null,
        agentName,
        title: `${phase.name}${agentName ? `: ${agentName}` : ""}`,
      })
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

      const workspace = source?.workspaceId
        ? getWorkspace(source.workspaceId)?.path
        : undefined

      // Chain a child controller so run-level cancel unwinds the phase worker.
      const childAbort = new AbortController()
      if (signal.aborted) childAbort.abort(signal.reason)
      else
        signal.addEventListener(
          "abort",
          () => childAbort.abort(signal.reason),
          { once: true }
        )

      const prompt = kickoffPrompt({
        phase,
        objective: run.objective ?? "",
        upstream: this.collectUpstream(run, phase),
      })

      try {
        const result = await runAgentLoop({
          conversationId: worker.id,
          workspace,
          agentDir: workspace,
          userMessage: prompt,
          abort: childAbort,
          // Phases are autonomous; the phase gate is the HITL point.
          autoMode: true,
          onEvent: () => {},
        })
        if (result.stopped || childAbort.signal.aborted)
          return { stopped: true }
        if (result.error)
          return { error: result.error, retryable: result.retryable }
        return { content: result.content } satisfies PhaseResult
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  }

  // v1: single-agent phases. The pool's first agent (position 0) runs the phase.
  // dispatch routing over N agents is the 025.3 fast-follow.
  private resolveAgent(phase: ProcessPhase): string | null {
    const pool = processes.listPhaseAgents(phase.id)
    return pool[0]?.agentName ?? null
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
      results.push({
        phaseName: src.name,
        content: pr.taskId ? this.lastAssistantContent(pr) : null,
      })
    }
    return results
  }

  // The final assistant message of a phase's worker conversation (its "output").
  private lastAssistantContent(phaseRun: ProcessPhaseRun): string | null {
    if (!phaseRun.taskId) return null
    // The worker conversation id is the phase-run's backing task's conversation.
    const workerTask = getTask(phaseRun.taskId)
    if (!workerTask) return null
    const messages = listMessages(workerTask.conversationId)
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant" && messages[i].content)
        return messages[i].content
    }
    return null
  }
}

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
import type { LlmSelection } from "../../agent/providers"
import { route } from "./router"
import type {
  ProcessPhase,
  ProcessPhaseRun,
  ProcessRun,
} from "../../db/types"
import {
  eachSubtaskKickoffPrompt,
  fanOutDecomposePrompt,
  kickoffPrompt,
  parseDecomposition,
  type UpstreamResult,
} from "./prompts"
import {
  GateBlockedError,
  runScheduler,
  type BuildEachSubtaskPrompt,
  type Decompose,
  type DecomposeResult,
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
        decompose: this.makeDecompose(run),
        buildEachSubtaskPrompt: this.makeBuildEachSubtaskPrompt(run),
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
    return async ({ phase, phaseRun, subtaskPrompt, signal }) => {
      const source = run.sourceConversationId
        ? getConversation(run.sourceConversationId)
        : undefined

      const workspace = source?.workspaceId
        ? getWorkspace(source.workspaceId)?.path
        : undefined

      // A fan-out CHILD runs its decomposed sub-task briefing verbatim; a normal
      // phase gets the generic self-contained kickoff (plan 025.1).
      const prompt =
        subtaskPrompt ??
        kickoffPrompt({
          phase,
          objective: run.objective ?? "",
          upstream: this.collectUpstream(run, phase),
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

  // Build the DECOMPOSITION closure for a run (plan 025.1). A fan-out phase forks
  // a worker (same shape as makeRunPhase, so it can inspect the workspace), runs
  // an agent loop asking for a JSON array of sub-task briefings, and parses the
  // final assistant message. Each briefing becomes a child phase-run.
  private makeDecompose(run: ProcessRun): Decompose {
    return async ({ phase, phaseRun, signal }) => {
      const source = run.sourceConversationId
        ? getConversation(run.sourceConversationId)
        : undefined
      // The decomposition (planning) pass runs on pool[0]; each resulting CHILD
      // routes independently over the pool in makeRunPhase (plan 025.3).
      const agentName = await this.resolveAgent(phase)

      const worker = createConversation({
        mode: source?.mode ?? "interactive",
        workspaceId: source?.workspaceId ?? null,
        accountId: source?.accountId ?? null,
        modelId: source?.modelId ?? null,
        agentName,
        title: `${phase.name} (decompose)${agentName ? `: ${agentName}` : ""}`,
      })
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

      const workspace = source?.workspaceId
        ? getWorkspace(source.workspaceId)?.path
        : undefined

      const childAbort = new AbortController()
      if (signal.aborted) childAbort.abort(signal.reason)
      else
        signal.addEventListener(
          "abort",
          () => childAbort.abort(signal.reason),
          { once: true }
        )

      const prompt = fanOutDecomposePrompt({
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
          autoMode: true,
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
        subtaskContent: this.lastAssistantContent(sourceChildRun),
      })
    }
  }

  // The display name of a phase in this run's graph (for a kickoff briefing).
  private phaseName(run: ProcessRun, phaseId: string): string {
    if (!run.processId) return "upstream"
    const graph = processes.getProcessGraph(run.processId)
    return graph?.phases.find((p) => p.id === phaseId)?.name ?? "upstream"
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
      // A CONTAINER source's own top-level worker produced no real output — the
      // work lives in its children (fan-out sub-tasks (025.1) or on_each_subtask
      // consumer instances (025.2)). Aggregate the children's final content so a
      // downstream phase gets a real digest, not an empty parent (R7). A plain
      // phase has no children → use its own worker's last assistant message.
      const hasChildren =
        processes.listPhaseRuns({ runId: run.id, parentId: pr.id }).length > 0
      const content = hasChildren
        ? this.aggregateChildContent(run.id, pr.id)
        : pr.taskId
          ? this.lastAssistantContent(pr)
          : null
      results.push({ phaseName: src.name, content })
    }
    return results
  }

  // Concatenate the final assistant content of every child of a fan-out parent
  // phase-run, labeled by index, for a downstream phase's upstream digest (025.1).
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
      const content = child.taskId ? this.lastAssistantContent(child) : null
      if (content) parts.push(`#### Sub-task ${i + 1}\n${content.trim()}`)
    })
    return parts.length > 0 ? parts.join("\n\n") : null
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

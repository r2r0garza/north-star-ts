import { randomUUID } from "crypto"
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { createApproval, listApprovals } from "../../db/repositories/approvals"
import { listMessages } from "../../db/repositories/messages"
import { getTask } from "../../db/repositories/tasks"
import {
  createCheckpoint,
  listCheckpoints,
} from "../../db/repositories/task-checkpoints"
import { getDb } from "../../db/connection"
import * as processes from "../../db/repositories/processes"
import {
  FANOUT_CHECKPOINT_LABEL,
  EACH_SUBTASK_CHECKPOINT_LABEL,
  type FanoutCheckpointState,
  type EachSubtaskCheckpointState,
  type SubprocessCheckpointState,
} from "./checkpoints"
import { SHUTDOWN_ABORT_REASON, PAUSE_ABORT_REASON } from "../../agent/abort"
import type { TaskEventPayload } from "../runner"
import {
  sanitizeFailureContext,
  sanitizeFailureText,
} from "./failure-sanitizer"
import type {
  FailureContext,
  FailureStage,
  ProcessFlag,
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

// The max nesting depth for sub-process phases (plan 038.1): a sub-process phase
// runs another definition inline, which can itself contain sub-process phases.
// The DAG has no cycle guard, and the author-time acyclicity check can't catch a
// definition edited after a run started, so this runtime backstop is mandatory.
// Mirrors agents/types.ts MAX_AGENT_DEPTH (the spawn_subagent precedent).
export const MAX_PROCESS_DEPTH = 5

// Default cap on validator review rounds when a phase sets no explicit override
// (plan 031.1). NEVER unlimited — the DAG has no cycle guard, so a reset →
// re-run loop behind the validator must terminate. On exhaustion the phase
// escalates to a human gate.
export const DEFAULT_VALIDATOR_ITERATIONS = 3

// The checkpoint label prefix for a fan-out parent's persisted sub-task prompts
// Derive a short display TITLE from a sub-task briefing (plan 026 pass 1). The
// briefing is a freeform string; take its first non-empty line, strip a leading
// list/heading marker, and cap at ~60 chars on a word boundary. Deterministic —
// no LLM. Persisted on the child phase-run so the monitor shows the real work
// (e.g. "counter component") instead of a meaningless "#1".
export function subtaskTitle(briefing: string): string {
  const firstLine =
    briefing
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ""
  const cleaned = firstLine.replace(/^(?:[-*+]|\d+[.)]|#{1,6})\s+/, "").trim()
  const MAX = 60
  if (cleaned.length <= MAX) return cleaned
  const clipped = cleaned.slice(0, MAX)
  const lastSpace = clipped.lastIndexOf(" ")
  return `${(lastSpace > 20 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`
}

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
  outputIdentity?: string | null
  error?: string
  failure?: FailureContext
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

// Runs a SUB-PROCESS phase (plan 038.1): instead of a worker, the phase starts a
// nested run of `phase.subprocessId` inline (recursively driving the child graph,
// sharing this run's taskId/signal) and returns its aggregated outcome as a
// PhaseResult. `depth` is the current nesting depth for the MAX_PROCESS_DEPTH
// backstop. Injected so tests can stub it and a graph with no sub-process phases
// needs none (a sub-process phase with no runner fails loudly, like a fan-out
// phase with no decomposer).
export type RunSubProcess = (input: {
  phaseRun: ProcessPhaseRun
  phase: ProcessPhase
  depth: number
  // Present when this sub-process runs per fan-out child (plan 038.3): the child's
  // decomposed briefing, which seeds the nested run's objective. Absent for a
  // top-level (non-fan-out) sub-process phase, which inherits the parent run's objective.
  subtaskPrompt?: string
  // The nested run id recovered from a `subprocess:` checkpoint, if any (plan 038.3).
  // An ACCELERATOR — the runner prefers it over the parent_phase_run_id FK query,
  // falling back to the FK (the correctness path) when absent.
  existingChildRunId?: string
  signal: AbortSignal
}) => Promise<PhaseResult>

// The outcome of a fan-out phase's decomposition pass: a list of sub-task
// briefings, or an error/stop like a normal phase (plan 025.1).
export interface DecomposeResult {
  subtasks?: string[]
  error?: string
  failure?: FailureContext
  stopped?: boolean
  retryable?: boolean
}

// Runs a fan-out phase's decomposition worker. Injected so tests can stub it.
// `attempt` is 1-based; on a retry (>1) the runner appends a corrective note to
// the prompt so the worker is nudged back to the strict parseable format.
export type Decompose = (input: {
  phaseRun: ProcessPhaseRun
  phase: ProcessPhase
  attempt: number
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

// The outcome of a phase's VALIDATOR review pass (plan 031.1). A second agent
// judges a completed phase's output: `approved` gates whether the phase settles
// completed; `feedback` (when rejected) is injected into the phase's re-run
// kickoff (the 029 rework channel). error/stopped mirror a normal phase result
// so a cancelled/failed review unwinds like the phase worker itself. Any `error`
// is a failed review boundary, not approval. Injected so tests can stub the
// reviewer.
export interface ValidateResult {
  approved: boolean
  feedback?: string
  targetOutputIdentity?: string | null
  error?: string
  failure?: FailureContext
  stopped?: boolean
  retryable?: boolean
}

export type Validate = (input: {
  phase: ProcessPhase
  phaseRun: ProcessPhaseRun
  outputIdentity: string | null
  signal: AbortSignal
}) => Promise<ValidateResult>

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
  // Runs a phase's VALIDATOR review pass (plan 031.1). Optional so a graph with
  // no validator phases needs none; a validator-enabled phase with no validator
  // injected falls through to settling completed (no review), so the feature is
  // safely inert when unwired.
  validate?: Validate
  // Cross-phase flag-back routing (plan 031.2). When true (the process definition's
  // require_flag_approval), a pending flag raises a human-confirmation gate before
  // the send-back; when false, the scheduler applies the flag autonomously. Absent
  // → treated as true (confirm), the safe default.
  requireFlagApproval?: boolean
  // Applies a confirmed/autonomous flag's reset (plan 031.2). Injected (rather than
  // imported directly) so tests can stub the reset. Absent → flags are left pending
  // (inert), so the feature is safe when unwired.
  applyFlag?: (flag: ProcessFlag) => void
  // Runs a SUB-PROCESS phase's nested run (plan 038.1). Optional so a graph with no
  // sub-process phases needs none; a sub-process phase with no runner injected fails
  // loudly (like a fan-out phase with no decomposer). Inert when unwired.
  runSubProcess?: RunSubProcess
  // The current sub-process nesting depth (plan 038.1). 0 for a top-level run; the
  // service increments it for a nested run. Threaded to runSubProcess for the
  // MAX_PROCESS_DEPTH backstop.
  processDepth?: number
  // Best-effort external sink for failure diagnostics when SQLite persistence
  // throws while recording the phase row, failed-attempt audit, or task event.
  failureDiagnosticDir?: string | null
}

interface FailurePersistenceFallbackResult {
  path: string | null
  error: string | null
}

export class FailurePersistenceError extends Error {
  constructor(
    readonly failure: FailureContext,
    readonly fallback: FailurePersistenceFallbackResult
  ) {
    super(failure.message)
    this.name = "FailurePersistenceError"
  }
}

function processFailure(input: {
  resultFailure?: FailureContext
  code: string
  stage: FailureStage
  message: string
  retryable?: boolean
  attempt?: number | null
  maxAttempts?: number | null
  run: ProcessRun
  phase: ProcessPhase
  phaseRun: ProcessPhaseRun
  taskId: string
}): FailureContext {
  return sanitizeFailureContext({
    code: input.resultFailure?.code ?? input.code,
    stage: input.resultFailure?.stage ?? input.stage,
    message: input.resultFailure?.message ?? input.message,
    retryable: input.resultFailure?.retryable ?? input.retryable === true,
    attempt: input.attempt ?? input.resultFailure?.attempt ?? null,
    maxAttempts: input.maxAttempts ?? input.resultFailure?.maxAttempts ?? null,
    runId: input.resultFailure?.runId ?? input.run.id,
    phaseRunId: input.resultFailure?.phaseRunId ?? input.phaseRun.id,
    phaseId: input.resultFailure?.phaseId ?? input.phase.id,
    taskId: input.resultFailure?.taskId ?? input.taskId,
    workerTaskId:
      input.resultFailure?.workerTaskId ?? input.phaseRun.taskId ?? null,
    agentName:
      input.resultFailure?.agentName ?? input.phaseRun.agentName ?? null,
    toolCallId: input.resultFailure?.toolCallId ?? null,
    cause: input.resultFailure?.cause ?? null,
    occurredAt: input.resultFailure?.occurredAt ?? Date.now(),
  })
}

function recordFailedAttempt(input: {
  run: ProcessRun
  phase: ProcessPhase
  phaseRun: ProcessPhaseRun
  taskId: string
  failure: FailureContext
}): void {
  processes.createPhaseAttempt({
    runId: input.run.id,
    phaseRunId: input.phaseRun.id,
    phaseId: input.phase.id,
    taskId: input.taskId,
    workerTaskId: input.failure.workerTaskId,
    agentName: input.failure.agentName,
    stage: input.failure.stage,
    attempt: input.failure.attempt,
    maxAttempts: input.failure.maxAttempts,
    error: input.failure.message,
    failure: input.failure,
  })
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function failureSummary(failure: FailureContext): string {
  return `${failure.stage}/${failure.code}: ${failure.message}`
}

function writeFailurePersistenceFallback(input: {
  ctx: SchedulerCtx
  run: ProcessRun
  phase: ProcessPhase
  phaseRun: ProcessPhaseRun
  originalFailure: FailureContext
  persistenceError: unknown
}): FailurePersistenceFallbackResult {
  if (!input.ctx.failureDiagnosticDir) return { path: null, error: null }
  try {
    const dir = input.ctx.failureDiagnosticDir
    mkdirSync(dir, { recursive: true })
    const path = join(
      dir,
      `process-failure-${input.run.id}-${input.phaseRun.id}-${Date.now()}.json`
    )
    writeFileSync(
      path,
      JSON.stringify(
        {
          formatVersion: 1,
          writtenAt: new Date().toISOString(),
          runId: input.run.id,
          processId: input.run.processId,
          taskId: input.ctx.taskId,
          phaseId: input.phase.id,
          phaseKey: input.phase.key,
          phaseRunId: input.phaseRun.id,
          originalFailure: input.originalFailure,
          persistenceFailure: {
            message: sanitizeFailureText(
              errMessage(input.persistenceError),
              512
            ),
          },
        },
        null,
        2
      ),
      "utf8"
    )
    return { path, error: null }
  } catch (err) {
    return {
      path: null,
      error: sanitizeFailureText(errMessage(err), 512),
    }
  }
}

function persistenceFailure(input: {
  ctx: SchedulerCtx
  run: ProcessRun
  phase: ProcessPhase
  phaseRun: ProcessPhaseRun
  originalFailure: FailureContext
  persistenceError: unknown
  fallback: FailurePersistenceFallbackResult
}): FailureContext {
  const fallbackText = input.ctx.failureDiagnosticDir
    ? input.fallback.path
      ? `Best-effort fallback diagnostic: ${input.fallback.path}`
      : `Fallback diagnostic failed: ${input.fallback.error ?? "unknown error"}`
    : "No fallback diagnostic location is configured."
  return sanitizeFailureContext({
    code: "process_failure_persistence_failed",
    stage: "result_persistence",
    message:
      "Process failure diagnostics were not fully persisted. " +
      `Original failure: ${failureSummary(input.originalFailure)}. ` +
      `Persistence failure: ${errMessage(input.persistenceError)}. ` +
      fallbackText,
    retryable: false,
    attempt: input.originalFailure.attempt,
    maxAttempts: input.originalFailure.maxAttempts,
    runId: input.run.id,
    phaseRunId: input.phaseRun.id,
    phaseId: input.phase.id,
    taskId: input.ctx.taskId,
    workerTaskId: input.originalFailure.workerTaskId,
    agentName: input.originalFailure.agentName,
    toolCallId: input.originalFailure.toolCallId ?? null,
    cause: JSON.stringify({
      originalFailure: input.originalFailure,
      persistenceFailure: { message: errMessage(input.persistenceError) },
      fallback: input.fallback,
    }),
    occurredAt: Date.now(),
  })
}

// A gate's durable approval request blob (stored on the approvals row). Kinds
// share one shape but are accounted for SEPARATELY (gateRows/validatorGateRows
// filter by kind, so no kind cross-counts another):
//   - "process_phase_gate": the 029 approve-policy gate (count-based re-detection
//     via needsGate/gateRows/rework_round). Never mixed with the validator's.
//   - "process_validator_gate": the 031.1 exhaustion escalation — raised when a
//     validator phase burns its iteration cap without approving.
//   - "process_flag_gate": the 031.2 cross-phase flag confirmation — raised when a
//     phase-worker flagged an upstream defect and the process requires human
//     confirmation before the send-back. Carries the flagId to apply on approval.
interface GateRequest {
  kind: "process_phase_gate" | "process_validator_gate" | "process_flag_gate"
  phaseKey: string
  phaseRunId: string
  requestId: string
  approvalPacket?: ProcessApprovalPacket
  // Set only on a process_flag_gate (plan 031.2): the durable process_flags row to
  // apply on confirm, plus the target key + reason so the monitor can render the
  // confirmation card off the approvals row alone (no separate flags IPC).
  flagId?: string
  flagTargetKey?: string
  flagReason?: string
}

interface ApprovalArtifact {
  path: string
  name: string
  kind: "edit" | "write"
  fileType: "code" | "html" | "document"
  provenance: "phase_attributed" | "workspace"
}

interface ApprovalValidation {
  label: string
  status: "passed" | "failed" | "unknown"
  command: string | null
  output: string | null
}

interface ProcessApprovalPacket {
  requestId: string
  processRunId: string
  phaseRunId: string
  reworkRound: number
  createdAt: number
  summary: {
    outcome: string
    materialChanges: string[]
    validationSummary: string
    caveats: string[]
  }
  artifacts: ApprovalArtifact[]
  validations: ApprovalValidation[]
  downstream: Array<{ phaseId: string; name: string }>
  evidenceWarnings: string[]
  transcriptTaskId: string | null
}

const MUTATION_TOOLS = new Set([
  "edit_file_tool",
  "write_file_tool",
  "apply_patch_tool",
])

const VALIDATION_TOOL_NAMES = new Set([
  "run_shell_tool",
  "start_command",
  "test_diagnostics",
  "check_typescript",
])

function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/)
  return parts[parts.length - 1] || p
}

function fileTypeOf(path: string): ApprovalArtifact["fileType"] {
  if (/\.(html?|xhtml)$/i.test(path)) return "html"
  if (/\.(md|mdx|txt|rst|adoc)$/i.test(path)) return "document"
  return "code"
}

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw)
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function collectPatchArtifacts(
  operations: unknown,
  byPath: Map<string, ApprovalArtifact>
): void {
  if (!Array.isArray(operations)) return
  for (const op of operations) {
    if (!op || typeof op !== "object") continue
    const record = op as Record<string, unknown>
    const type = typeof record.type === "string" ? record.type : ""
    const path =
      type === "move" && typeof record.new_path === "string"
        ? record.new_path
        : typeof record.path === "string"
          ? record.path
          : ""
    if (!path || type === "delete") continue
    byPath.set(path, {
      path,
      name: basename(path),
      kind: type === "add" ? "write" : "edit",
      fileType: fileTypeOf(path),
      provenance: "workspace",
    })
  }
}

function collectApprovalEvidence(phaseRun: ProcessPhaseRun): {
  artifacts: ApprovalArtifact[]
  validations: ApprovalValidation[]
  evidenceWarnings: string[]
} {
  if (!phaseRun.taskId) {
    return {
      artifacts: [],
      validations: [],
      evidenceWarnings: [
        "No worker transcript task is attached to this phase.",
      ],
    }
  }
  const task = getTask(phaseRun.taskId)
  if (!task) {
    return {
      artifacts: [],
      validations: [],
      evidenceWarnings: ["The worker transcript task is no longer available."],
    }
  }

  const artifacts = new Map<string, ApprovalArtifact>()
  const validations: ApprovalValidation[] = []
  const toolCalls = new Map<
    string,
    { name: string; args: Record<string, unknown> | null }
  >()

  for (const message of listMessages(task.conversationId)) {
    for (const call of message.toolCalls ?? []) {
      const args = parseArgs(call.arguments)
      toolCalls.set(call.id, { name: call.name, args })
    }

    if (message.role !== "tool" || !message.toolCallId) continue
    const call = toolCalls.get(message.toolCallId)
    const output = message.content ?? ""
    if (!call) continue
    if (MUTATION_TOOLS.has(call.name) && !output.startsWith("ERROR[")) {
      if (call.name === "apply_patch_tool") {
        collectPatchArtifacts(call.args?.operations, artifacts)
      } else {
        const path = typeof call.args?.path === "string" ? call.args.path : ""
        if (path) {
          artifacts.set(path, {
            path,
            name: basename(path),
            kind: call.name === "edit_file_tool" ? "edit" : "write",
            fileType: fileTypeOf(path),
            provenance: "workspace",
          })
        }
      }
    }
    if (!VALIDATION_TOOL_NAMES.has(call.name)) continue
    const command =
      typeof call.args?.command === "string"
        ? call.args.command
        : typeof call.args?.cmd === "string"
          ? call.args.cmd
          : null
    validations.push({
      label: command ?? call.name,
      status: output.startsWith("ERROR[") ? "failed" : "passed",
      command,
      output: output.slice(0, 4000),
    })
  }

  return {
    artifacts: [...artifacts.values()],
    validations,
    evidenceWarnings:
      artifacts.size > 0
        ? [
            "File diffs are current workspace evidence derived from phase-attributed tool calls; they may include overlapping or subsequent edits.",
          ]
        : [],
  }
}

function buildApprovalPacket(input: {
  requestId: string
  run: ProcessRun
  phase: ProcessPhase
  phaseRun: ProcessPhaseRun
  graph: ProcessGraph
  gateKind: "phase" | "validator"
}): ProcessApprovalPacket {
  const evidence = collectApprovalEvidence(input.phaseRun)
  const downstream = input.graph.edges
    .filter((e) => e.fromPhaseId === input.phase.id)
    .map((e) => {
      const p = input.graph.phases.find((phase) => phase.id === e.toPhaseId)
      return { phaseId: e.toPhaseId, name: p?.name ?? e.toPhaseId }
    })
  const fileCount = evidence.artifacts.length
  const validationCount = evidence.validations.length
  const failedCount = evidence.validations.filter(
    (v) => v.status === "failed"
  ).length
  const materialChanges =
    fileCount > 0
      ? evidence.artifacts
          .slice(0, 6)
          .map((a) => `${a.kind === "edit" ? "Edited" : "Wrote"} ${a.path}`)
      : ["No changed files were attributed to this phase."]
  const validationSummary =
    validationCount === 0
      ? "No validation commands or diagnostics were recorded."
      : failedCount > 0
        ? `${failedCount} of ${validationCount} recorded validation checks failed.`
        : `${validationCount} recorded validation check${validationCount === 1 ? "" : "s"} passed.`
  const caveats = [
    ...evidence.evidenceWarnings,
    ...(validationCount === 0
      ? ["Review the transcript for manual validation details."]
      : []),
  ]
  return {
    requestId: input.requestId,
    processRunId: input.run.id,
    phaseRunId: input.phaseRun.id,
    reworkRound: input.phaseRun.reworkRound,
    createdAt: Date.now(),
    summary: {
      outcome:
        input.gateKind === "validator"
          ? input.phaseRun.error
            ? `${input.phase.name} could not be validated: ${input.phaseRun.error}`
            : `${input.phase.name} exhausted validator review and needs a human decision.`
          : `${input.phase.name} completed and is ready for approval.`,
      materialChanges,
      validationSummary,
      caveats,
    },
    artifacts: evidence.artifacts,
    validations: evidence.validations,
    downstream,
    evidenceWarnings: evidence.evidenceWarnings,
    transcriptTaskId: input.phaseRun.taskId,
  }
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
  // parentPhaseRunId → nested childRunId (plan 038.3). An ACCELERATOR for resume:
  // makeRunSubProcess consults this to skip the getProcessRunByParentPhaseRunId FK
  // query. Not load-bearing — the FK re-attach remains the correctness path.
  const nestedRunByPhaseRun = new Map<string, string>()
  // Which (sourceChildRunId → consumerPhaseId) pairs already spawned an instance,
  // so an each-subtask trigger is idempotent across re-evaluation and resume (025.2).
  const triggeredPairs = new Set<string>()
  const triggeredKey = (
    sourceChildRunId: string,
    consumerPhaseId: string
  ): string => `${sourceChildRunId}->${consumerPhaseId}`
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
    } else if (cp.label?.startsWith("subprocess:")) {
      // Sub-process nested-run mapping (plan 038.3). Latest-wins (a whole-reset
      // that re-creates the nested run writes a fresh row).
      const state = cp.state as SubprocessCheckpointState
      if (state?.parentPhaseRunId && state.childRunId)
        nestedRunByPhaseRun.set(state.parentPhaseRunId, state.childRunId)
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
      const children = processes.listPhaseRuns({
        runId: run.id,
        parentId: pr.id,
      })
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

  // All gate rows for a phase-run (a re-gated phase has >1 — plan 029). Order is
  // unspecified and NOT relied upon: gate detection is by count/status, not
  // recency, so equal-millisecond requested_at ties (real in fast runs) are safe.
  const gateRows = (phaseRunId: string) =>
    listApprovals({ taskId: ctx.taskId }).filter((a) => {
      const req = a.request as GateRequest | null
      return req?.kind === "process_phase_gate" && req.phaseRunId === phaseRunId
    })

  // Is the gate on a COMPLETED gated phase resolved? A phase with
  // gate_policy='approve' holds back its dependents until one of its gate rows is
  // 'approved'. Reads the durable approvals table (resume-correct). A
  // request-changes decision settles a row 'denied' (a denied row never becomes
  // approved, and you can't request changes on an already-approved gate), so
  // "any approved row" is exact and order-independent (plan 029).
  const gateResolved = (phase: ProcessPhase): boolean => {
    if (phase.gatePolicy !== "approve") return true
    const pr = runByPhaseId.get(phase.id)!
    return gateRows(pr.id).some((a) => a.status === "approved")
  }

  // Flip THIS run and every ancestor run (up the parent_phase_run_id chain) to
  // waiting_for_approval when a gate fires (plan 038.2). For a top-level run this is
  // just run.id; for a NESTED sub-process run the parent phase-run's run must also
  // show waiting_for_approval so the monitor badge + the paused-hint read correctly
  // (038.1 flipped only this run's row, leaving the top-level stuck reading
  // "running"). Bounded by MAX_PROCESS_DEPTH (the DAG has no cycle guard).
  const markWaitingForApprovalToTop = (): void => {
    let cur: ProcessRun | undefined = run
    let depth = 0
    while (cur && depth < MAX_PROCESS_DEPTH) {
      processes.updateProcessRun(cur.id, { status: "waiting_for_approval" })
      if (!cur.parentPhaseRunId) break
      const parentPhaseRun = processes.getPhaseRun(cur.parentPhaseRunId)
      cur = parentPhaseRun
        ? processes.getProcessRun(parentPhaseRun.runId)
        : undefined
      depth++
    }
  }

  // Create (once) the durable gate for a completed gated phase, flip the run to
  // waiting_for_approval, emit, checkpoint, and throw to unwind.
  const raiseGate = (phase: ProcessPhase): never => {
    const pr = runByPhaseId.get(phase.id)!
    const requestId = randomUUID()
    const freshPr = processes.getPhaseRun(pr.id) ?? pr
    const request: GateRequest = {
      kind: "process_phase_gate",
      phaseKey: phase.key,
      phaseRunId: pr.id,
      requestId,
      approvalPacket: buildApprovalPacket({
        requestId,
        run,
        phase,
        phaseRun: freshPr,
        graph,
        gateKind: "phase",
      }),
    }
    createApproval({ taskId: ctx.taskId, request })
    markWaitingForApprovalToTop()
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
      gateKind: "phase",
    })
    checkpoint()
    throw new GateBlockedError()
  }

  // Does a gated phase need a (fresh) gate raised? True when it's completed, has
  // an approve policy, at least one dependent, and the number of gate rows raised
  // so far equals its rework_round — i.e. every prior send-back is accounted for
  // and the phase has re-completed owing a new gate (plan 029 "Request changes").
  // Each rework round settles exactly one gate row and bumps rework_round, and
  // raiseGate inserts one row per raise, so:
  //   rows == round        → owe a gate (first completion: 0 == 0; after a
  //                          re-run: N settled rows == N rounds) → raise.
  //   rows == round + 1    → the gate for this (re-)completion is already raised
  //                          (pending or settled) → do not re-raise.
  // This is exact at any timestamp resolution (unlike comparing finishedAt).
  const needsGate = (phase: ProcessPhase): boolean => {
    if (phase.gatePolicy !== "approve") return false
    if (statusOf(phase.id) !== "completed") return false
    // A gate holds back the phase's dependents. Normally a phase with NO downstream
    // edge has nothing to hold, so it skips the gate. But in a NESTED sub-process run
    // (plan 038.2) a terminal phase DOES have an implicit dependent — the parent
    // phase that only advances once the whole nested run completes — so its gate must
    // still fire (else the sub-process completes and the parent marches on without
    // ever asking for approval, the reported bug). A run is nested iff it has a
    // parent phase-run.
    const isNestedRun = run.parentPhaseRunId !== null
    const hasDependents =
      isNestedRun || graph.edges.some((e) => e.fromPhaseId === phase.id)
    if (!hasDependents) return false
    const pr = runByPhaseId.get(phase.id)!
    // Re-read the phase-run: a request-changes re-run bumped rework_round after
    // the cached row was loaded at scheduler entry.
    const round = processes.getPhaseRun(pr.id)?.reworkRound ?? 0
    return gateRows(pr.id).length <= round
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

  // Validator gate rows for a phase-run (plan 031.1). Kept SEPARATE from gateRows
  // (which is the 029 phase-gate kind) so the two gate kinds never cross-count.
  const validatorGateRows = (phaseRunId: string) =>
    listApprovals({ taskId: ctx.taskId }).filter((a) => {
      const req = a.request as GateRequest | null
      return (
        req?.kind === "process_validator_gate" && req.phaseRunId === phaseRunId
      )
    })

  const validatorReviewRetryRequested = (phaseRunId: string): boolean =>
    validatorGateRows(phaseRunId).some(
      (a) =>
        a.status === "denied" &&
        (a.decision as { retryReview?: boolean } | null)?.retryReview === true
    )

  const validatorManualOverrideApproved = (phaseRunId: string): boolean =>
    validatorGateRows(phaseRunId).some((a) => {
      if (a.status !== "approved") return false
      const decision = a.decision as {
        manualOverride?: boolean
        gateKind?: string
        phaseRunId?: string
      } | null
      return (
        decision?.manualOverride === true &&
        decision.gateKind === "process_validator_gate" &&
        decision.phaseRunId === phaseRunId
      )
    })

  // The VALIDATOR escalation (plan 031.1). When a validator phase burns its
  // iteration cap, or the review boundary fails before a valid verdict arrives,
  // raise a human gate on the SAME phase-run. The phase-run is left
  // `waiting_for_approval`, so dependents wait without a gateResolved check.
  const raiseValidatorGate = (
    phase: ProcessPhase,
    phaseRun: ProcessPhaseRun
  ): never => {
    const requestId = randomUUID()
    const freshPr = processes.getPhaseRun(phaseRun.id) ?? phaseRun
    const request: GateRequest = {
      kind: "process_validator_gate",
      phaseKey: phase.key,
      phaseRunId: phaseRun.id,
      requestId,
      approvalPacket: buildApprovalPacket({
        requestId,
        run,
        phase,
        phaseRun: freshPr,
        graph,
        gateKind: "validator",
      }),
    }
    createApproval({ taskId: ctx.taskId, request })
    markWaitingForApprovalToTop()
    ctx.emit({
      type: "process_phase",
      runId: run.id,
      phaseRunId: phaseRun.id,
      phaseKey: phase.key,
      agentName: phaseRun.agentName,
      status: "waiting_for_approval",
      parentId: phaseRun.parentId,
      requestId,
      gateKind: "validator",
      failure: freshPr.failure,
    })
    checkpoint()
    throw new GateBlockedError()
  }

  // Reconcile any validator exhaustion gate that a human has settled (plan 031.1).
  // A phase-run parked in `waiting_for_approval` by raiseValidatorGate has an
  // approved validator gate row → settle it `completed` and emit, so the ready-set
  // (which requires a source be `completed`) releases its dependents. Denied /
  // still-pending rows are left as-is (a denied validator gate is a dead-end in
  // v1, mirroring process:deny; a request-changes send-back resets the row to
  // `pending` via the 029 path, so it won't match here). Idempotent — a row not in
  // waiting_for_approval is skipped.
  const reconcileValidatorGates = (): void => {
    for (const phase of graph.phases) {
      if (!phase.validator) continue
      const pr = runByPhaseId.get(phase.id)
      if (!pr) continue
      const fresh = processes.getPhaseRun(pr.id)
      if (fresh?.status !== "waiting_for_approval") continue
      if (!validatorManualOverrideApproved(pr.id)) continue
      processes.updatePhaseRun(pr.id, {
        status: "completed",
        finishedAt: Date.now(),
      })
      emitPhase(phase, pr.id, "completed")
    }
  }

  // Route pending cross-phase rework flags (plan 031.2). Called at QUIESCENCE
  // (inFlight empty) — the only safe point to reset phases, since nothing is
  // running and every phase is terminal or pending. Returns true if it changed
  // state (a flag was applied → the walk must re-evaluate), false if there's
  // nothing pending. Throws GateBlockedError when a flag needs human confirmation.
  const routePendingFlags = (): boolean => {
    const pending = processes.listFlags({ runId: run.id, status: "pending" })
    if (pending.length === 0) return false

    if (ctx.requireFlagApproval === false) {
      // Autonomous: apply each pending flag's reset inline, mark it applied.
      let changed = false
      for (const flag of pending) {
        if (ctx.applyFlag) {
          ctx.applyFlag(flag)
          changed = true
        }
        processes.updateFlagStatus(flag.id, "applied")
      }
      return changed
    }

    // Confirm: raise a human gate for the first pending flag (one at a time —
    // approving/dismissing it resumes and re-routes the next). Throws to unwind.
    return raiseFlagGate(pending[0])
  }

  // Raise a durable human-confirmation gate for a pending flag (plan 031.2). Near
  // copy of raiseGate/raiseValidatorGate but keyed to the FLAGGING phase-run (so
  // the monitor renders the card on the phase that raised it) and carrying the
  // flagId to apply on approval. Flips the run waiting_for_approval + throws.
  const raiseFlagGate = (flag: ProcessFlag): never => {
    // A pending flag being routed always still has its flagging instance (the
    // SET-NULL only fires later, when a subsequent per-child reset deletes a
    // SETTLED flag's instance). Fall back defensively so the event stays valid.
    const flaggingRunId = flag.flaggingPhaseRunId ?? ""
    const flaggingRun = flaggingRunId
      ? processes.getPhaseRun(flaggingRunId)
      : undefined
    const flaggingPhase = flaggingRun
      ? phasesById.get(flaggingRun.phaseId)
      : undefined
    const targetPhase = phasesById.get(flag.targetPhaseId)
    const requestId = randomUUID()
    const request: GateRequest = {
      kind: "process_flag_gate",
      phaseKey: flaggingPhase?.key ?? "",
      phaseRunId: flaggingRunId,
      requestId,
      flagId: flag.id,
      flagTargetKey: targetPhase?.key ?? "",
      flagReason: flag.reason,
    }
    createApproval({ taskId: ctx.taskId, request })
    markWaitingForApprovalToTop()
    ctx.emit({
      type: "process_phase",
      runId: run.id,
      phaseRunId: flaggingRunId,
      phaseKey: flaggingPhase?.key ?? "",
      agentName: flaggingRun?.agentName ?? null,
      status: "waiting_for_approval",
      parentId: flaggingRun?.parentId ?? null,
      requestId,
      gateKind: "flag",
    })
    checkpoint()
    throw new GateBlockedError()
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
  // For a combined fan-out + sub-process phase (plan 038.3) each child runs the
  // sub-process as its own nested run (seeded with the child's briefing) instead
  // of a worker — mirroring the ready-set fork below.
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
    const promise = (
      phase.subprocessId
        ? runSubProcessWithRetry(phase, childRun, prompt)
        : runPhaseWithRetry(phase, childRun, prompt)
    ).then(() => childRun.id)
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

  // Dispatch a SUB-PROCESS phase (plan 038.1): set the phase-run `running`, then run
  // its nested run to completion inline via runSubProcessWithRetry. Unlike a fan-out
  // parent, a sub-process phase-run has exactly ONE unit of in-flight work (the
  // whole nested run), so it settles DIRECTLY off the closure's result — it is NOT a
  // container (no derive/abort-sweep machinery). Keyed in inFlight by its own run id,
  // exactly like a normal phase (dispatch), so it holds one PER_RUN_CONCURRENCY slot.
  const dispatchSubProcess = (phase: ProcessPhase): void => {
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
    const promise = runSubProcessWithRetry(phase, pr).then(() => pr.id)
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
          title: subtaskTitle(prompt),
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
          ? ctx.buildEachSubtaskPrompt({
              phase: consumer,
              sourceChildRun: child,
            })
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
            // Label the per-child instance by the source child it consumes (its
            // title), else derive from the instance's own kickoff prompt.
            title: child.title ?? (prompt ? subtaskTitle(prompt) : null),
            // First-class lineage (plan 031.2): which source fan-out child this
            // instance consumes, so a flag from it resolves to that specific child.
            sourceChildRunId: child.id,
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
      const latest = processes.getPhaseRun(parentRun.id) ?? parentRun
      const failure = processFailure({
        code: "decomposer_missing",
        stage: "decomposition",
        message: "fan-out phase has no decomposer configured",
        retryable: false,
        attempt: null,
        maxAttempts: MAX_PHASE_ATTEMPTS,
        run,
        phase,
        phaseRun: latest,
        taskId: ctx.taskId,
      })
      persistPhaseFailure({
        phase,
        phaseRun: latest,
        failure,
        patch: {
          status: "failed",
          error: failure.message,
          failure,
          finishedAt: Date.now(),
        },
        emitStatus: "failed",
      })
      return
    }
    let attempt = 0
    while (true) {
      attempt++
      const result = await ctx.decompose({
        phaseRun: parentRun,
        phase,
        attempt,
        signal: ctx.signal,
      })
      if (result.stopped || ctx.signal.aborted) {
        settleStoppedPhaseRun(phase, parentRun.id)
        return
      }
      const subtasks = result.subtasks ?? []
      if (result.error || subtasks.length === 0) {
        const err = result.error ?? "fan-out produced no sub-tasks"
        const latest = processes.getPhaseRun(parentRun.id) ?? parentRun
        const failure = processFailure({
          resultFailure: result.failure,
          code:
            subtasks.length === 0
              ? "decomposition_empty"
              : "decomposition_failed",
          stage: subtasks.length === 0 ? "output_validation" : "decomposition",
          message: err,
          retryable: result.retryable,
          attempt,
          maxAttempts: MAX_PHASE_ATTEMPTS,
          run,
          phase,
          phaseRun: latest,
          taskId: ctx.taskId,
        })
        if (result.retryable && attempt < MAX_PHASE_ATTEMPTS) {
          persistPhaseFailure({
            phase,
            phaseRun: latest,
            failure,
            patch: {
              iteration: attempt,
              error: failure.message,
              failure,
            },
          })
          continue
        }
        persistPhaseFailure({
          phase,
          phaseRun: latest,
          failure,
          patch: {
            status: "failed",
            error: failure.message,
            failure,
            finishedAt: Date.now(),
            iteration: attempt,
          },
          emitStatus: "failed",
        })
        return
      }
      // Success: spawn children. The parent stays `running` — deriveFanoutParents
      // settles it once every child is terminal.
      createChildrenAtomic(parentRun, subtasks)
      processes.updatePhaseRun(parentRun.id, {
        iteration: attempt,
        error: null,
        failure: null,
      })
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
        status === "running" || (status === "pending" && !phase.fanOut)
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
      const failedChild = children.find((c) => c.status === "failed")
      const derivedFailure =
        derived === "failed"
          ? (failedChild?.failure ??
            processFailure({
              code: "fanout_child_failed",
              stage: "scheduler",
              message: failedChild?.error ?? "fan-out child failed",
              retryable: false,
              run,
              phase,
              phaseRun: pr,
              taskId: ctx.taskId,
            }))
          : null
      const patch: Parameters<typeof processes.updatePhaseRun>[1] = {
        status: derived,
        error:
          failedChild?.error ?? (derived === "completed" ? null : pr.error),
        failure:
          derived === "failed"
            ? derivedFailure
            : derived === "completed"
              ? null
              : pr.failure,
        finishedAt: Date.now(),
      }
      if (derivedFailure) {
        persistPhaseFailure({
          phase,
          phaseRun: pr,
          failure: derivedFailure,
          recordAttempt: !failedChild?.failure,
          patch,
          emitStatus: "failed",
        })
      } else {
        processes.updatePhaseRun(pr.id, patch)
        emitPhase(phase, pr.id, derived)
      }
      settledAny = true
    }
    return settledAny
  }

  const runPhaseWithRetry = async (
    phase: ProcessPhase,
    phaseRun: ProcessPhaseRun,
    subtaskPrompt?: string
  ): Promise<void> => {
    // A validator (plan 031.1) reviews only a top-level, non-fan-out phase run —
    // never a fan-out CHILD or on_each_subtask instance (subtaskPrompt present):
    // sub-DAG / container replay is plan 031.2. Inert if no validator injected.
    const runsValidator =
      phase.validator && !!ctx.validate && subtaskPrompt === undefined
    let reviewOnlyRetry =
      runsValidator &&
      phaseRun.taskId !== null &&
      validatorReviewRetryRequested(phaseRun.id)
    let attempt = 0
    // Chain a child controller so run-level cancel unwinds the phase worker.
    while (true) {
      attempt++
      if (!reviewOnlyRetry || attempt > 1) {
        const result = await ctx.runPhase({
          phaseRun,
          phase,
          subtaskPrompt,
          signal: ctx.signal,
        })
        if (result.stopped || ctx.signal.aborted) {
          settleStoppedPhaseRun(phase, phaseRun.id)
          return
        }
        if (result.error) {
          const latest = processes.getPhaseRun(phaseRun.id) ?? phaseRun
          const failure = processFailure({
            resultFailure: result.failure,
            code: "phase_worker_failed",
            stage: result.failure?.stage ?? "model_request",
            message: result.error,
            retryable: result.retryable,
            attempt,
            maxAttempts: MAX_PHASE_ATTEMPTS,
            run,
            phase,
            phaseRun: latest,
            taskId: ctx.taskId,
          })
          if (result.retryable && attempt < MAX_PHASE_ATTEMPTS) {
            persistPhaseFailure({
              phase,
              phaseRun: latest,
              failure,
              patch: {
                iteration: attempt,
                error: failure.message,
                failure,
              },
            })
            continue
          }
          persistPhaseFailure({
            phase,
            phaseRun: latest,
            failure,
            patch: {
              status: "failed",
              error: failure.message,
              failure,
              finishedAt: Date.now(),
              iteration: attempt,
            },
            emitStatus: "failed",
          })
          return
        }
        if (result.outputIdentity !== undefined) {
          processes.updatePhaseRun(phaseRun.id, {
            outputIdentity: result.outputIdentity,
          })
        }
      }

      // The worker succeeded. Before settling `completed`, run the validator
      // review (plan 031.1) if enabled: only a valid approval settles the phase; a
      // valid rejection re-runs the worker with feedback (via the 029 rework
      // channel) until the iteration cap, at which point it escalates to a human
      // gate. Reviewer errors or invalid output hold the phase at the same gate.
      if (runsValidator) {
        const outputIdentity =
          processes.getPhaseRun(phaseRun.id)?.outputIdentity ?? null
        const verdict = await ctx.validate!({
          phase,
          phaseRun,
          outputIdentity,
          signal: ctx.signal,
        })
        if (verdict.stopped || ctx.signal.aborted) {
          settleStoppedPhaseRun(phase, phaseRun.id)
          return
        }
        const currentOutputIdentity =
          processes.getPhaseRun(phaseRun.id)?.outputIdentity ?? null
        if (
          verdict.targetOutputIdentity !== undefined &&
          verdict.targetOutputIdentity !== currentOutputIdentity
        ) {
          return
        }
        if (verdict.error) {
          const latest = processes.getPhaseRun(phaseRun.id) ?? phaseRun
          const failure = processFailure({
            resultFailure: verdict.failure,
            code: "validator_review_failed",
            stage: verdict.failure?.stage ?? "reviewer",
            message: verdict.error,
            retryable: verdict.retryable,
            attempt: latest.validatorRound + 1,
            maxAttempts:
              phase.validatorMaxIterations > 0
                ? phase.validatorMaxIterations
                : DEFAULT_VALIDATOR_ITERATIONS,
            run,
            phase,
            phaseRun: latest,
            taskId: ctx.taskId,
          })
          persistPhaseFailure({
            phase,
            phaseRun: latest,
            failure,
            patch: {
              status: "waiting_for_approval",
              error: failure.message,
              failure,
              reworkNote: null,
            },
          })
          raiseValidatorGate(phase, processes.getPhaseRun(phaseRun.id)!)
        }
        if (!verdict.approved) {
          const round =
            (processes.getPhaseRun(phaseRun.id)?.validatorRound ?? 0) + 1
          const cap =
            phase.validatorMaxIterations > 0
              ? phase.validatorMaxIterations
              : DEFAULT_VALIDATOR_ITERATIONS
          if (round >= cap) {
            // Exhaustion → escalate to a human gate. Park the phase-run in
            // waiting_for_approval carrying the last feedback; raiseValidatorGate
            // throws to unwind the scheduler (the run settles paused).
            processes.updatePhaseRun(phaseRun.id, {
              status: "waiting_for_approval",
              validatorRound: round,
              reworkNote: verdict.feedback ?? null,
            })
            raiseValidatorGate(phase, processes.getPhaseRun(phaseRun.id)!)
          }
          // Under the cap: stash the feedback + bump the round, then re-run the
          // worker. The re-run's kickoff reads reworkNote fresh (service.ts), so
          // the worker sees the requested changes. Reset the transient-retry
          // budget for the fresh worker run.
          processes.updatePhaseRun(phaseRun.id, {
            validatorRound: round,
            reworkNote: verdict.feedback ?? null,
            outputIdentity: null,
          })
          reviewOnlyRetry = false
          attempt = 0
          continue
        }
      }

      processes.updatePhaseRun(phaseRun.id, {
        status: "completed",
        error: null,
        failure: null,
        finishedAt: Date.now(),
        iteration: attempt,
      })
      emitPhase(phase, phaseRun.id, "completed")
      return
    }
  }

  // Settle a SUB-PROCESS phase (plan 038.1) off its nested run's outcome. A trimmed
  // runPhaseWithRetry: NO validator (a sub-process's own phases carry their own
  // validators — the parent phase just aggregates) and NO retry (re-driving the
  // same child run is deterministic — the idempotent seed never resets a failed
  // frontier, so recovery is parent-level restartRun, plan 038.2). `subtaskPrompt`
  // is set when the sub-process runs per fan-out child (plan 038.3), seeding the
  // nested run's objective; absent for a top-level sub-process phase.
  // A GateBlockedError from inside the nested run propagates uncaught (the whole run
  // pauses on the shared task). Absent runner → fail loudly (mirrors the no-decomposer
  // guard) so a mis-wired engine never silently completes a sub-process phase.
  const runSubProcessWithRetry = async (
    phase: ProcessPhase,
    phaseRun: ProcessPhaseRun,
    subtaskPrompt?: string
  ): Promise<void> => {
    if (!ctx.runSubProcess) {
      const latest = processes.getPhaseRun(phaseRun.id) ?? phaseRun
      const failure = processFailure({
        code: "subprocess_runner_missing",
        stage: "subprocess",
        message: "sub-process phase has no runner configured",
        retryable: false,
        attempt: 1,
        maxAttempts: 1,
        run,
        phase,
        phaseRun: latest,
        taskId: ctx.taskId,
      })
      persistPhaseFailure({
        phase,
        phaseRun: latest,
        failure,
        patch: {
          status: "failed",
          error: failure.message,
          failure,
          finishedAt: Date.now(),
        },
        emitStatus: "failed",
      })
      return
    }
    const result = await ctx.runSubProcess({
      phaseRun,
      phase,
      depth: ctx.processDepth ?? 0,
      subtaskPrompt,
      existingChildRunId: nestedRunByPhaseRun.get(phaseRun.id),
      signal: ctx.signal,
    })
    if (result.stopped || ctx.signal.aborted) {
      settleStoppedPhaseRun(phase, phaseRun.id)
      return
    }
    if (result.error) {
      const latest = processes.getPhaseRun(phaseRun.id) ?? phaseRun
      const failure = processFailure({
        resultFailure: result.failure,
        code: "subprocess_failed",
        stage: "subprocess",
        message: result.error,
        retryable: result.retryable,
        attempt: 1,
        maxAttempts: 1,
        run,
        phase,
        phaseRun: latest,
        taskId: ctx.taskId,
      })
      persistPhaseFailure({
        phase,
        phaseRun: latest,
        failure,
        patch: {
          status: "failed",
          error: failure.message,
          failure,
          finishedAt: Date.now(),
        },
        emitStatus: "failed",
      })
      return
    }
    processes.updatePhaseRun(phaseRun.id, {
      status: "completed",
      error: null,
      failure: null,
      finishedAt: Date.now(),
    })
    emitPhase(phase, phaseRun.id, "completed")
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
      failure: pr?.failure ?? null,
    })
  }

  const persistPhaseFailure = (input: {
    phase: ProcessPhase
    phaseRun: ProcessPhaseRun
    failure: FailureContext
    recordAttempt?: boolean
    patch: Parameters<typeof processes.updatePhaseRun>[1]
    emitStatus?: "failed" | "waiting_for_approval"
  }): ProcessPhaseRun => {
    try {
      if (input.recordAttempt !== false) {
        recordFailedAttempt({
          run,
          phase: input.phase,
          phaseRun: input.phaseRun,
          taskId: ctx.taskId,
          failure: input.failure,
        })
      }
      const updated = processes.updatePhaseRun(input.phaseRun.id, input.patch)
      if (input.emitStatus) {
        ctx.emit({
          type: "process_phase",
          runId: run.id,
          phaseRunId: input.phaseRun.id,
          phaseKey: input.phase.key,
          agentName: updated.agentName ?? input.failure.agentName,
          status: input.emitStatus,
          parentId: updated.parentId,
          failure: updated.failure ?? input.failure,
        })
      }
      return updated
    } catch (err) {
      const fallback = writeFailurePersistenceFallback({
        ctx,
        run,
        phase: input.phase,
        phaseRun: input.phaseRun,
        originalFailure: input.failure,
        persistenceError: err,
      })
      const failure = persistenceFailure({
        ctx,
        run,
        phase: input.phase,
        phaseRun: input.phaseRun,
        originalFailure: input.failure,
        persistenceError: err,
        fallback,
      })
      try {
        processes.updatePhaseRun(input.phaseRun.id, {
          status: "failed",
          error: failure.message,
          failure,
          finishedAt: Date.now(),
        })
      } catch {
        // The fallback diagnostic and thrown FailurePersistenceError are the source
        // of truth when SQLite cannot even record the persistence failure.
      }
      try {
        ctx.emit({
          type: "process_phase",
          runId: run.id,
          phaseRunId: input.phaseRun.id,
          phaseKey: input.phase.key,
          agentName: input.phaseRun.agentName ?? failure.agentName,
          status: "failed",
          parentId: input.phaseRun.parentId,
          failure,
        })
      } catch {
        // A task_events write can be the failing persistence boundary. The task
        // result still carries the honest error, and the external fallback may
        // carry the original failure.
      }
      throw new FailurePersistenceError(failure, fallback)
    }
  }

  // Whether the current abort is RESUMABLE (app quit / pause) vs a genuine user
  // cancel (plan 038.3). A resumable abort must NOT settle in-flight phase-runs to
  // terminal `cancelled` — that would strand them (crash-reset only resets
  // running/ready), leaving a run that can never complete on resume.
  const resumableAbort = (): boolean =>
    ctx.signal.reason === SHUTDOWN_ABORT_REASON ||
    ctx.signal.reason === PAUSE_ABORT_REASON

  // Settle a phase-run whose worker returned `stopped` (or observed the abort). On a
  // genuine cancel → terminal `cancelled`. On a resumable abort → leave it as-is
  // (`running`), so crash-reset resumes it on the next boot (plan 038.3).
  const settleStoppedPhaseRun = (
    phase: ProcessPhase,
    phaseRunId: string
  ): void => {
    if (resumableAbort()) return
    processes.updatePhaseRun(phaseRunId, {
      status: "cancelled",
      finishedAt: Date.now(),
    })
    emitPhase(phase, phaseRunId, "cancelled")
  }

  // ── the walk ──────────────────────────────────────────────────────────────
  while (true) {
    if (ctx.signal.aborted) {
      // The signal aborted: stop scheduling. HOW we settle phase-runs depends on
      // WHY (plan 038.3 — a quit used to permanently `cancel` in-flight phases):
      //   • SHUTDOWN (app quit) / PAUSE — RESUMABLE. Leave non-terminal phase-runs as
      //     they are; the next boot's reconcile flips the task interrupted→queued and
      //     the crash-reset resets `running`→`pending` so the run resumes where it
      //     left off. Settling them terminal-`cancelled` here would strand them (the
      //     crash-reset only resets running/ready, never cancelled) → a run that can
      //     never complete.
      //   • A genuine user CANCEL (plain abort, no reason) — TERMINAL. Settle every
      //     non-terminal phase-run of THIS run to cancelled so the DAG isn't left with
      //     a dangling `running`/`pending` row. Covers a CONTAINER (status not owned by
      //     any in-flight promise) AND a plain phase-run whose worker / nested
      //     sub-process run was mid-flight (the nested run's own scheduler settles its
      //     rows; this run's phase-run row is settled here).
      if (!resumableAbort()) {
        for (const pr of processes.listPhaseRuns({ runId: run.id })) {
          const phase = phasesById.get(pr.phaseId)
          // Settle any RUNNING phase-run — a plain worker / nested sub-process (plan
          // 038.3) or a container — plus a still-PENDING container (its status isn't
          // owned by an in-flight promise). A never-started plain `pending` phase is
          // left as-is (unchanged behavior: it simply never ran).
          const isContainerRow =
            pr.parentId === null && phase !== undefined && isContainer(phase)
          const settle =
            pr.status === "running" ||
            (pr.status === "pending" && isContainerRow)
          if (!settle) continue
          processes.updatePhaseRun(pr.id, {
            status: "cancelled",
            finishedAt: Date.now(),
          })
          if (phase) emitPhase(phase, pr.id, "cancelled")
        }
      }
      return
    }

    // Settle any validator EXHAUSTION gate a human has approved (plan 031.1):
    // flip the parked phase `completed` so its dependents can become ready. Runs
    // first — the resumed run (post-approval) must reconcile before readiness.
    reconcileValidatorGates()

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

    // A pending cross-phase rework flag (plan 031.2) means a rework is queued that
    // will reset the flagged phase + its downstream. STOP dispatching new phases
    // until it's routed — otherwise the flagging phase's dependents (e.g. Publish)
    // would dispatch in the window before the terminal-check routes the flag, doing
    // throwaway work on soon-to-be-invalidated output. In-flight phases drain, the
    // walk reaches quiescence, and routePendingFlags handles it there.
    const flagPending =
      processes.listFlags({ runId: run.id, status: "pending" }).length > 0

    // Dispatch ready phases up to the per-run pool budget. Fan-out is checked
    // FIRST (plan 038.3): a combined fan-out + sub-process phase decomposes at the
    // parent, then each child dispatches the sub-process (dispatchChild forks). A
    // pure sub-process phase (no fan-out) runs one nested run directly; a normal
    // phase runs a worker directly.
    if (!flagPending)
      for (const phase of ready) {
        if (inFlight.size >= PER_RUN_CONCURRENCY) break
        if (phase.fanOut) dispatchDecompose(phase)
        else if (phase.subprocessId) dispatchSubProcess(phase)
        else dispatch(phase)
      }

    // Dispatch any pending fan-out CHILD (plan 025.1). Children have no edges —
    // they're ready by construction once decompose created them — and share the
    // per-run pool with sibling phases.
    if (!flagPending) {
      const pendingChildren = processes
        .listPhaseRuns({ runId: run.id })
        .filter((pr) => pr.parentId !== null && pr.status === "pending")
      for (const child of pendingChildren) {
        if (inFlight.size >= PER_RUN_CONCURRENCY) break
        if (inFlight.has(child.id)) continue
        dispatchChild(child)
      }
    }

    if (inFlight.size === 0) {
      // Nothing running. Either the run is complete (all phases terminal), it's
      // wedged (a failed phase blocks its dependents), OR a pending rework flag is
      // holding back the flagging phase's dependents (they were left `pending` by
      // the dispatch guard above). Distinguish these.
      const anyFailed = graph.phases.some((p) =>
        ["failed", "cancelled"].includes(statusOf(p.id))
      )
      // Route any pending cross-phase rework flag (plan 031.2) at this quiescent
      // point BEFORE concluding — this is the only safe reset point (nothing
      // in-flight). Skipped on a failed run (a failed phase wedges the DAG; a flag
      // targeting a completed upstream can't unwedge it, so let the failure
      // surface). Autonomous → applyFlag reset each (re-walk); confirm →
      // raiseFlagGate throws GateBlockedError (run pauses). Not gated on
      // allTerminal: the dispatch guard leaves the flagging phase's dependents
      // `pending`, so they're intentionally NOT terminal here.
      if (!anyFailed && routePendingFlags()) continue
      const allTerminal = graph.phases.every((p) =>
        ["completed", "failed", "cancelled", "skipped"].includes(statusOf(p.id))
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

import { parseCompletionContract } from "../../process/completion-contract"
import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type {
  EdgeTrigger,
  PhaseCompletionContract,
  PhaseCompletionReceipt,
  FailureContext,
  FailureStage,
  PhaseGatePolicy,
  PhaseRouting,
  PhaseRunStatus,
  ProcessPhaseAttempt,
  ProcessDefinition,
  ProcessEdge,
  ProcessFlag,
  ProcessFlagStatus,
  ProcessGraph,
  ProcessPhase,
  ProcessPhaseAgent,
  ProcessPhaseRun,
  ProcessRun,
  ProcessRunStatus,
} from "../types"

// Repository for the Process engine (plan 025). Flat module of functions,
// namespaced by the barrel as `processes.*`. Two halves: definition authoring
// (definitions + phases + agents + edges) and run execution (runs + phase runs).

// ── row types + mappers ─────────────────────────────────────────────────────

interface ProcessDefinitionRow {
  id: string
  name: string
  description: string | null
  require_flag_approval: number
  created_at: number
  updated_at: number
}

function toDefinition(row: ProcessDefinitionRow): ProcessDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    requireFlagApproval: row.require_flag_approval === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

interface ProcessPhaseRow {
  completion_contract: string
  id: string
  process_id: string
  key: string
  name: string
  routing: PhaseRouting
  gate_policy: PhaseGatePolicy
  fan_out: number
  max_rework_rounds: number
  dot_folder: number
  validator: number
  validator_max_iterations: number
  validator_agent: string | null
  subprocess_id: string | null
  position: number
}

function toPhase(row: ProcessPhaseRow): ProcessPhase {
  return {
    completionContract: parseCompletionContract(
      JSON.parse(row.completion_contract)
    ),
    id: row.id,
    processId: row.process_id,
    key: row.key,
    name: row.name,
    routing: row.routing,
    gatePolicy: row.gate_policy,
    fanOut: row.fan_out === 1,
    maxReworkRounds: row.max_rework_rounds,
    dotFolder: row.dot_folder === 1,
    validator: row.validator === 1,
    validatorMaxIterations: row.validator_max_iterations,
    validatorAgent: row.validator_agent,
    subprocessId: row.subprocess_id,
    position: row.position,
  }
}

interface ProcessPhaseAgentRow {
  id: string
  phase_id: string
  agent_name: string
  skills: string | null
  tools: string | null
  position: number
}

function toPhaseAgent(row: ProcessPhaseAgentRow): ProcessPhaseAgent {
  return {
    id: row.id,
    phaseId: row.phase_id,
    agentName: row.agent_name,
    // Tri-state: SQL NULL → null (agent's own); a JSON array → [] or [list].
    skills: row.skills === null ? null : (JSON.parse(row.skills) as string[]),
    tools: row.tools === null ? null : (JSON.parse(row.tools) as string[]),
    position: row.position,
  }
}

interface ProcessEdgeRow {
  id: string
  process_id: string
  from_phase_id: string
  to_phase_id: string
  trigger: EdgeTrigger
}

function toEdge(row: ProcessEdgeRow): ProcessEdge {
  return {
    id: row.id,
    processId: row.process_id,
    fromPhaseId: row.from_phase_id,
    toPhaseId: row.to_phase_id,
    trigger: row.trigger,
  }
}

interface ProcessRunRow {
  completion_contracts: string | null
  id: string
  process_id: string | null
  source_conversation_id: string | null
  workspace_id: string | null
  task_id: string | null
  objective: string | null
  title: string | null
  parent_phase_run_id: string | null
  status: ProcessRunStatus
  started_at: number | null
  finished_at: number | null
  created_at: number
}

function toRun(row: ProcessRunRow): ProcessRun {
  return {
    completionContracts:
      row.completion_contracts === null
        ? null
        : JSON.parse(row.completion_contracts),
    id: row.id,
    processId: row.process_id,
    sourceConversationId: row.source_conversation_id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    objective: row.objective,
    title: row.title,
    parentPhaseRunId: row.parent_phase_run_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  }
}

interface ProcessPhaseRunRow {
  completion_receipt: string | null
  id: string
  run_id: string
  phase_id: string
  parent_id: string | null
  status: PhaseRunStatus
  task_id: string | null
  agent_name: string | null
  title: string | null
  iteration: number
  error: string | null
  failure: string | null
  started_at: number | null
  finished_at: number | null
  rework_note: string | null
  rework_round: number
  validator_round: number
  output_identity: string | null
  source_child_run_id: string | null
}

function toPhaseRun(row: ProcessPhaseRunRow): ProcessPhaseRun {
  return {
    completionReceipt:
      row.completion_receipt === null
        ? null
        : JSON.parse(row.completion_receipt),
    id: row.id,
    runId: row.run_id,
    phaseId: row.phase_id,
    parentId: row.parent_id,
    status: row.status,
    taskId: row.task_id,
    agentName: row.agent_name,
    title: row.title,
    iteration: row.iteration,
    error: row.error,
    failure:
      row.failure === null ? null : (JSON.parse(row.failure) as FailureContext),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    reworkNote: row.rework_note,
    reworkRound: row.rework_round,
    validatorRound: row.validator_round,
    outputIdentity: row.output_identity,
    sourceChildRunId: row.source_child_run_id,
  }
}

interface ProcessPhaseAttemptRow {
  id: string
  run_id: string
  phase_run_id: string
  phase_id: string
  task_id: string | null
  worker_task_id: string | null
  agent_name: string | null
  stage: FailureStage
  status: "failed"
  attempt: number | null
  max_attempts: number | null
  error: string
  failure: string
  created_at: number
}

function toPhaseAttempt(row: ProcessPhaseAttemptRow): ProcessPhaseAttempt {
  return {
    id: row.id,
    runId: row.run_id,
    phaseRunId: row.phase_run_id,
    phaseId: row.phase_id,
    taskId: row.task_id,
    workerTaskId: row.worker_task_id,
    agentName: row.agent_name,
    stage: row.stage,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    error: row.error,
    failure: JSON.parse(row.failure) as FailureContext,
    createdAt: row.created_at,
  }
}

// ── definitions ─────────────────────────────────────────────────────────────

export function createProcessDefinition(input: {
  name: string
  description?: string | null
}): ProcessDefinition {
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      "INSERT INTO process_definitions (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(id, input.name, input.description ?? null, now, now)
  return getProcessDefinition(id)!
}

export function getProcessDefinition(
  id: string
): ProcessDefinition | undefined {
  const row = getDb()
    .prepare("SELECT * FROM process_definitions WHERE id = ?")
    .get(id) as ProcessDefinitionRow | undefined
  return row ? toDefinition(row) : undefined
}

export function listProcessDefinitions(): ProcessDefinition[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM process_definitions ORDER BY name COLLATE NOCASE ASC"
    )
    .all() as ProcessDefinitionRow[]
  return rows.map(toDefinition)
}

export function updateProcessDefinition(
  id: string,
  patch: {
    name?: string
    description?: string | null
    requireFlagApproval?: boolean
  }
): ProcessDefinition {
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.name !== undefined) {
    sets.push("name = ?")
    values.push(patch.name)
  }
  if (patch.description !== undefined) {
    sets.push("description = ?")
    values.push(patch.description)
  }
  if (patch.requireFlagApproval !== undefined) {
    sets.push("require_flag_approval = ?")
    values.push(patch.requireFlagApproval ? 1 : 0)
  }
  if (sets.length > 0) {
    sets.push("updated_at = ?")
    values.push(Date.now(), id)
    getDb()
      .prepare(`UPDATE process_definitions SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values)
  }
  return getProcessDefinition(id)!
}

// CASCADE clears phases, phase agents, and edges (FKs to process_definitions).
export function deleteProcessDefinition(id: string): void {
  getDb().prepare("DELETE FROM process_definitions WHERE id = ?").run(id)
}

// ── phases ──────────────────────────────────────────────────────────────────

// Author-time acyclicity guard for sub-process references (plan 038.1): the DAG
// engine has NO runtime cycle guard, so a definition must not (transitively) run
// itself as a sub-process. Given a prospective edge (ownerProcessId runs
// subprocessId), returns true if adding it would close a cycle — i.e. self-
// reference, or ownerProcessId is already reachable FROM subprocessId via the
// existing subprocess_id references. Callers reject with an error surfaced to the
// builder. O(V+E) DFS over the (small) subprocess reference graph.
export function wouldCloseSubprocessCycle(
  ownerProcessId: string,
  subprocessId: string
): boolean {
  if (ownerProcessId === subprocessId) return true
  // Build processId → set of definitions it (directly) runs as sub-processes.
  const edges = getDb()
    .prepare(
      "SELECT process_id, subprocess_id FROM process_phases WHERE subprocess_id IS NOT NULL"
    )
    .all() as Array<{ process_id: string; subprocess_id: string }>
  const adj = new Map<string, Set<string>>()
  for (const e of edges) {
    if (!adj.has(e.process_id)) adj.set(e.process_id, new Set())
    adj.get(e.process_id)!.add(e.subprocess_id)
  }
  // The prospective edge closes a cycle iff ownerProcessId is reachable from
  // subprocessId (following existing edges), since owner → subprocess would then
  // complete a loop back to owner.
  const seen = new Set<string>()
  const stack = [subprocessId]
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (cur === ownerProcessId) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const next of adj.get(cur) ?? []) stack.push(next)
  }
  return false
}

// Validate a phase's would-be sub-process reference before a write: it must not
// close a cycle. Fan-out + sub-process are NO LONGER mutually exclusive (plan
// 038.3): a phase with both set decomposes into N sub-tasks and runs the
// sub-process once PER child (seeded with that child's briefing) instead of a
// single worker; fan-out alone runs a worker per child; sub-process alone runs
// one nested run. Throws on violation (the repo is the single chokepoint — both
// createPhase and updatePhase route through it, so direct repo callers are
// covered too).
function assertSubprocessValid(
  ownerProcessId: string,
  subprocessId: string | null | undefined,
  _fanOut: boolean | undefined
): void {
  if (!subprocessId) return
  if (wouldCloseSubprocessCycle(ownerProcessId, subprocessId))
    throw new Error("sub-process would create a cycle")
}

export function createPhase(input: {
  completionContract?: PhaseCompletionContract
  processId: string
  key: string
  name: string
  routing?: PhaseRouting
  gatePolicy?: PhaseGatePolicy
  fanOut?: boolean
  maxReworkRounds?: number
  dotFolder?: boolean
  validator?: boolean
  validatorMaxIterations?: number
  validatorAgent?: string | null
  subprocessId?: string | null
  position: number
}): ProcessPhase {
  const contract = parseCompletionContract(input.completionContract)
  assertSubprocessValid(input.processId, input.subprocessId, input.fanOut)
  const id = randomUUID()
  getDb()
    .prepare(
      "INSERT INTO process_phases (id, process_id, key, name, routing, gate_policy, fan_out, max_rework_rounds, dot_folder, validator, validator_max_iterations, validator_agent, subprocess_id, position, completion_contract) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      id,
      input.processId,
      input.key,
      input.name,
      input.routing ?? "single",
      input.gatePolicy ?? "auto",
      input.fanOut ? 1 : 0,
      input.maxReworkRounds ?? 0,
      input.dotFolder ? 1 : 0,
      input.validator ? 1 : 0,
      input.validatorMaxIterations ?? 0,
      input.validatorAgent ?? null,
      input.subprocessId ?? null,
      input.position,
      JSON.stringify(contract)
    )
  return getPhase(id)!
}

export function getPhase(id: string): ProcessPhase | undefined {
  const row = getDb()
    .prepare("SELECT * FROM process_phases WHERE id = ?")
    .get(id) as ProcessPhaseRow | undefined
  return row ? toPhase(row) : undefined
}

export function listPhases(processId: string): ProcessPhase[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM process_phases WHERE process_id = ? ORDER BY position ASC"
    )
    .all(processId) as ProcessPhaseRow[]
  return rows.map(toPhase)
}

export function updatePhase(
  id: string,
  patch: {
    completionContract?: PhaseCompletionContract
    key?: string
    name?: string
    routing?: PhaseRouting
    gatePolicy?: PhaseGatePolicy
    fanOut?: boolean
    maxReworkRounds?: number
    dotFolder?: boolean
    validator?: boolean
    validatorMaxIterations?: number
    validatorAgent?: string | null
    subprocessId?: string | null
    position?: number
  }
): ProcessPhase {
  // Validate the sub-process/fan-out combination against the EFFECTIVE state (the
  // patch may set only one side, so read the current phase for the other) before
  // any write (plan 038.1).
  if (patch.subprocessId !== undefined || patch.fanOut !== undefined) {
    const current = getPhase(id)
    if (current) {
      const nextSubprocessId =
        patch.subprocessId !== undefined
          ? patch.subprocessId
          : current.subprocessId
      const nextFanOut =
        patch.fanOut !== undefined ? patch.fanOut : current.fanOut
      assertSubprocessValid(current.processId, nextSubprocessId, nextFanOut)
    }
  }
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.completionContract !== undefined) {
    sets.push("completion_contract = ?")
    values.push(
      JSON.stringify(parseCompletionContract(patch.completionContract))
    )
  }
  if (patch.key !== undefined) {
    sets.push("key = ?")
    values.push(patch.key)
  }
  if (patch.name !== undefined) {
    sets.push("name = ?")
    values.push(patch.name)
  }
  if (patch.routing !== undefined) {
    sets.push("routing = ?")
    values.push(patch.routing)
  }
  if (patch.gatePolicy !== undefined) {
    sets.push("gate_policy = ?")
    values.push(patch.gatePolicy)
  }
  if (patch.fanOut !== undefined) {
    sets.push("fan_out = ?")
    values.push(patch.fanOut ? 1 : 0)
  }
  if (patch.maxReworkRounds !== undefined) {
    sets.push("max_rework_rounds = ?")
    values.push(patch.maxReworkRounds)
  }
  if (patch.dotFolder !== undefined) {
    sets.push("dot_folder = ?")
    values.push(patch.dotFolder ? 1 : 0)
  }
  if (patch.validator !== undefined) {
    sets.push("validator = ?")
    values.push(patch.validator ? 1 : 0)
  }
  if (patch.validatorMaxIterations !== undefined) {
    sets.push("validator_max_iterations = ?")
    values.push(patch.validatorMaxIterations)
  }
  if (patch.validatorAgent !== undefined) {
    sets.push("validator_agent = ?")
    values.push(patch.validatorAgent)
  }
  if (patch.subprocessId !== undefined) {
    sets.push("subprocess_id = ?")
    values.push(patch.subprocessId)
  }
  if (patch.position !== undefined) {
    sets.push("position = ?")
    values.push(patch.position)
  }
  if (sets.length > 0) {
    values.push(id)
    getDb()
      .prepare(`UPDATE process_phases SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values)
  }
  return getPhase(id)!
}

export function deletePhase(id: string): void {
  getDb().prepare("DELETE FROM process_phases WHERE id = ?").run(id)
}

// ── phase agents (the pool) ──────────────────────────────────────────────────

export function createPhaseAgent(input: {
  phaseId: string
  agentName: string
  skills?: string[] | null
  tools?: string[] | null
  position: number
}): ProcessPhaseAgent {
  const id = randomUUID()
  getDb()
    .prepare(
      "INSERT INTO process_phase_agents (id, phase_id, agent_name, skills, tools, position) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(
      id,
      input.phaseId,
      input.agentName,
      input.skills == null ? null : JSON.stringify(input.skills),
      input.tools == null ? null : JSON.stringify(input.tools),
      input.position
    )
  return getPhaseAgent(id)!
}

export function getPhaseAgent(id: string): ProcessPhaseAgent | undefined {
  const row = getDb()
    .prepare("SELECT * FROM process_phase_agents WHERE id = ?")
    .get(id) as ProcessPhaseAgentRow | undefined
  return row ? toPhaseAgent(row) : undefined
}

export function listPhaseAgents(phaseId: string): ProcessPhaseAgent[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM process_phase_agents WHERE phase_id = ? ORDER BY position ASC"
    )
    .all(phaseId) as ProcessPhaseAgentRow[]
  return rows.map(toPhaseAgent)
}

export function deletePhaseAgent(id: string): void {
  getDb().prepare("DELETE FROM process_phase_agents WHERE id = ?").run(id)
}

// ── edges ────────────────────────────────────────────────────────────────────

export function createEdge(input: {
  processId: string
  fromPhaseId: string
  toPhaseId: string
  trigger?: EdgeTrigger
}): ProcessEdge {
  const id = randomUUID()
  getDb()
    .prepare(
      "INSERT INTO process_edges (id, process_id, from_phase_id, to_phase_id, trigger) VALUES (?, ?, ?, ?, ?)"
    )
    .run(
      id,
      input.processId,
      input.fromPhaseId,
      input.toPhaseId,
      input.trigger ?? "on_complete"
    )
  const row = getDb()
    .prepare("SELECT * FROM process_edges WHERE id = ?")
    .get(id) as ProcessEdgeRow
  return toEdge(row)
}

export function listEdges(processId: string): ProcessEdge[] {
  const rows = getDb()
    .prepare("SELECT * FROM process_edges WHERE process_id = ?")
    .all(processId) as ProcessEdgeRow[]
  return rows.map(toEdge)
}

export function deleteEdge(id: string): void {
  getDb().prepare("DELETE FROM process_edges WHERE id = ?").run(id)
}

// The whole authored graph in one shape — the scheduler and monitor both need it.
export function getProcessGraph(processId: string): ProcessGraph | undefined {
  const definition = getProcessDefinition(processId)
  if (!definition) return undefined
  const phases = listPhases(processId)
  const agents = phases.flatMap((p) => listPhaseAgents(p.id))
  const edges = listEdges(processId)
  return { definition, phases, agents, edges }
}

// ── runs ──────────────────────────────────────────────────────────────────────

export function createProcessRun(input: {
  processId: string | null
  sourceConversationId: string | null
  workspaceId?: string | null
  taskId?: string | null
  objective?: string | null
  // A nested run's caller (plan 038.1): the sub-process phase-run that started it.
  parentPhaseRunId?: string | null
  status?: ProcessRunStatus
}): ProcessRun {
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      "INSERT INTO process_runs (id, process_id, source_conversation_id, workspace_id, task_id, objective, parent_phase_run_id, status, started_at, finished_at, created_at, completion_contracts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      id,
      input.processId,
      input.sourceConversationId,
      input.workspaceId ?? null,
      input.taskId ?? null,
      input.objective ?? null,
      input.parentPhaseRunId ?? null,
      input.status ?? "queued",
      null,
      null,
      now,
      JSON.stringify(
        Object.fromEntries(
          (input.processId ? listPhases(input.processId) : []).map((phase) => [
            phase.id,
            phase.completionContract,
          ])
        )
      )
    )
  return getProcessRun(id)!
}

// The nested run started by a sub-process phase-run (plan 038.1). At most one per
// phase-run (the closure looks-up-or-creates), so crash-resume re-attaches to the
// in-flight child run instead of restarting it.
export function getProcessRunByParentPhaseRunId(
  phaseRunId: string
): ProcessRun | undefined {
  const row = getDb()
    .prepare("SELECT * FROM process_runs WHERE parent_phase_run_id = ? LIMIT 1")
    .get(phaseRunId) as ProcessRunRow | undefined
  return row ? toRun(row) : undefined
}

export function getProcessRun(id: string): ProcessRun | undefined {
  const row = getDb()
    .prepare("SELECT * FROM process_runs WHERE id = ?")
    .get(id) as ProcessRunRow | undefined
  return row ? toRun(row) : undefined
}

export function listProcessRuns(opts?: {
  processId?: string
  status?: ProcessRunStatus
  parentPhaseRunId?: string
}): ProcessRun[] {
  const clauses: string[] = []
  const values: unknown[] = []
  if (opts?.processId) {
    clauses.push("process_id = ?")
    values.push(opts.processId)
  }
  if (opts?.status) {
    clauses.push("status = ?")
    values.push(opts.status)
  }
  if (opts?.parentPhaseRunId) {
    clauses.push("parent_phase_run_id = ?")
    values.push(opts.parentPhaseRunId)
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  const rows = getDb()
    .prepare(`SELECT * FROM process_runs ${where} ORDER BY created_at DESC`)
    .all(...values) as ProcessRunRow[]
  return rows.map(toRun)
}

export function updateProcessRun(
  id: string,
  patch: {
    status?: ProcessRunStatus
    taskId?: string | null
    title?: string | null
    startedAt?: number | null
    finishedAt?: number | null
  }
): ProcessRun {
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.status !== undefined) {
    sets.push("status = ?")
    values.push(patch.status)
  }
  if (patch.title !== undefined) {
    sets.push("title = ?")
    values.push(patch.title)
  }
  if (patch.taskId !== undefined) {
    sets.push("task_id = ?")
    values.push(patch.taskId)
  }
  if (patch.startedAt !== undefined) {
    sets.push("started_at = ?")
    values.push(patch.startedAt)
  }
  if (patch.finishedAt !== undefined) {
    sets.push("finished_at = ?")
    values.push(patch.finishedAt)
  }
  if (sets.length > 0) {
    values.push(id)
    getDb()
      .prepare(`UPDATE process_runs SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values)
  }
  return getProcessRun(id)!
}

// ── phase runs ─────────────────────────────────────────────────────────────────

export function createPhaseRun(input: {
  runId: string
  phaseId: string
  parentId?: string | null
  status?: PhaseRunStatus
  agentName?: string | null
  title?: string | null
  // The source fan-out child this on_each_subtask consumer instance consumes
  // (plan 031.2 lineage). Null/omitted for ordinary runs and fan-out children.
  sourceChildRunId?: string | null
}): ProcessPhaseRun {
  const id = randomUUID()
  getDb()
    .prepare(
      "INSERT INTO process_phase_runs (id, run_id, phase_id, parent_id, status, task_id, agent_name, title, iteration, error, started_at, finished_at, source_child_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      id,
      input.runId,
      input.phaseId,
      input.parentId ?? null,
      input.status ?? "pending",
      null,
      input.agentName ?? null,
      input.title ?? null,
      0,
      null,
      null,
      null,
      input.sourceChildRunId ?? null
    )
  return getPhaseRun(id)!
}

export function getPhaseRun(id: string): ProcessPhaseRun | undefined {
  const row = getDb()
    .prepare("SELECT * FROM process_phase_runs WHERE id = ?")
    .get(id) as ProcessPhaseRunRow | undefined
  return row ? toPhaseRun(row) : undefined
}

export function listPhaseRuns(opts: {
  runId?: string
  parentId?: string | null
  phaseId?: string
}): ProcessPhaseRun[] {
  const clauses: string[] = []
  const values: unknown[] = []
  if (opts.runId) {
    clauses.push("run_id = ?")
    values.push(opts.runId)
  }
  // parentId can be explicitly null (top-level phase runs) — distinguish from
  // undefined (no filter).
  if (opts.parentId !== undefined) {
    if (opts.parentId === null) {
      clauses.push("parent_id IS NULL")
    } else {
      clauses.push("parent_id = ?")
      values.push(opts.parentId)
    }
  }
  if (opts.phaseId) {
    clauses.push("phase_id = ?")
    values.push(opts.phaseId)
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  const rows = getDb()
    .prepare(`SELECT * FROM process_phase_runs ${where}`)
    .all(...values) as ProcessPhaseRunRow[]
  return rows.map(toPhaseRun)
}

export function updatePhaseRun(
  id: string,
  patch: {
    status?: PhaseRunStatus
    taskId?: string | null
    agentName?: string | null
    iteration?: number
    error?: string | null
    failure?: FailureContext | null
    startedAt?: number | null
    finishedAt?: number | null
    reworkNote?: string | null
    reworkRound?: number
    validatorRound?: number
    outputIdentity?: string | null
    completionReceipt?: PhaseCompletionReceipt | null
  }
): ProcessPhaseRun {
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.status !== undefined) {
    sets.push("status = ?")
    values.push(patch.status)
  }
  if (patch.taskId !== undefined) {
    sets.push("task_id = ?")
    values.push(patch.taskId)
  }
  if (patch.agentName !== undefined) {
    sets.push("agent_name = ?")
    values.push(patch.agentName)
  }
  if (patch.iteration !== undefined) {
    sets.push("iteration = ?")
    values.push(patch.iteration)
  }
  if (patch.error !== undefined) {
    sets.push("error = ?")
    values.push(patch.error)
  }
  if (patch.failure !== undefined) {
    sets.push("failure = ?")
    values.push(patch.failure === null ? null : JSON.stringify(patch.failure))
  }
  if (patch.startedAt !== undefined) {
    sets.push("started_at = ?")
    values.push(patch.startedAt)
  }
  if (patch.finishedAt !== undefined) {
    sets.push("finished_at = ?")
    values.push(patch.finishedAt)
  }
  if (patch.reworkNote !== undefined) {
    sets.push("rework_note = ?")
    values.push(patch.reworkNote)
  }
  if (patch.reworkRound !== undefined) {
    sets.push("rework_round = ?")
    values.push(patch.reworkRound)
  }
  if (patch.validatorRound !== undefined) {
    sets.push("validator_round = ?")
    values.push(patch.validatorRound)
  }
  if (patch.completionReceipt !== undefined || patch.outputIdentity === null) {
    sets.push("completion_receipt = ?")
    values.push(
      patch.outputIdentity === null || !patch.completionReceipt
        ? null
        : JSON.stringify(patch.completionReceipt)
    )
  }
  if (patch.outputIdentity !== undefined) {
    sets.push("output_identity = ?")
    values.push(patch.outputIdentity)
  }
  if (sets.length > 0) {
    values.push(id)
    getDb()
      .prepare(`UPDATE process_phase_runs SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values)
  }
  return getPhaseRun(id)!
}

export function createPhaseAttempt(input: {
  runId: string
  phaseRunId: string
  phaseId: string
  taskId?: string | null
  workerTaskId?: string | null
  agentName?: string | null
  stage: FailureStage
  attempt?: number | null
  maxAttempts?: number | null
  error: string
  failure: FailureContext
}): ProcessPhaseAttempt {
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      "INSERT INTO process_phase_attempts (id, run_id, phase_run_id, phase_id, task_id, worker_task_id, agent_name, stage, status, attempt, max_attempts, error, failure, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?)"
    )
    .run(
      id,
      input.runId,
      input.phaseRunId,
      input.phaseId,
      input.taskId ?? null,
      input.workerTaskId ?? null,
      input.agentName ?? null,
      input.stage,
      input.attempt ?? null,
      input.maxAttempts ?? null,
      input.error,
      JSON.stringify(input.failure),
      now
    )
  return getPhaseAttempt(id)!
}

export function getPhaseAttempt(id: string): ProcessPhaseAttempt | undefined {
  const row = getDb()
    .prepare("SELECT * FROM process_phase_attempts WHERE id = ?")
    .get(id) as ProcessPhaseAttemptRow | undefined
  return row ? toPhaseAttempt(row) : undefined
}

export function listPhaseAttempts(opts: {
  runId?: string
  phaseRunId?: string
}): ProcessPhaseAttempt[] {
  const clauses: string[] = []
  const values: unknown[] = []
  if (opts.runId) {
    clauses.push("run_id = ?")
    values.push(opts.runId)
  }
  if (opts.phaseRunId) {
    clauses.push("phase_run_id = ?")
    values.push(opts.phaseRunId)
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  const rows = getDb()
    .prepare(
      `SELECT * FROM process_phase_attempts ${where} ORDER BY created_at ASC`
    )
    .all(...values) as ProcessPhaseAttemptRow[]
  return rows.map(toPhaseAttempt)
}

// Delete a phase-run and its descendant children (the parent_id FK is
// ON DELETE CASCADE, so children/instances go with it). Used by flag-back
// (plan 031.2) to clear a container's stale children before a re-decompose /
// re-trigger, so the container starts clean.
export function deletePhaseRun(id: string): void {
  getDb().prepare("DELETE FROM process_phase_runs WHERE id = ?").run(id)
}

// ── flags (plan 031.2) ───────────────────────────────────────────────────────

interface ProcessFlagRow {
  id: string
  run_id: string
  flagging_phase_run_id: string | null
  target_phase_id: string
  target_child_run_id: string | null
  reason: string
  status: ProcessFlagStatus
  created_at: number
}

function toFlag(row: ProcessFlagRow): ProcessFlag {
  return {
    id: row.id,
    runId: row.run_id,
    flaggingPhaseRunId: row.flagging_phase_run_id,
    targetPhaseId: row.target_phase_id,
    targetChildRunId: row.target_child_run_id,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
  }
}

export function createFlag(input: {
  runId: string
  flaggingPhaseRunId: string
  targetPhaseId: string
  targetChildRunId?: string | null
  reason: string
}): ProcessFlag {
  const id = randomUUID()
  getDb()
    .prepare(
      "INSERT INTO process_flags (id, run_id, flagging_phase_run_id, target_phase_id, target_child_run_id, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)"
    )
    .run(
      id,
      input.runId,
      input.flaggingPhaseRunId,
      input.targetPhaseId,
      input.targetChildRunId ?? null,
      input.reason,
      Date.now()
    )
  return getFlag(id)!
}

export function getFlag(id: string): ProcessFlag | undefined {
  const row = getDb()
    .prepare("SELECT * FROM process_flags WHERE id = ?")
    .get(id) as ProcessFlagRow | undefined
  return row ? toFlag(row) : undefined
}

export function listFlags(opts: {
  runId: string
  status?: ProcessFlagStatus
}): ProcessFlag[] {
  const clauses = ["run_id = ?"]
  const values: unknown[] = [opts.runId]
  if (opts.status) {
    clauses.push("status = ?")
    values.push(opts.status)
  }
  const rows = getDb()
    .prepare(
      `SELECT * FROM process_flags WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC`
    )
    .all(...values) as ProcessFlagRow[]
  return rows.map(toFlag)
}

export function updateFlagStatus(id: string, status: ProcessFlagStatus): void {
  getDb()
    .prepare("UPDATE process_flags SET status = ? WHERE id = ?")
    .run(status, id)
}

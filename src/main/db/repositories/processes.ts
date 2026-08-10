import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type {
  EdgeTrigger,
  PhaseGatePolicy,
  PhaseRouting,
  PhaseRunStatus,
  ProcessDefinition,
  ProcessEdge,
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
  created_at: number
  updated_at: number
}

function toDefinition(row: ProcessDefinitionRow): ProcessDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

interface ProcessPhaseRow {
  id: string
  process_id: string
  key: string
  name: string
  routing: PhaseRouting
  gate_policy: PhaseGatePolicy
  fan_out: number
  max_rework_rounds: number
  position: number
}

function toPhase(row: ProcessPhaseRow): ProcessPhase {
  return {
    id: row.id,
    processId: row.process_id,
    key: row.key,
    name: row.name,
    routing: row.routing,
    gatePolicy: row.gate_policy,
    fanOut: row.fan_out === 1,
    maxReworkRounds: row.max_rework_rounds,
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
  id: string
  process_id: string | null
  source_conversation_id: string | null
  workspace_id: string | null
  task_id: string | null
  objective: string | null
  title: string | null
  status: ProcessRunStatus
  started_at: number | null
  finished_at: number | null
  created_at: number
}

function toRun(row: ProcessRunRow): ProcessRun {
  return {
    id: row.id,
    processId: row.process_id,
    sourceConversationId: row.source_conversation_id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    objective: row.objective,
    title: row.title,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  }
}

interface ProcessPhaseRunRow {
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
  started_at: number | null
  finished_at: number | null
  rework_note: string | null
  rework_round: number
}

function toPhaseRun(row: ProcessPhaseRunRow): ProcessPhaseRun {
  return {
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
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    reworkNote: row.rework_note,
    reworkRound: row.rework_round,
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
    .prepare("SELECT * FROM process_definitions ORDER BY updated_at DESC")
    .all() as ProcessDefinitionRow[]
  return rows.map(toDefinition)
}

export function updateProcessDefinition(
  id: string,
  patch: { name?: string; description?: string | null }
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
  if (sets.length > 0) {
    sets.push("updated_at = ?")
    values.push(Date.now(), id)
    getDb()
      .prepare(
        `UPDATE process_definitions SET ${sets.join(", ")} WHERE id = ?`
      )
      .run(...values)
  }
  return getProcessDefinition(id)!
}

// CASCADE clears phases, phase agents, and edges (FKs to process_definitions).
export function deleteProcessDefinition(id: string): void {
  getDb().prepare("DELETE FROM process_definitions WHERE id = ?").run(id)
}

// ── phases ──────────────────────────────────────────────────────────────────

export function createPhase(input: {
  processId: string
  key: string
  name: string
  routing?: PhaseRouting
  gatePolicy?: PhaseGatePolicy
  fanOut?: boolean
  maxReworkRounds?: number
  position: number
}): ProcessPhase {
  const id = randomUUID()
  getDb()
    .prepare(
      "INSERT INTO process_phases (id, process_id, key, name, routing, gate_policy, fan_out, max_rework_rounds, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
      input.position
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
    key?: string
    name?: string
    routing?: PhaseRouting
    gatePolicy?: PhaseGatePolicy
    fanOut?: boolean
    maxReworkRounds?: number
    position?: number
  }
): ProcessPhase {
  const sets: string[] = []
  const values: unknown[] = []
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
  status?: ProcessRunStatus
}): ProcessRun {
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      "INSERT INTO process_runs (id, process_id, source_conversation_id, workspace_id, task_id, objective, status, started_at, finished_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      id,
      input.processId,
      input.sourceConversationId,
      input.workspaceId ?? null,
      input.taskId ?? null,
      input.objective ?? null,
      input.status ?? "queued",
      null,
      null,
      now
    )
  return getProcessRun(id)!
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
}): ProcessPhaseRun {
  const id = randomUUID()
  getDb()
    .prepare(
      "INSERT INTO process_phase_runs (id, run_id, phase_id, parent_id, status, task_id, agent_name, title, iteration, error, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
      null
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
    startedAt?: number | null
    finishedAt?: number | null
    reworkNote?: string | null
    reworkRound?: number
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
  if (sets.length > 0) {
    values.push(id)
    getDb()
      .prepare(`UPDATE process_phase_runs SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values)
  }
  return getPhaseRun(id)!
}

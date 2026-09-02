import { parseCompletionContract } from "./completion-contract"
import { getDb } from "../db/connection"
import {
  createEdge,
  createPhase,
  createPhaseAgent,
  createProcessDefinition,
  getProcessDefinition,
  getPhase,
  getPhaseRun,
  getProcessGraph,
  getProcessRun,
  listPhaseAttempts,
  listPhaseRuns,
  listProcessRuns,
  updateProcessDefinition,
} from "../db/repositories/processes"
import type {
  EdgeTrigger,
  FailureContext,
  PhaseGatePolicy,
  PhaseRouting,
  ProcessPhaseAttempt,
  ProcessPhase,
  ProcessPhaseRun,
  ProcessGraph,
  ProcessRun,
} from "../db/types"
import type {
  AgentRef,
  AgentScope,
  ExternalAgentSourceKind,
} from "../agent/agents/types"
import { sanitizeFailureContext } from "../tasks/process/failure-sanitizer"

const FORMAT_VERSION = 1
const INCIDENT_FORMAT_VERSION = 1
const AGENT_REF_PREFIX = "agentref:v1:"

const ROUTINGS: readonly PhaseRouting[] = ["single", "dispatch"]
const GATE_POLICIES: readonly PhaseGatePolicy[] = ["auto", "approve"]
const EDGE_TRIGGERS: readonly EdgeTrigger[] = ["on_complete", "on_each_subtask"]
const AGENT_SOURCE_KINDS: readonly ExternalAgentSourceKind[] = [
  "north_star",
  "github",
  "copilot",
  "cursor",
  "claude",
  "codex",
]
const AGENT_SCOPES: readonly AgentScope[] = ["global", "workspace", "custom"]

export interface PortableAgentDescriptor {
  sourceKind: ExternalAgentSourceKind
  nativeName: string
  scope?: AgentScope
  sourcePathHint?: string
}

export interface PortableSubprocessDescriptor {
  name: string
}

export interface ProcessExportPhaseAgent {
  agent: PortableAgentDescriptor | { legacyName: string }
  skills: string[] | null
  tools: string[] | null
  position: number
}

export interface ProcessExportPhase {
  completionContract?: ProcessPhase["completionContract"]
  key: string
  name: string
  routing: PhaseRouting
  gatePolicy: PhaseGatePolicy
  fanOut: boolean
  maxReworkRounds: number
  dotFolder: boolean
  validator: boolean
  validatorMaxIterations: number
  validatorAgent: PortableAgentDescriptor | { legacyName: string } | null
  subprocess: PortableSubprocessDescriptor | null
  position: number
  agents: ProcessExportPhaseAgent[]
}

export interface ProcessExportEdge {
  fromKey: string
  toKey: string
  trigger: EdgeTrigger
}

export interface ProcessExport {
  formatVersion: 1
  exportedAt: string
  definition: {
    name: string
    description: string | null
    requireFlagApproval: boolean
  }
  phases: ProcessExportPhase[]
  edges: ProcessExportEdge[]
}

export interface ProcessImportResult {
  processId: string
  warnings: string[]
}

export interface ProcessIncidentAppInfo {
  name: string
  version: string
  build: string | null
}

export interface ProcessIncidentRunIdentity {
  completionContracts: ProcessRun["completionContracts"]
  id: string
  processId: string | null
  processName: string | null
  taskId: string | null
  sourceConversationId: string | null
  workspaceId: string | null
  parentPhaseRunId: string | null
  status: ProcessRun["status"]
  objective: string | null
  title: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface ProcessIncidentPhaseRunIdentity {
  completionReceipt: ProcessPhaseRun["completionReceipt"]
  id: string
  runId: string
  phaseId: string
  phaseKey: string | null
  phaseName: string | null
  parentId: string | null
  taskId: string | null
  workerTaskId: string | null
  agentName: string | null
  status: ProcessPhaseRun["status"]
  iteration: number
  reworkRound: number
  validatorRound: number
  sourceChildRunId: string | null
  startedAt: string | null
  finishedAt: string | null
  failure: FailureContext | null
}

export interface ProcessIncidentAttempt {
  id: string
  runId: string
  phaseRunId: string
  phaseId: string
  phaseKey: string | null
  taskId: string | null
  workerTaskId: string | null
  agentName: string | null
  stage: ProcessPhaseAttempt["stage"]
  status: ProcessPhaseAttempt["status"]
  attempt: number | null
  maxAttempts: number | null
  error: string
  failure: FailureContext
  createdAt: string
}

export interface ProcessRunIncidentExport {
  formatVersion: 1
  kind: "process_run_incident"
  exportedAt: string
  app: ProcessIncidentAppInfo
  rootRunId: string
  runs: ProcessIncidentRunIdentity[]
  phaseRuns: ProcessIncidentPhaseRunIdentity[]
  attempts: ProcessIncidentAttempt[]
}

function parseAgentRef(value: string): AgentRef | null {
  if (!value.startsWith(AGENT_REF_PREFIX)) return null
  try {
    const parsed = JSON.parse(value.slice(AGENT_REF_PREFIX.length)) as unknown
    if (!parsed || typeof parsed !== "object") return null
    const candidate = parsed as Record<string, unknown>
    if (
      !isOneOf(candidate.sourceKind, AGENT_SOURCE_KINDS) ||
      !isOneOf(candidate.scope, AGENT_SCOPES) ||
      typeof candidate.definitionPath !== "string" ||
      typeof candidate.nativeName !== "string" ||
      candidate.nativeName.trim() === ""
    ) {
      return null
    }
    return {
      sourceKind: candidate.sourceKind,
      scope: candidate.scope,
      definitionPath: candidate.definitionPath,
      nativeName: candidate.nativeName,
    }
  } catch {
    return null
  }
}

function agentToExport(
  value: string
): PortableAgentDescriptor | { legacyName: string } {
  const ref = parseAgentRef(value)
  if (!ref) return { legacyName: value }
  return {
    sourceKind: ref.sourceKind,
    scope: ref.scope,
    nativeName: ref.nativeName,
  }
}

function agentFromExport(
  agent: PortableAgentDescriptor | { legacyName: string },
  warnings: string[],
  context: string
): string {
  if ("legacyName" in agent) {
    if (agent.legacyName.trim() === "") {
      throw new Error(`${context} has an empty legacy agent name`)
    }
    warnings.push(`${context} uses a legacy unqualified agent name.`)
    return agent.legacyName
  }

  const ref: AgentRef = {
    sourceKind: agent.sourceKind,
    scope: agent.scope ?? "workspace",
    definitionPath: agent.sourcePathHint ?? "",
    nativeName: agent.nativeName,
  }
  if (!agent.sourcePathHint) {
    warnings.push(
      `${context} references ${agent.sourceKind}:${agent.nativeName}; import kept the unresolved portable descriptor.`
    )
  }
  return `${AGENT_REF_PREFIX}${JSON.stringify(ref)}`
}

export function buildProcessExport(graph: ProcessGraph): ProcessExport {
  const phaseById = new Map(graph.phases.map((phase) => [phase.id, phase]))
  const agentsByPhaseId = new Map<string, ProcessExportPhaseAgent[]>()
  for (const agent of graph.agents) {
    const list = agentsByPhaseId.get(agent.phaseId) ?? []
    list.push({
      agent: agentToExport(agent.agentName),
      skills: agent.skills,
      tools: agent.tools,
      position: agent.position,
    })
    agentsByPhaseId.set(agent.phaseId, list)
  }

  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    definition: {
      name: graph.definition.name,
      description: graph.definition.description,
      requireFlagApproval: graph.definition.requireFlagApproval,
    },
    phases: graph.phases
      .map((phase) => {
        const subprocess = phase.subprocessId
          ? getProcessDefinition(phase.subprocessId)
          : undefined
        return {
          key: phase.key,
          name: phase.name,
          routing: phase.routing,
          gatePolicy: phase.gatePolicy,
          fanOut: phase.fanOut,
          maxReworkRounds: phase.maxReworkRounds,
          dotFolder: phase.dotFolder,
          completionContract: phase.completionContract,
          validator: phase.validator,
          validatorMaxIterations: phase.validatorMaxIterations,
          validatorAgent: phase.validatorAgent
            ? agentToExport(phase.validatorAgent)
            : null,
          subprocess: subprocess ? { name: subprocess.name } : null,
          position: phase.position,
          agents: (agentsByPhaseId.get(phase.id) ?? []).sort(
            (a, b) => a.position - b.position
          ),
        }
      })
      .sort((a, b) => a.position - b.position),
    edges: graph.edges.map((edge) => {
      const from = phaseById.get(edge.fromPhaseId)
      const to = phaseById.get(edge.toPhaseId)
      if (!from || !to) {
        throw new Error("Process graph contains an edge with a missing phase")
      }
      return {
        fromKey: from.key,
        toKey: to.key,
        trigger: edge.trigger,
      }
    }),
  }
}

export function exportProcessDefinition(processId: string): ProcessExport {
  const graph = getProcessGraph(processId)
  if (!graph) throw new Error("Process not found")
  return buildProcessExport(graph)
}

export function buildProcessRunIncidentExport(
  processRunId: string,
  app: ProcessIncidentAppInfo
): ProcessRunIncidentExport {
  const rootRun = getProcessRun(processRunId)
  if (!rootRun) throw new Error("Process run not found")

  const runIds = collectIncidentRunIds(rootRun)
  const runs = [...runIds]
    .map((id) => getProcessRun(id))
    .filter((run): run is ProcessRun => !!run)
  const phaseRuns = runs.flatMap((run) => listPhaseRuns({ runId: run.id }))
  const attempts = runs
    .flatMap((run) => listPhaseAttempts({ runId: run.id }))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))

  return {
    formatVersion: INCIDENT_FORMAT_VERSION,
    kind: "process_run_incident",
    exportedAt: new Date().toISOString(),
    app,
    rootRunId: rootRun.id,
    runs: runs.map(runToIncidentIdentity),
    phaseRuns: phaseRuns.map(phaseRunToIncidentIdentity),
    attempts: attempts.map(attemptToIncident),
  }
}

export const exportProcessRunIncident = buildProcessRunIncidentExport

export function importProcessExport(input: unknown): ProcessImportResult {
  const parsed = validateProcessExport(input)
  const warnings: string[] = []

  return getDb().transaction(() => {
    const definition = createProcessDefinition({
      name: parsed.definition.name,
      description: parsed.definition.description,
    })
    if (
      parsed.definition.requireFlagApproval !== definition.requireFlagApproval
    ) {
      updateProcessDefinition(definition.id, {
        requireFlagApproval: parsed.definition.requireFlagApproval,
      })
    }

    const phaseIdByKey = new Map<string, string>()
    for (const phase of parsed.phases) {
      const subprocessId = resolveSubprocess(
        phase.subprocess,
        warnings,
        phase.key,
        definition.id
      )
      const created = createPhase({
        processId: definition.id,
        key: phase.key,
        name: phase.name,
        routing: phase.routing,
        gatePolicy: phase.gatePolicy,
        fanOut: phase.fanOut,
        maxReworkRounds: phase.maxReworkRounds,
        dotFolder: phase.dotFolder,
        completionContract: phase.completionContract,
        validator: phase.validator,
        validatorMaxIterations: phase.validatorMaxIterations,
        validatorAgent: phase.validatorAgent
          ? agentFromExport(
              phase.validatorAgent,
              warnings,
              `phase '${phase.key}' validator`
            )
          : null,
        subprocessId,
        position: phase.position,
      })
      phaseIdByKey.set(phase.key, created.id)

      for (const agent of phase.agents) {
        createPhaseAgent({
          phaseId: created.id,
          agentName: agentFromExport(
            agent.agent,
            warnings,
            `phase '${phase.key}' agent`
          ),
          skills: agent.skills,
          tools: agent.tools,
          position: agent.position,
        })
      }
    }

    for (const edge of parsed.edges) {
      createEdge({
        processId: definition.id,
        fromPhaseId: phaseIdByKey.get(edge.fromKey)!,
        toPhaseId: phaseIdByKey.get(edge.toKey)!,
        trigger: edge.trigger,
      })
    }

    return { processId: definition.id, warnings }
  })()
}

function collectIncidentRunIds(rootRun: ProcessRun): Set<string> {
  const ids = new Set<string>()
  const queue: ProcessRun[] = []

  let current: ProcessRun | undefined = rootRun
  while (current) {
    if (ids.has(current.id)) break
    ids.add(current.id)
    queue.push(current)
    const parentPhaseRun: ProcessPhaseRun | undefined = current.parentPhaseRunId
      ? getPhaseRun(current.parentPhaseRunId)
      : undefined
    current = parentPhaseRun ? getProcessRun(parentPhaseRun.runId) : undefined
  }

  const allRuns = listProcessRuns()
  for (let index = 0; index < queue.length; index++) {
    const run = queue[index]
    const phaseRunIds = new Set(
      listPhaseRuns({ runId: run.id }).map((phaseRun) => phaseRun.id)
    )
    for (const candidate of allRuns) {
      if (
        candidate.parentPhaseRunId &&
        phaseRunIds.has(candidate.parentPhaseRunId) &&
        !ids.has(candidate.id)
      ) {
        ids.add(candidate.id)
        queue.push(candidate)
      }
    }
  }

  return ids
}

function runToIncidentIdentity(run: ProcessRun): ProcessIncidentRunIdentity {
  return {
    completionContracts: run.completionContracts,
    id: run.id,
    processId: run.processId,
    processName: run.processId
      ? (getProcessDefinition(run.processId)?.name ?? null)
      : null,
    taskId: run.taskId,
    sourceConversationId: run.sourceConversationId,
    workspaceId: run.workspaceId,
    parentPhaseRunId: run.parentPhaseRunId,
    status: run.status,
    objective: run.objective,
    title: run.title,
    createdAt: iso(run.createdAt),
    startedAt: nullableIso(run.startedAt),
    finishedAt: nullableIso(run.finishedAt),
  }
}

function phaseRunToIncidentIdentity(
  phaseRun: ProcessPhaseRun
): ProcessIncidentPhaseRunIdentity {
  const phase = getPhase(phaseRun.phaseId)
  return {
    id: phaseRun.id,
    runId: phaseRun.runId,
    phaseId: phaseRun.phaseId,
    completionReceipt: phaseRun.completionReceipt,
    phaseKey: phase?.key ?? null,
    phaseName: phase?.name ?? null,
    parentId: phaseRun.parentId,
    taskId: phaseRun.taskId,
    workerTaskId: phaseRun.taskId,
    agentName: phaseRun.agentName,
    status: phaseRun.status,
    iteration: phaseRun.iteration,
    reworkRound: phaseRun.reworkRound,
    validatorRound: phaseRun.validatorRound,
    sourceChildRunId: phaseRun.sourceChildRunId,
    startedAt: nullableIso(phaseRun.startedAt),
    finishedAt: nullableIso(phaseRun.finishedAt),
    failure: phaseRun.failure ? sanitizeFailureContext(phaseRun.failure) : null,
  }
}

function attemptToIncident(
  attempt: ProcessPhaseAttempt
): ProcessIncidentAttempt {
  const phase = getPhase(attempt.phaseId)
  const failure = sanitizeFailureContext(attempt.failure)
  return {
    id: attempt.id,
    runId: attempt.runId,
    phaseRunId: attempt.phaseRunId,
    phaseId: attempt.phaseId,
    phaseKey: phase?.key ?? null,
    taskId: attempt.taskId,
    workerTaskId: attempt.workerTaskId,
    agentName: attempt.agentName,
    stage: attempt.stage,
    status: attempt.status,
    attempt: attempt.attempt,
    maxAttempts: attempt.maxAttempts,
    error: failure.message,
    failure,
    createdAt: iso(attempt.createdAt),
  }
}

function iso(value: number): string {
  return new Date(value).toISOString()
}

function nullableIso(value: number | null): string | null {
  return value === null ? null : iso(value)
}

function resolveSubprocess(
  subprocess: PortableSubprocessDescriptor | null,
  warnings: string[],
  phaseKey: string,
  ownerProcessId: string
): string | null {
  if (!subprocess) return null
  const matches = getDb()
    .prepare(
      "SELECT id FROM process_definitions WHERE name = ? AND id != ? ORDER BY created_at ASC"
    )
    .all(subprocess.name, ownerProcessId) as Array<{ id: string }>
  if (matches.length === 1) return matches[0].id
  warnings.push(
    `phase '${phaseKey}' references sub-process '${subprocess.name}', but ${matches.length === 0 ? "it was not found" : "the name is ambiguous"}.`
  )
  return null
}

function validateProcessExport(input: unknown): ProcessExport {
  if (!isRecord(input))
    throw new Error("Import file must contain a JSON object")
  if (input.formatVersion !== FORMAT_VERSION) {
    throw new Error(
      `Unsupported process export formatVersion: ${String(input.formatVersion)}`
    )
  }
  const definition = requireRecord(input.definition, "definition")
  const phasesInput = requireArray(input.phases, "phases")
  const edgesInput = requireArray(input.edges, "edges")

  const result: ProcessExport = {
    formatVersion: FORMAT_VERSION,
    exportedAt: optionalString(input.exportedAt, "exportedAt") ?? "",
    definition: {
      name: nonEmptyString(definition.name, "definition.name"),
      description:
        definition.description === null || definition.description === undefined
          ? null
          : stringValue(definition.description, "definition.description"),
      requireFlagApproval:
        typeof definition.requireFlagApproval === "boolean"
          ? definition.requireFlagApproval
          : true,
    },
    phases: [],
    edges: [],
  }

  const phaseKeys = new Set<string>()
  for (const [index, rawPhase] of phasesInput.entries()) {
    const phase = requireRecord(rawPhase, `phases[${index}]`)
    const key = nonEmptyString(phase.key, `phases[${index}].key`)
    if (phaseKeys.has(key)) throw new Error(`Duplicate phase key '${key}'`)
    phaseKeys.add(key)
    result.phases.push({
      key,
      name: nonEmptyString(phase.name, `phases[${index}].name`),
      routing: enumValue(phase.routing, ROUTINGS, `phases[${index}].routing`),
      gatePolicy: enumValue(
        phase.gatePolicy,
        GATE_POLICIES,
        `phases[${index}].gatePolicy`
      ),
      fanOut: booleanValue(phase.fanOut, `phases[${index}].fanOut`),
      maxReworkRounds: nonNegativeInteger(
        phase.maxReworkRounds,
        `phases[${index}].maxReworkRounds`
      ),
      dotFolder: booleanValue(phase.dotFolder, `phases[${index}].dotFolder`),
      completionContract: parseCompletionContract(phase.completionContract),
      validator: booleanValue(phase.validator, `phases[${index}].validator`),
      validatorMaxIterations: nonNegativeInteger(
        phase.validatorMaxIterations,
        `phases[${index}].validatorMaxIterations`
      ),
      validatorAgent:
        phase.validatorAgent === null || phase.validatorAgent === undefined
          ? null
          : validateAgentDescriptor(
              phase.validatorAgent,
              `phases[${index}].validatorAgent`
            ),
      subprocess:
        phase.subprocess === null || phase.subprocess === undefined
          ? null
          : validateSubprocessDescriptor(
              phase.subprocess,
              `phases[${index}].subprocess`
            ),
      position: nonNegativeInteger(phase.position, `phases[${index}].position`),
      agents: requireArray(phase.agents, `phases[${index}].agents`).map(
        (rawAgent, agentIndex) => {
          const agent = requireRecord(
            rawAgent,
            `phases[${index}].agents[${agentIndex}]`
          )
          return {
            agent: validateAgentDescriptor(
              agent.agent,
              `phases[${index}].agents[${agentIndex}].agent`
            ),
            skills: nullableStringArray(
              agent.skills,
              `phases[${index}].agents[${agentIndex}].skills`
            ),
            tools: nullableStringArray(
              agent.tools,
              `phases[${index}].agents[${agentIndex}].tools`
            ),
            position: nonNegativeInteger(
              agent.position,
              `phases[${index}].agents[${agentIndex}].position`
            ),
          }
        }
      ),
    })
  }

  for (const [index, rawEdge] of edgesInput.entries()) {
    const edge = requireRecord(rawEdge, `edges[${index}]`)
    const fromKey = nonEmptyString(edge.fromKey, `edges[${index}].fromKey`)
    const toKey = nonEmptyString(edge.toKey, `edges[${index}].toKey`)
    if (!phaseKeys.has(fromKey)) {
      throw new Error(`Edge ${index} references unknown fromKey '${fromKey}'`)
    }
    if (!phaseKeys.has(toKey)) {
      throw new Error(`Edge ${index} references unknown toKey '${toKey}'`)
    }
    result.edges.push({
      fromKey,
      toKey,
      trigger: enumValue(
        edge.trigger,
        EDGE_TRIGGERS,
        `edges[${index}].trigger`
      ),
    })
  }

  return result
}

function validateAgentDescriptor(
  input: unknown,
  path: string
): PortableAgentDescriptor | { legacyName: string } {
  const obj = requireRecord(input, path)
  if ("legacyName" in obj) {
    return { legacyName: nonEmptyString(obj.legacyName, `${path}.legacyName`) }
  }
  return {
    sourceKind: enumValue(
      obj.sourceKind,
      AGENT_SOURCE_KINDS,
      `${path}.sourceKind`
    ),
    nativeName: nonEmptyString(obj.nativeName, `${path}.nativeName`),
    scope:
      obj.scope === undefined
        ? undefined
        : enumValue(obj.scope, AGENT_SCOPES, `${path}.scope`),
    sourcePathHint: optionalString(
      obj.sourcePathHint,
      `${path}.sourcePathHint`
    ),
  }
}

function validateSubprocessDescriptor(
  input: unknown,
  path: string
): PortableSubprocessDescriptor {
  const obj = requireRecord(input, path)
  return { name: nonEmptyString(obj.name, `${path}.name`) }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function requireRecord(input: unknown, path: string): Record<string, unknown> {
  if (!isRecord(input)) throw new Error(`${path} must be an object`)
  return input
}

function requireArray(input: unknown, path: string): unknown[] {
  if (!Array.isArray(input)) throw new Error(`${path} must be an array`)
  return input
}

function stringValue(input: unknown, path: string): string {
  if (typeof input !== "string") throw new Error(`${path} must be a string`)
  return input
}

function optionalString(input: unknown, path: string): string | undefined {
  if (input === undefined) return undefined
  return stringValue(input, path)
}

function nonEmptyString(input: unknown, path: string): string {
  const value = stringValue(input, path).trim()
  if (!value) throw new Error(`${path} must not be empty`)
  return value
}

function booleanValue(input: unknown, path: string): boolean {
  if (typeof input !== "boolean") throw new Error(`${path} must be a boolean`)
  return input
}

function nonNegativeInteger(input: unknown, path: string): number {
  if (!Number.isInteger(input) || (input as number) < 0) {
    throw new Error(`${path} must be a non-negative integer`)
  }
  return input as number
}

function nullableStringArray(input: unknown, path: string): string[] | null {
  if (input === null) return null
  if (!Array.isArray(input)) throw new Error(`${path} must be null or an array`)
  for (const [index, value] of input.entries()) {
    if (typeof value !== "string") {
      throw new Error(`${path}[${index}] must be a string`)
    }
  }
  return input
}

function enumValue<T extends string>(
  input: unknown,
  values: readonly T[],
  path: string
): T {
  if (typeof input !== "string" || !isOneOf(input, values)) {
    throw new Error(`${path} must be one of: ${values.join(", ")}`)
  }
  return input
}

function isOneOf<T extends string>(
  input: unknown,
  values: readonly T[]
): input is T {
  return (
    typeof input === "string" && (values as readonly string[]).includes(input)
  )
}

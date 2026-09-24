import type {
  ProcessRuntimeConfig,
  Provider,
  RigDecisionRight,
  RigGraph,
} from "../db/types"
import type { AgentDefinition, ExternalAgentSourceKind } from "../agent/agents/types"
import { getDb } from "../db/connection"
import {
  createPod,
  createRig,
  createSeat,
  getRigGraph,
  setOversight,
  updatePod,
} from "../db/repositories/rigs"

const PROVIDERS: ReadonlySet<Provider> = new Set([
  "portkey",
  "openai_compatible",
  "openai",
  "claude_code",
  "codex_cli",
  "codex_subscription",
  "anthropic",
  "google",
  "azure_openai",
])

export interface PortableRigAgent {
  sourceKind: ExternalAgentSourceKind
  nativeName: string
  label: string
}

export interface RigExport {
  formatVersion: 1
  exportedAt: string
  rig: { name: string; description: string | null; cultureMd: string }
  pods: Array<{
    key: string
    name: string
    missionStatement: string
    cultureMd: string
    leadSeatKey: string | null
    position: number
  }>
  seats: Array<{
    podKey: string
    key: string
    role: string
    charter: string
    agent: PortableRigAgent | null
    skills: string[] | null
    tools: string[] | null
    mcpServers: string[] | null
    decisionRights: RigDecisionRight[]
    runtimeConfig: ProcessRuntimeConfig | null
    position: number
  }>
  oversight: Array<{ overseerPodKey: string; overseenPodKey: string }>
}

export interface RigImportResult {
  rigId: string
  warnings: string[]
}

function portableRuntime(
  config: ProcessRuntimeConfig | null,
  providers: Map<string, Provider>
): ProcessRuntimeConfig | null {
  const worker = config?.worker
  if (!worker) return null
  return {
    worker: {
      provider: worker.provider ?? (worker.accountId ? providers.get(worker.accountId) : undefined) ?? null,
      modelId: worker.modelId ?? null,
    },
  }
}

function localRuntime(
  config: ProcessRuntimeConfig | null,
  accounts: Map<Provider, string>,
  warnings: string[],
  context: string
): ProcessRuntimeConfig | null {
  const worker = config?.worker
  if (!worker) return null
  if (!worker.provider || !PROVIDERS.has(worker.provider)) {
    warnings.push(`${context} runtime could not be mapped and now inherits.`)
    return null
  }
  const accountId = accounts.get(worker.provider)
  if (!accountId) {
    warnings.push(`${context} uses ${worker.provider}, which has no local account; runtime now inherits.`)
    return null
  }
  return { worker: { accountId, modelId: worker.modelId ?? null } }
}

export function buildRigExport(
  graph: RigGraph,
  agents: AgentDefinition[] = []
): RigExport {
  const podById = new Map(graph.pods.map((pod) => [pod.id, pod]))
  const seatById = new Map(graph.seats.map((seat) => [seat.id, seat]))
  const agentByRef = new Map(agents.map((agent) => [agent.refId, agent]))
  const providerRows = getDb()
    .prepare("SELECT id, provider FROM provider_accounts")
    .all() as Array<{ id: string; provider: Provider }>
  const providers = new Map(providerRows.map((row) => [row.id, row.provider]))
  return {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    rig: {
      name: graph.rig.name,
      description: graph.rig.description,
      cultureMd: graph.rig.cultureMd,
    },
    pods: graph.pods.map((pod) => ({
      key: pod.key,
      name: pod.name,
      missionStatement: pod.missionStatement,
      cultureMd: pod.cultureMd,
      leadSeatKey: pod.leadSeatId ? seatById.get(pod.leadSeatId)?.key ?? null : null,
      position: pod.position,
    })),
    seats: graph.seats.map((seat) => {
      const pod = podById.get(seat.podId)!
      const agent = seat.agentRefId ? agentByRef.get(seat.agentRefId) : null
      return {
        podKey: pod.key,
        key: seat.key,
        role: seat.role,
        charter: seat.charter,
        agent: agent
          ? { sourceKind: agent.sourceKind, nativeName: agent.nativeName, label: agent.label }
          : seat.agentRefId
            ? parsePortableAgent(seat.agentRefId, seat.agentLabel)
            : null,
        skills: seat.skills,
        tools: seat.tools,
        mcpServers: seat.mcpServers,
        decisionRights: seat.decisionRights,
        runtimeConfig: portableRuntime(seat.runtimeConfig, providers),
        position: seat.position,
      }
    }),
    oversight: graph.oversight.map((edge) => ({
      overseerPodKey: podById.get(edge.overseerPodId)!.key,
      overseenPodKey: podById.get(edge.overseenPodId)!.key,
    })),
  }
}

function parsePortableAgent(refId: string, label: string | null): PortableRigAgent | null {
  if (!refId.startsWith("agentref:v1:")) return null
  try {
    const value = JSON.parse(refId.slice("agentref:v1:".length)) as Record<string, unknown>
    return typeof value.sourceKind === "string" && typeof value.nativeName === "string"
      ? {
          sourceKind: value.sourceKind as ExternalAgentSourceKind,
          nativeName: value.nativeName,
          label: label ?? String(value.nativeName),
        }
      : null
  } catch {
    return null
  }
}

export function importRigExport(
  value: RigExport,
  agents: AgentDefinition[] = []
): RigImportResult {
  if (value.formatVersion !== 1) throw new Error("Unsupported rig export version")
  const warnings: string[] = []
  const providerRows = getDb()
    .prepare("SELECT id, provider FROM provider_accounts WHERE enabled = 1 ORDER BY position")
    .all() as Array<{ id: string; provider: Provider }>
  const accounts = new Map<Provider, string>()
  for (const row of providerRows) if (!accounts.has(row.provider)) accounts.set(row.provider, row.id)
  const agentByPortableId = new Map(
    agents.map((agent) => [`${agent.sourceKind}:${agent.nativeName}`, agent])
  )
  return getDb().transaction(() => {
    const rig = createRig(value.rig)
    const podIds = new Map<string, string>()
    const seatIds = new Map<string, string>()
    for (const pod of value.pods) {
      const created = createPod({ ...pod, rigId: rig.id })
      podIds.set(pod.key, created.id)
    }
    for (const seat of value.seats) {
      const podId = podIds.get(seat.podKey)
      if (!podId) throw new Error(`Seat ${seat.key} references missing pod ${seat.podKey}`)
      const agent = seat.agent
        ? agentByPortableId.get(`${seat.agent.sourceKind}:${seat.agent.nativeName}`)
        : null
      if (seat.agent && !agent) warnings.push(`${seat.key}@${seat.podKey} references an unavailable agent.`)
      const created = createSeat({
        ...seat,
        podId,
        agentRefId: agent?.refId ?? (seat.agent ? portableAgentRef(seat.agent) : null),
        agentLabel: agent?.label ?? seat.agent?.label ?? null,
        runtimeConfig: localRuntime(seat.runtimeConfig, accounts, warnings, `${seat.key}@${seat.podKey}`),
      })
      seatIds.set(`${seat.podKey}:${seat.key}`, created.id)
    }
    for (const pod of value.pods) {
      if (pod.leadSeatKey) {
        updatePod(podIds.get(pod.key)!, {
          leadSeatId: seatIds.get(`${pod.key}:${pod.leadSeatKey}`) ?? null,
        })
      }
    }
    setOversight(
      rig.id,
      value.oversight.map((edge) => ({
        overseerPodId: podIds.get(edge.overseerPodKey)!,
        overseenPodId: podIds.get(edge.overseenPodKey)!,
      }))
    )
    if (!getRigGraph(rig.id)) throw new Error("Imported rig was not persisted")
    return { rigId: rig.id, warnings }
  })()
}

function portableAgentRef(agent: PortableRigAgent): string {
  return `agentref:v1:${JSON.stringify({
    sourceKind: agent.sourceKind,
    scope: "workspace",
    definitionPath: "",
    nativeName: agent.nativeName,
  })}`
}

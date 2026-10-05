import type { AgentDefinition } from "../agent/agents/types"
import type {
  ProcessRuntimeConfig,
  ProcessRuntimeSelection,
  RigPod,
  RigSeat,
} from "../db/types"
import { formatSeatAddress } from "../../shared/mission-control/address"

export interface ResolvedSeat {
  seat: RigSeat
  address: string
  agent: AgentDefinition | null
  status: "vacant" | "resolved" | "unresolved"
  label: string
  skills: string[] | undefined
  tools: string[] | undefined
  mcpServers: string[] | undefined
  runtime: ProcessRuntimeSelection | null
}

function narrowed(
  override: string[] | null,
  inherited: string[] | undefined
): string[] | undefined {
  return override === null ? inherited : override
}

export function resolveSeat(
  seat: RigSeat,
  pod: RigPod,
  agents: AgentDefinition[],
  inheritedRuntime?: ProcessRuntimeSelection | null
): ResolvedSeat {
  const agent = seat.agentRefId
    ? agents.find((candidate) => candidate.refId === seat.agentRefId) ?? null
    : null
  const status = !seat.agentRefId ? "vacant" : agent ? "resolved" : "unresolved"
  return {
    seat,
    address: formatSeatAddress(seat.key, pod.key),
    agent,
    status,
    label: agent?.label ?? seat.agentLabel ?? (status === "vacant" ? "Vacant" : "Unresolved agent"),
    skills: narrowed(seat.skills, agent?.skills),
    tools: narrowed(seat.tools, agent?.tools),
    mcpServers: narrowed(seat.mcpServers, agent?.mcpServers),
    runtime: seat.runtimeConfig?.worker ?? inheritedRuntime ?? null,
  }
}

export function workerRuntimeConfig(
  selection: ProcessRuntimeSelection | null
): ProcessRuntimeConfig | null {
  return selection ? { worker: selection } : null
}

import type { AgentDefinition } from "../agent/agents/types"
import type {
  ProcessGraph,
  RigGraph,
  RigPod,
  SeatBinding,
  SeatBindingsSnapshot,
} from "../db/types"
import { resolveSeat, type ResolvedSeat } from "./seats"

// Run-start seat resolution (plan 106.3, decision 2). Every seat role a
// playbook uses is resolved against the initiative's rig SNAPSHOT, in the
// slice's pod first, then up its oversight chain. The result is frozen onto the
// run; workers never consult the live rig. A missing or unusable role fails the
// run before any worker starts — there is no silent fallback to a default agent.

export class SeatResolutionError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(" "))
    this.name = "SeatResolutionError"
  }
}

// Every seat role referenced by a definition, including nested sub-process
// definitions (which run inside the same Mission Control run).
export function collectSeatRoles(
  graph: ProcessGraph,
  loadGraph: (processId: string) => ProcessGraph | undefined,
  seen = new Set<string>()
): string[] {
  if (seen.has(graph.definition.id)) return []
  seen.add(graph.definition.id)
  const roles = new Set<string>()
  for (const agent of graph.agents) if (agent.seatRole) roles.add(agent.seatRole)
  for (const phase of graph.phases) {
    if (!phase.subprocessId) continue
    const nested = loadGraph(phase.subprocessId)
    if (nested)
      for (const role of collectSeatRoles(nested, loadGraph, seen)) roles.add(role)
  }
  return [...roles].sort()
}

// The pod a container executes in: the requested pod (the slice's own, else the
// initiative default); with none requested, the first overseen pod (a working
// pod rather than an orchestration pod), else the first pod.
export function executionPod(
  rig: RigGraph,
  podKey: string | null | undefined
): RigPod | null {
  const pods = [...rig.pods].sort((a, b) => a.position - b.position)
  if (podKey) return pods.find((pod) => pod.key === podKey) ?? null
  const overseen = new Set(rig.oversight.map((edge) => edge.overseenPodId))
  return pods.find((pod) => overseen.has(pod.id)) ?? pods[0] ?? null
}

// The pod itself, then its overseers breadth-first (nearest first).
function podSearchOrder(rig: RigGraph, pod: RigPod): RigPod[] {
  const byId = new Map(rig.pods.map((p) => [p.id, p]))
  const order: RigPod[] = [pod]
  const seen = new Set([pod.id])
  for (let i = 0; i < order.length; i++) {
    const overseers = rig.oversight
      .filter((edge) => edge.overseenPodId === order[i].id)
      .map((edge) => byId.get(edge.overseerPodId))
      .filter((p): p is RigPod => !!p && !seen.has(p.id))
      .sort((a, b) => a.position - b.position)
    for (const overseer of overseers) {
      seen.add(overseer.id)
      order.push(overseer)
    }
  }
  return order
}

// One resolved seat as the frozen binding workers read.
export function toSeatBinding(
  resolved: ResolvedSeat & { agent: AgentDefinition },
  pod: RigPod
): SeatBinding {
  const { seat } = resolved
  return {
    address: resolved.address,
    role: seat.role,
    seatId: seat.id,
    podKey: pod.key,
    podName: pod.name,
    agentName: resolved.agent.refId,
    agentLabel: resolved.label,
    charter: seat.charter,
    podMission: pod.missionStatement,
    podCulture: pod.cultureMd,
    decisionRights: seat.decisionRights,
    skills: seat.skills,
    tools: seat.tools,
    mcpServers: seat.mcpServers,
    runtime: resolved.runtime,
  }
}

// A single seat bound outside a playbook run (a seat session, plan 106.4): the
// same binding and snapshot shape run-start resolution produces, so seat context
// renders identically in both places. Throws when the seat is vacant or its
// agent is unavailable.
export function resolveSingleSeat(input: {
  rig: RigGraph
  address: string
  agents: AgentDefinition[]
  intentChain: string
}): { snapshot: SeatBindingsSnapshot; seat: SeatBinding } {
  const { rig } = input
  for (const pod of rig.pods) {
    for (const seat of rig.seats.filter((s) => s.podId === pod.id)) {
      const resolved = resolveSeat(seat, pod, input.agents)
      if (resolved.address !== input.address) continue
      if (resolved.status !== "resolved" || !resolved.agent)
        throw new SeatResolutionError([
          `${resolved.address} is ${resolved.status === "vacant" ? "vacant" : "bound to an unavailable agent"}.`,
        ])
      const binding = toSeatBinding({ ...resolved, agent: resolved.agent }, pod)
      return {
        seat: binding,
        snapshot: {
          version: 1,
          rigName: rig.rig.name,
          rigCulture: rig.rig.cultureMd,
          podKey: pod.key,
          roles: { [seat.role]: [binding.address] },
          seats: { [binding.address]: binding },
          intentChain: input.intentChain,
        },
      }
    }
  }
  throw new SeatResolutionError([`No seat ${input.address} in the rig.`])
}

export function resolveSeatBindings(input: {
  rig: RigGraph
  podKey: string | null | undefined
  roles: string[]
  agents: AgentDefinition[]
  intentChain: string
  // A role the rig has no seat for at all may borrow another role's seats
  // (e.g. conflict resolution: integrator → lead, plan 106.5).
  roleFallbacks?: Record<string, string>
}): SeatBindingsSnapshot {
  const { rig, roles, agents } = input
  const pod = executionPod(rig, input.podKey)
  if (!pod)
    throw new SeatResolutionError([
      input.podKey
        ? `The rig "${rig.rig.name}" has no pod "${input.podKey}".`
        : `The rig "${rig.rig.name}" has no pods.`,
    ])
  const searchOrder = podSearchOrder(rig, pod)
  const podById = new Map(rig.pods.map((p) => [p.id, p]))
  const snapshot: SeatBindingsSnapshot = {
    version: 1,
    rigName: rig.rig.name,
    rigCulture: rig.rig.cultureMd,
    podKey: pod.key,
    roles: {},
    seats: {},
    intentChain: input.intentChain,
  }
  const problems: string[] = []
  const fallback = (role: string) => {
    const other = input.roleFallbacks?.[role]
    return other && !rig.seats.some((seat) => seat.role === role) ? other : role
  }
  for (const role of roles) {
    const seatRole = fallback(role)
    const candidates: SeatBinding[] = []
    const unusable: string[] = []
    for (const searchPod of searchOrder) {
      const seats = rig.seats
        .filter((seat) => seat.podId === searchPod.id && seat.role === seatRole)
        .sort((a, b) => a.position - b.position)
      for (const seat of seats) {
        const resolved = resolveSeat(seat, searchPod, agents)
        if (resolved.status !== "resolved" || !resolved.agent) {
          unusable.push(
            `${resolved.address} is ${resolved.status === "vacant" ? "vacant" : "bound to an unavailable agent"}`
          )
          continue
        }
        candidates.push(
          toSeatBinding(
            { ...resolved, agent: resolved.agent },
            podById.get(seat.podId) ?? searchPod
          )
        )
      }
      // The nearest pod that has a usable seat wins; overseers are only a
      // fallback when the pod itself cannot fill the role.
      if (candidates.length) break
    }
    if (!candidates.length) {
      problems.push(
        unusable.length
          ? `Role "${role}" has no usable seat for pod "${pod.key}": ${unusable.join("; ")}.`
          : `No seat has role "${seatRole}"${seatRole === role ? "" : ` (standing in for "${role}")`} in pod "${pod.key}" or the pods overseeing it.`
      )
      continue
    }
    snapshot.roles[role] = candidates.map((c) => c.address)
    for (const candidate of candidates)
      snapshot.seats[candidate.address] = candidate
  }
  if (problems.length) throw new SeatResolutionError(problems)
  return snapshot
}

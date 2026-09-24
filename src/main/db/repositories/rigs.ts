import { randomUUID } from "crypto"
import { isPodKey, isRigKey } from "../../../shared/mission-control/address"
import { getDb } from "../connection"
import {
  RIG_DECISION_RIGHTS,
  type ProcessRuntimeConfig,
  type Rig,
  type RigDecisionRight,
  type RigDiagnostic,
  type RigGraph,
  type RigOversight,
  type RigPod,
  type RigSeat,
} from "../types"

export const MAX_CULTURE_CHARS = 32 * 1024
const DECISION_RIGHTS = new Set<string>(RIG_DECISION_RIGHTS)

export class RigValidationError extends Error {
  readonly code = "rig_validation_failed"

  constructor(readonly diagnostics: RigDiagnostic[]) {
    super(diagnostics.map((diagnostic) => diagnostic.message).join(" "))
    this.name = "RigValidationError"
  }
}

interface RigRow {
  id: string
  name: string
  description: string | null
  culture_md: string
  created_at: number
  updated_at: number
}

interface PodRow {
  id: string
  rig_id: string
  key: string
  name: string
  mission_statement: string
  culture_md: string
  lead_seat_id: string | null
  position: number
}

interface SeatRow {
  id: string
  pod_id: string
  key: string
  role: string
  charter: string
  agent_ref_id: string | null
  agent_label: string | null
  skills: string | null
  tools: string | null
  mcp_servers: string | null
  decision_rights: string
  runtime_config: string | null
  position: number
}

interface OversightRow {
  id: string
  rig_id: string
  overseer_pod_id: string
  overseen_pod_id: string
}

function parseStringList(value: string | null): string[] | null {
  if (value === null) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : null
  } catch {
    return null
  }
}

function parseRuntimeConfig(value: string | null): ProcessRuntimeConfig | null {
  if (value === null) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object"
      ? (parsed as ProcessRuntimeConfig)
      : null
  } catch {
    return null
  }
}

function toRig(row: RigRow): Rig {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    cultureMd: row.culture_md,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toPod(row: PodRow): RigPod {
  return {
    id: row.id,
    rigId: row.rig_id,
    key: row.key,
    name: row.name,
    missionStatement: row.mission_statement,
    cultureMd: row.culture_md,
    leadSeatId: row.lead_seat_id,
    position: row.position,
  }
}

function toSeat(row: SeatRow): RigSeat {
  const rights = parseStringList(row.decision_rights) ?? []
  return {
    id: row.id,
    podId: row.pod_id,
    key: row.key,
    role: row.role,
    charter: row.charter,
    agentRefId: row.agent_ref_id,
    agentLabel: row.agent_label,
    skills: parseStringList(row.skills),
    tools: parseStringList(row.tools),
    mcpServers: parseStringList(row.mcp_servers),
    decisionRights: rights.filter((right): right is RigDecisionRight =>
      DECISION_RIGHTS.has(right)
    ),
    runtimeConfig: parseRuntimeConfig(row.runtime_config),
    position: row.position,
  }
}

function toOversight(row: OversightRow): RigOversight {
  return {
    id: row.id,
    rigId: row.rig_id,
    overseerPodId: row.overseer_pod_id,
    overseenPodId: row.overseen_pod_id,
  }
}

function json(value: unknown[] | object | null | undefined): string | null {
  return value == null ? null : JSON.stringify(value)
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new RigValidationError([
      { severity: "error", code: "required", message: `${label} is required.` },
    ])
  }
  return normalized
}

function culture(value: string, label: string): string {
  if (value.length > MAX_CULTURE_CHARS) {
    throw new RigValidationError([
      {
        severity: "error",
        code: "culture_too_large",
        message: `${label} must be ${MAX_CULTURE_CHARS} characters or fewer.`,
      },
    ])
  }
  return value
}

function key(value: string, label: string, pod = false): string {
  const normalized = value.trim()
  if (pod ? !isPodKey(normalized) : !isRigKey(normalized)) {
    throw new RigValidationError([
      {
        severity: "error",
        code: "invalid_key",
        message: `${label} must use lowercase letters, numbers, and single hyphens, up to 32 characters${pod ? "; rig and system are reserved" : ""}.`,
      },
    ])
  }
  return normalized
}

function rights(value: RigDecisionRight[] | undefined): RigDecisionRight[] {
  const normalized = [...new Set(value ?? [])]
  const invalid = normalized.filter((right) => !DECISION_RIGHTS.has(right))
  if (invalid.length) {
    throw new RigValidationError([
      {
        severity: "error",
        code: "invalid_decision_right",
        message: `Unknown decision rights: ${invalid.join(", ")}.`,
      },
    ])
  }
  return normalized
}

function touchRig(rigId: string): void {
  getDb().prepare("UPDATE rigs SET updated_at = ? WHERE id = ?").run(Date.now(), rigId)
}

function rigIdForPod(podId: string): string | null {
  const row = getDb()
    .prepare("SELECT rig_id FROM rig_pods WHERE id = ?")
    .get(podId) as { rig_id: string } | undefined
  return row?.rig_id ?? null
}

function assertSeatAddressAvailable(podId: string, seatKey: string, exceptId?: string): void {
  const existing = getDb()
    .prepare("SELECT id FROM rig_seats WHERE pod_id = ? AND key = ? AND id != ?")
    .get(podId, seatKey, exceptId ?? "") as { id: string } | undefined
  if (!existing) return
  const pod = getPod(podId)
  throw new RigValidationError([
    {
      severity: "error",
      code: "duplicate_seat_address",
      message: `The seat address ${seatKey}@${pod?.key ?? "pod"} is already in use.`,
      entityId: existing.id,
    },
  ])
}

export function createRig(input: {
  name: string
  description?: string | null
  cultureMd?: string
}): Rig {
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      "INSERT INTO rigs (id, name, description, culture_md, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(
      id,
      requiredText(input.name, "Rig name"),
      input.description ?? null,
      culture(input.cultureMd ?? "", "Rig culture"),
      now,
      now
    )
  return getRig(id)!
}

export function getRig(id: string): Rig | null {
  const row = getDb().prepare("SELECT * FROM rigs WHERE id = ?").get(id) as
    | RigRow
    | undefined
  return row ? toRig(row) : null
}

export function listRigs(): Rig[] {
  return (getDb()
    .prepare("SELECT * FROM rigs ORDER BY updated_at DESC")
    .all() as RigRow[]).map(toRig)
}

export function updateRig(
  id: string,
  patch: { name?: string; description?: string | null; cultureMd?: string }
): Rig {
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.name !== undefined) {
    sets.push("name = ?")
    values.push(requiredText(patch.name, "Rig name"))
  }
  if (patch.description !== undefined) {
    sets.push("description = ?")
    values.push(patch.description)
  }
  if (patch.cultureMd !== undefined) {
    sets.push("culture_md = ?")
    values.push(culture(patch.cultureMd, "Rig culture"))
  }
  if (sets.length) {
    sets.push("updated_at = ?")
    values.push(Date.now(), id)
    getDb().prepare(`UPDATE rigs SET ${sets.join(", ")} WHERE id = ?`).run(...values)
  }
  const rig = getRig(id)
  if (!rig) throw new Error(`Rig not found: ${id}`)
  return rig
}

export function deleteRig(id: string): void {
  getDb().prepare("DELETE FROM rigs WHERE id = ?").run(id)
}

export function createPod(input: {
  rigId: string
  key: string
  name: string
  missionStatement?: string
  cultureMd?: string
  position?: number
}): RigPod {
  const id = randomUUID()
  const position =
    input.position ??
    ((getDb()
      .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM rig_pods WHERE rig_id = ?")
      .get(input.rigId) as { position: number }).position)
  getDb()
    .prepare(
      "INSERT INTO rig_pods (id, rig_id, key, name, mission_statement, culture_md, lead_seat_id, position) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)"
    )
    .run(
      id,
      input.rigId,
      key(input.key, "Pod key", true),
      requiredText(input.name, "Pod name"),
      input.missionStatement ?? "",
      culture(input.cultureMd ?? "", "Pod culture"),
      position
    )
  touchRig(input.rigId)
  return getPod(id)!
}

export function getPod(id: string): RigPod | null {
  const row = getDb().prepare("SELECT * FROM rig_pods WHERE id = ?").get(id) as
    | PodRow
    | undefined
  return row ? toPod(row) : null
}

export function listPods(rigId: string): RigPod[] {
  return (getDb()
    .prepare("SELECT * FROM rig_pods WHERE rig_id = ? ORDER BY position, id")
    .all(rigId) as PodRow[]).map(toPod)
}

export function updatePod(
  id: string,
  patch: {
    key?: string
    name?: string
    missionStatement?: string
    cultureMd?: string
    leadSeatId?: string | null
    position?: number
  }
): RigPod {
  const pod = getPod(id)
  if (!pod) throw new Error(`Pod not found: ${id}`)
  if (patch.leadSeatId) {
    const lead = getSeat(patch.leadSeatId)
    if (!lead || lead.podId !== id) {
      throw new RigValidationError([
        {
          severity: "error",
          code: "foreign_lead_seat",
          message: "A pod lead must be a seat in that pod.",
          entityId: id,
        },
      ])
    }
  }
  const sets: string[] = []
  const values: unknown[] = []
  const fields: Array<[keyof typeof patch, string, (value: never) => unknown]> = [
    ["key", "key", (value) => key(value, "Pod key", true)],
    ["name", "name", (value) => requiredText(value, "Pod name")],
    ["missionStatement", "mission_statement", (value) => value],
    ["cultureMd", "culture_md", (value) => culture(value, "Pod culture")],
    ["leadSeatId", "lead_seat_id", (value) => value],
    ["position", "position", (value) => value],
  ]
  for (const [property, column, normalize] of fields) {
    const value = patch[property]
    if (value !== undefined) {
      sets.push(`${column} = ?`)
      values.push(normalize(value as never))
    }
  }
  if (sets.length) {
    values.push(id)
    getDb().prepare(`UPDATE rig_pods SET ${sets.join(", ")} WHERE id = ?`).run(...values)
    touchRig(pod.rigId)
  }
  return getPod(id)!
}

export function deletePod(id: string): void {
  const rigId = rigIdForPod(id)
  getDb().prepare("DELETE FROM rig_pods WHERE id = ?").run(id)
  if (rigId) touchRig(rigId)
}

export function reorderPods(rigId: string, ids: string[]): RigPod[] {
  const existing = listPods(rigId).map((pod) => pod.id)
  if (ids.length !== existing.length || ids.some((id) => !existing.includes(id))) {
    throw new RigValidationError([
      { severity: "error", code: "invalid_reorder", message: "Pod reorder must contain every pod in the rig exactly once." },
    ])
  }
  getDb().transaction(() => {
    ids.forEach((id, position) =>
      getDb().prepare("UPDATE rig_pods SET position = ? WHERE id = ?").run(position, id)
    )
    touchRig(rigId)
  })()
  return listPods(rigId)
}

export function createSeat(input: {
  podId: string
  key: string
  role: string
  charter?: string
  agentRefId?: string | null
  agentLabel?: string | null
  skills?: string[] | null
  tools?: string[] | null
  mcpServers?: string[] | null
  decisionRights?: RigDecisionRight[]
  runtimeConfig?: ProcessRuntimeConfig | null
  position?: number
}): RigSeat {
  const rigId = rigIdForPod(input.podId)
  if (!rigId) throw new Error(`Pod not found: ${input.podId}`)
  const id = randomUUID()
  const seatKey = key(input.key, "Seat key")
  assertSeatAddressAvailable(input.podId, seatKey)
  const position =
    input.position ??
    ((getDb()
      .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM rig_seats WHERE pod_id = ?")
      .get(input.podId) as { position: number }).position)
  getDb()
    .prepare(
      `INSERT INTO rig_seats
       (id, pod_id, key, role, charter, agent_ref_id, agent_label, skills, tools, mcp_servers, decision_rights, runtime_config, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.podId,
      seatKey,
      key(input.role, "Seat role"),
      input.charter ?? "",
      input.agentRefId ?? null,
      input.agentLabel ?? null,
      json(input.skills),
      json(input.tools),
      json(input.mcpServers),
      JSON.stringify(rights(input.decisionRights)),
      json(input.runtimeConfig),
      position
    )
  touchRig(rigId)
  return getSeat(id)!
}

export function getSeat(id: string): RigSeat | null {
  const row = getDb().prepare("SELECT * FROM rig_seats WHERE id = ?").get(id) as
    | SeatRow
    | undefined
  return row ? toSeat(row) : null
}

export function listSeatsForPod(podId: string): RigSeat[] {
  return (getDb()
    .prepare("SELECT * FROM rig_seats WHERE pod_id = ? ORDER BY position, id")
    .all(podId) as SeatRow[]).map(toSeat)
}

export function listSeatsForRig(rigId: string): RigSeat[] {
  return (getDb()
    .prepare(
      `SELECT seat.* FROM rig_seats seat
       JOIN rig_pods pod ON pod.id = seat.pod_id
       WHERE pod.rig_id = ? ORDER BY pod.position, seat.position, seat.id`
    )
    .all(rigId) as SeatRow[]).map(toSeat)
}

export function updateSeat(
  id: string,
  patch: {
    key?: string
    role?: string
    charter?: string
    agentRefId?: string | null
    agentLabel?: string | null
    skills?: string[] | null
    tools?: string[] | null
    mcpServers?: string[] | null
    decisionRights?: RigDecisionRight[]
    runtimeConfig?: ProcessRuntimeConfig | null
    position?: number
  }
): RigSeat {
  const seat = getSeat(id)
  if (!seat) throw new Error(`Seat not found: ${id}`)
  const sets: string[] = []
  const values: unknown[] = []
  const add = (column: string, value: unknown) => {
    sets.push(`${column} = ?`)
    values.push(value)
  }
  if (patch.key !== undefined) {
    const seatKey = key(patch.key, "Seat key")
    assertSeatAddressAvailable(seat.podId, seatKey, id)
    add("key", seatKey)
  }
  if (patch.role !== undefined) add("role", key(patch.role, "Seat role"))
  if (patch.charter !== undefined) add("charter", patch.charter)
  if (patch.agentRefId !== undefined) add("agent_ref_id", patch.agentRefId)
  if (patch.agentLabel !== undefined) add("agent_label", patch.agentLabel)
  if (patch.skills !== undefined) add("skills", json(patch.skills))
  if (patch.tools !== undefined) add("tools", json(patch.tools))
  if (patch.mcpServers !== undefined) add("mcp_servers", json(patch.mcpServers))
  if (patch.decisionRights !== undefined) {
    add("decision_rights", JSON.stringify(rights(patch.decisionRights)))
  }
  if (patch.runtimeConfig !== undefined) add("runtime_config", json(patch.runtimeConfig))
  if (patch.position !== undefined) add("position", patch.position)
  if (sets.length) {
    values.push(id)
    getDb().prepare(`UPDATE rig_seats SET ${sets.join(", ")} WHERE id = ?`).run(...values)
    touchRig(rigIdForPod(seat.podId)!)
  }
  return getSeat(id)!
}

export function deleteSeat(id: string): void {
  const seat = getSeat(id)
  if (!seat) return
  const rigId = rigIdForPod(seat.podId)
  getDb().transaction(() => {
    getDb().prepare("UPDATE rig_pods SET lead_seat_id = NULL WHERE lead_seat_id = ?").run(id)
    getDb().prepare("DELETE FROM rig_seats WHERE id = ?").run(id)
    if (rigId) touchRig(rigId)
  })()
}

export function reorderSeats(podId: string, ids: string[]): RigSeat[] {
  const existing = listSeatsForPod(podId).map((seat) => seat.id)
  if (ids.length !== existing.length || ids.some((id) => !existing.includes(id))) {
    throw new RigValidationError([
      { severity: "error", code: "invalid_reorder", message: "Seat reorder must contain every seat in the pod exactly once." },
    ])
  }
  getDb().transaction(() => {
    ids.forEach((id, position) =>
      getDb().prepare("UPDATE rig_seats SET position = ? WHERE id = ?").run(position, id)
    )
    const rigId = rigIdForPod(podId)
    if (rigId) touchRig(rigId)
  })()
  return listSeatsForPod(podId)
}

export function listOversight(rigId: string): RigOversight[] {
  return (getDb()
    .prepare("SELECT * FROM rig_oversight WHERE rig_id = ? ORDER BY id")
    .all(rigId) as OversightRow[]).map(toOversight)
}

function graphHasCycle(edges: Array<{ from: string; to: string }>): boolean {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to])
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true
    if (visited.has(node)) return false
    visiting.add(node)
    for (const next of adjacency.get(node) ?? []) {
      if (visit(next)) return true
    }
    visiting.delete(node)
    visited.add(node)
    return false
  }
  return [...adjacency.keys()].some(visit)
}

export function setOversight(
  rigId: string,
  edges: Array<{ overseerPodId: string; overseenPodId: string }>
): RigOversight[] {
  const podIds = new Set(listPods(rigId).map((pod) => pod.id))
  const seen = new Set<string>()
  const diagnostics: RigDiagnostic[] = []
  for (const edge of edges) {
    if (edge.overseerPodId === edge.overseenPodId) {
      diagnostics.push({ severity: "error", code: "self_oversight", message: "A pod cannot oversee itself." })
    }
    if (!podIds.has(edge.overseerPodId) || !podIds.has(edge.overseenPodId)) {
      diagnostics.push({ severity: "error", code: "foreign_oversight_pod", message: "Oversight edges must connect pods in the same rig." })
    }
    const identity = `${edge.overseerPodId}:${edge.overseenPodId}`
    if (seen.has(identity)) {
      diagnostics.push({ severity: "error", code: "duplicate_oversight", message: "Duplicate oversight edges are not allowed." })
    }
    seen.add(identity)
  }
  const nonSelfEdges = edges.filter((edge) => edge.overseerPodId !== edge.overseenPodId)
  if (graphHasCycle(nonSelfEdges.map((edge) => ({ from: edge.overseerPodId, to: edge.overseenPodId })))) {
    diagnostics.push({ severity: "error", code: "oversight_cycle", message: "Oversight must form an acyclic graph." })
  }
  if (diagnostics.length) throw new RigValidationError(diagnostics)
  getDb().transaction(() => {
    getDb().prepare("DELETE FROM rig_oversight WHERE rig_id = ?").run(rigId)
    const insert = getDb().prepare(
      "INSERT INTO rig_oversight (id, rig_id, overseer_pod_id, overseen_pod_id) VALUES (?, ?, ?, ?)"
    )
    for (const edge of edges) {
      insert.run(randomUUID(), rigId, edge.overseerPodId, edge.overseenPodId)
    }
    touchRig(rigId)
  })()
  return listOversight(rigId)
}

export function getRigGraph(id: string): RigGraph | null {
  const rig = getRig(id)
  if (!rig) return null
  return {
    rig,
    pods: listPods(id),
    seats: listSeatsForRig(id),
    oversight: listOversight(id),
  }
}

export function diagnoseRig(graph: RigGraph): RigDiagnostic[] {
  const diagnostics: RigDiagnostic[] = []
  const podById = new Map(graph.pods.map((pod) => [pod.id, pod]))
  const seatById = new Map(graph.seats.map((seat) => [seat.id, seat]))
  for (const pod of graph.pods) {
    if (pod.leadSeatId && seatById.get(pod.leadSeatId)?.podId !== pod.id) {
      diagnostics.push({ severity: "error", code: "foreign_lead_seat", message: `${pod.name}'s lead is not a seat in that pod.`, entityId: pod.id })
    }
  }
  for (const edge of graph.oversight) {
    if (!podById.has(edge.overseerPodId) || !podById.has(edge.overseenPodId)) {
      diagnostics.push({ severity: "error", code: "foreign_oversight_pod", message: "An oversight edge references a pod outside this rig.", entityId: edge.id })
    }
  }
  const groups = new Map<string, RigSeat[]>()
  for (const seat of graph.seats) {
    if (!seat.agentRefId || seat.charter.trim()) continue
    const identity = JSON.stringify([seat.podId, seat.agentRefId, seat.skills, seat.tools, seat.mcpServers])
    groups.set(identity, [...(groups.get(identity) ?? []), seat])
  }
  for (const seats of groups.values()) {
    if (seats.length > 1) {
      diagnostics.push({ severity: "warning", code: "redundant_seats", message: "These seats use the same agent and capabilities with no charter, so they may duplicate each other's work.", entityId: seats[0].podId })
    }
  }
  return diagnostics
}

export function duplicateRig(id: string, name?: string): RigGraph {
  const source = getRigGraph(id)
  if (!source) throw new Error(`Rig not found: ${id}`)
  return getDb().transaction(() => {
    const rig = createRig({ name: name ?? `${source.rig.name} copy`, description: source.rig.description, cultureMd: source.rig.cultureMd })
    const podIds = new Map<string, string>()
    const seatIds = new Map<string, string>()
    for (const pod of source.pods) {
      const created = createPod({ rigId: rig.id, key: pod.key, name: pod.name, missionStatement: pod.missionStatement, cultureMd: pod.cultureMd, position: pod.position })
      podIds.set(pod.id, created.id)
    }
    for (const seat of source.seats) {
      const created = createSeat({ ...seat, podId: podIds.get(seat.podId)!, position: seat.position })
      seatIds.set(seat.id, created.id)
    }
    for (const pod of source.pods) {
      if (pod.leadSeatId) updatePod(podIds.get(pod.id)!, { leadSeatId: seatIds.get(pod.leadSeatId) ?? null })
    }
    setOversight(rig.id, source.oversight.map((edge) => ({ overseerPodId: podIds.get(edge.overseerPodId)!, overseenPodId: podIds.get(edge.overseenPodId)! })))
    return getRigGraph(rig.id)!
  })()
}

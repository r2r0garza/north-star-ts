import { randomUUID } from "crypto"
import { isRigKey } from "../../../shared/mission-control/address"
import { findCycle } from "../../../shared/mission-control/waves"
import { getDb } from "../connection"
import type {
  Initiative,
  InitiativeGraph,
  Mission,
  RigGraph,
  SliceEdge,
  SliceSpec,
  WorkRevision,
  WorkSlice,
} from "../types"
import { getRigGraph } from "./rigs"
import {
  sliceStatusPath,
  transitionMissionStatus,
} from "../../mission-control/work-state"

interface InitiativeRow {
  id: string
  key: string
  name: string
  intent: string
  definition_of_done: string
  rig_id: string | null
  rig_snapshot: string | null
  workspace_id: string | null
  project_id: string | null
  default_pod_key: string | null
  playbook_id: string | null
  drive_mode: Initiative["driveMode"]
  budgets: string
  status: Initiative["status"]
  task_id: string | null
  created_at: number
  updated_at: number
  started_at: number | null
  finished_at: number | null
}
interface MissionRow {
  id: string
  initiative_id: string
  key: string
  name: string
  outcome: string
  definition_of_done: string
  playbook_id: string | null
  merge_policy: string
  integration_branch: string | null
  status: Mission["status"]
  position: number
  started_at: number | null
  finished_at: number | null
}
interface SliceRow {
  id: string
  mission_id: string
  key: string
  title: string
  spec: string
  proof: string | null
  pod_key: string | null
  playbook_id: string | null
  status: WorkSlice["status"]
  process_run_id: string | null
  branch: string | null
  attempts: number
  origin: WorkSlice["origin"]
  position: number
  started_at: number | null
  finished_at: number | null
}
interface EdgeRow {
  id: string
  mission_id: string
  from_slice_id: string
  to_slice_id: string
}
interface RevisionRow {
  id: string
  initiative_id: string
  target_kind: WorkRevision["targetKind"]
  target_id: string
  actor: string
  change: string
  reason: string | null
  created_at: number
}

const EMPTY_SPEC: SliceSpec = {
  goal: "",
  acceptance: [],
  outOfScope: [],
  touchHints: [],
  notes: "",
}

function parse<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
function text(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required.`)
  return normalized
}
function workKey(value: string, label: string): string {
  const normalized = value.trim()
  if (!isRigKey(normalized))
    throw new Error(
      `${label} must use lowercase letters, numbers, and single hyphens, up to 32 characters.`
    )
  return normalized
}
// Keys are derived from names in the UI, so creation takes the next free
// suffix (`name`, `name-2`, …) rather than failing on a duplicate.
function freeKey(base: string, taken: (key: string) => boolean): string {
  if (!taken(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const key = `${base.slice(0, 32 - suffix.length).replace(/-$/, "")}${suffix}`
    if (!taken(key)) return key
  }
}
function exists(sql: string, ...params: unknown[]): boolean {
  return (
    getDb()
      .prepare(sql)
      .get(...params) !== undefined
  )
}
function assertKeyFree(taken: boolean, label: string, key: string): void {
  if (taken)
    throw new Error(`${label} “${key}” is already in use. Choose another.`)
}
function spec(value?: Partial<SliceSpec>): SliceSpec {
  return {
    goal: value?.goal ?? "",
    acceptance:
      value?.acceptance?.map((item) => item.trim()).filter(Boolean) ?? [],
    outOfScope:
      value?.outOfScope?.map((item) => item.trim()).filter(Boolean) ?? [],
    touchHints:
      value?.touchHints?.map((item) => item.trim()).filter(Boolean) ?? [],
    notes: value?.notes ?? "",
  }
}
function toInitiative(row: InitiativeRow): Initiative {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    intent: row.intent,
    definitionOfDone: row.definition_of_done,
    rigId: row.rig_id,
    rigSnapshot: parse<RigGraph | null>(row.rig_snapshot, null),
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    defaultPodKey: row.default_pod_key,
    playbookId: row.playbook_id,
    driveMode: row.drive_mode,
    budgets: parse(row.budgets, {}),
    status: row.status,
    taskId: row.task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}
function toMission(row: MissionRow): Mission {
  return {
    id: row.id,
    initiativeId: row.initiative_id,
    key: row.key,
    name: row.name,
    outcome: row.outcome,
    definitionOfDone: row.definition_of_done,
    playbookId: row.playbook_id,
    mergePolicy: parse(row.merge_policy, { mode: "manual" }),
    integrationBranch: row.integration_branch,
    status: row.status,
    position: row.position,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}
function toSlice(row: SliceRow): WorkSlice {
  return {
    id: row.id,
    missionId: row.mission_id,
    key: row.key,
    title: row.title,
    spec: spec(parse(row.spec, EMPTY_SPEC)),
    proof: parse<unknown | null>(row.proof, null),
    podKey: row.pod_key,
    playbookId: row.playbook_id,
    status: row.status,
    processRunId: row.process_run_id,
    branch: row.branch,
    attempts: row.attempts,
    origin: row.origin,
    position: row.position,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}
function toEdge(row: EdgeRow): SliceEdge {
  return {
    id: row.id,
    missionId: row.mission_id,
    fromSliceId: row.from_slice_id,
    toSliceId: row.to_slice_id,
  }
}
function toRevision(row: RevisionRow): WorkRevision {
  return {
    id: row.id,
    initiativeId: row.initiative_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    actor: row.actor,
    change: parse(row.change, { op: "unknown" }),
    reason: row.reason,
    createdAt: row.created_at,
  }
}

export function getInitiative(id: string): Initiative | null {
  const row = getDb()
    .prepare("SELECT * FROM initiatives WHERE id = ?")
    .get(id) as InitiativeRow | undefined
  return row ? toInitiative(row) : null
}
export function listInitiatives(): Initiative[] {
  return (
    getDb()
      .prepare("SELECT * FROM initiatives ORDER BY updated_at DESC")
      .all() as InitiativeRow[]
  ).map(toInitiative)
}
export function listMissions(initiativeId: string): Mission[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM missions WHERE initiative_id = ? ORDER BY position, id"
      )
      .all(initiativeId) as MissionRow[]
  ).map(toMission)
}
export function getMission(id: string): Mission | null {
  const row = getDb().prepare("SELECT * FROM missions WHERE id = ?").get(id) as
    | MissionRow
    | undefined
  return row ? toMission(row) : null
}
export function listSlices(missionId: string): WorkSlice[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM slices WHERE mission_id = ? ORDER BY position, id"
      )
      .all(missionId) as SliceRow[]
  ).map(toSlice)
}
export function getSlice(id: string): WorkSlice | null {
  const row = getDb().prepare("SELECT * FROM slices WHERE id = ?").get(id) as
    | SliceRow
    | undefined
  return row ? toSlice(row) : null
}
export function listEdges(missionId: string): SliceEdge[] {
  return (
    getDb()
      .prepare("SELECT * FROM slice_edges WHERE mission_id = ? ORDER BY id")
      .all(missionId) as EdgeRow[]
  ).map(toEdge)
}
export function listRevisions(initiativeId: string): WorkRevision[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM work_revisions WHERE initiative_id = ? ORDER BY created_at DESC, id DESC"
      )
      .all(initiativeId) as RevisionRow[]
  ).map(toRevision)
}
function initiativeIdForMission(missionId: string): string {
  const mission = getMission(missionId)
  if (!mission) throw new Error(`Mission not found: ${missionId}`)
  return mission.initiativeId
}
function touch(initiativeId: string): void {
  getDb()
    .prepare("UPDATE initiatives SET updated_at = ? WHERE id = ?")
    .run(Date.now(), initiativeId)
}
// A container's playbook must exist and match its altitude; null clears the
// choice so the run falls back to the default playbook for that altitude.
function playbookRef(
  value: string | null,
  altitude: "initiative" | "mission" | "slice"
): string | null {
  if (value === null) return null
  const row = getDb()
    .prepare("SELECT altitude FROM playbooks WHERE id = ?")
    .get(value) as { altitude: string } | undefined
  if (!row) throw new Error(`Playbook not found: ${value}`)
  if (row.altitude !== altitude)
    throw new Error(
      `A ${row.altitude} playbook can't be used for a ${altitude}.`
    )
  return value
}

// Deleting work cascades its playbook_runs rows, which would orphan a live
// Process run and lose the slice outcome, so running work must be cancelled first.
function assertNoRunningPlaybook(where: string, ...values: unknown[]): void {
  const running = getDb()
    .prepare(
      `SELECT 1 FROM playbook_runs WHERE status = 'running' AND (${where}) LIMIT 1`
    )
    .get(...values)
  if (running)
    throw new Error("A playbook run is in progress here. Cancel it first.")
}

function audit(
  initiativeId: string,
  targetKind: WorkRevision["targetKind"],
  targetId: string,
  op: string,
  before: unknown,
  after: unknown,
  actor = "user",
  reason?: string | null
): void {
  const initiative = getInitiative(initiativeId)
  if (!initiative || initiative.status === "draft") return
  getDb()
    .prepare(
      "INSERT INTO work_revisions (id, initiative_id, target_kind, target_id, actor, change, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      randomUUID(),
      initiativeId,
      targetKind,
      targetId,
      actor,
      JSON.stringify({ op, before, after }),
      reason?.trim() || "User-authored structural change",
      Date.now()
    )
}
function currentRigSnapshot(initiative: Initiative): RigGraph | null {
  return initiative.rigId ? getRigGraph(initiative.rigId) : null
}
function snapshotComparable(graph: RigGraph | null): string {
  return JSON.stringify(
    graph
      ? {
          rig: {
            name: graph.rig.name,
            description: graph.rig.description,
            cultureMd: graph.rig.cultureMd,
          },
          pods: graph.pods,
          seats: graph.seats,
          oversight: graph.oversight.map(({ id: _id, ...edge }) => edge),
        }
      : null
  )
}
export function getInitiativeGraph(id: string): InitiativeGraph | null {
  const initiative = getInitiative(id)
  if (!initiative) return null
  const missions = listMissions(id)
  const slices = missions.flatMap((mission) => listSlices(mission.id))
  const edges = missions.flatMap((mission) => listEdges(mission.id))
  const current = currentRigSnapshot(initiative)
  return {
    initiative,
    missions,
    slices,
    edges,
    revisions: listRevisions(id),
    // A deleted rig isn't drift: there is nothing to re-seat from, and the
    // initiative keeps running on its snapshot.
    rigDrifted: Boolean(
      initiative.rigSnapshot &&
      current &&
      snapshotComparable(initiative.rigSnapshot) !== snapshotComparable(current)
    ),
  }
}

export function createInitiative(input: {
  key: string
  name: string
  intent: string
  definitionOfDone: string
  rigId?: string | null
  workspaceId?: string | null
  projectId?: string | null
  defaultPodKey?: string | null
}): InitiativeGraph {
  const id = randomUUID()
  const now = Date.now()
  getDb().transaction(() => {
    getDb()
      .prepare(
        "INSERT INTO initiatives (id, key, name, intent, definition_of_done, rig_id, workspace_id, project_id, default_pod_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)"
      )
      .run(
        id,
        freeKey(workKey(input.key, "Initiative key"), (key) =>
          exists("SELECT 1 FROM initiatives WHERE key = ?", key)
        ),
        text(input.name, "Initiative name"),
        input.intent,
        input.definitionOfDone,
        input.rigId ?? null,
        input.workspaceId ?? null,
        input.projectId ?? null,
        input.defaultPodKey ?? null,
        now,
        now
      )
    createMission({
      initiativeId: id,
      key: "mission-1",
      name: "First mission",
      outcome: "",
    })
  })()
  return getInitiativeGraph(id)!
}
export function updateInitiative(
  id: string,
  patch: Partial<
    Pick<
      Initiative,
      | "key"
      | "name"
      | "intent"
      | "definitionOfDone"
      | "rigId"
      | "workspaceId"
      | "projectId"
      | "defaultPodKey"
      | "playbookId"
    >
  >,
  actor = "user",
  reason?: string
): InitiativeGraph {
  const before = getInitiative(id)
  if (!before) throw new Error(`Initiative not found: ${id}`)
  // Running work resolves the workspace live and seats come from the rig
  // snapshot taken at start, so the binding is frozen once started.
  if (
    before.status !== "draft" &&
    ((patch.rigId !== undefined && patch.rigId !== before.rigId) ||
      (patch.workspaceId !== undefined &&
        patch.workspaceId !== before.workspaceId) ||
      (patch.projectId !== undefined && patch.projectId !== before.projectId))
  )
    throw new Error(
      "The rig, workspace, and project can't be changed after an initiative has started."
    )
  const sets: string[] = []
  const values: unknown[] = []
  const add = (column: string, value: unknown) => {
    sets.push(`${column} = ?`)
    values.push(value)
  }
  if (patch.key !== undefined) {
    const key = workKey(patch.key, "Initiative key")
    assertKeyFree(
      exists("SELECT 1 FROM initiatives WHERE key = ? AND id != ?", key, id),
      "Initiative key",
      key
    )
    add("key", key)
  }
  if (patch.name !== undefined) add("name", text(patch.name, "Initiative name"))
  if (patch.intent !== undefined) add("intent", patch.intent)
  if (patch.definitionOfDone !== undefined)
    add("definition_of_done", patch.definitionOfDone)
  if (patch.rigId !== undefined) add("rig_id", patch.rigId)
  if (patch.workspaceId !== undefined) add("workspace_id", patch.workspaceId)
  if (patch.projectId !== undefined) add("project_id", patch.projectId)
  if (patch.defaultPodKey !== undefined)
    add("default_pod_key", patch.defaultPodKey)
  if (patch.playbookId !== undefined)
    add("playbook_id", playbookRef(patch.playbookId, "initiative"))
  if (sets.length) {
    add("updated_at", Date.now())
    values.push(id)
    getDb()
      .prepare(`UPDATE initiatives SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values)
  }
  const after = getInitiative(id)!
  audit(id, "initiative", id, "update", before, after, actor, reason)
  return getInitiativeGraph(id)!
}
export function deleteInitiative(id: string): void {
  assertNoRunningPlaybook("initiative_id = ?", id)
  getDb().prepare("DELETE FROM initiatives WHERE id = ?").run(id)
}
export function startInitiative(id: string): InitiativeGraph {
  const initiative = getInitiative(id)
  if (!initiative) throw new Error(`Initiative not found: ${id}`)
  if (initiative.status !== "draft")
    throw new Error("Only a draft initiative can be started.")
  const snapshot = currentRigSnapshot(initiative)
  if (!snapshot)
    throw new Error("Choose an available rig before starting the initiative.")
  const now = Date.now()
  getDb()
    .prepare(
      "UPDATE initiatives SET rig_snapshot = ?, status = 'active', started_at = ?, updated_at = ? WHERE id = ?"
    )
    .run(JSON.stringify(snapshot), now, now, id)
  return getInitiativeGraph(id)!
}
export function reseatInitiative(id: string, reason?: string): InitiativeGraph {
  const before = getInitiative(id)
  if (!before) throw new Error(`Initiative not found: ${id}`)
  const snapshot = currentRigSnapshot(before)
  if (!snapshot) throw new Error("The initiative's rig is no longer available.")
  getDb()
    .prepare(
      "UPDATE initiatives SET rig_snapshot = ?, updated_at = ? WHERE id = ?"
    )
    .run(JSON.stringify(snapshot), Date.now(), id)
  audit(
    id,
    "initiative",
    id,
    "reseat",
    before.rigSnapshot,
    snapshot,
    "user",
    reason
  )
  return getInitiativeGraph(id)!
}

export function createMission(input: {
  initiativeId: string
  key: string
  name: string
  outcome: string
  definitionOfDone?: string
}): InitiativeGraph {
  const id = randomUUID()
  const position = (
    getDb()
      .prepare(
        "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM missions WHERE initiative_id = ?"
      )
      .get(input.initiativeId) as { position: number }
  ).position
  getDb()
    .prepare(
      "INSERT INTO missions (id, initiative_id, key, name, outcome, definition_of_done, status, position) VALUES (?, ?, ?, ?, ?, ?, 'planned', ?)"
    )
    .run(
      id,
      input.initiativeId,
      freeKey(workKey(input.key, "Mission key"), (key) =>
        exists(
          "SELECT 1 FROM missions WHERE initiative_id = ? AND key = ?",
          input.initiativeId,
          key
        )
      ),
      text(input.name, "Mission name"),
      input.outcome,
      input.definitionOfDone ?? "",
      position
    )
  audit(input.initiativeId, "mission", id, "create", null, getMission(id))
  touch(input.initiativeId)
  return getInitiativeGraph(input.initiativeId)!
}
export function updateMission(
  id: string,
  patch: Partial<
    Pick<
      Mission,
      "key" | "name" | "outcome" | "definitionOfDone" | "position" | "playbookId"
    >
  >,
  actor = "user",
  reason?: string
): InitiativeGraph {
  const before = getMission(id)
  if (!before) throw new Error(`Mission not found: ${id}`)
  const sets: string[] = []
  const values: unknown[] = []
  const add = (c: string, v: unknown) => {
    sets.push(`${c} = ?`)
    values.push(v)
  }
  if (patch.key !== undefined) {
    const key = workKey(patch.key, "Mission key")
    assertKeyFree(
      exists(
        "SELECT 1 FROM missions WHERE initiative_id = ? AND key = ? AND id != ?",
        before.initiativeId,
        key,
        id
      ),
      "Mission key",
      key
    )
    add("key", key)
  }
  if (patch.name !== undefined) add("name", text(patch.name, "Mission name"))
  if (patch.outcome !== undefined) add("outcome", patch.outcome)
  if (patch.definitionOfDone !== undefined)
    add("definition_of_done", patch.definitionOfDone)
  if (patch.position !== undefined) add("position", patch.position)
  if (patch.playbookId !== undefined)
    add("playbook_id", playbookRef(patch.playbookId, "mission"))
  if (sets.length) {
    values.push(id)
    getDb()
      .prepare(`UPDATE missions SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values)
  }
  const after = getMission(id)!
  audit(
    before.initiativeId,
    "mission",
    id,
    "update",
    before,
    after,
    actor,
    reason
  )
  touch(before.initiativeId)
  return getInitiativeGraph(before.initiativeId)!
}
export function deleteMission(
  id: string,
  actor = "user",
  reason?: string
): InitiativeGraph {
  const before = getMission(id)
  if (!before) throw new Error(`Mission not found: ${id}`)
  assertNoRunningPlaybook(
    "mission_id = ? OR slice_id IN (SELECT id FROM slices WHERE mission_id = ?)",
    id,
    id
  )
  getDb().prepare("DELETE FROM missions WHERE id = ?").run(id)
  audit(
    before.initiativeId,
    "mission",
    id,
    "delete",
    before,
    null,
    actor,
    reason
  )
  touch(before.initiativeId)
  return getInitiativeGraph(before.initiativeId)!
}

export function createSlice(input: {
  missionId: string
  key: string
  title: string
  spec?: Partial<SliceSpec>
  podKey?: string | null
}): InitiativeGraph {
  const id = randomUUID()
  const initiativeId = initiativeIdForMission(input.missionId)
  const position = (
    getDb()
      .prepare(
        "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM slices WHERE mission_id = ?"
      )
      .get(input.missionId) as { position: number }
  ).position
  getDb()
    .prepare(
      "INSERT INTO slices (id, mission_id, key, title, spec, pod_key, status, position) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)"
    )
    .run(
      id,
      input.missionId,
      freeKey(workKey(input.key, "Slice key"), (key) =>
        exists(
          "SELECT 1 FROM slices WHERE mission_id = ? AND key = ?",
          input.missionId,
          key
        )
      ),
      text(input.title, "Slice title"),
      JSON.stringify(spec(input.spec)),
      input.podKey ?? null,
      position
    )
  audit(initiativeId, "slice", id, "create", null, getSlice(id))
  touch(initiativeId)
  return getInitiativeGraph(initiativeId)!
}
export function updateSlice(
  id: string,
  patch: Partial<
    Pick<
      WorkSlice,
      "key" | "title" | "spec" | "podKey" | "position" | "playbookId"
    >
  >,
  actor = "user",
  reason?: string
): InitiativeGraph {
  const before = getSlice(id)
  if (!before) throw new Error(`Slice not found: ${id}`)
  if (before.startedAt && patch.spec)
    throw new Error(
      "A started slice spec can only be revised by the execution workflow."
    )
  const sets: string[] = []
  const values: unknown[] = []
  const add = (c: string, v: unknown) => {
    sets.push(`${c} = ?`)
    values.push(v)
  }
  if (patch.key !== undefined) {
    const key = workKey(patch.key, "Slice key")
    assertKeyFree(
      exists(
        "SELECT 1 FROM slices WHERE mission_id = ? AND key = ? AND id != ?",
        before.missionId,
        key,
        id
      ),
      "Slice key",
      key
    )
    add("key", key)
  }
  if (patch.title !== undefined) add("title", text(patch.title, "Slice title"))
  if (patch.spec !== undefined) add("spec", JSON.stringify(spec(patch.spec)))
  if (patch.podKey !== undefined) add("pod_key", patch.podKey)
  if (patch.position !== undefined) add("position", patch.position)
  if (patch.playbookId !== undefined)
    add("playbook_id", playbookRef(patch.playbookId, "slice"))
  if (sets.length) {
    values.push(id)
    getDb()
      .prepare(`UPDATE slices SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values)
  }
  const initiativeId = initiativeIdForMission(before.missionId)
  const after = getSlice(id)!
  audit(initiativeId, "slice", id, "update", before, after, actor, reason)
  touch(initiativeId)
  return getInitiativeGraph(initiativeId)!
}
export function deleteSlice(
  id: string,
  actor = "user",
  reason?: string
): InitiativeGraph {
  const before = getSlice(id)
  if (!before) throw new Error(`Slice not found: ${id}`)
  assertNoRunningPlaybook("slice_id = ?", id)
  const initiativeId = initiativeIdForMission(before.missionId)
  getDb().prepare("DELETE FROM slices WHERE id = ?").run(id)
  audit(initiativeId, "slice", id, "delete", before, null, actor, reason)
  touch(initiativeId)
  return getInitiativeGraph(initiativeId)!
}
export function setSliceEdges(
  missionId: string,
  edges: Array<{ fromSliceId: string; toSliceId: string }>,
  actor = "user",
  reason?: string
): InitiativeGraph {
  const slices = listSlices(missionId)
  const ids = new Set(slices.map((slice) => slice.id))
  const unique = new Set<string>()
  for (const edge of edges) {
    if (edge.fromSliceId === edge.toSliceId)
      throw new Error("A slice cannot depend on itself.")
    if (!ids.has(edge.fromSliceId) || !ids.has(edge.toSliceId))
      throw new Error("Slice dependencies must stay within one mission.")
    const key = `${edge.fromSliceId}:${edge.toSliceId}`
    if (unique.has(key))
      throw new Error("Duplicate slice dependencies are not allowed.")
    unique.add(key)
  }
  const cycle = findCycle(slices, edges)
  if (cycle) {
    const labels = new Map(slices.map((slice) => [slice.id, slice.key]))
    throw new Error(
      `Slice dependencies must be acyclic: ${cycle.map((id) => labels.get(id) ?? id).join(" → ")}`
    )
  }
  const before = listEdges(missionId)
  getDb().transaction(() => {
    getDb()
      .prepare("DELETE FROM slice_edges WHERE mission_id = ?")
      .run(missionId)
    const insert = getDb().prepare(
      "INSERT INTO slice_edges (id, mission_id, from_slice_id, to_slice_id) VALUES (?, ?, ?, ?)"
    )
    for (const edge of edges)
      insert.run(randomUUID(), missionId, edge.fromSliceId, edge.toSliceId)
  })()
  const initiativeId = initiativeIdForMission(missionId)
  const after = listEdges(missionId)
  audit(
    initiativeId,
    "edge",
    missionId,
    "replace",
    before,
    after,
    actor,
    reason
  )
  touch(initiativeId)
  return getInitiativeGraph(initiativeId)!
}

// Execution-owned slice state (plan 106.3). Only the slice runner writes these
// fields; the status moves along a legal transition path and every change is
// audited as a system actor so the revision log explains what the run did.
export function setSliceExecution(
  id: string,
  patch: {
    status?: WorkSlice["status"]
    processRunId?: string | null
    attempts?: number
    proof?: unknown | null
    startedAt?: number | null
    finishedAt?: number | null
  },
  reason: string,
  actor = "mission-control"
): WorkSlice {
  const before = getSlice(id)
  if (!before) throw new Error(`Slice not found: ${id}`)
  if (patch.status !== undefined && patch.status !== before.status) {
    const path = sliceStatusPath(before.status, patch.status)
    if (!path)
      throw new Error(
        `Invalid status transition: ${before.status} → ${patch.status}`
      )
  }
  const sets: string[] = []
  const values: unknown[] = []
  const add = (c: string, v: unknown) => {
    sets.push(`${c} = ?`)
    values.push(v)
  }
  if (patch.status !== undefined) add("status", patch.status)
  if (patch.processRunId !== undefined)
    add("process_run_id", patch.processRunId)
  if (patch.attempts !== undefined) add("attempts", patch.attempts)
  if (patch.proof !== undefined)
    add("proof", patch.proof === null ? null : JSON.stringify(patch.proof))
  if (patch.startedAt !== undefined) add("started_at", patch.startedAt)
  if (patch.finishedAt !== undefined) add("finished_at", patch.finishedAt)
  if (!sets.length) return before
  values.push(id)
  getDb()
    .prepare(`UPDATE slices SET ${sets.join(", ")} WHERE id = ?`)
    .run(...values)
  const after = getSlice(id)!
  const initiativeId = initiativeIdForMission(before.missionId)
  audit(initiativeId, "slice", id, "execute", before, after, actor, reason)
  touch(initiativeId)
  return after
}

// Move a mission to a status along a legal path (execution-owned, audited).
export function setMissionExecutionStatus(
  id: string,
  status: Mission["status"],
  reason: string,
  actor = "mission-control"
): Mission {
  const before = getMission(id)
  if (!before) throw new Error(`Mission not found: ${id}`)
  if (before.status === status) return before
  transitionMissionStatus(before.status, status)
  const now = Date.now()
  getDb()
    .prepare(
      "UPDATE missions SET status = ?, started_at = COALESCE(started_at, ?), finished_at = ? WHERE id = ?"
    )
    .run(
      status,
      status === "active" ? now : null,
      ["completed", "cancelled", "failed"].includes(status) ? now : null,
      id
    )
  const after = getMission(id)!
  audit(before.initiativeId, "mission", id, "execute", before, after, actor, reason)
  touch(before.initiativeId)
  return after
}

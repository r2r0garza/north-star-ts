import { randomUUID } from "crypto"
import { isRigKey } from "../../../shared/mission-control/address"
import { findCycle } from "../../../shared/mission-control/waves"
import { getDb } from "../connection"
import type {
  DriveMode,
  Feature,
  FeatureDrive,
  FeatureGraph,
  MergePolicyMode,
  Milestone,
  MilestoneDodReview,
  MilestoneLanding,
  RigGraph,
  UserStoryEdge,
  UserStorySpec,
  WorkRevision,
  UserStory,
} from "../types"
import { getRigGraph } from "./rigs"
import {
  milestoneStatusPath,
  userStoryStatusPath,
  transitionMilestoneStatus,
} from "../../mission-control/work-state"
import { emitWorkChanged } from "../../mission-control/work-events"
import { normalizeStory } from "../../../shared/mission-control/story"

interface FeatureRow {
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
  drive_mode: Feature["driveMode"]
  budgets: string
  drive: string | null
  status: Feature["status"]
  task_id: string | null
  created_at: number
  updated_at: number
  started_at: number | null
  finished_at: number | null
}
interface MilestoneRow {
  id: string
  feature_id: string
  key: string
  name: string
  outcome: string
  definition_of_done: string
  playbook_id: string | null
  merge_policy: string
  integration_branch: string | null
  base_ref: string | null
  base_oid: string | null
  repo_root: string | null
  landing: string | null
  dod_review: string | null
  status: Milestone["status"]
  position: number
  started_at: number | null
  finished_at: number | null
}
interface UserStoryRow {
  id: string
  milestone_id: string
  key: string
  title: string
  spec: string
  proof: string | null
  pod_key: string | null
  playbook_id: string | null
  status: UserStory["status"]
  process_run_id: string | null
  branch: string | null
  worktree_path: string | null
  base_oid: string | null
  attempts: number
  origin: UserStory["origin"]
  position: number
  started_at: number | null
  finished_at: number | null
}
interface EdgeRow {
  id: string
  milestone_id: string
  from_user_story_id: string
  to_user_story_id: string
}
interface RevisionRow {
  id: string
  feature_id: string
  target_kind: WorkRevision["targetKind"]
  target_id: string
  actor: string
  change: string
  reason: string | null
  created_at: number
}

const EMPTY_SPEC: UserStorySpec = {
  story: null,
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
function spec(value?: Partial<UserStorySpec>): UserStorySpec {
  return {
    story: normalizeStory(value?.story),
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
export const DEFAULT_DRIVE: FeatureDrive = {
  autoApplyPlan: false,
  overlapPolicy: "wait",
  activeMs: 0,
  accountedAt: null,
  pauseReason: null,
  pausedBy: null,
}
function drive(value: string | null): FeatureDrive {
  const parsed = parse<Partial<FeatureDrive>>(value, {})
  return {
    autoApplyPlan: parsed.autoApplyPlan === true,
    overlapPolicy: parsed.overlapPolicy === "parallel" ? "parallel" : "wait",
    activeMs:
      typeof parsed.activeMs === "number" && parsed.activeMs >= 0
        ? parsed.activeMs
        : 0,
    accountedAt:
      typeof parsed.accountedAt === "number" ? parsed.accountedAt : null,
    pauseReason:
      typeof parsed.pauseReason === "string" ? parsed.pauseReason : null,
    pausedBy:
      parsed.pausedBy === "user" || parsed.pausedBy === "budget"
        ? parsed.pausedBy
        : null,
  }
}
function toFeature(row: FeatureRow): Feature {
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
    drive: drive(row.drive),
    status: row.status,
    taskId: row.task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}
const MERGE_POLICY_MODES: readonly MergePolicyMode[] = [
  "manual",
  "local_merge",
  "open_pr",
]
function mergePolicy(value: string): Milestone["mergePolicy"] {
  const mode = parse<{ mode?: string }>(value, {}).mode
  return {
    mode: MERGE_POLICY_MODES.includes(mode as MergePolicyMode)
      ? (mode as MergePolicyMode)
      : "manual",
  }
}
function toMilestone(row: MilestoneRow): Milestone {
  return {
    id: row.id,
    featureId: row.feature_id,
    key: row.key,
    name: row.name,
    outcome: row.outcome,
    definitionOfDone: row.definition_of_done,
    playbookId: row.playbook_id,
    mergePolicy: mergePolicy(row.merge_policy),
    integrationBranch: row.integration_branch,
    baseRef: row.base_ref,
    baseOid: row.base_oid,
    repoRoot: row.repo_root,
    landing: parse<MilestoneLanding | null>(row.landing, null),
    dodReview: parse<MilestoneDodReview | null>(row.dod_review, null),
    status: row.status,
    position: row.position,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}
function toUserStory(row: UserStoryRow): UserStory {
  return {
    id: row.id,
    milestoneId: row.milestone_id,
    key: row.key,
    title: row.title,
    spec: spec(parse(row.spec, EMPTY_SPEC)),
    proof: parse<unknown | null>(row.proof, null),
    podKey: row.pod_key,
    playbookId: row.playbook_id,
    status: row.status,
    processRunId: row.process_run_id,
    branch: row.branch,
    worktreePath: row.worktree_path,
    baseOid: row.base_oid,
    attempts: row.attempts,
    origin: row.origin,
    position: row.position,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}
function toEdge(row: EdgeRow): UserStoryEdge {
  return {
    id: row.id,
    milestoneId: row.milestone_id,
    fromUserStoryId: row.from_user_story_id,
    toUserStoryId: row.to_user_story_id,
  }
}
function toRevision(row: RevisionRow): WorkRevision {
  return {
    id: row.id,
    featureId: row.feature_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    actor: row.actor,
    change: parse(row.change, { op: "unknown" }),
    reason: row.reason,
    createdAt: row.created_at,
  }
}

export function getFeature(id: string): Feature | null {
  const row = getDb().prepare("SELECT * FROM features WHERE id = ?").get(id) as
    | FeatureRow
    | undefined
  return row ? toFeature(row) : null
}
export function listFeatures(): Feature[] {
  return (
    getDb()
      .prepare("SELECT * FROM features ORDER BY updated_at DESC")
      .all() as FeatureRow[]
  ).map(toFeature)
}
export function listMilestones(featureId: string): Milestone[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM milestones WHERE feature_id = ? ORDER BY position, id"
      )
      .all(featureId) as MilestoneRow[]
  ).map(toMilestone)
}
export function getMilestone(id: string): Milestone | null {
  const row = getDb()
    .prepare("SELECT * FROM milestones WHERE id = ?")
    .get(id) as MilestoneRow | undefined
  return row ? toMilestone(row) : null
}
export function listUserStories(milestoneId: string): UserStory[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM user_stories WHERE milestone_id = ? ORDER BY position, id"
      )
      .all(milestoneId) as UserStoryRow[]
  ).map(toUserStory)
}
export function getUserStory(id: string): UserStory | null {
  const row = getDb()
    .prepare("SELECT * FROM user_stories WHERE id = ?")
    .get(id) as UserStoryRow | undefined
  return row ? toUserStory(row) : null
}
export function listEdges(milestoneId: string): UserStoryEdge[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM user_story_edges WHERE milestone_id = ? ORDER BY id"
      )
      .all(milestoneId) as EdgeRow[]
  ).map(toEdge)
}
export function listRevisions(featureId: string): WorkRevision[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM work_revisions WHERE feature_id = ? ORDER BY created_at DESC, id DESC"
      )
      .all(featureId) as RevisionRow[]
  ).map(toRevision)
}
function featureIdForMilestone(milestoneId: string): string {
  const milestone = getMilestone(milestoneId)
  if (!milestone) throw new Error(`Milestone not found: ${milestoneId}`)
  return milestone.featureId
}
function touch(featureId: string): void {
  getDb()
    .prepare("UPDATE features SET updated_at = ? WHERE id = ?")
    .run(Date.now(), featureId)
  emitWorkChanged(featureId)
}
// A container's playbook must exist and match its altitude; null clears the
// choice so the run falls back to the default playbook for that altitude.
function playbookRef(
  value: string | null,
  altitude: "feature" | "milestone" | "user_story"
): string | null {
  if (value === null) return null
  const row = getDb()
    .prepare("SELECT altitude FROM playbooks WHERE id = ?")
    .get(value) as { altitude: string } | undefined
  if (!row) throw new Error(`Playbook not found: ${value}`)
  if (row.altitude !== altitude)
    throw new Error(
      `A ${row.altitude.replace("_", " ")} playbook can't be used for a ${altitude.replace("_", " ")}.`
    )
  return value
}

// Deleting work cascades its playbook_runs rows, which would orphan a live
// Process run and lose the user story outcome, so running work must be cancelled first.
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
  featureId: string,
  targetKind: WorkRevision["targetKind"],
  targetId: string,
  op: string,
  before: unknown,
  after: unknown,
  actor = "user",
  reason?: string | null
): void {
  const feature = getFeature(featureId)
  if (!feature || feature.status === "draft") return
  getDb()
    .prepare(
      "INSERT INTO work_revisions (id, feature_id, target_kind, target_id, actor, change, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      randomUUID(),
      featureId,
      targetKind,
      targetId,
      actor,
      JSON.stringify({ op, before, after }),
      reason?.trim() || "User-authored structural change",
      Date.now()
    )
}
function currentRigSnapshot(feature: Feature): RigGraph | null {
  return feature.rigId ? getRigGraph(feature.rigId) : null
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
export function getFeatureGraph(id: string): FeatureGraph | null {
  const feature = getFeature(id)
  if (!feature) return null
  const milestones = listMilestones(id)
  const userStories = milestones.flatMap((milestone) =>
    listUserStories(milestone.id)
  )
  const edges = milestones.flatMap((milestone) => listEdges(milestone.id))
  const current = currentRigSnapshot(feature)
  return {
    feature,
    milestones,
    userStories,
    edges,
    revisions: listRevisions(id),
    // A deleted rig isn't drift: there is nothing to re-seat from, and the
    // feature keeps running on its snapshot.
    rigDrifted: Boolean(
      feature.rigSnapshot &&
      current &&
      snapshotComparable(feature.rigSnapshot) !== snapshotComparable(current)
    ),
  }
}

export function createFeature(input: {
  key: string
  name: string
  intent: string
  definitionOfDone: string
  rigId?: string | null
  workspaceId?: string | null
  projectId?: string | null
  defaultPodKey?: string | null
}): FeatureGraph {
  const id = randomUUID()
  const now = Date.now()
  getDb().transaction(() => {
    getDb()
      .prepare(
        "INSERT INTO features (id, key, name, intent, definition_of_done, rig_id, workspace_id, project_id, default_pod_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)"
      )
      .run(
        id,
        freeKey(workKey(input.key, "Feature key"), (key) =>
          exists("SELECT 1 FROM features WHERE key = ?", key)
        ),
        text(input.name, "Feature name"),
        input.intent,
        input.definitionOfDone,
        input.rigId ?? null,
        input.workspaceId ?? null,
        input.projectId ?? null,
        input.defaultPodKey ?? null,
        now,
        now
      )
    createMilestone({
      featureId: id,
      key: "milestone-1",
      name: "First milestone",
      outcome: "",
    })
  })()
  return getFeatureGraph(id)!
}
export function updateFeature(
  id: string,
  patch: Partial<
    Pick<
      Feature,
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
): FeatureGraph {
  const before = getFeature(id)
  if (!before) throw new Error(`Feature not found: ${id}`)
  // Running work resolves the workspace live and seats come from the rig
  // snapshot taken at start, so the binding is frozen once started. The
  // project is only an organizing label, so it stays editable in any status.
  if (
    before.status !== "draft" &&
    ((patch.rigId !== undefined && patch.rigId !== before.rigId) ||
      (patch.workspaceId !== undefined &&
        patch.workspaceId !== before.workspaceId))
  )
    throw new Error(
      "The rig and workspace can't be changed after a feature has started."
    )
  const sets: string[] = []
  const values: unknown[] = []
  const add = (column: string, value: unknown) => {
    sets.push(`${column} = ?`)
    values.push(value)
  }
  if (patch.key !== undefined) {
    const key = workKey(patch.key, "Feature key")
    assertKeyFree(
      exists("SELECT 1 FROM features WHERE key = ? AND id != ?", key, id),
      "Feature key",
      key
    )
    add("key", key)
  }
  if (patch.name !== undefined) add("name", text(patch.name, "Feature name"))
  if (patch.intent !== undefined) add("intent", patch.intent)
  if (patch.definitionOfDone !== undefined)
    add("definition_of_done", patch.definitionOfDone)
  if (patch.rigId !== undefined) add("rig_id", patch.rigId)
  if (patch.workspaceId !== undefined) add("workspace_id", patch.workspaceId)
  if (patch.projectId !== undefined) add("project_id", patch.projectId)
  if (patch.defaultPodKey !== undefined)
    add("default_pod_key", patch.defaultPodKey)
  if (patch.playbookId !== undefined)
    add("playbook_id", playbookRef(patch.playbookId, "feature"))
  if (sets.length) {
    add("updated_at", Date.now())
    values.push(id)
    getDb()
      .prepare(`UPDATE features SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values)
  }
  const after = getFeature(id)!
  audit(id, "feature", id, "update", before, after, actor, reason)
  return getFeatureGraph(id)!
}
export function deleteFeature(id: string): void {
  assertNoRunningPlaybook("feature_id = ?", id)
  getDb().prepare("DELETE FROM features WHERE id = ?").run(id)
}
export function startFeature(id: string): FeatureGraph {
  const feature = getFeature(id)
  if (!feature) throw new Error(`Feature not found: ${id}`)
  if (feature.status !== "draft")
    throw new Error("Only a draft feature can be started.")
  const snapshot = currentRigSnapshot(feature)
  if (!snapshot)
    throw new Error("Choose an available rig before starting the feature.")
  const now = Date.now()
  getDb()
    .prepare(
      "UPDATE features SET rig_snapshot = ?, status = 'active', started_at = ?, updated_at = ? WHERE id = ?"
    )
    .run(JSON.stringify(snapshot), now, now, id)
  emitWorkChanged(id)
  return getFeatureGraph(id)!
}
export function reseatFeature(id: string, reason?: string): FeatureGraph {
  const before = getFeature(id)
  if (!before) throw new Error(`Feature not found: ${id}`)
  const snapshot = currentRigSnapshot(before)
  if (!snapshot) throw new Error("The feature's rig is no longer available.")
  getDb()
    .prepare(
      "UPDATE features SET rig_snapshot = ?, updated_at = ? WHERE id = ?"
    )
    .run(JSON.stringify(snapshot), Date.now(), id)
  audit(
    id,
    "feature",
    id,
    "reseat",
    before.rigSnapshot,
    snapshot,
    "user",
    reason
  )
  return getFeatureGraph(id)!
}

export function createMilestone(input: {
  featureId: string
  key: string
  name: string
  outcome: string
  definitionOfDone?: string
}): FeatureGraph {
  const id = randomUUID()
  const position = (
    getDb()
      .prepare(
        "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM milestones WHERE feature_id = ?"
      )
      .get(input.featureId) as { position: number }
  ).position
  const feature = getFeature(input.featureId)
  if (feature && ["completed", "cancelled"].includes(feature.status))
    throw new Error(
      feature.status === "completed"
        ? "This feature is completed. Reopen it to add milestones."
        : "This feature was cancelled, so its plan can't change."
    )
  // Autopilot milestones land by an approved local merge by default (106.6);
  // the user can still switch any milestone back to manual.
  const autopilot = feature?.driveMode === "autopilot"
  getDb()
    .prepare(
      "INSERT INTO milestones (id, feature_id, key, name, outcome, definition_of_done, merge_policy, status, position) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?)"
    )
    .run(
      id,
      input.featureId,
      freeKey(workKey(input.key, "Milestone key"), (key) =>
        exists(
          "SELECT 1 FROM milestones WHERE feature_id = ? AND key = ?",
          input.featureId,
          key
        )
      ),
      text(input.name, "Milestone name"),
      input.outcome,
      input.definitionOfDone ?? "",
      JSON.stringify({ mode: autopilot ? "local_merge" : "manual" }),
      position
    )
  audit(input.featureId, "milestone", id, "create", null, getMilestone(id))
  touch(input.featureId)
  return getFeatureGraph(input.featureId)!
}
export function updateMilestone(
  id: string,
  patch: Partial<
    Pick<
      Milestone,
      | "key"
      | "name"
      | "outcome"
      | "definitionOfDone"
      | "position"
      | "playbookId"
    >
  >,
  actor = "user",
  reason?: string
): FeatureGraph {
  const before = getMilestone(id)
  if (!before) throw new Error(`Milestone not found: ${id}`)
  const sets: string[] = []
  const values: unknown[] = []
  const add = (c: string, v: unknown) => {
    sets.push(`${c} = ?`)
    values.push(v)
  }
  if (patch.key !== undefined) {
    const key = workKey(patch.key, "Milestone key")
    assertKeyFree(
      exists(
        "SELECT 1 FROM milestones WHERE feature_id = ? AND key = ? AND id != ?",
        before.featureId,
        key,
        id
      ),
      "Milestone key",
      key
    )
    add("key", key)
  }
  if (patch.name !== undefined) add("name", text(patch.name, "Milestone name"))
  if (patch.outcome !== undefined) add("outcome", patch.outcome)
  if (patch.definitionOfDone !== undefined)
    add("definition_of_done", patch.definitionOfDone)
  if (patch.position !== undefined) add("position", patch.position)
  if (patch.playbookId !== undefined)
    add("playbook_id", playbookRef(patch.playbookId, "milestone"))
  if (sets.length) {
    values.push(id)
    getDb()
      .prepare(`UPDATE milestones SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values)
  }
  const after = getMilestone(id)!
  audit(
    before.featureId,
    "milestone",
    id,
    "update",
    before,
    after,
    actor,
    reason
  )
  touch(before.featureId)
  return getFeatureGraph(before.featureId)!
}
export function deleteMilestone(
  id: string,
  actor = "user",
  reason?: string
): FeatureGraph {
  const before = getMilestone(id)
  if (!before) throw new Error(`Milestone not found: ${id}`)
  assertNoRunningPlaybook(
    "milestone_id = ? OR user_story_id IN (SELECT id FROM user_stories WHERE milestone_id = ?)",
    id,
    id
  )
  getDb().prepare("DELETE FROM milestones WHERE id = ?").run(id)
  audit(
    before.featureId,
    "milestone",
    id,
    "delete",
    before,
    null,
    actor,
    reason
  )
  touch(before.featureId)
  return getFeatureGraph(before.featureId)!
}

export function createUserStory(
  input: Parameters<typeof addUserStory>[0]
): FeatureGraph {
  const userStory = addUserStory(input)
  return getFeatureGraph(featureIdForMilestone(userStory.milestoneId))!
}
// Insert one user story and return it (plan edits need the new id).
export function addUserStory(input: {
  milestoneId: string
  key: string
  title: string
  spec?: Partial<UserStorySpec>
  podKey?: string | null
  // User stories a seat added (plan 106.6) carry origin 'agent' and its address.
  origin?: UserStory["origin"]
  actor?: string
  reason?: string
}): UserStory {
  const id = randomUUID()
  const featureId = featureIdForMilestone(input.milestoneId)
  const status = getFeature(featureId)?.status
  if (status === "completed" || status === "cancelled")
    throw new Error(
      status === "completed"
        ? "This feature is completed. Reopen it to add work."
        : "This feature was cancelled, so its plan can't change."
    )
  const position = (
    getDb()
      .prepare(
        "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM user_stories WHERE milestone_id = ?"
      )
      .get(input.milestoneId) as { position: number }
  ).position
  getDb()
    .prepare(
      "INSERT INTO user_stories (id, milestone_id, key, title, spec, pod_key, status, origin, position) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)"
    )
    .run(
      id,
      input.milestoneId,
      freeKey(workKey(input.key, "User story key"), (key) =>
        exists(
          "SELECT 1 FROM user_stories WHERE milestone_id = ? AND key = ?",
          input.milestoneId,
          key
        )
      ),
      text(input.title, "User story title"),
      JSON.stringify(spec(input.spec)),
      input.podKey ?? null,
      input.origin ?? "user",
      position
    )
  audit(
    featureId,
    "user_story",
    id,
    "create",
    null,
    getUserStory(id),
    input.actor,
    input.reason
  )
  touch(featureId)
  return getUserStory(id)!
}
export function updateUserStory(
  id: string,
  patch: Partial<
    Pick<
      UserStory,
      "key" | "title" | "spec" | "podKey" | "position" | "playbookId"
    >
  >,
  actor = "user",
  reason?: string
): FeatureGraph {
  const before = getUserStory(id)
  if (!before) throw new Error(`User story not found: ${id}`)
  if (before.startedAt && patch.spec)
    throw new Error(
      "A started user story spec can only be revised by the execution workflow."
    )
  const sets: string[] = []
  const values: unknown[] = []
  const add = (c: string, v: unknown) => {
    sets.push(`${c} = ?`)
    values.push(v)
  }
  if (patch.key !== undefined) {
    const key = workKey(patch.key, "User story key")
    assertKeyFree(
      exists(
        "SELECT 1 FROM user_stories WHERE milestone_id = ? AND key = ? AND id != ?",
        before.milestoneId,
        key,
        id
      ),
      "User story key",
      key
    )
    add("key", key)
  }
  if (patch.title !== undefined)
    add("title", text(patch.title, "User story title"))
  if (patch.spec !== undefined) add("spec", JSON.stringify(spec(patch.spec)))
  if (patch.podKey !== undefined) add("pod_key", patch.podKey)
  if (patch.position !== undefined) add("position", patch.position)
  if (patch.playbookId !== undefined)
    add("playbook_id", playbookRef(patch.playbookId, "user_story"))
  if (sets.length) {
    values.push(id)
    getDb()
      .prepare(`UPDATE user_stories SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values)
  }
  const featureId = featureIdForMilestone(before.milestoneId)
  const after = getUserStory(id)!
  audit(featureId, "user_story", id, "update", before, after, actor, reason)
  touch(featureId)
  return getFeatureGraph(featureId)!
}
export function deleteUserStory(
  id: string,
  actor = "user",
  reason?: string
): FeatureGraph {
  const before = getUserStory(id)
  if (!before) throw new Error(`User story not found: ${id}`)
  assertNoRunningPlaybook("user_story_id = ?", id)
  const featureId = featureIdForMilestone(before.milestoneId)
  getDb().prepare("DELETE FROM user_stories WHERE id = ?").run(id)
  audit(featureId, "user_story", id, "delete", before, null, actor, reason)
  touch(featureId)
  return getFeatureGraph(featureId)!
}
export function setUserStoryEdges(
  milestoneId: string,
  edges: Array<{ fromUserStoryId: string; toUserStoryId: string }>,
  actor = "user",
  reason?: string
): FeatureGraph {
  const userStories = listUserStories(milestoneId)
  const ids = new Set(userStories.map((userStory) => userStory.id))
  const unique = new Set<string>()
  for (const edge of edges) {
    if (edge.fromUserStoryId === edge.toUserStoryId)
      throw new Error("A user story cannot depend on itself.")
    if (!ids.has(edge.fromUserStoryId) || !ids.has(edge.toUserStoryId))
      throw new Error("User story dependencies must stay within one milestone.")
    const key = `${edge.fromUserStoryId}:${edge.toUserStoryId}`
    if (unique.has(key))
      throw new Error("Duplicate user story dependencies are not allowed.")
    unique.add(key)
  }
  const cycle = findCycle(userStories, edges)
  if (cycle) {
    const labels = new Map(
      userStories.map((userStory) => [userStory.id, userStory.key])
    )
    throw new Error(
      `User story dependencies must be acyclic: ${cycle.map((id) => labels.get(id) ?? id).join(" → ")}`
    )
  }
  const before = listEdges(milestoneId)
  getDb().transaction(() => {
    getDb()
      .prepare("DELETE FROM user_story_edges WHERE milestone_id = ?")
      .run(milestoneId)
    const insert = getDb().prepare(
      "INSERT INTO user_story_edges (id, milestone_id, from_user_story_id, to_user_story_id) VALUES (?, ?, ?, ?)"
    )
    for (const edge of edges)
      insert.run(
        randomUUID(),
        milestoneId,
        edge.fromUserStoryId,
        edge.toUserStoryId
      )
  })()
  const featureId = featureIdForMilestone(milestoneId)
  const after = listEdges(milestoneId)
  audit(featureId, "edge", milestoneId, "replace", before, after, actor, reason)
  touch(featureId)
  return getFeatureGraph(featureId)!
}

// Execution-owned user story state (plan 106.3). Only the user story runner writes these
// fields; the status moves along a legal transition path and every change is
// audited as a system actor so the revision log explains what the run did.
export function setUserStoryExecution(
  id: string,
  patch: {
    status?: UserStory["status"]
    processRunId?: string | null
    branch?: string | null
    worktreePath?: string | null
    baseOid?: string | null
    attempts?: number
    proof?: unknown | null
    startedAt?: number | null
    finishedAt?: number | null
  },
  reason: string,
  actor = "mission-control"
): UserStory {
  const before = getUserStory(id)
  if (!before) throw new Error(`User story not found: ${id}`)
  if (patch.status !== undefined && patch.status !== before.status) {
    const path = userStoryStatusPath(before.status, patch.status)
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
  if (patch.branch !== undefined) add("branch", patch.branch)
  if (patch.worktreePath !== undefined) add("worktree_path", patch.worktreePath)
  if (patch.baseOid !== undefined) add("base_oid", patch.baseOid)
  if (patch.attempts !== undefined) add("attempts", patch.attempts)
  if (patch.proof !== undefined)
    add("proof", patch.proof === null ? null : JSON.stringify(patch.proof))
  if (patch.startedAt !== undefined) add("started_at", patch.startedAt)
  if (patch.finishedAt !== undefined) add("finished_at", patch.finishedAt)
  if (!sets.length) return before
  values.push(id)
  getDb()
    .prepare(`UPDATE user_stories SET ${sets.join(", ")} WHERE id = ?`)
    .run(...values)
  const after = getUserStory(id)!
  const featureId = featureIdForMilestone(before.milestoneId)
  audit(featureId, "user_story", id, "execute", before, after, actor, reason)
  touch(featureId)
  return after
}

// Move a milestone to a status along a legal path (execution-owned, audited).
export function setMilestoneExecutionStatus(
  id: string,
  status: Milestone["status"],
  reason: string,
  actor = "mission-control"
): Milestone {
  const before = getMilestone(id)
  if (!before) throw new Error(`Milestone not found: ${id}`)
  if (before.status === status) return before
  transitionMilestoneStatus(before.status, status)
  const now = Date.now()
  getDb()
    .prepare(
      "UPDATE milestones SET status = ?, started_at = COALESCE(started_at, ?), finished_at = ? WHERE id = ?"
    )
    .run(
      status,
      status === "active" ? now : null,
      ["completed", "cancelled", "failed"].includes(status) ? now : null,
      id
    )
  const after = getMilestone(id)!
  audit(
    before.featureId,
    "milestone",
    id,
    "execute",
    before,
    after,
    actor,
    reason
  )
  touch(before.featureId)
  return after
}

// ── milestone integration (plan 106.5) ────────────────────────────────────────

// The merge policy is chosen before the milestone starts. Once it has an
// integration branch the only change allowed is back to manual, so an approval
// the user expects can never be skipped by a policy switch mid-milestone.
export function setMilestoneMergePolicy(
  id: string,
  mode: MergePolicyMode,
  actor = "user"
): FeatureGraph {
  const before = getMilestone(id)
  if (!before) throw new Error(`Milestone not found: ${id}`)
  if (!MERGE_POLICY_MODES.includes(mode))
    throw new Error(`Unknown merge policy: ${mode}`)
  if (before.mergePolicy.mode === mode)
    return getFeatureGraph(before.featureId)!
  if (["completed", "cancelled"].includes(before.status))
    throw new Error("A finished milestone's merge policy can't change.")
  if (
    (before.integrationBranch || before.status !== "planned") &&
    mode !== "manual"
  )
    throw new Error(
      "The merge policy is locked once the milestone starts. It can only change to manual."
    )
  getDb()
    .prepare("UPDATE milestones SET merge_policy = ? WHERE id = ?")
    .run(JSON.stringify({ mode }), id)
  audit(
    before.featureId,
    "milestone",
    id,
    "merge_policy",
    before.mergePolicy,
    { mode },
    actor,
    `Merge policy set to ${mode.replace(/_/g, " ")}`
  )
  touch(before.featureId)
  return getFeatureGraph(before.featureId)!
}

// Record the integration branch a milestone's user stories merge into (execution-owned).
export function setMilestoneIntegration(
  id: string,
  input: {
    integrationBranch: string
    baseRef: string
    baseOid: string
    repoRoot: string
  },
  actor = "mission-control"
): Milestone {
  const before = getMilestone(id)
  if (!before) throw new Error(`Milestone not found: ${id}`)
  getDb()
    .prepare(
      "UPDATE milestones SET integration_branch = ?, base_ref = ?, base_oid = ?, repo_root = ? WHERE id = ?"
    )
    .run(
      input.integrationBranch,
      input.baseRef,
      input.baseOid,
      input.repoRoot,
      id
    )
  const after = getMilestone(id)!
  audit(
    before.featureId,
    "milestone",
    id,
    "integration",
    null,
    input,
    actor,
    `Integration branch ${input.integrationBranch} created from ${input.baseRef}`
  )
  touch(before.featureId)
  return after
}

export function setMilestoneLanding(
  id: string,
  landing: MilestoneLanding
): Milestone {
  const before = getMilestone(id)
  if (!before) throw new Error(`Milestone not found: ${id}`)
  getDb()
    .prepare("UPDATE milestones SET landing = ? WHERE id = ?")
    .run(JSON.stringify(landing), id)
  emitWorkChanged(before.featureId)
  return getMilestone(id)!
}

// Walk a milestone to a status one legal hop at a time (execution-owned).
export function advanceMilestoneStatus(
  id: string,
  target: Milestone["status"],
  reason: string,
  actor = "mission-control"
): Milestone {
  const milestone = getMilestone(id)
  if (!milestone) throw new Error(`Milestone not found: ${id}`)
  const path = milestoneStatusPath(milestone.status, target)
  if (!path)
    throw new Error(
      `Invalid status transition: ${milestone.status} → ${target}`
    )
  let current = milestone
  for (const status of path)
    current = setMilestoneExecutionStatus(id, status, reason, actor)
  return current
}

// ── drive (plan 106.6) ──────────────────────────────────────────────────────

const DRIVE_MODES: readonly DriveMode[] = ["manual", "copilot", "autopilot"]

export function setFeatureDrive(
  id: string,
  patch: Partial<FeatureDrive>
): Feature {
  const before = getFeature(id)
  if (!before) throw new Error(`Feature not found: ${id}`)
  getDb()
    .prepare("UPDATE features SET drive = ? WHERE id = ?")
    .run(JSON.stringify({ ...before.drive, ...patch }), id)
  return getFeature(id)!
}

// The mode changes only before start or while paused, so a running drive never
// switches policy under in-flight work.
export function setDriveMode(
  id: string,
  mode: DriveMode,
  actor = "user"
): Feature {
  const before = getFeature(id)
  if (!before) throw new Error(`Feature not found: ${id}`)
  if (!DRIVE_MODES.includes(mode))
    throw new Error(`Unknown drive mode: ${mode}`)
  if (before.driveMode === mode) return before
  if (!["draft", "paused"].includes(before.status))
    throw new Error("Pause the feature before changing its drive mode.")
  getDb()
    .prepare("UPDATE features SET drive_mode = ?, updated_at = ? WHERE id = ?")
    .run(mode, Date.now(), id)
  audit(
    id,
    "feature",
    id,
    "drive_mode",
    before.driveMode,
    mode,
    actor,
    `Drive mode set to ${mode}`
  )
  emitWorkChanged(id)
  return getFeature(id)!
}

// Budgets are the user's alone (tools never call this). Only whole,
// non-negative numbers are stored; null removes a key (back to its default).
export function setFeatureBudgets(
  id: string,
  patch: Record<string, number | null>,
  actor = "user"
): Feature {
  const before = getFeature(id)
  if (!before) throw new Error(`Feature not found: ${id}`)
  const next: Record<string, unknown> = { ...before.budgets }
  for (const [key, value] of Object.entries(patch)) {
    if (!/^[a-zA-Z]+$/.test(key)) throw new Error(`Unknown budget: ${key}`)
    if (value === null) delete next[key]
    else if (!Number.isInteger(value) || value < 0)
      throw new Error(`Budget ${key} must be a whole number of 0 or more.`)
    else next[key] = value
  }
  getDb()
    .prepare("UPDATE features SET budgets = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(next), Date.now(), id)
  audit(
    id,
    "feature",
    id,
    "budgets",
    before.budgets,
    next,
    actor,
    "Budgets updated"
  )
  emitWorkChanged(id)
  return getFeature(id)!
}

const FEATURE_TRANSITIONS: Record<Feature["status"], Feature["status"][]> = {
  draft: ["active", "cancelled"],
  active: ["paused", "completed", "cancelled", "failed"],
  paused: ["active", "cancelled"],
  // Reopened for more milestones (the next sprint): it waits paused so the
  // user can add work, check the mode and budgets, then resume.
  completed: ["paused"],
  cancelled: [],
  failed: ["cancelled"],
}

export function setFeatureStatus(
  id: string,
  status: Feature["status"],
  reason: string,
  actor = "user"
): Feature {
  const before = getFeature(id)
  if (!before) throw new Error(`Feature not found: ${id}`)
  if (before.status === status) return before
  if (!FEATURE_TRANSITIONS[before.status].includes(status))
    throw new Error(`A feature can't go from ${before.status} to ${status}.`)
  const now = Date.now()
  getDb()
    .prepare(
      "UPDATE features SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?"
    )
    .run(
      status,
      ["completed", "cancelled", "failed"].includes(status) ? now : null,
      now,
      id
    )
  audit(id, "feature", id, "status", before.status, status, actor, reason)
  emitWorkChanged(id)
  return getFeature(id)!
}

export function setMilestoneDodReview(
  id: string,
  review: MilestoneDodReview | null,
  actor = "user"
): Milestone {
  const before = getMilestone(id)
  if (!before) throw new Error(`Milestone not found: ${id}`)
  getDb()
    .prepare("UPDATE milestones SET dod_review = ? WHERE id = ?")
    .run(review ? JSON.stringify(review) : null, id)
  audit(
    before.featureId,
    "milestone",
    id,
    "dod_review",
    before.dodReview,
    review,
    actor,
    review
      ? `Definition of done judged met: ${review.summary}`
      : "DoD review cleared"
  )
  touch(before.featureId)
  return getMilestone(id)!
}

// An audited revision written by a Mission Control service rather than a
// repository mutation (e.g. one summary row per applied revise_plan call).
export function recordRevision(
  featureId: string,
  targetKind: WorkRevision["targetKind"],
  targetId: string,
  op: string,
  after: unknown,
  actor: string,
  reason: string
): void {
  audit(featureId, targetKind, targetId, op, null, after, actor, reason)
}

export function countRevisions(
  featureId: string,
  targetId: string,
  op: string
): number {
  return getDb()
    .prepare(
      "SELECT COUNT(*) FROM work_revisions WHERE feature_id = ? AND target_id = ? AND json_extract(change, '$.op') = ?"
    )
    .pluck()
    .get(featureId, targetId, op) as number
}

// User stories a seat added to a milestone on its own authority (revise_plan). User stories
// the user applied from a proposal — even a seat's planning proposal — were
// approved by the user and don't count against the agent-user-story budget.
export function countSeatCreatedUserStories(milestoneId: string): number {
  return getDb()
    .prepare(
      `SELECT COUNT(*) FROM user_stories s
       JOIN work_revisions r ON r.target_id = s.id AND json_extract(r.change, '$.op') = 'create'
       WHERE s.milestone_id = ? AND r.actor LIKE '%@%' AND r.actor NOT LIKE '%@rig'`
    )
    .pluck()
    .get(milestoneId) as number
}

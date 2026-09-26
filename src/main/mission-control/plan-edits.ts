import { getDb } from "../db/connection"
import * as initiatives from "../db/repositories/initiatives"
import type { Initiative, Mission, SliceSpec, WorkSlice } from "../db/types"
import {
  describePlanChange,
  SEAT_APPLICABLE_OPS,
  type MissionDraft,
  type PlanChange,
  type SliceDraft,
} from "../../shared/mission-control/plan-changes"
import { emitWorkChanged } from "./work-events"

// Applies structural plan changes (plan 106.6). One engine serves both paths:
// the lead's `revise_plan` (bounded to the active mission, gated by rights and
// budget) and the user applying a proposal (any op). Every change set applies
// in ONE transaction — a change that fails validation rolls the whole set
// back — and every write is audited with the actor and reason.

export interface ApplyInput {
  initiativeId: string
  // Slice ops without an explicit mission apply here.
  missionId: string | null
  changes: PlanChange[]
  actor: string
  reason: string
  // Slices a seat creates are marked as agent work.
  origin: WorkSlice["origin"]
}

export interface ApplyResult {
  applied: string[]
  createdSliceIds: string[]
  createdMissionIds: string[]
  // Changes left out (partial or dry runs only), with why.
  skipped: Array<{ index: number; description: string; error: string }>
}

export interface ApplyOptions {
  // Apply every change that still applies and skip the rest, instead of
  // refusing the whole set (a proposal whose plan moved on).
  partial?: boolean
  // Report what would apply, then roll everything back.
  dryRun?: boolean
}

class DryRun extends Error {}

const NOT_STARTED = new Set(["draft", "ready", "blocked"])

function slug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32)
      .replace(/-$/, "") || "slice"
  )
}

function specOf(draft: SliceDraft): Partial<SliceSpec> {
  return {
    goal: draft.goal ?? draft.title,
    acceptance: draft.acceptance ?? [],
    outOfScope: draft.outOfScope ?? [],
    touchHints: draft.touchHints ?? [],
    notes: draft.notes ?? "",
  }
}

// Why a change set can't be applied by a seat directly, or null. Out-of-scope
// changes are always proposals, whatever the seat's rights.
export function seatScopeRefusal(
  changes: PlanChange[],
  activeMission: Mission | null
): string | null {
  if (!activeMission)
    return "There is no active milestone, so plan changes can only be proposed."
  for (const change of changes) {
    if (!SEAT_APPLICABLE_OPS.has(change.op))
      return `"${change.op}" changes the feature, a milestone's outcome, or adds a milestone, which only the user may do.`
    if (change.op === "add_slice" && change.mission && change.mission !== activeMission.key)
      return `Changes are limited to the active milestone (${activeMission.key}); ${change.mission} is another milestone.`
  }
  return null
}

class PlanEditError extends Error {}

function fail(message: string): never {
  throw new PlanEditError(message)
}

interface Scope {
  initiative: Initiative
  missions: Mission[]
}

function missionByKey(scope: Scope, key: string): Mission {
  const mission = scope.missions.find((m) => m.key === key)
  if (!mission) fail(`No milestone "${key}" in this feature.`)
  return mission
}

function sliceByKey(missionId: string, key: string): WorkSlice {
  const slice = initiatives.listSlices(missionId).find((s) => s.key === key)
  if (!slice) {
    const mission = initiatives.getMission(missionId)
    fail(`No user story "${key}" in milestone ${mission?.key ?? missionId}.`)
  }
  return slice
}

function assertPod(scope: Scope, pod: string | null | undefined): void {
  if (!pod) return
  const pods = scope.initiative.rigSnapshot?.pods ?? []
  if (!pods.some((p) => p.key === pod))
    fail(
      `No pod "${pod}" in this feature's rig. Pods: ${pods.map((p) => p.key).join(", ") || "none"}.`
    )
}

function edgesOf(missionId: string) {
  return initiatives
    .listEdges(missionId)
    .map((e) => ({ fromSliceId: e.fromSliceId, toSliceId: e.toSliceId }))
}

function setEdges(
  missionId: string,
  edges: Array<{ fromSliceId: string; toSliceId: string }>,
  input: ApplyInput
): void {
  const unique = new Map(edges.map((e) => [`${e.fromSliceId}:${e.toSliceId}`, e]))
  try {
    initiatives.setSliceEdges(missionId, [...unique.values()], input.actor, input.reason)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

function createSlice(
  scope: Scope,
  missionId: string,
  draft: SliceDraft,
  input: ApplyInput
): WorkSlice {
  assertPod(scope, draft.pod)
  const mission = initiatives.getMission(missionId)!
  if (["completed", "cancelled"].includes(mission.status))
    fail(`Milestone ${mission.key} is ${mission.status}; user stories can't be added to it.`)
  const slice = initiatives.addSlice({
    missionId,
    key: slug(draft.key ?? draft.title),
    title: draft.title,
    spec: specOf(draft),
    podKey: draft.pod ?? null,
    origin: input.origin,
    actor: input.actor,
    reason: input.reason,
  })
  return slice
}

// A dependency names a slice by key: first one created in this same change
// (by the key its draft asked for, even if a clash suffixed it), else an
// existing slice in the mission.
function addDependencies(
  missionId: string,
  sliceId: string,
  dependsOn: string[] | undefined,
  input: ApplyInput,
  created: Map<string, string> = new Map()
): void {
  if (!dependsOn?.length) return
  const extra = dependsOn.map((key) => ({
    fromSliceId: created.get(slug(key)) ?? sliceByKey(missionId, key).id,
    toSliceId: sliceId,
  }))
  setEdges(missionId, [...edgesOf(missionId), ...extra], input)
}

function fillOrCreateMission(
  scope: Scope,
  draft: MissionDraft,
  first: boolean,
  input: ApplyInput
): Mission {
  const byKey = draft.key ? scope.missions.find((m) => m.key === draft.key) : undefined
  const empty = (m: Mission) =>
    m.status === "planned" && initiatives.listSlices(m.id).length === 0
  // The initiative's untouched starter mission takes the first planned one.
  const starter = scope.missions.find(
    (m) => empty(m) && m.key === "mission-1" && !m.outcome.trim()
  )
  const target = byKey && empty(byKey) ? byKey : first && starter ? starter : null
  if (target) {
    initiatives.updateMission(
      target.id,
      {
        name: draft.name,
        outcome: draft.outcome,
        ...(draft.definitionOfDone !== undefined
          ? { definitionOfDone: draft.definitionOfDone }
          : {}),
      },
      input.actor,
      input.reason
    )
    return initiatives.getMission(target.id)!
  }
  if (byKey) fail(`Milestone "${byKey.key}" already has user stories; propose changes to it instead.`)
  const graph = initiatives.createMission({
    initiativeId: scope.initiative.id,
    key: slug(draft.key ?? draft.name),
    name: draft.name,
    outcome: draft.outcome,
    definitionOfDone: draft.definitionOfDone,
  })
  const created = graph.missions.at(-1)!
  scope.missions.push(created)
  return created
}

// Blocked ⇄ ready follows the graph: a not-started slice that waits on a
// cancelled slice is blocked; a blocked slice with no cancelled predecessor is
// ready again. Idempotent.
export function refreshBlocked(missionId: string, actor: string): void {
  const slices = initiatives.listSlices(missionId)
  const byId = new Map(slices.map((s) => [s.id, s]))
  const edges = initiatives.listEdges(missionId)
  for (const slice of slices) {
    const cancelledPred = edges
      .filter((e) => e.toSliceId === slice.id)
      .map((e) => byId.get(e.fromSliceId))
      .find((p) => p?.status === "cancelled")
    if (cancelledPred && (slice.status === "draft" || slice.status === "ready"))
      initiatives.setSliceExecution(
        slice.id,
        { status: "blocked" },
        `Blocked: depends on cancelled user story ${cancelledPred.key}`,
        actor
      )
    else if (!cancelledPred && slice.status === "blocked")
      initiatives.setSliceExecution(
        slice.id,
        { status: "ready" },
        "Unblocked: no cancelled dependency remains",
        actor
      )
  }
}

function applyOne(
  scope: Scope,
  change: PlanChange,
  input: ApplyInput,
  result: ApplyResult,
  firstMission: { value: boolean }
): void {
  const missionId = (key?: string) => {
    if (key) return missionByKey(scope, key).id
    if (!input.missionId) fail("This change needs a milestone.")
    return input.missionId
  }
  switch (change.op) {
    case "add_slice": {
      const target = missionId(change.mission)
      const slice = createSlice(scope, target, change.slice, input)
      addDependencies(target, slice.id, change.slice.dependsOn, input)
      result.createdSliceIds.push(slice.id)
      break
    }
    case "split_slice": {
      const target = missionId()
      const original = sliceByKey(target, change.slice)
      if (!NOT_STARTED.has(original.status) && original.status !== "failed")
        fail(`User story ${original.key} is ${original.status}; only a user story that isn't running or finished can be split.`)
      const edges = edgesOf(target)
      const preds = edges.filter((e) => e.toSliceId === original.id).map((e) => e.fromSliceId)
      const succs = edges.filter((e) => e.fromSliceId === original.id).map((e) => e.toSliceId)
      const created = change.into.map((draft) => createSlice(scope, target, draft, input))
      const keyToId = new Map(
        change.into.map((draft, index) => [slug(draft.key ?? draft.title), created[index].id])
      )
      const next = edges.filter(
        (e) => e.fromSliceId !== original.id && e.toSliceId !== original.id
      )
      change.into.forEach((draft, index) => {
        const id = created[index].id
        for (const pred of preds) next.push({ fromSliceId: pred, toSliceId: id })
        for (const key of draft.dependsOn ?? []) {
          const from = keyToId.get(slug(key)) ?? sliceByKey(target, key).id
          next.push({ fromSliceId: from, toSliceId: id })
        }
        for (const succ of succs) next.push({ fromSliceId: id, toSliceId: succ })
      })
      setEdges(target, next, input)
      initiatives.setSliceExecution(
        original.id,
        { status: "cancelled", finishedAt: Date.now() },
        `Split into ${created.map((s) => s.key).join(", ")}: ${input.reason}`,
        input.actor
      )
      result.createdSliceIds.push(...created.map((s) => s.id))
      break
    }
    case "add_dependency":
    case "remove_dependency": {
      const target = missionId()
      const from = sliceByKey(target, change.from)
      const to = sliceByKey(target, change.to)
      const edges = edgesOf(target)
      if (change.op === "add_dependency") {
        if (!NOT_STARTED.has(to.status) && to.status !== "failed")
          fail(`User story ${to.key} is ${to.status}; a dependency can only be added to a user story that hasn't started.`)
        setEdges(target, [...edges, { fromSliceId: from.id, toSliceId: to.id }], input)
      } else {
        const next = edges.filter((e) => !(e.fromSliceId === from.id && e.toSliceId === to.id))
        if (next.length === edges.length)
          fail(`${to.key} does not depend on ${from.key}.`)
        setEdges(target, next, input)
      }
      break
    }
    case "reorder": {
      const target = missionId()
      const slices = initiatives.listSlices(target)
      const listed = change.order.map((key) => sliceByKey(target, key))
      const rest = slices.filter((s) => !listed.some((l) => l.id === s.id))
      ;[...listed, ...rest].forEach((slice, position) => {
        if (slice.position !== position)
          initiatives.updateSlice(slice.id, { position }, input.actor, input.reason)
      })
      break
    }
    case "edit_slice": {
      const target = missionId()
      const slice = sliceByKey(target, change.slice)
      if (slice.startedAt || !NOT_STARTED.has(slice.status))
        fail(`User story ${slice.key} has started; only a user story that has not started can be edited. Split or cancel it instead.`)
      assertPod(scope, change.patch.pod)
      const { pod, title, ...specPatch } = change.patch
      initiatives.updateSlice(
        slice.id,
        {
          ...(title ? { title } : {}),
          ...(pod !== undefined ? { podKey: pod } : {}),
          ...(Object.keys(specPatch).length
            ? { spec: { ...slice.spec, ...specPatch } }
            : {}),
        },
        input.actor,
        input.reason
      )
      break
    }
    case "add_mission": {
      const mission = fillOrCreateMission(scope, change.mission, firstMission.value, input)
      firstMission.value = false
      const created: WorkSlice[] = []
      for (const draft of change.mission.slices ?? []) {
        const slice = createSlice(scope, mission.id, draft, input)
        created.push(slice)
      }
      // Dependencies after every slice exists, so order in the list is free.
      const keyToId = new Map(
        (change.mission.slices ?? []).map((draft, index) => [
          slug(draft.key ?? draft.title),
          created[index].id,
        ])
      )
      for (const [index, draft] of (change.mission.slices ?? []).entries())
        addDependencies(mission.id, created[index].id, draft.dependsOn, input, keyToId)
      result.createdMissionIds.push(mission.id)
      result.createdSliceIds.push(...created.map((s) => s.id))
      break
    }
    case "edit_mission": {
      const mission = missionByKey(scope, change.mission)
      if (["completed", "cancelled"].includes(mission.status))
        fail(`Milestone ${mission.key} is ${mission.status} and can't be edited.`)
      initiatives.updateMission(mission.id, change.patch, input.actor, input.reason)
      break
    }
    case "edit_initiative":
      initiatives.updateInitiative(scope.initiative.id, change.patch, input.actor, input.reason)
      break
  }
  result.applied.push(describePlanChange(change))
}

export function applyPlanChanges(
  input: ApplyInput,
  options: ApplyOptions = {}
): ApplyResult {
  const initiative = initiatives.getInitiative(input.initiativeId)
  if (!initiative) throw new Error(`Feature not found: ${input.initiativeId}`)
  if (!input.changes.length) throw new Error("There are no changes to apply.")
  const result: ApplyResult = {
    applied: [],
    createdSliceIds: [],
    createdMissionIds: [],
    skipped: [],
  }
  try {
    applyAll(initiative, input, result, options)
  } catch (error) {
    if (error instanceof DryRun) return result
    throw error
  }
  emitWorkChanged(initiative.id)
  return result
}

function applyAll(
  initiative: Initiative,
  input: ApplyInput,
  result: ApplyResult,
  options: ApplyOptions
): void {
  const tolerant = options.partial || options.dryRun
  getDb().transaction(() => {
    const scope: Scope = { initiative, missions: initiatives.listMissions(initiative.id) }
    const firstMission = { value: true }
    for (const [index, change] of input.changes.entries()) {
      try {
        if (!tolerant) {
          applyOne(scope, change, input, result, firstMission)
          continue
        }
        // Each change in its own savepoint: a failing one rolls back alone,
        // and later changes see exactly what the earlier ones did.
        const missions = scope.missions.length
        const first = firstMission.value
        try {
          getDb().transaction(() => applyOne(scope, change, input, result, firstMission))()
        } catch (error) {
          scope.missions.length = missions
          firstMission.value = first
          result.skipped.push({
            index,
            description: describePlanChange(change),
            error: error instanceof Error ? error.message : String(error),
          })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new PlanEditError(`Change ${index + 1} (${change.op}): ${message}`)
      }
    }
    const touched = new Set(
      [input.missionId, ...result.createdMissionIds].filter((id): id is string => !!id)
    )
    for (const mission of initiatives.listMissions(initiative.id))
      if (touched.has(mission.id) || input.changes.some((c) => c.op === "split_slice"))
        refreshBlocked(mission.id, input.actor)
    // Thrown inside the transaction so everything above rolls back.
    if (options.dryRun) throw new DryRun()
  })()
}

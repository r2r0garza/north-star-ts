import { getDb } from "../db/connection"
import * as features from "../db/repositories/features"
import type { Feature, Milestone, UserStorySpec, WorkUserStory } from "../db/types"
import {
  describePlanChange,
  SEAT_APPLICABLE_OPS,
  type MilestoneDraft,
  type PlanChange,
  type UserStoryDraft,
} from "../../shared/mission-control/plan-changes"
import { emitWorkChanged } from "./work-events"

// Applies structural plan changes (plan 106.6). One engine serves both paths:
// the lead's `revise_plan` (bounded to the active milestone, gated by rights and
// budget) and the user applying a proposal (any op). Every change set applies
// in ONE transaction — a change that fails validation rolls the whole set
// back — and every write is audited with the actor and reason.

export interface ApplyInput {
  featureId: string
  // User story ops without an explicit milestone apply here.
  milestoneId: string | null
  changes: PlanChange[]
  actor: string
  reason: string
  // User stories a seat creates are marked as agent work.
  origin: WorkUserStory["origin"]
}

export interface ApplyResult {
  applied: string[]
  createdUserStoryIds: string[]
  createdMilestoneIds: string[]
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
      .replace(/-$/, "") || "user_story"
  )
}

function specOf(draft: UserStoryDraft): Partial<UserStorySpec> {
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
  activeMilestone: Milestone | null
): string | null {
  if (!activeMilestone)
    return "There is no active milestone, so plan changes can only be proposed."
  for (const change of changes) {
    if (!SEAT_APPLICABLE_OPS.has(change.op))
      return `"${change.op}" changes the feature, a milestone's outcome, or adds a milestone, which only the user may do.`
    if (change.op === "add_user_story" && change.milestone && change.milestone !== activeMilestone.key)
      return `Changes are limited to the active milestone (${activeMilestone.key}); ${change.milestone} is another milestone.`
  }
  return null
}

class PlanEditError extends Error {}

function fail(message: string): never {
  throw new PlanEditError(message)
}

interface Scope {
  feature: Feature
  milestones: Milestone[]
}

function milestoneByKey(scope: Scope, key: string): Milestone {
  const milestone = scope.milestones.find((m) => m.key === key)
  if (!milestone) fail(`No milestone "${key}" in this feature.`)
  return milestone
}

function userStoryByKey(milestoneId: string, key: string): WorkUserStory {
  const userStory = features.listUserStories(milestoneId).find((s) => s.key === key)
  if (!userStory) {
    const milestone = features.getMilestone(milestoneId)
    fail(`No user story "${key}" in milestone ${milestone?.key ?? milestoneId}.`)
  }
  return userStory
}

function assertPod(scope: Scope, pod: string | null | undefined): void {
  if (!pod) return
  const pods = scope.feature.rigSnapshot?.pods ?? []
  if (!pods.some((p) => p.key === pod))
    fail(
      `No pod "${pod}" in this feature's rig. Pods: ${pods.map((p) => p.key).join(", ") || "none"}.`
    )
}

function edgesOf(milestoneId: string) {
  return features
    .listEdges(milestoneId)
    .map((e) => ({ fromUserStoryId: e.fromUserStoryId, toUserStoryId: e.toUserStoryId }))
}

function setEdges(
  milestoneId: string,
  edges: Array<{ fromUserStoryId: string; toUserStoryId: string }>,
  input: ApplyInput
): void {
  const unique = new Map(edges.map((e) => [`${e.fromUserStoryId}:${e.toUserStoryId}`, e]))
  try {
    features.setUserStoryEdges(milestoneId, [...unique.values()], input.actor, input.reason)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

function createUserStory(
  scope: Scope,
  milestoneId: string,
  draft: UserStoryDraft,
  input: ApplyInput
): WorkUserStory {
  assertPod(scope, draft.pod)
  const milestone = features.getMilestone(milestoneId)!
  if (["completed", "cancelled"].includes(milestone.status))
    fail(`Milestone ${milestone.key} is ${milestone.status}; user stories can't be added to it.`)
  const userStory = features.addUserStory({
    milestoneId,
    key: slug(draft.key ?? draft.title),
    title: draft.title,
    spec: specOf(draft),
    podKey: draft.pod ?? null,
    origin: input.origin,
    actor: input.actor,
    reason: input.reason,
  })
  return userStory
}

// A dependency names a user story by key: first one created in this same change
// (by the key its draft asked for, even if a clash suffixed it), else an
// existing user story in the milestone.
function addDependencies(
  milestoneId: string,
  userStoryId: string,
  dependsOn: string[] | undefined,
  input: ApplyInput,
  created: Map<string, string> = new Map()
): void {
  if (!dependsOn?.length) return
  const extra = dependsOn.map((key) => ({
    fromUserStoryId: created.get(slug(key)) ?? userStoryByKey(milestoneId, key).id,
    toUserStoryId: userStoryId,
  }))
  setEdges(milestoneId, [...edgesOf(milestoneId), ...extra], input)
}

function fillOrCreateMilestone(
  scope: Scope,
  draft: MilestoneDraft,
  first: boolean,
  input: ApplyInput
): Milestone {
  const byKey = draft.key ? scope.milestones.find((m) => m.key === draft.key) : undefined
  const empty = (m: Milestone) =>
    m.status === "planned" && features.listUserStories(m.id).length === 0
  // The feature's untouched starter milestone takes the first planned one.
  const starter = scope.milestones.find(
    (m) => empty(m) && m.key === "milestone-1" && !m.outcome.trim()
  )
  const target = byKey && empty(byKey) ? byKey : first && starter ? starter : null
  if (target) {
    features.updateMilestone(
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
    return features.getMilestone(target.id)!
  }
  if (byKey) fail(`Milestone "${byKey.key}" already has user stories; propose changes to it instead.`)
  const graph = features.createMilestone({
    featureId: scope.feature.id,
    key: slug(draft.key ?? draft.name),
    name: draft.name,
    outcome: draft.outcome,
    definitionOfDone: draft.definitionOfDone,
  })
  const created = graph.milestones.at(-1)!
  scope.milestones.push(created)
  return created
}

// Blocked ⇄ ready follows the graph: a not-started user story that waits on a
// cancelled user story is blocked; a blocked user story with no cancelled predecessor is
// ready again. Idempotent.
export function refreshBlocked(milestoneId: string, actor: string): void {
  const userStories = features.listUserStories(milestoneId)
  const byId = new Map(userStories.map((s) => [s.id, s]))
  const edges = features.listEdges(milestoneId)
  for (const userStory of userStories) {
    const cancelledPred = edges
      .filter((e) => e.toUserStoryId === userStory.id)
      .map((e) => byId.get(e.fromUserStoryId))
      .find((p) => p?.status === "cancelled")
    if (cancelledPred && (userStory.status === "draft" || userStory.status === "ready"))
      features.setUserStoryExecution(
        userStory.id,
        { status: "blocked" },
        `Blocked: depends on cancelled user story ${cancelledPred.key}`,
        actor
      )
    else if (!cancelledPred && userStory.status === "blocked")
      features.setUserStoryExecution(
        userStory.id,
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
  firstMilestone: { value: boolean }
): void {
  const milestoneId = (key?: string) => {
    if (key) return milestoneByKey(scope, key).id
    if (!input.milestoneId) fail("This change needs a milestone.")
    return input.milestoneId
  }
  switch (change.op) {
    case "add_user_story": {
      const target = milestoneId(change.milestone)
      const userStory = createUserStory(scope, target, change.userStory, input)
      addDependencies(target, userStory.id, change.userStory.dependsOn, input)
      result.createdUserStoryIds.push(userStory.id)
      break
    }
    case "split_user_story": {
      const target = milestoneId()
      const original = userStoryByKey(target, change.userStory)
      if (!NOT_STARTED.has(original.status) && original.status !== "failed")
        fail(`User story ${original.key} is ${original.status}; only a user story that isn't running or finished can be split.`)
      const edges = edgesOf(target)
      const preds = edges.filter((e) => e.toUserStoryId === original.id).map((e) => e.fromUserStoryId)
      const succs = edges.filter((e) => e.fromUserStoryId === original.id).map((e) => e.toUserStoryId)
      const created = change.into.map((draft) => createUserStory(scope, target, draft, input))
      const keyToId = new Map(
        change.into.map((draft, index) => [slug(draft.key ?? draft.title), created[index].id])
      )
      const next = edges.filter(
        (e) => e.fromUserStoryId !== original.id && e.toUserStoryId !== original.id
      )
      change.into.forEach((draft, index) => {
        const id = created[index].id
        for (const pred of preds) next.push({ fromUserStoryId: pred, toUserStoryId: id })
        for (const key of draft.dependsOn ?? []) {
          const from = keyToId.get(slug(key)) ?? userStoryByKey(target, key).id
          next.push({ fromUserStoryId: from, toUserStoryId: id })
        }
        for (const succ of succs) next.push({ fromUserStoryId: id, toUserStoryId: succ })
      })
      setEdges(target, next, input)
      features.setUserStoryExecution(
        original.id,
        { status: "cancelled", finishedAt: Date.now() },
        `Split into ${created.map((s) => s.key).join(", ")}: ${input.reason}`,
        input.actor
      )
      result.createdUserStoryIds.push(...created.map((s) => s.id))
      break
    }
    case "add_dependency":
    case "remove_dependency": {
      const target = milestoneId()
      const from = userStoryByKey(target, change.from)
      const to = userStoryByKey(target, change.to)
      const edges = edgesOf(target)
      if (change.op === "add_dependency") {
        if (!NOT_STARTED.has(to.status) && to.status !== "failed")
          fail(`User story ${to.key} is ${to.status}; a dependency can only be added to a user story that hasn't started.`)
        setEdges(target, [...edges, { fromUserStoryId: from.id, toUserStoryId: to.id }], input)
      } else {
        const next = edges.filter((e) => !(e.fromUserStoryId === from.id && e.toUserStoryId === to.id))
        if (next.length === edges.length)
          fail(`${to.key} does not depend on ${from.key}.`)
        setEdges(target, next, input)
      }
      break
    }
    case "reorder": {
      const target = milestoneId()
      const userStories = features.listUserStories(target)
      const listed = change.order.map((key) => userStoryByKey(target, key))
      const rest = userStories.filter((s) => !listed.some((l) => l.id === s.id))
      ;[...listed, ...rest].forEach((userStory, position) => {
        if (userStory.position !== position)
          features.updateUserStory(userStory.id, { position }, input.actor, input.reason)
      })
      break
    }
    case "edit_user_story": {
      const target = milestoneId()
      const userStory = userStoryByKey(target, change.userStory)
      if (userStory.startedAt || !NOT_STARTED.has(userStory.status))
        fail(`User story ${userStory.key} has started; only a user story that has not started can be edited. Split or cancel it instead.`)
      assertPod(scope, change.patch.pod)
      const { pod, title, ...specPatch } = change.patch
      features.updateUserStory(
        userStory.id,
        {
          ...(title ? { title } : {}),
          ...(pod !== undefined ? { podKey: pod } : {}),
          ...(Object.keys(specPatch).length
            ? { spec: { ...userStory.spec, ...specPatch } }
            : {}),
        },
        input.actor,
        input.reason
      )
      break
    }
    case "add_milestone": {
      const milestone = fillOrCreateMilestone(scope, change.milestone, firstMilestone.value, input)
      firstMilestone.value = false
      const created: WorkUserStory[] = []
      for (const draft of change.milestone.userStories ?? []) {
        const userStory = createUserStory(scope, milestone.id, draft, input)
        created.push(userStory)
      }
      // Dependencies after every user story exists, so order in the list is free.
      const keyToId = new Map(
        (change.milestone.userStories ?? []).map((draft, index) => [
          slug(draft.key ?? draft.title),
          created[index].id,
        ])
      )
      for (const [index, draft] of (change.milestone.userStories ?? []).entries())
        addDependencies(milestone.id, created[index].id, draft.dependsOn, input, keyToId)
      result.createdMilestoneIds.push(milestone.id)
      result.createdUserStoryIds.push(...created.map((s) => s.id))
      break
    }
    case "edit_milestone": {
      const milestone = milestoneByKey(scope, change.milestone)
      if (["completed", "cancelled"].includes(milestone.status))
        fail(`Milestone ${milestone.key} is ${milestone.status} and can't be edited.`)
      features.updateMilestone(milestone.id, change.patch, input.actor, input.reason)
      break
    }
    case "edit_feature":
      features.updateFeature(scope.feature.id, change.patch, input.actor, input.reason)
      break
  }
  result.applied.push(describePlanChange(change))
}

export function applyPlanChanges(
  input: ApplyInput,
  options: ApplyOptions = {}
): ApplyResult {
  const feature = features.getFeature(input.featureId)
  if (!feature) throw new Error(`Feature not found: ${input.featureId}`)
  if (!input.changes.length) throw new Error("There are no changes to apply.")
  const result: ApplyResult = {
    applied: [],
    createdUserStoryIds: [],
    createdMilestoneIds: [],
    skipped: [],
  }
  try {
    applyAll(feature, input, result, options)
  } catch (error) {
    if (error instanceof DryRun) return result
    throw error
  }
  emitWorkChanged(feature.id)
  return result
}

function applyAll(
  feature: Feature,
  input: ApplyInput,
  result: ApplyResult,
  options: ApplyOptions
): void {
  const tolerant = options.partial || options.dryRun
  getDb().transaction(() => {
    const scope: Scope = { feature, milestones: features.listMilestones(feature.id) }
    const firstMilestone = { value: true }
    for (const [index, change] of input.changes.entries()) {
      try {
        if (!tolerant) {
          applyOne(scope, change, input, result, firstMilestone)
          continue
        }
        // Each change in its own savepoint: a failing one rolls back alone,
        // and later changes see exactly what the earlier ones did.
        const milestones = scope.milestones.length
        const first = firstMilestone.value
        try {
          getDb().transaction(() => applyOne(scope, change, input, result, firstMilestone))()
        } catch (error) {
          scope.milestones.length = milestones
          firstMilestone.value = first
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
      [input.milestoneId, ...result.createdMilestoneIds].filter((id): id is string => !!id)
    )
    for (const milestone of features.listMilestones(feature.id))
      if (touched.has(milestone.id) || input.changes.some((c) => c.op === "split_user_story"))
        refreshBlocked(milestone.id, input.actor)
    // Thrown inside the transaction so everything above rolls back.
    if (options.dryRun) throw new DryRun()
  })()
}

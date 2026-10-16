import { readdirSync } from "fs"
import * as features from "../db/repositories/features"
import { listRecipeStates } from "../db/repositories/app-recipe-states"
import { getWorkspace } from "../db/repositories/workspaces"
import type { Feature, UserStory } from "../db/types"
import { isProvisional } from "../../shared/mission-control/app-launch"
import { touchHintsOverlap } from "../../shared/mission-control/waves"

// Two plan rules the plan-edit engine applies after every change set (plan
// 112.5), inside its transaction:
//
// - The runnable skeleton (`112` section C): while the workspace has no
//   verified recipe and nothing runnable (a provisional recipe counts as
//   none), the first milestone's first story makes the app runnable, and
//   every other story there depends on it. It's done like any story: its
//   proof needs the app check to verify the recipe, and its wave gate puts a
//   smoke test in the suite. Nothing that needs the app runs before that.
// - Overlapping stories (`112` section E): two new stories whose touch hints
//   overlap, with no path between them, get an explained edge from the
//   earlier-positioned one to the later, so the later is built and explored
//   against the earlier one's merged result. The lead or user may remove it.

export const SKELETON_KEY = "app-skeleton"

const NOT_STARTED = new Set<UserStory["status"]>(["draft", "ready", "blocked"])

// Anything in the folder besides dotfiles and docs: a project, runnable or
// not (a library has no recipe and needs no skeleton).
function hasProjectFiles(dir: string): boolean {
  try {
    return readdirSync(dir).some(
      (name) =>
        !name.startsWith(".") &&
        !/^(readme|license|licence|changelog)\b|\.md$/i.test(name)
    )
  } catch {
    return true
  }
}

// No verified recipe and nothing runnable: the app doesn't exist yet. A
// recipe planned from intent (provisional) counts as none.
export function isGreenfield(feature: Feature): boolean {
  const workspace = feature.workspaceId
    ? getWorkspace(feature.workspaceId)
    : null
  if (!workspace) return false
  if (listRecipeStates(workspace.id).some((s) => s.state === "verified"))
    return false
  return workspace.appLaunch.services.length
    ? isProvisional(workspace.appLaunch)
    : !hasProjectFiles(workspace.path)
}

// Whether `to` is reachable from `from` along the edges.
function reaches(
  edges: Array<{ fromUserStoryId: string; toUserStoryId: string }>,
  from: string,
  to: string
): boolean {
  const seen = new Set<string>()
  const queue = [from]
  while (queue.length) {
    const id = queue.shift()!
    if (id === to) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const e of edges)
      if (e.fromUserStoryId === id) queue.push(e.toUserStoryId)
  }
  return false
}

function edgesOf(milestoneId: string) {
  return features.listEdges(milestoneId).map((e) => ({
    fromUserStoryId: e.fromUserStoryId,
    toUserStoryId: e.toUserStoryId,
  }))
}

export function shapePlan(input: {
  feature: Feature
  milestoneId: string
  // Stories this change set created: only they get overlap edges, so an
  // edge the user removed stays removed.
  createdIds: ReadonlySet<string>
  actor: string
}): void {
  const { feature, milestoneId, actor } = input
  ensureSkeleton(feature, milestoneId, actor)
  serializeOverlaps(milestoneId, input.createdIds, actor)
}

function ensureSkeleton(
  feature: Feature,
  milestoneId: string,
  actor: string
): void {
  const first = features
    .listMilestones(feature.id)
    .find((m) => m.status !== "cancelled")
  if (first?.id !== milestoneId || !isGreenfield(feature)) return
  const stories = features
    .listUserStories(milestoneId)
    .filter((s) => s.status !== "cancelled")
  // An empty milestone, or one already under way, keeps its shape.
  if (!stories.length || stories.some((s) => !NOT_STARTED.has(s.status))) return
  let skeleton = stories.find((s) => s.key === SKELETON_KEY)
  if (!skeleton) {
    const lowest = Math.min(...stories.map((s) => s.position))
    skeleton = features.addUserStory({
      milestoneId,
      key: SKELETON_KEY,
      title: "Runnable skeleton",
      spec: {
        goal: "Make the app runnable before anything that needs it is built: the smallest app that starts with one command and serves its home page, with its app launch recipe saved (app_launch_save) so Mission Control can start it.",
        acceptance: [
          "The app starts from the workspace's app launch recipe, and the recipe verifies.",
          "The app's home page loads.",
        ],
        outOfScope: ["Any feature beyond the empty home page."],
        notes:
          "Added by Mission Control: the workspace has no app that runs yet, so every other story in this milestone waits for this one.",
      },
      actor,
      reason: "Runnable skeleton: the workspace has no verified app recipe yet",
    })
    features.updateUserStory(skeleton.id, { position: lowest - 1 }, actor)
  }
  const edges = edgesOf(milestoneId)
  const added = stories
    .filter(
      (s) =>
        s.id !== skeleton!.id &&
        !s.spec.runsLast &&
        !reaches(edges, skeleton!.id, s.id) &&
        !reaches(edges, s.id, skeleton!.id)
    )
    .map((s) => ({ fromUserStoryId: skeleton!.id, toUserStoryId: s.id }))
  if (added.length)
    features.setUserStoryEdges(
      milestoneId,
      [...edges, ...added],
      actor,
      `Runnable skeleton: ${added.length} user ${added.length === 1 ? "story waits" : "stories wait"} for ${SKELETON_KEY}, so nothing that needs the app runs before it does.`
    )
}

function serializeOverlaps(
  milestoneId: string,
  createdIds: ReadonlySet<string>,
  actor: string
): void {
  if (!createdIds.size) return
  const stories = features
    .listUserStories(milestoneId)
    .filter(
      (s) =>
        NOT_STARTED.has(s.status) &&
        !s.spec.runsLast &&
        // Fix stories have no dependencies (plan 112.5).
        s.origin !== "gate" &&
        s.spec.touchHints.length > 0
    )
    .sort((a, b) => a.position - b.position)
  const edges = edgesOf(milestoneId)
  const reasons: string[] = []
  for (const [i, earlier] of stories.entries())
    for (const later of stories.slice(i + 1)) {
      if (!createdIds.has(earlier.id) && !createdIds.has(later.id)) continue
      if (!touchHintsOverlap(earlier.spec.touchHints, later.spec.touchHints))
        continue
      if (
        reaches(edges, earlier.id, later.id) ||
        reaches(edges, later.id, earlier.id)
      )
        continue
      edges.push({ fromUserStoryId: earlier.id, toUserStoryId: later.id })
      reasons.push(`${later.key} after ${earlier.key}`)
    }
  if (reasons.length)
    features.setUserStoryEdges(
      milestoneId,
      edges,
      actor,
      `Automatic: their touch hints overlap, so each later story builds on the earlier one's merged result (${reasons.join("; ")}). Remove an edge to let them run in parallel.`
    )
}

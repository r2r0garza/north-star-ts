import { budgetLimit } from "../../../shared/mission-control/budgets"
import { TASK_LANE_SLOTS } from "../../../shared/task-lanes"
import type { PlanChange } from "../../../shared/mission-control/plan-changes"
import {
  overlappingPairs,
  scheduleSteps,
  type ScheduleStory,
  type WaveEdge,
} from "../../../shared/mission-control/waves"
import type { Feature, FeatureGraph } from "@/types"

// What the "Overlapping stories" setting buys for a set of user stories: the
// estimated sequential steps when overlapping stories wait versus run in
// parallel, and which independent stories overlap. A unit-time estimate that
// follows the Navigator's dispatch rules; real stories vary in length.
export interface OverlapEstimate {
  label: string
  stories: number
  wait: number
  parallel: number
  // Keys of independent user stories whose touch hints overlap.
  pairs: Array<[string, string]>
}

// How many user stories can run at once: the concurrency budget, further
// limited by the default pod's builder seats, as the Navigator counts them,
// and by the task runner's work lane.
export function scheduleCapacity(feature: Feature): number {
  const budget = Math.min(
    budgetLimit(feature.budgets, "maxConcurrentUserStories"),
    TASK_LANE_SLOTS.work
  )
  const rig = feature.rigSnapshot
  const pod = rig?.pods.find((p) => p.key === feature.defaultPodKey)
  if (!rig || !pod) return Math.max(1, budget)
  const builders = rig.seats.filter(
    (seat) =>
      seat.podId === pod.id && seat.role === "builder" && seat.agentRefId
  ).length
  return Math.max(1, Math.min(budget, Math.max(1, builders)))
}

function estimate(
  label: string,
  stories: Array<ScheduleStory & { key: string }>,
  edges: WaveEdge[],
  capacity: number
): OverlapEstimate {
  const keyOf = new Map(stories.map((story) => [story.id, story.key]))
  return {
    label,
    stories: stories.length,
    wait: scheduleSteps(stories, edges, {
      maxConcurrent: capacity,
      overlap: "wait",
    }).length,
    parallel: scheduleSteps(stories, edges, {
      maxConcurrent: capacity,
      overlap: "parallel",
    }).length,
    pairs: overlappingPairs(stories, edges).map(
      ([a, b]) => [keyOf.get(a)!, keyOf.get(b)!] as [string, string]
    ),
  }
}

// The milestone being worked on, over its user stories still to finish.
export function milestoneOverlapEstimate(
  graph: FeatureGraph
): OverlapEstimate | null {
  const milestone = [...graph.milestones]
    .sort((a, b) => a.position - b.position)
    .find((m) => !["completed", "cancelled"].includes(m.status))
  if (!milestone) return null
  const stories = graph.userStories
    .filter(
      (s) =>
        s.milestoneId === milestone.id &&
        !["done", "cancelled"].includes(s.status)
    )
    .map((s) => ({
      id: s.id,
      key: s.key,
      touchHints: s.spec.touchHints,
      position: s.position,
    }))
  if (!stories.length) return null
  const edges = graph.edges.filter((e) => e.milestoneId === milestone.id)
  return estimate(
    milestone.key,
    stories,
    edges,
    scheduleCapacity(graph.feature)
  )
}

// Each milestone a planning proposal would add, before it's applied.
export function proposalOverlapEstimates(
  changes: PlanChange[],
  feature: Feature
): OverlapEstimate[] {
  const capacity = scheduleCapacity(feature)
  return changes.flatMap((change) => {
    if (change.op !== "add_milestone") return []
    const drafts = change.milestone.userStories ?? []
    if (!drafts.length) return []
    const stories = drafts.map((draft, position) => {
      const key = draft.key ?? draft.title
      return { id: key, key, touchHints: draft.touchHints ?? [], position }
    })
    const edges = drafts.flatMap((draft) =>
      (draft.dependsOn ?? []).map((from) => ({
        fromUserStoryId: from,
        toUserStoryId: draft.key ?? draft.title,
      }))
    )
    return [
      estimate(
        change.milestone.key ?? change.milestone.name,
        stories,
        edges,
        capacity
      ),
    ]
  })
}

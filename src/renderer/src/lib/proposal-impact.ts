import {
  deriveWaves,
  withRunsLastEdges,
} from "../../../shared/mission-control/waves"
import type { FeatureGraph, PlanProposal } from "@/types"

// What approving an added user story does to the order of the stories
// already planned, so a reviewer isn't surprised: waves come from
// dependencies, and a new story's dependencies don't make stories in later
// waves wait for it.
export interface AddedStoryImpact {
  key: string
  // It runs after every other story in the milestone.
  runsLast: boolean
  // Not-finished stories that will wait for it: the ones it blocks, their
  // dependents, and stories that run last.
  waiting: string[]
  // Not-finished stories in later waves that won't wait for it.
  notWaiting: string[]
}

export function addedStoryImpacts(
  proposal: Pick<PlanProposal, "changes" | "milestoneId">,
  graph: FeatureGraph
): AddedStoryImpact[] {
  return proposal.changes.flatMap((change): AddedStoryImpact[] => {
    if (change.op !== "add_user_story") return []
    const milestone = change.milestone
      ? graph.milestones.find((m) => m.key === change.milestone)
      : graph.milestones.find((m) => m.id === proposal.milestoneId)
    if (!milestone) return []
    const draft = change.userStory
    const key = draft.key ?? draft.title
    const stories = graph.userStories.filter(
      (s) => s.milestoneId === milestone.id && s.status !== "cancelled"
    )
    if (draft.runsLast)
      return [{ key, runsLast: true, waiting: [], notWaiting: [] }]
    const byKey = new Map(stories.map((s) => [s.key, s]))
    const edges = withRunsLastEdges(
      stories.map((s) => ({
        id: s.id,
        status: s.status,
        runsLast: s.spec.runsLast,
      })),
      graph.edges.filter((e) => e.milestoneId === milestone.id)
    )
    let levels: Map<string, number>
    try {
      levels = deriveWaves(stories, edges).levels
    } catch {
      return []
    }
    // Its wave: one after its latest dependency.
    const level =
      1 +
      Math.max(
        -1,
        ...(draft.dependsOn ?? []).map((dep) => {
          const story = byKey.get(dep)
          return story ? (levels.get(story.id) ?? 0) : -1
        })
      )
    // Everything downstream of what it blocks, plus stories that run last.
    const waiting = new Set<string>()
    const queue = (draft.blocks ?? [])
      .map((k) => byKey.get(k)?.id)
      .filter((id): id is string => !!id)
    for (const s of stories) if (s.spec.runsLast) queue.push(s.id)
    while (queue.length) {
      const id = queue.shift()!
      if (waiting.has(id)) continue
      waiting.add(id)
      for (const e of edges)
        if (e.fromUserStoryId === id) queue.push(e.toUserStoryId)
    }
    const open = stories.filter((s) => s.status !== "done")
    return [
      {
        key,
        runsLast: false,
        waiting: open.filter((s) => waiting.has(s.id)).map((s) => s.key),
        notWaiting: open
          .filter((s) => !waiting.has(s.id) && (levels.get(s.id) ?? 0) > level)
          .map((s) => s.key),
      },
    ]
  })
}

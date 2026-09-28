import { describe, expect, it } from "vitest"
import type { FeatureGraph, PlanProposal } from "@/types"
import { addedStoryImpacts } from "./proposal-impact"

// US-1 → US-2, US-3 → US-4, US-5, plus a proof that runs last.
function graph(): FeatureGraph {
  const story = (key: string, status = "ready", runsLast = false) => ({
    id: key,
    key,
    milestoneId: "m1",
    status,
    spec: { runsLast },
  })
  const edge = (from: string, to: string) => ({
    milestoneId: "m1",
    fromUserStoryId: from,
    toUserStoryId: to,
  })
  return {
    milestones: [{ id: "m1", key: "milestone-1" }],
    userStories: [
      story("us-1", "done"),
      story("us-2"),
      story("us-3"),
      story("us-4"),
      story("us-5"),
      story("proof", "ready", true),
    ],
    edges: [
      edge("us-1", "us-2"),
      edge("us-1", "us-3"),
      edge("us-2", "us-4"),
      edge("us-3", "us-4"),
      edge("us-2", "us-5"),
      edge("us-3", "us-5"),
    ],
  } as unknown as FeatureGraph
}

const adding = (
  userStory: Record<string, unknown>
): Pick<PlanProposal, "changes" | "milestoneId"> => ({
  milestoneId: "m1",
  changes: [
    { op: "add_user_story", userStory: { title: "US-6", ...userStory } },
  ] as PlanProposal["changes"],
})

describe("addedStoryImpacts", () => {
  it("warns that later-wave stories won't wait for a story added to wave 2", () => {
    expect(
      addedStoryImpacts(adding({ key: "us-6", dependsOn: ["us-1"] }), graph())
    ).toEqual([
      {
        key: "us-6",
        runsLast: false,
        waiting: ["proof"],
        notWaiting: ["us-4", "us-5"],
      },
    ])
  })

  it("lists the stories it blocks, and their dependents, as waiting", () => {
    const [impact] = addedStoryImpacts(
      adding({ key: "us-6", dependsOn: ["us-1"], blocks: ["us-4"] }),
      graph()
    )
    expect(impact.waiting.sort()).toEqual(["proof", "us-4"])
    expect(impact.notWaiting).toEqual(["us-5"])
  })

  it("says a runs-last addition waits for everything", () => {
    expect(
      addedStoryImpacts(adding({ key: "docs", runsLast: true }), graph())
    ).toEqual([{ key: "docs", runsLast: true, waiting: [], notWaiting: [] }])
  })
})

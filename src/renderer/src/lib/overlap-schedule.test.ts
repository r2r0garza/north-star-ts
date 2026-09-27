import { describe, expect, it } from "vitest"
import type { Feature } from "@/types"
import { overlapEstimateText } from "@/components/mission-control/overlap-estimate"
import { proposalOverlapEstimates, scheduleCapacity } from "./overlap-schedule"

// Only the fields the estimate reads.
function feature(
  builders: number,
  budgets: Record<string, number> = {}
): Feature {
  return {
    budgets,
    defaultPodKey: "impl",
    rigSnapshot: {
      pods: [{ id: "pod-impl", key: "impl" }],
      seats: Array.from({ length: builders }, (_, i) => ({
        podId: "pod-impl",
        role: "builder",
        agentRefId: `agent-${i}`,
      })),
    },
  } as unknown as Feature
}

// nav-test-4's plan: every story touches runtime.py.
const plan = [
  {
    op: "add_milestone" as const,
    milestone: {
      key: "milestone-1",
      name: "Scheduled runs",
      outcome: "",
      userStories: [
        { key: "persist", title: "Persist", touchHints: ["src/runtime.py"] },
        {
          key: "claim",
          title: "Claim",
          touchHints: ["src/runtime.py"],
          dependsOn: ["persist"],
        },
        {
          key: "read",
          title: "Read",
          touchHints: ["src/runtime.py"],
          dependsOn: ["persist"],
        },
        {
          key: "worker",
          title: "Worker",
          touchHints: ["src/worker.py", "src/runtime.py"],
          dependsOn: ["claim", "read"],
        },
      ],
    },
  },
]

describe("overlap schedule estimate", () => {
  it("caps concurrency at the budget and the default pod's builders", () => {
    expect(scheduleCapacity(feature(2))).toBe(2)
    expect(scheduleCapacity(feature(5))).toBe(3)
    expect(scheduleCapacity(feature(5, { maxConcurrentUserStories: 1 }))).toBe(
      1
    )
    // The task runner's work lane caps a budget raised past it.
    expect(
      scheduleCapacity(feature(10, { maxConcurrentUserStories: 10 }))
    ).toBe(6)
  })

  it("estimates a planning proposal both ways before it's applied", () => {
    const [estimate] = proposalOverlapEstimates(plan, feature(2))
    expect(estimate).toEqual({
      label: "milestone-1",
      stories: 4,
      wait: 4,
      parallel: 3,
      pairs: [["claim", "read"]],
    })
    expect(overlapEstimateText(estimate)).toBe(
      "milestone-1: 4 steps if overlapping stories wait, 3 steps if they run in parallel. Overlapping: claim ↔ read."
    )
  })

  it("says when the concurrency limit, not overlaps, sets the pace", () => {
    const [estimate] = proposalOverlapEstimates(plan, feature(1))
    expect(estimate).toMatchObject({ wait: 4, parallel: 4 })
    expect(overlapEstimateText(estimate)).toContain(
      "the concurrency limit, not the overlaps"
    )
  })
})

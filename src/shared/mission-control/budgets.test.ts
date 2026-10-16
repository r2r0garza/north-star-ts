import { describe, expect, it } from "vitest"
import { budgetMeters, type BudgetUsage } from "./budgets"

const usage: BudgetUsage = {
  maxConcurrentUserStories: 0,
  maxUserStoryAttempts: 0,
  maxPlanRevisionsPerMilestone: 0,
  maxAgentUserStoriesPerMilestone: 2,
  maxMessagesPerHour: 0,
  maxActiveHours: 0,
  maxPhaseMinutes: 0,
  maxGateFixRounds: 0,
}

describe("budgetMeters", () => {
  it("shows agent-added user stories against the milestone's total", () => {
    const meter = budgetMeters({}, usage, {
      key: "m1",
      final: false,
      userStories: 7,
    }).find((m) => m.key === "maxAgentUserStoriesPerMilestone")!
    expect(meter).toMatchObject({
      used: 2,
      limit: 5,
      level: "ok",
      context: "7 in milestone",
    })
    expect(meter.help).toContain("Stories from a plan you applied don't count")
  })

  it("adds context only to the agent-added user story meter", () => {
    const meters = budgetMeters({}, usage, {
      key: "m1",
      final: false,
      userStories: 7,
    })
    expect(meters.filter((m) => m.context).map((m) => m.key)).toEqual([
      "maxAgentUserStoriesPerMilestone",
    ])
  })
})

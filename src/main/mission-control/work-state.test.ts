import { describe, expect, it } from "vitest"
import {
  transitionMilestoneStatus,
  transitionUserStoryStatus,
} from "./work-state"

describe("Mission Control work transitions", () => {
  it("accepts declared forward and retry transitions", () => {
    expect(transitionMilestoneStatus("planned", "active")).toBe("active")
    expect(transitionMilestoneStatus("review", "active")).toBe("active")
    expect(transitionUserStoryStatus("draft", "ready")).toBe("ready")
    expect(transitionUserStoryStatus("failed", "ready")).toBe("ready")
  })

  it("rejects undeclared transitions", () => {
    expect(() => transitionMilestoneStatus("planned", "completed")).toThrow(
      /planned → completed/
    )
    expect(() => transitionUserStoryStatus("done", "running")).toThrow(
      /done → running/
    )
  })
})

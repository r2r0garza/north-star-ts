import { describe, expect, it } from "vitest"
import {
  transitionMilestoneStatus,
  transitionUserStoryStatus,
  userStoryStatusPath,
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

  it("ends an attempt unverified, and leaves it only through the user (plan 112.3)", () => {
    expect(transitionUserStoryStatus("running", "unverified")).toBe(
      "unverified"
    )
    expect(transitionUserStoryStatus("proving", "unverified")).toBe(
      "unverified"
    )
    // Checked again, accepted (merged or done), or abandoned.
    expect(userStoryStatusPath("unverified", "running")).toEqual([
      "ready",
      "running",
    ])
    expect(transitionUserStoryStatus("unverified", "integrating")).toBe(
      "integrating"
    )
    expect(transitionUserStoryStatus("unverified", "done")).toBe("done")
    // A finishing story never passes through it.
    expect(userStoryStatusPath("running", "done")).toEqual([
      "proving",
      "integrating",
      "done",
    ])
    expect(userStoryStatusPath("running", "failed")).toEqual(["failed"])
    // Never quietly turned into a failure.
    expect(() => transitionUserStoryStatus("unverified", "failed")).toThrow()
  })
})

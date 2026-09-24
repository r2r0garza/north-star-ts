import { describe, expect, it } from "vitest"
import { transitionMissionStatus, transitionSliceStatus } from "./work-state"

describe("Mission Control work transitions", () => {
  it("accepts declared forward and retry transitions", () => {
    expect(transitionMissionStatus("planned", "active")).toBe("active")
    expect(transitionMissionStatus("review", "active")).toBe("active")
    expect(transitionSliceStatus("draft", "ready")).toBe("ready")
    expect(transitionSliceStatus("failed", "ready")).toBe("ready")
  })

  it("rejects undeclared transitions", () => {
    expect(() => transitionMissionStatus("planned", "completed")).toThrow(
      /planned → completed/
    )
    expect(() => transitionSliceStatus("done", "running")).toThrow(
      /done → running/
    )
  })
})

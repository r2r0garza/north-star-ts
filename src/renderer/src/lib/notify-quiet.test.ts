import { describe, expect, it } from "vitest"

import { isQuietTask } from "./notify"

describe("isQuietTask", () => {
  it("silences Mission Control's seat work and quiet runs", () => {
    expect(isQuietTask({ kind: "seat_wake", featureId: "f" })).toBe(true)
    expect(isQuietTask({ kind: "seat_session" })).toBe(true)
    expect(isQuietTask({ processRunId: "r", quiet: true })).toBe(true)
    expect(isQuietTask({ kind: "workspace_index" })).toBe(true)
  })

  it("still notifies for the user's own background work", () => {
    expect(isQuietTask({ processRunId: "r" })).toBe(false)
    expect(isQuietTask({ kind: "todo_run" })).toBe(false)
    expect(isQuietTask(null)).toBe(false)
  })
})

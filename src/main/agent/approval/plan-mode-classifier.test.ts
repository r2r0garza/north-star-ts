import { describe, it, expect } from "vitest"
import { PlanModeClassifier } from "./plan-mode-classifier"
import type { ToolAction } from "./types"

const action = (kind: ToolAction["kind"]): ToolAction => ({
  tool: "t",
  kind,
  summary: "s",
  identity: "i",
})

describe("PlanModeClassifier", () => {
  it("hard-blocks workspace-mutating kinds while plan mode is on", () => {
    const c = new PlanModeClassifier(() => true)
    for (const kind of ["file_write", "file_edit", "shell", "delegate"] as const) {
      expect(c.classify(action(kind))).toEqual({
        level: "hard_block",
        reason: expect.stringContaining("Plan mode"),
      })
    }
  })

  it("ignores browser actions even in plan mode (returns null → next classifier)", () => {
    const c = new PlanModeClassifier(() => true)
    expect(c.classify(action("browser"))).toBeNull()
  })

  it("passes everything through when plan mode is off", () => {
    const c = new PlanModeClassifier(() => false)
    for (const kind of [
      "file_write",
      "file_edit",
      "shell",
      "delegate",
      "browser",
    ] as const) {
      expect(c.classify(action(kind))).toBeNull()
    }
  })

  it("reads the getter live, so approval mid-turn stops blocking", () => {
    let on = true
    const c = new PlanModeClassifier(() => on)
    expect(c.classify(action("file_write"))?.level).toBe("hard_block")
    on = false
    expect(c.classify(action("file_write"))).toBeNull()
  })
})

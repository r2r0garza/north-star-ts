import { describe, expect, it } from "vitest"
import { pushLabel } from "./git-actions"

describe("pushLabel", () => {
  it("shows a positive ahead count", () => {
    expect(pushLabel(2)).toBe("Push (2)")
  })

  it("keeps the plain label without commits to push", () => {
    expect(pushLabel(0)).toBe("Push")
    expect(pushLabel(undefined)).toBe("Push")
  })
})

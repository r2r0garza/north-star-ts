import { afterEach, describe, expect, it } from "vitest"
import {
  clearPhaseClock,
  holdPhaseClock,
  phaseClockHeld,
  phaseHeldMs,
} from "./phase-clock"

describe("phase clock", () => {
  let now = 0
  const clock = () => now
  afterEach(() => {
    clearPhaseClock("p1")
    now = 0
  })

  it("counts held time, including a hold in progress", () => {
    const release = holdPhaseClock("p1", clock)
    expect(phaseClockHeld("p1")).toBe(true)
    now = 5_000
    expect(phaseHeldMs("p1", clock)).toBe(5_000)
    release()
    now = 9_000
    expect(phaseClockHeld("p1")).toBe(false)
    expect(phaseHeldMs("p1", clock)).toBe(5_000)
  })

  it("runs again only when the last of nested holds is released, once", () => {
    const outer = holdPhaseClock("p1", clock)
    now = 1_000
    const inner = holdPhaseClock("p1", clock)
    now = 2_000
    inner()
    inner()
    expect(phaseClockHeld("p1")).toBe(true)
    now = 3_000
    outer()
    expect(phaseClockHeld("p1")).toBe(false)
    expect(phaseHeldMs("p1", clock)).toBe(3_000)
  })

  it("forgets a cleared phase", () => {
    holdPhaseClock("p1", clock)()
    clearPhaseClock("p1")
    expect(phaseHeldMs("p1", clock)).toBe(0)
  })
})

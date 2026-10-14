import { afterEach, describe, expect, it, vi } from "vitest"
import {
  armPhaseDeadline,
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

describe("phase deadlines", () => {
  afterEach(() => {
    clearPhaseClock("p2")
    vi.useRealTimers()
  })

  it("moves both deadlines by the time the clock was held", () => {
    vi.useFakeTimers({ now: 0 })
    const timers: Array<ReturnType<typeof setTimeout>> = []
    const fired: string[] = []
    const minute = 60_000
    armPhaseDeadline("p2", 0, 10 * minute, timers, () => fired.push("wrap"))
    armPhaseDeadline("p2", 0, 20 * minute, timers, () => fired.push("stop"))
    vi.advanceTimersByTime(5 * minute)
    const release = holdPhaseClock("p2")
    // Held through both original deadlines: neither fires.
    vi.advanceTimersByTime(30 * minute)
    expect(fired).toEqual([])
    release()
    // 30 held minutes push them to 40 and 50.
    vi.advanceTimersByTime(4 * minute)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(1 * minute + 1)
    expect(fired).toEqual(["wrap"])
    vi.advanceTimersByTime(10 * minute)
    expect(fired).toEqual(["wrap", "stop"])
    for (const timer of timers) clearTimeout(timer)
  })

  it("fires on time when the clock is never held", () => {
    vi.useFakeTimers({ now: 0 })
    const timers: Array<ReturnType<typeof setTimeout>> = []
    let fired = false
    armPhaseDeadline("p2", 0, 1_000, timers, () => (fired = true))
    vi.advanceTimersByTime(999)
    expect(fired).toBe(false)
    vi.advanceTimersByTime(1)
    expect(fired).toBe(true)
  })
})

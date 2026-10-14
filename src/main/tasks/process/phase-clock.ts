// Time a phase spends waiting on the user (a QA step waiting for its test
// browser) doesn't count toward Mission Control's per-phase time limit: the
// limit is for runaway work, not for the user being away. In memory only: a
// restarted app re-runs the step, which waits (and holds the clock) again.

interface Clock {
  heldMs: number
  holds: number
  since: number | null
}

const clocks = new Map<string, Clock>()

// Stop the phase's clock until the returned release is called (idempotent).
// Holds nest: the clock runs again when the last one is released.
export function holdPhaseClock(
  phaseRunId: string,
  now: () => number = Date.now
): () => void {
  const clock = clocks.get(phaseRunId) ?? { heldMs: 0, holds: 0, since: null }
  if (clock.holds === 0) clock.since = now()
  clock.holds++
  clocks.set(phaseRunId, clock)
  let released = false
  return () => {
    if (released) return
    released = true
    clock.holds--
    if (clock.holds === 0 && clock.since !== null) {
      clock.heldMs += now() - clock.since
      clock.since = null
    }
  }
}

export function phaseClockHeld(phaseRunId: string): boolean {
  return (clocks.get(phaseRunId)?.holds ?? 0) > 0
}

// Total held time so far, including a hold still in progress.
export function phaseHeldMs(
  phaseRunId: string,
  now: () => number = Date.now
): number {
  const clock = clocks.get(phaseRunId)
  if (!clock) return 0
  return clock.heldMs + (clock.since !== null ? now() - clock.since : 0)
}

// The phase ended: forget its clock.
export function clearPhaseClock(phaseRunId: string): void {
  clocks.delete(phaseRunId)
}

// Fire `fire` once the phase has run `offsetMs` of unheld time since
// `startedAt` (Mission Control's per-phase time limit). The deadline is
// re-checked when it comes due: held time pushes it back, and while the clock
// is held it's re-armed at least a minute out. Timers go in `timers` so the
// phase clears them when it ends.
export function armPhaseDeadline(
  phaseRunId: string,
  startedAt: number,
  offsetMs: number,
  timers: Array<ReturnType<typeof setTimeout>>,
  fire: () => void,
  now: () => number = Date.now
): void {
  const check = () => {
    const remaining =
      startedAt + offsetMs + phaseHeldMs(phaseRunId, now) - now()
    if (phaseClockHeld(phaseRunId))
      timers.push(setTimeout(check, Math.max(remaining, 60_000)))
    else if (remaining > 0) timers.push(setTimeout(check, remaining))
    else fire()
  }
  timers.push(setTimeout(check, Math.max(0, startedAt + offsetMs - now())))
}

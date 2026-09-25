import type { MissionStatus, SliceStatus } from "../db/types"

const MISSION_TRANSITIONS: Record<MissionStatus, readonly MissionStatus[]> = {
  planned: ["active", "cancelled"],
  active: ["integrating", "failed", "cancelled"],
  integrating: ["review", "failed", "cancelled"],
  review: ["completed", "active", "failed", "cancelled"],
  completed: [],
  cancelled: [],
  failed: ["active", "cancelled"],
}

const SLICE_TRANSITIONS: Record<SliceStatus, readonly SliceStatus[]> = {
  draft: ["ready", "cancelled"],
  ready: ["blocked", "running", "cancelled"],
  blocked: ["ready", "cancelled", "failed"],
  running: ["proving", "blocked", "failed", "cancelled"],
  proving: ["integrating", "running", "failed", "cancelled"],
  integrating: ["done", "failed", "cancelled"],
  done: [],
  failed: ["ready", "cancelled"],
  cancelled: [],
}

function transition<T extends string>(
  current: T,
  next: T,
  table: Record<T, readonly T[]>
): T {
  if (current === next) return current
  if (!table[current].includes(next))
    throw new Error(`Invalid status transition: ${current} → ${next}`)
  return next
}

export function transitionMissionStatus(
  current: MissionStatus,
  next: MissionStatus
): MissionStatus {
  return transition(current, next, MISSION_TRANSITIONS)
}

export function transitionSliceStatus(
  current: SliceStatus,
  next: SliceStatus
): SliceStatus {
  return transition(current, next, SLICE_TRANSITIONS)
}

// The shortest legal status path from current to target (excluding current),
// or null when target is unreachable. Execution outcomes walk this path so every
// hop is a legal transition — e.g. running → proving → integrating → done while
// integration is a pass-through until 106.5.
export function sliceStatusPath(
  current: SliceStatus,
  target: SliceStatus
): SliceStatus[] | null {
  if (current === target) return []
  const previous = new Map<SliceStatus, SliceStatus>()
  const queue: SliceStatus[] = [current]
  const seen = new Set<SliceStatus>([current])
  while (queue.length) {
    const status = queue.shift()!
    for (const next of SLICE_TRANSITIONS[status]) {
      if (seen.has(next)) continue
      seen.add(next)
      previous.set(next, status)
      if (next === target) {
        const path: SliceStatus[] = [target]
        let cursor = status
        while (cursor !== current) {
          path.unshift(cursor)
          cursor = previous.get(cursor)!
        }
        return path
      }
      queue.push(next)
    }
  }
  return null
}

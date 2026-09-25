import type { MissionStatus, SliceStatus } from "../db/types"

const MISSION_TRANSITIONS: Record<MissionStatus, readonly MissionStatus[]> = {
  planned: ["active", "cancelled"],
  active: ["integrating", "failed", "cancelled"],
  // Back to active when a slice leaves the merge queue unmerged (106.5).
  integrating: ["review", "active", "failed", "cancelled"],
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
// hop is a legal transition — e.g. running → proving → integrating, and
// straight on to done when the workspace has no integration branch.
export function sliceStatusPath(
  current: SliceStatus,
  target: SliceStatus
): SliceStatus[] | null {
  return statusPath(current, target, SLICE_TRANSITIONS)
}

export function missionStatusPath(
  current: MissionStatus,
  target: MissionStatus
): MissionStatus[] | null {
  return statusPath(current, target, MISSION_TRANSITIONS)
}

function statusPath<T extends string>(
  current: T,
  target: T,
  table: Record<T, readonly T[]>
): T[] | null {
  if (current === target) return []
  const previous = new Map<T, T>()
  const queue: T[] = [current]
  const seen = new Set<T>([current])
  while (queue.length) {
    const status = queue.shift()!
    for (const next of table[status]) {
      if (seen.has(next)) continue
      seen.add(next)
      previous.set(next, status)
      if (next === target) {
        const path: T[] = [target]
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

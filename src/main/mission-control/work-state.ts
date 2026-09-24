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

import type { MilestoneStatus, UserStoryStatus } from "../db/types"

const MILESTONE_TRANSITIONS: Record<
  MilestoneStatus,
  readonly MilestoneStatus[]
> = {
  planned: ["active", "cancelled"],
  active: ["integrating", "failed", "cancelled"],
  // Back to active when a user story leaves the merge queue unmerged (106.5).
  integrating: ["review", "active", "failed", "cancelled"],
  review: ["completed", "active", "failed", "cancelled"],
  completed: [],
  cancelled: [],
  failed: ["active", "cancelled"],
}

const USER_STORY_TRANSITIONS: Record<
  UserStoryStatus,
  readonly UserStoryStatus[]
> = {
  // A draft waits (blocked) when a user story it depends on is cancelled (106.6).
  draft: ["ready", "blocked", "cancelled"],
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

export function transitionMilestoneStatus(
  current: MilestoneStatus,
  next: MilestoneStatus
): MilestoneStatus {
  return transition(current, next, MILESTONE_TRANSITIONS)
}

export function transitionUserStoryStatus(
  current: UserStoryStatus,
  next: UserStoryStatus
): UserStoryStatus {
  return transition(current, next, USER_STORY_TRANSITIONS)
}

// The shortest legal status path from current to target (excluding current),
// or null when target is unreachable. Execution outcomes walk this path so every
// hop is a legal transition — e.g. running → proving → integrating, and
// straight on to done when the workspace has no integration branch.
export function userStoryStatusPath(
  current: UserStoryStatus,
  target: UserStoryStatus
): UserStoryStatus[] | null {
  return statusPath(current, target, USER_STORY_TRANSITIONS)
}

export function milestoneStatusPath(
  current: MilestoneStatus,
  target: MilestoneStatus
): MilestoneStatus[] | null {
  return statusPath(current, target, MILESTONE_TRANSITIONS)
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

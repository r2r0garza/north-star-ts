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
  running: ["proving", "blocked", "failed", "unverified", "cancelled"],
  proving: ["integrating", "running", "failed", "unverified", "cancelled"],
  integrating: ["done", "failed", "cancelled"],
  done: [],
  failed: ["ready", "cancelled"],
  // Plan 112.3: checked again (back to ready, no attempt burned), or
  // accepted unverified by the user (merged like an accepted story).
  unverified: ["ready", "integrating", "done", "cancelled"],
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
// Entered only on purpose, never on the way somewhere else: a story that
// finishes must not pass through "the app couldn't be run" (plan 112.3).
const USER_STORY_NO_TRANSIT = new Set<UserStoryStatus>(["unverified"])

export function userStoryStatusPath(
  current: UserStoryStatus,
  target: UserStoryStatus
): UserStoryStatus[] | null {
  return statusPath(
    current,
    target,
    USER_STORY_TRANSITIONS,
    USER_STORY_NO_TRANSIT
  )
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
  table: Record<T, readonly T[]>,
  noTransit: ReadonlySet<T> = new Set()
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
      if (!noTransit.has(next)) queue.push(next)
    }
  }
  return null
}

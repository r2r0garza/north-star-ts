export interface WaveNode {
  id: string
  status?: string
  position?: number
}

export interface WaveEdge {
  fromUserStoryId: string
  toUserStoryId: string
}

export interface WaveResult<T extends WaveNode> {
  waves: T[][]
  levels: Map<string, number>
  criticalPath: string[]
}

function adjacency(nodes: WaveNode[], edges: WaveEdge[]) {
  const ids = new Set(nodes.map((node) => node.id))
  const incoming = new Map(nodes.map((node) => [node.id, [] as string[]]))
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]))
  for (const edge of edges) {
    if (!ids.has(edge.fromUserStoryId) || !ids.has(edge.toUserStoryId)) continue
    outgoing.get(edge.fromUserStoryId)!.push(edge.toUserStoryId)
    incoming.get(edge.toUserStoryId)!.push(edge.fromUserStoryId)
  }
  return { incoming, outgoing }
}

export function findCycle(
  nodes: WaveNode[],
  edges: WaveEdge[]
): string[] | null {
  const { outgoing } = adjacency(nodes, edges)
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const stack: string[] = []
  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id)
      return [...stack.slice(start), id]
    }
    if (visited.has(id)) return null
    visiting.add(id)
    stack.push(id)
    for (const next of outgoing.get(id) ?? []) {
      const cycle = visit(next)
      if (cycle) return cycle
    }
    stack.pop()
    visiting.delete(id)
    visited.add(id)
    return null
  }
  for (const node of nodes) {
    const cycle = visit(node.id)
    if (cycle) return cycle
  }
  return null
}

export function deriveWaves<T extends WaveNode>(
  nodes: T[],
  edges: WaveEdge[]
): WaveResult<T> {
  const cycle = findCycle(nodes, edges)
  if (cycle)
    throw new Error(
      `User story dependencies must be acyclic: ${cycle.join(" → ")}`
    )
  const { incoming, outgoing } = adjacency(nodes, edges)
  const levels = new Map<string, number>()
  const queue = nodes
    .filter((node) => incoming.get(node.id)!.length === 0)
    .map((node) => node.id)
  while (queue.length) {
    const id = queue.shift()!
    const level = (incoming.get(id) ?? []).reduce(
      (max, predecessor) => Math.max(max, (levels.get(predecessor) ?? 0) + 1),
      0
    )
    levels.set(id, level)
    for (const next of outgoing.get(id) ?? []) {
      if (
        (incoming.get(next) ?? []).every((predecessor) =>
          levels.has(predecessor)
        )
      )
        queue.push(next)
    }
  }
  const maxLevel = levels.size ? Math.max(...levels.values()) : -1
  const waves = Array.from({ length: maxLevel + 1 }, (_, level) =>
    nodes
      .filter((node) => levels.get(node.id) === level)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  )
  let endpoint = nodes.reduce<T | null>(
    (best, node) =>
      !best || (levels.get(node.id) ?? 0) > (levels.get(best.id) ?? 0)
        ? node
        : best,
    null
  )
  const criticalPath: string[] = []
  while (endpoint) {
    criticalPath.unshift(endpoint.id)
    const predecessors = incoming.get(endpoint.id) ?? []
    const previous = predecessors.reduce<string | null>(
      (best, id) =>
        best === null || (levels.get(id) ?? 0) > (levels.get(best) ?? 0)
          ? id
          : best,
      null
    )
    endpoint = previous
      ? (nodes.find((node) => node.id === previous) ?? null)
      : null
  }
  return { waves, levels, criticalPath }
}

// Ready user stories whose predecessors are all done. With an integration branch
// (plan 106.5) a user story is done only once its merge landed, so "done" here
// already means "merged": a dependent user story starts from a head that contains
// its predecessors' code.
export function readySet<T extends WaveNode>(
  nodes: T[],
  edges: WaveEdge[]
): T[] {
  const { incoming } = adjacency(nodes, edges)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  return nodes.filter(
    (node) =>
      node.status === "ready" &&
      (incoming.get(node.id) ?? []).every(
        (id) => byId.get(id)?.status === "done"
      )
  )
}

// ── touch hints (plan 106.5, decision 7) ────────────────────────────────────

// The literal directory (or file) a touch hint is anchored at: everything
// before its first glob character, cut back to a path boundary. "" means the
// hint can match anywhere in the repository.
export function touchHintRoot(hint: string): string {
  let root = hint.trim().replace(/^\.?\/+/, "")
  const glob = root.search(/[*?[{]/)
  if (glob >= 0) root = root.slice(0, root.lastIndexOf("/", glob) + 1)
  return root
}

// Whether two user stories' touch hints may name the same files. Conservative: two
// hints overlap when one's anchor contains the other's. User stories without hints
// declare nothing, so they never overlap.
export function touchHintsOverlap(a: string[], b: string[]): boolean {
  const within = (path: string, dir: string) =>
    path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`)
  for (const left of a.map(touchHintRoot))
    for (const right of b.map(touchHintRoot)) {
      if (left === "" || right === "") return true
      if (within(left, right) || within(right, left)) return true
    }
  return false
}

// ── overlap policy and schedule estimate ────────────────────────────────────

// Whether user stories whose touch hints overlap wait for each other (the
// default) or run in parallel and leave any collision to the merge queue.
export type OverlapPolicy = "wait" | "parallel"

export interface ScheduleStory {
  id: string
  touchHints: string[]
  position?: number
}

// A unit-time estimate of the steps a set of user stories takes: each step
// starts every story whose predecessors are done, up to maxConcurrent, and
// under "wait" skips a story whose touch hints overlap one already starting in
// that step, as the Navigator does. Edges to stories outside the set count as
// met (done, or in an earlier milestone).
export function scheduleSteps(
  stories: ScheduleStory[],
  edges: WaveEdge[],
  options: { maxConcurrent: number; overlap: OverlapPolicy }
): string[][] {
  const ids = new Set(stories.map((story) => story.id))
  const deps = new Map(stories.map((story) => [story.id, [] as string[]]))
  for (const edge of edges)
    if (ids.has(edge.fromUserStoryId) && ids.has(edge.toUserStoryId))
      deps.get(edge.toUserStoryId)!.push(edge.fromUserStoryId)
  const ordered = [...stories].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0)
  )
  const cap = Math.max(1, options.maxConcurrent)
  const done = new Set<string>()
  const steps: string[][] = []
  while (done.size < stories.length) {
    const step: ScheduleStory[] = []
    for (const story of ordered) {
      if (step.length >= cap) break
      if (done.has(story.id)) continue
      if (!deps.get(story.id)!.every((id) => done.has(id))) continue
      if (
        options.overlap === "wait" &&
        step.some((other) =>
          touchHintsOverlap(other.touchHints, story.touchHints)
        )
      )
        continue
      step.push(story)
    }
    // A cycle leaves nothing startable; deriveWaves reports cycles.
    if (!step.length) break
    for (const story of step) done.add(story.id)
    steps.push(step.map((story) => story.id))
  }
  return steps
}

// Independent stories (neither depends on the other, even indirectly) whose
// touch hints overlap: the pairs "wait" serializes and "parallel" doesn't.
export function overlappingPairs(
  stories: ScheduleStory[],
  edges: WaveEdge[]
): Array<[string, string]> {
  const ids = new Set(stories.map((story) => story.id))
  const parents = new Map(stories.map((story) => [story.id, [] as string[]]))
  for (const edge of edges)
    if (ids.has(edge.fromUserStoryId) && ids.has(edge.toUserStoryId))
      parents.get(edge.toUserStoryId)!.push(edge.fromUserStoryId)
  const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
    for (const parent of parents.get(id) ?? [])
      if (!seen.has(parent)) {
        seen.add(parent)
        ancestors(parent, seen)
      }
    return seen
  }
  const pairs: Array<[string, string]> = []
  for (let i = 0; i < stories.length; i++)
    for (let j = i + 1; j < stories.length; j++) {
      const a = stories[i]
      const b = stories[j]
      if (ancestors(a.id).has(b.id) || ancestors(b.id).has(a.id)) continue
      if (touchHintsOverlap(a.touchHints, b.touchHints))
        pairs.push([a.id, b.id])
    }
  return pairs
}

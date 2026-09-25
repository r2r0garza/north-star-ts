export interface WaveNode {
  id: string
  status?: string
  position?: number
}

export interface WaveEdge {
  fromSliceId: string
  toSliceId: string
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
    if (!ids.has(edge.fromSliceId) || !ids.has(edge.toSliceId)) continue
    outgoing.get(edge.fromSliceId)!.push(edge.toSliceId)
    incoming.get(edge.toSliceId)!.push(edge.fromSliceId)
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
    throw new Error(`Slice dependencies must be acyclic: ${cycle.join(" → ")}`)
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

// Ready slices whose predecessors are all done. With an integration branch
// (plan 106.5) a slice is done only once its merge landed, so "done" here
// already means "merged": a dependent slice starts from a head that contains
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

// Whether two slices' touch hints may name the same files. Conservative: two
// hints overlap when one's anchor contains the other's. Slices without hints
// declare nothing, so they never overlap.
export function touchHintsOverlap(a: string[], b: string[]): boolean {
  const within = (path: string, dir: string) =>
    path === dir ||
    path.startsWith(dir.endsWith("/") ? dir : `${dir}/`)
  for (const left of a.map(touchHintRoot))
    for (const right of b.map(touchHintRoot)) {
      if (left === "" || right === "") return true
      if (within(left, right) || within(right, left)) return true
    }
  return false
}

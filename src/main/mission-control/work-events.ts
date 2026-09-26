// A change feed for the work map (plan 106.6). Every audited write to an
// feature's milestones, user stories, proposals, or drive state announces the
// feature it touched; the Navigator recomputes its position from SQLite on
// each announcement (debounced), so it never depends on in-memory state.

type Listener = (featureId: string) => void

const listeners = new Set<Listener>()

export function onWorkChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitWorkChanged(featureId: string): void {
  for (const listener of listeners) {
    try {
      listener(featureId)
    } catch (err) {
      console.error("Work change listener failed:", err)
    }
  }
}

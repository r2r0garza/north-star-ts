// A change feed for the work map (plan 106.6). Every audited write to an
// initiative's missions, slices, proposals, or drive state announces the
// initiative it touched; the Navigator recomputes its position from SQLite on
// each announcement (debounced), so it never depends on in-memory state.

type Listener = (initiativeId: string) => void

const listeners = new Set<Listener>()

export function onWorkChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitWorkChanged(initiativeId: string): void {
  for (const listener of listeners) {
    try {
      listener(initiativeId)
    } catch (err) {
      console.error("Work change listener failed:", err)
    }
  }
}

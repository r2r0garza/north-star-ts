// A tiny change feed for Comms (plan 106.4): anything that writes seat mail or
// seat-session state announces the initiative it touched, and the main process
// forwards that to the renderer so the Comms tab refreshes live.

type Listener = (initiativeId: string) => void

const listeners = new Set<Listener>()

export function onCommsChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitCommsChanged(initiativeId: string): void {
  for (const listener of listeners) {
    try {
      listener(initiativeId)
    } catch (err) {
      console.error("Comms change listener failed:", err)
    }
  }
}

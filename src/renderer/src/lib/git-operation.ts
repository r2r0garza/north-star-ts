import { useSyncExternalStore } from "react"

const counts = new Map<string, number>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export async function runGitMutation<T>(
  workspace: string,
  operation: () => Promise<T>
): Promise<T> {
  const path = workspace.trim()
  counts.set(path, (counts.get(path) ?? 0) + 1)
  notify()
  try {
    return await operation()
  } finally {
    const next = (counts.get(path) ?? 1) - 1
    if (next > 0) counts.set(path, next)
    else counts.delete(path)
    notify()
  }
}

export function useGitMutationBusy(workspace: string): boolean {
  const path = workspace.trim()
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => (counts.get(path) ?? 0) > 0,
    () => false
  )
}

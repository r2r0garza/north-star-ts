import { useCallback, useSyncExternalStore } from "react"
import type { GitStatusResult } from "@/types"

const FALLBACK_INTERVAL_MS = 15_000

type GitStatusSnapshot = {
  status: GitStatusResult | null
  loading: boolean
}

type GitStatusEntry = {
  snapshot: GitStatusSnapshot
  listeners: Set<() => void>
  inFlight: Promise<void> | null
  refreshQueued: boolean
  interval: number | null
  onFocus: () => void
  onVisibilityChange: () => void
  onGitStateChanged: () => void
}

const EMPTY_SNAPSHOT: GitStatusSnapshot = { status: null, loading: false }
const entries = new Map<string, GitStatusEntry>()

function canPoll(): boolean {
  return document.visibilityState === "visible" && document.hasFocus()
}

function notify(entry: GitStatusEntry): void {
  for (const listener of entry.listeners) listener()
}

function refresh(workspace: string, entry: GitStatusEntry): void {
  if (entry.inFlight) {
    entry.refreshQueued = true
    return
  }

  if (!entry.snapshot.status && !entry.snapshot.loading) {
    entry.snapshot = { ...entry.snapshot, loading: true }
    notify(entry)
  }

  entry.inFlight = window.cowork.git
    .status(workspace)
    .then((status) => {
      entry.snapshot = { status, loading: false }
      notify(entry)
    })
    .catch(() => {
      entry.snapshot = { status: null, loading: false }
      notify(entry)
    })
    .finally(() => {
      entry.inFlight = null
      if (entry.refreshQueued && entry.listeners.size > 0) {
        entry.refreshQueued = false
        refresh(workspace, entry)
      }
    })
}

function createEntry(workspace: string): GitStatusEntry {
  const entry: GitStatusEntry = {
    snapshot: { status: null, loading: true },
    listeners: new Set(),
    inFlight: null,
    refreshQueued: false,
    interval: null,
    onFocus: () => refresh(workspace, entry),
    onVisibilityChange: () => {
      if (document.visibilityState === "visible") refresh(workspace, entry)
    },
    onGitStateChanged: () => refresh(workspace, entry),
  }
  entries.set(workspace, entry)
  return entry
}

function start(workspace: string, entry: GitStatusEntry): void {
  refresh(workspace, entry)
  window.addEventListener("focus", entry.onFocus)
  document.addEventListener("visibilitychange", entry.onVisibilityChange)
  window.addEventListener("git-state-changed", entry.onGitStateChanged)
  entry.interval = window.setInterval(() => {
    if (canPoll()) refresh(workspace, entry)
  }, FALLBACK_INTERVAL_MS)
}

function stop(workspace: string, entry: GitStatusEntry): void {
  window.removeEventListener("focus", entry.onFocus)
  document.removeEventListener("visibilitychange", entry.onVisibilityChange)
  window.removeEventListener("git-state-changed", entry.onGitStateChanged)
  if (entry.interval !== null) window.clearInterval(entry.interval)
  entries.delete(workspace)
}

export function invalidateGitStatus(workspace: string): void {
  const path = workspace.trim()
  const entry = entries.get(path)
  if (entry) refresh(path, entry)
}

export function useGitStatus(workspace: string): GitStatusSnapshot {
  const path = workspace.trim()
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!path) return () => {}
      const entry = entries.get(path) ?? createEntry(path)
      entry.listeners.add(listener)
      if (entry.listeners.size === 1) start(path, entry)
      return () => {
        entry.listeners.delete(listener)
        if (entry.listeners.size === 0) stop(path, entry)
      }
    },
    [path]
  )
  const getSnapshot = useCallback(
    () =>
      path ? (entries.get(path)?.snapshot ?? EMPTY_SNAPSHOT) : EMPTY_SNAPSHOT,
    [path]
  )
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SNAPSHOT)
}

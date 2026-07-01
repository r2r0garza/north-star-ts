import * as React from "react"
import { Play, Pause, X, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { IndexStatus, TaskEventPayload } from "@/types"

// The Indexing section of the Workspace Activity panel (plan 008). Resolves the
// active conversation's workspace, shows the index build's live progress
// (scanned/total + stage), and offers Pause/Resume/Cancel/Clear. Progress rides
// the runner's `task:event` tail (index_progress events); the one-shot
// index:status read paints the initial/reattach state before any live event.

// Live progress overlaid on the status snapshot (from index_progress events).
interface LiveProgress {
  stage: string
  filesScanned: number
  filesTotal: number
}

export function IndexingSection({ conversationId }: { conversationId: string | null }) {
  const [workspaceId, setWorkspaceId] = React.useState<string | null>(null)
  const [status, setStatus] = React.useState<IndexStatus | null>(null)
  const [live, setLive] = React.useState<LiveProgress | null>(null)

  // Resolve the conversation's workspace, then load the index status snapshot.
  const refetch = React.useCallback(async (wsId: string | null) => {
    if (!wsId) {
      setStatus(null)
      return
    }
    setStatus(await window.cowork.index.status(wsId))
  }, [])
  const refetchRef = React.useRef(refetch)
  refetchRef.current = refetch

  React.useEffect(() => {
    let cancelled = false
    setLive(null)
    setStatus(null)
    setWorkspaceId(null)
    if (!conversationId) return
    void (async () => {
      const conv = await window.cowork.db.conversations.get(conversationId)
      if (cancelled) return
      const wsId = conv?.workspaceId ?? null
      setWorkspaceId(wsId)
      await refetchRef.current(wsId)
    })()
    return () => {
      cancelled = true
    }
  }, [conversationId])

  // Live tail: apply index_progress for this workspace's task, refetch the
  // snapshot on any status change (paused/cancelled/completed/running).
  React.useEffect(() => {
    if (!workspaceId) return
    const unsubscribe = window.cowork.tasks.onEvent((payload) => {
      const { taskId, event } = payload
      // Only react to this workspace's index task.
      if (status?.taskId && taskId !== status.taskId) return
      if (event.type === "index_progress") {
        setLive({
          stage: event.stage,
          filesScanned: event.filesScanned,
          filesTotal: event.filesTotal,
        })
      } else if (event.type === "status_change") {
        void refetchRef.current(workspaceId)
      }
    })
    return unsubscribe
  }, [workspaceId, status?.taskId])

  if (!conversationId) {
    return <p className="px-2 py-1.5 text-xs text-muted-foreground">No session selected.</p>
  }
  if (!workspaceId) {
    return <p className="px-2 py-1.5 text-xs text-muted-foreground">No workspace assigned.</p>
  }
  if (!status) {
    return <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</p>
  }
  // Non-null local: the guards above returned when workspaceId was null, but TS
  // doesn't carry that narrowing into the async handlers below.
  const wsId = workspaceId
  if (!status.enabled) {
    return (
      <div className="flex flex-col gap-2 px-1">
        <p className="text-xs text-muted-foreground">Indexing disabled for this workspace.</p>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await window.cowork.index.setEnabled({ workspaceId: wsId, enabled: true })
            await refetch(wsId)
          }}
        >
          Enable indexing
        </Button>
      </div>
    )
  }

  const taskStatus = status.taskStatus
  const scanned = live?.filesScanned ?? status.filesScanned
  const total = live?.filesTotal ?? status.filesTotal
  const stage = live?.stage ?? status.stage ?? "file_map"
  const isRunning = taskStatus === "running" || taskStatus === "queued"
  const isPaused = taskStatus === "paused" || taskStatus === "interrupted"
  const isCancelled = taskStatus === "cancelled"
  const isDone = taskStatus === "completed"
  // Idle = nothing driving a build: no task yet, completed, or cancelled. These
  // states offer a Start/Rebuild action (cancelled keeps its partial index, so a
  // (re)start hash-skips what's already there).
  const isIdle = taskStatus === null || isDone || isCancelled
  // Whether any partial/complete index exists — gates the Clear + "Rebuild" label.
  const hasIndex = scanned > 0

  async function pause() {
    if (status?.taskId) await window.cowork.tasks.pause(status.taskId)
    await refetch(wsId)
  }
  async function resume() {
    if (status?.taskId) await window.cowork.tasks.resume(status.taskId)
    await refetch(wsId)
  }
  async function cancel() {
    if (status?.taskId) await window.cowork.tasks.cancel(status.taskId)
    await refetch(wsId)
  }
  async function start() {
    await window.cowork.index.start({ workspaceId: wsId })
    await refetch(wsId)
  }
  async function clear() {
    await window.cowork.index.clear(wsId)
    setLive(null)
    await refetch(wsId)
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border bg-card p-2.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {isRunning ? <Spinner className="size-3" /> : null}
        <span>
          {isRunning
            ? total > 0
              ? `Indexing… ${scanned} / ${total} files`
              : `Scanning… ${scanned} files`
            : isPaused
              ? "Indexing paused"
              : isCancelled
                ? "Indexing cancelled. Partial index kept."
                : isDone
                  ? `Indexed ${scanned} files`
                  : hasIndex
                    ? `Indexed ${scanned} files`
                    : "Not indexed."}
        </span>
      </div>
      <div className="text-[11px] text-muted-foreground/70">Stage: {stage}</div>

      <div className="flex gap-1">
        {isRunning && (
          <>
            <Button size="sm" variant="outline" onClick={() => void pause()} title="Pause indexing">
              <Pause className="size-3.5" />
              Pause
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => void cancel()}
              title="Cancel indexing"
              aria-label="Cancel indexing"
            >
              <X className="size-3.5" />
            </Button>
          </>
        )}
        {isPaused && (
          <Button size="sm" variant="outline" onClick={() => void resume()} title="Resume indexing">
            <Play className="size-3.5" />
            Resume
          </Button>
        )}
        {isIdle && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void start()}
            title={hasIndex ? "Rebuild the index" : "Start indexing"}
          >
            <Play className="size-3.5" />
            {hasIndex ? "Rebuild" : "Start"}
          </Button>
        )}
        {(isPaused || hasIndex) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void clear()}
            title="Clear the index"
          >
            <Trash2 className="size-3.5" />
            Clear
          </Button>
        )}
      </div>
    </div>
  )
}

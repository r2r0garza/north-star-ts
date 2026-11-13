import { useCallback, useEffect, useRef, useState } from "react"
import {
  ArrowLeft,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { cn } from "@/lib/utils"
import { waitForTask } from "@/components/dashboards-screen"
import type {
  KanbanBoard,
  KanbanBoardGraph,
  KanbanCard,
  KanbanCall,
  KanbanIntakeFilter,
  KanbanSource,
} from "../../../shared/kanban"

// Kanban board view (plan 136.1): read-only. Boards are authored by an agent
// (kanban_write); this view approves the intake recipe, syncs, and shows cards.

function describeFilter(f: KanbanIntakeFilter): string {
  const parts: string[] = f.query ? [`raw query: ${f.query}`] : []
  if (f.tags.length) parts.push(`tags (${f.match}): ${f.tags.join(", ")}`)
  if (f.excludeTags.length) parts.push(`not: ${f.excludeTags.join(", ")}`)
  parts.push(
    f.assignee.mode === "me"
      ? "assigned to me"
      : f.assignee.mode === "user"
        ? `assigned to ${f.assignee.user}`
        : "any assignee"
  )
  return parts.join(" · ")
}

function describeCall(c: { command?: string; tool?: string; args?: unknown }) {
  return c.command ?? `${c.tool} ${JSON.stringify(c.args ?? {})}`
}

// Shows the call as it will actually run, with the filter's query bound in.
function RecipePreview({
  source,
  call,
}: {
  source: KanbanSource
  call: KanbanCall
}) {
  return (
    <div className="flex flex-col gap-1 font-mono text-xs">
      <div className="break-all">{describeCall(call)}</div>
      {source.whoami ? (
        <div className="break-all text-muted-foreground">
          whoami: {describeCall(source.whoami)}
        </div>
      ) : null}
    </div>
  )
}

function Card({ card }: { card: KanbanCard }) {
  const { item } = card
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-md border bg-card p-2.5",
        card.status === "unmatched" && "opacity-60"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs text-muted-foreground">#{item.id}</span>
        {item.url ? (
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${item.title} in tracker`}
          >
            <ExternalLink className="size-3.5 text-muted-foreground hover:text-foreground" />
          </a>
        ) : null}
      </div>
      <p className="text-sm leading-snug">{item.title}</p>
      <div className="flex flex-wrap gap-1">
        {item.type ? <Badge variant="outline">{item.type}</Badge> : null}
        {item.state ? <Badge variant="outline">{item.state}</Badge> : null}
        {item.tags.map((t) => (
          <Badge key={t} variant="secondary">
            {t}
          </Badge>
        ))}
        {card.status === "unmatched" ? (
          <Badge variant="destructive">no longer matches</Badge>
        ) : null}
      </div>
    </div>
  )
}

function Column({ name, cards }: { name: string; cards: KanbanCard[] }) {
  return (
    // Columns share the width; past min-w-56 the board scrolls sideways.
    <section
      aria-label={name}
      className="flex min-h-0 max-w-80 min-w-56 flex-1 flex-col rounded-lg bg-muted/40"
    >
      <div className="flex h-9 shrink-0 items-center justify-between px-3">
        <span className="truncate text-xs font-medium">{name}</span>
        <span className="text-xs text-muted-foreground">{cards.length}</span>
      </div>
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {cards.map((c) => (
          <Card key={c.id} card={c} />
        ))}
      </div>
    </section>
  )
}

export function KanbanScreen({ onClose }: { onClose: () => void }) {
  const [boards, setBoards] = useState<KanbanBoard[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [graph, setGraph] = useState<KanbanBoardGraph | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<KanbanBoard | null>(null)
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedId

  const refreshList = useCallback(async () => {
    const list = await window.cowork.kanban.list()
    setBoards(list)
    setSelectedId((cur) =>
      cur && list.some((b) => b.id === cur) ? cur : (list[0]?.id ?? null)
    )
  }, [])

  const loadGraph = useCallback(async (id: string) => {
    const g = await window.cowork.kanban.graph(id)
    if (selectedRef.current === id) setGraph(g)
  }, [])

  const sync = useCallback(
    async (id: string, silent = false) => {
      setSyncing(true)
      try {
        const taskId = await window.cowork.kanban.sync(id)
        if (taskId) await waitForTask(taskId)
        await loadGraph(id)
        if (!silent) toast.success("Board synced")
      } finally {
        setSyncing(false)
      }
    },
    [loadGraph]
  )

  useEffect(() => {
    void refreshList()
  }, [refreshList])

  // Show stored cards at once, then sync on open and at the board's interval
  // while the screen is open (Decision 5: no background intake).
  const intervalMs =
    graph?.board.id === selectedId ? graph?.board.syncIntervalMs : undefined
  const approved = graph?.approved ?? false
  useEffect(() => {
    if (!selectedId) {
      setGraph(null)
      return
    }
    void loadGraph(selectedId)
  }, [selectedId, loadGraph])
  useEffect(() => {
    if (!selectedId || !approved || !intervalMs) return
    void sync(selectedId, true)
    const timer = setInterval(() => void sync(selectedId, true), intervalMs)
    return () => clearInterval(timer)
  }, [selectedId, approved, intervalMs, sync])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  async function approve() {
    if (!graph?.sourceHash) return
    const result = await window.cowork.kanban.approveSource(
      graph.board.id,
      graph.sourceHash
    )
    if (!result.ok) {
      toast.error(result.reason)
      await loadGraph(graph.board.id)
      return
    }
    toast.success("Intake recipe approved")
    if (result.taskId) await waitForTask(result.taskId)
    await loadGraph(graph.board.id)
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    await window.cowork.kanban.delete(pendingDelete.id)
    setPendingDelete(null)
    await refreshList()
  }

  const board = graph?.board
  const inbox = graph?.cards.filter((c) => c.columnId === null) ?? []

  return (
    <div
      data-slot="kanban-screen"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background pt-11 text-sm text-foreground"
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-4">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close boards"
          className="group/back flex items-center gap-2 rounded-md text-left"
        >
          <ArrowLeft className="size-4 text-muted-foreground transition-colors group-hover/back:text-foreground" />
          <h1 className="font-heading text-base font-medium">Boards</h1>
        </button>
        <Button variant="ghost" size="icon-sm" onClick={onClose}>
          <XIcon />
          <span className="sr-only">Close</span>
        </Button>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex w-60 shrink-0 flex-col border-r">
          <div className="flex h-12 shrink-0 items-center px-3">
            <span className="text-xs font-medium text-muted-foreground">
              Boards
            </span>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-0.5 px-2 pb-2">
              {boards.map((b) => (
                <div
                  key={b.id}
                  className={cn(
                    "group/row flex items-center gap-1 rounded-md px-2 py-1.5",
                    b.id === selectedId
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50"
                  )}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left"
                    onClick={() => setSelectedId(b.id)}
                  >
                    {b.name}
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${b.name}`}
                    onClick={() => setPendingDelete(b)}
                    className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
                  >
                    <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
                  </button>
                </div>
              ))}
              {boards.length === 0 ? (
                <p className="px-2 py-4 text-xs text-muted-foreground">
                  No boards yet. Ask an agent to set one up, e.g. "Make a board
                  from my GitHub issues labeled agent-go."
                </p>
              ) : null}
            </div>
          </ScrollArea>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {board && graph ? (
            <>
              <div className="flex shrink-0 flex-col gap-1 border-b px-4 py-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 truncate font-medium">{board.name}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void sync(board.id)}
                    disabled={syncing || !graph.approved}
                  >
                    <span
                      className={cn("inline-flex", syncing && "animate-spin")}
                    >
                      <RefreshCw className="size-4" />
                    </span>
                    Sync
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {describeFilter(board.filter)}
                  {board.lastSyncAt
                    ? ` · synced ${new Date(board.lastSyncAt).toLocaleTimeString()}`
                    : ""}
                </p>
                {board.lastSyncError && graph.approved ? (
                  <p role="alert" className="text-xs text-destructive">
                    {board.lastSyncError}
                  </p>
                ) : null}
                {graph.intakeError ? (
                  <p role="alert" className="text-xs text-destructive">
                    {graph.intakeError}
                  </p>
                ) : null}
                {!graph.approved && board.source && graph.intakeCall ? (
                  <div className="mt-1 flex items-start justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-2">
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="text-xs font-medium">
                        Approve this intake recipe to sync. It runs on every
                        sync without asking.
                      </span>
                      {board.filter.assignee.mode === "anyone" ? (
                        <span className="text-xs text-destructive">
                          This board pulls items assigned to anyone, including
                          teammates&apos; and unassigned items.
                        </span>
                      ) : null}
                      <RecipePreview
                        source={board.source}
                        call={graph.intakeCall}
                      />
                    </div>
                    <Button size="sm" onClick={approve}>
                      <ShieldCheck className="size-4" />
                      Approve
                    </Button>
                  </div>
                ) : null}
              </div>
              {/* Native overflow: the house ScrollArea is vertical-only. */}
              <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
                <Column name="Inbox" cards={inbox} />
                {graph.columns.map((col) => (
                  <Column
                    key={col.id}
                    name={col.name}
                    cards={graph.cards.filter((c) => c.columnId === col.id)}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
              Select a board.
            </div>
          )}
        </div>
      </div>

      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes the board and its cards from North Star. Nothing changes
              in the tracker.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

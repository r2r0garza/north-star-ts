import { useCallback, useEffect, useRef, useState } from "react"
import {
  ArrowLeft,
  ChevronDown,
  ExternalLink,
  MoreHorizontal,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Trash2,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import { KanbanSettingsSheet } from "@/components/kanban-settings-sheet"
import { cn } from "@/lib/utils"
import { waitForTask } from "@/components/dashboards-screen"
import type {
  KanbanBoard,
  KanbanBoardGraph,
  KanbanCard,
  KanbanCardRun,
  KanbanCall,
  KanbanColumn,
  KanbanIntakeFilter,
  KanbanSource,
} from "../../../shared/kanban"

// Kanban board view (plans 136.1/136.2). Boards are authored by an agent
// (kanban_write) or the settings sheet; this view approves the intake recipe,
// syncs, and moves cards through columns whose agents run unattended.

type Result = { ok: true } | { ok: false; reason: string }
type CardAction =
  | { kind: "move"; columnId: string | null }
  | { kind: "approve" | "reject" | "stop" | "remove" | "history" }
  | { kind: "allow" | "deny" }
  | { kind: FeedbackKind }

type FeedbackKind = "sendBack" | "retry" | "rejectWithFeedback"
const FEEDBACK_TITLE: Record<FeedbackKind, string> = {
  retry: "Rerun this column",
  sendBack: "Send back",
  rejectWithFeedback: "Reject with feedback",
}

const RUN_BADGE: Record<
  KanbanCard["runState"],
  {
    label: string
    variant: "outline" | "secondary" | "destructive" | "default"
  } | null
> = {
  idle: null,
  running: { label: "running", variant: "secondary" },
  waiting: { label: "waiting on you", variant: "default" },
  blocked: { label: "needs you", variant: "default" },
  failed: { label: "failed", variant: "destructive" },
  done: { label: "done", variant: "outline" },
}

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

function CardMenu({
  card,
  columns,
  onAction,
}: {
  card: KanbanCard
  columns: KanbanColumn[]
  onAction: (action: CardAction) => void
}) {
  const running = card.runState === "running"
  const index = columns.findIndex((c) => c.id === card.columnId)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`Actions for #${card.item.id}`}>
          <MoreHorizontal className="size-4 text-muted-foreground hover:text-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {card.runState === "waiting" ? (
          <DropdownMenuItem onSelect={() => onAction({ kind: "approve" })}>
            Approve and move on
          </DropdownMenuItem>
        ) : null}
        {running ? (
          <DropdownMenuItem onSelect={() => onAction({ kind: "stop" })}>
            Stop run
          </DropdownMenuItem>
        ) : null}
        {!running && card.columnId ? (
          <DropdownMenuItem onSelect={() => onAction({ kind: "retry" })}>
            Rerun this column…
          </DropdownMenuItem>
        ) : null}
        {!running && index >= 0 ? (
          <DropdownMenuItem onSelect={() => onAction({ kind: "sendBack" })}>
            Send back to {columns[index - 1]?.name ?? "Inbox"}…
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={running}>
            Move to
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {[{ id: null, name: "Inbox" }, ...columns].map((c) => (
              <DropdownMenuItem
                key={c.id ?? "inbox"}
                disabled={c.id === card.columnId}
                onSelect={() => onAction({ kind: "move", columnId: c.id })}
              >
                {c.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onSelect={() => onAction({ kind: "history" })}>
          Run history
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={running}
          onSelect={() => onAction({ kind: "remove" })}
        >
          Remove from board
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// What a card needs from the user, with the buttons to give it, right on the
// card (not only in the menu).
function CardAttention({
  card,
  onAction,
}: {
  card: KanbanCard
  onAction: (action: CardAction) => void
}) {
  const box = "flex flex-col gap-1.5 rounded-md border p-2 text-xs"
  const row = "flex flex-wrap gap-1.5"
  if (card.pendingApproval)
    return (
      <div className={cn(box, "border-amber-500/40 bg-amber-500/10")}>
        <span className="font-medium">
          The agent wants to: {card.pendingApproval.summary}
        </span>
        <span className="text-muted-foreground">
          {card.pendingApproval.reason}
        </span>
        <div className={row}>
          <Button size="xs" onClick={() => onAction({ kind: "allow" })}>
            Allow
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => onAction({ kind: "deny" })}
          >
            Deny
          </Button>
        </div>
      </div>
    )
  if (card.runState === "waiting")
    return (
      <div className={cn(box, "bg-muted/60")}>
        <span>Done here. Review the result, then approve or reject.</span>
        <div className={row}>
          <Button size="xs" onClick={() => onAction({ kind: "approve" })}>
            Approve
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => onAction({ kind: "rejectWithFeedback" })}
          >
            Reject with feedback
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onAction({ kind: "reject" })}
          >
            Reject
          </Button>
        </div>
      </div>
    )
  if (
    (card.runState === "blocked" || card.runState === "failed") &&
    card.columnId
  )
    return (
      <div
        className={cn(
          box,
          card.runState === "failed"
            ? "border-destructive/40 text-destructive"
            : "border-amber-500/40 bg-amber-500/10"
        )}
      >
        <span className="line-clamp-4 whitespace-pre-wrap">
          {card.runError ??
            (card.runState === "failed"
              ? "The run failed."
              : "The agent is blocked.")}
        </span>
        <div className={row}>
          <Button
            size="xs"
            variant="outline"
            onClick={() => onAction({ kind: "retry" })}
          >
            Rerun…
          </Button>
        </div>
      </div>
    )
  return null
}

function Card({
  card,
  columns,
  onAction,
}: {
  card: KanbanCard
  columns: KanbanColumn[]
  onAction: (action: CardAction) => void
}) {
  const { item } = card
  const badge = card.pendingApproval
    ? ({ label: "needs approval", variant: "default" } as const)
    : RUN_BADGE[card.runState]
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-md border bg-card p-2.5",
        card.status === "unmatched" && "opacity-60"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          #{item.id}
          {card.runState === "running" ? <Spinner className="size-3" /> : null}
        </span>
        <span className="flex items-center gap-1.5">
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
          <CardMenu card={card} columns={columns} onAction={onAction} />
        </span>
      </div>
      <button
        type="button"
        className="text-left text-sm leading-snug hover:underline"
        onClick={() => onAction({ kind: "history" })}
      >
        {item.title}
      </button>
      <CardAttention card={card} onAction={onAction} />
      <div className="flex flex-wrap gap-1">
        {badge ? <Badge variant={badge.variant}>{badge.label}</Badge> : null}
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

function Column({
  name,
  cards,
  columns,
  onAction,
}: {
  name: string
  cards: KanbanCard[]
  columns: KanbanColumn[]
  onAction: (card: KanbanCard, action: CardAction) => void
}) {
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
          <Card
            key={c.id}
            card={c}
            columns={columns}
            onAction={(action) => onAction(c, action)}
          />
        ))}
      </div>
    </section>
  )
}

// A card's runs, newest first, each linking to its transcript.
function RunHistory({
  card,
  onClose,
  onOpenConversation,
}: {
  card: KanbanCard | null
  onClose: () => void
  onOpenConversation: (id: string) => void
}) {
  const [runs, setRuns] = useState<KanbanCardRun[]>([])
  useEffect(() => {
    if (!card) return
    void window.cowork.kanban.runs(card.id).then((r) => setRuns(r.reverse()))
  }, [card])
  return (
    <Sheet open={!!card} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-[28rem] sm:max-w-[28rem]">
        <SheetHeader>
          <SheetTitle>
            #{card?.item.id} {card?.item.title}
          </SheetTitle>
          <SheetDescription>
            {card?.branch ? `Branch ${card.branch}` : "No worktree yet"}
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1 px-4 pb-4">
          <div className="flex flex-col gap-3">
            {runs.length === 0 ? (
              <p className="text-xs text-muted-foreground">No runs yet.</p>
            ) : null}
            {runs.map((r) => (
              <div
                key={r.id}
                className="flex flex-col gap-1 rounded-md border p-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">{r.columnName}</span>
                  <Badge
                    variant={
                      r.status === "failed"
                        ? "destructive"
                        : r.status === "running"
                          ? "secondary"
                          : "outline"
                    }
                  >
                    {r.status}
                  </Badge>
                </div>
                <span className="text-xs text-muted-foreground">
                  {new Date(r.startedAt).toLocaleString()}
                </span>
                {r.result || r.error ? (
                  <p
                    className={cn(
                      "text-xs whitespace-pre-wrap",
                      r.error && "text-destructive"
                    )}
                  >
                    {r.result ?? r.error}
                  </p>
                ) : null}
                {r.conversationId ? (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto self-start p-0 text-xs"
                    onClick={() => onOpenConversation(r.conversationId!)}
                  >
                    Open transcript
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}

// Optional feedback for a rerun or send-back; it leads the agent's prompt.
function FeedbackDialog({
  title,
  required = false,
  onClose,
  onSubmit,
}: {
  title: string | null
  required?: boolean
  onClose: () => void
  onSubmit: (feedback: string) => void
}) {
  const [text, setText] = useState("")
  useEffect(() => setText(""), [title])
  return (
    <Dialog open={!!title} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Textarea
          aria-label="Feedback for the agent"
          placeholder={
            required
              ? "What should the agent change?"
              : "Optional: what should the agent do differently?"
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={required && !text.trim()}
            onClick={() => onSubmit(text)}
          >
            Run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function KanbanScreen({
  onClose,
  onOpenConversation,
}: {
  onClose: () => void
  onOpenConversation: (conversationId: string) => void
}) {
  const [boards, setBoards] = useState<KanbanBoard[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [graph, setGraph] = useState<KanbanBoardGraph | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<KanbanBoard | null>(null)
  const [historyCard, setHistoryCard] = useState<KanbanCard | null>(null)
  const [feedbackFor, setFeedbackFor] = useState<{
    card: KanbanCard
    kind: FeedbackKind
  } | null>(null)
  const [pendingRemove, setPendingRemove] = useState<KanbanCard | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
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

  // Runs advance cards in the background: poll while any card is running.
  const anyRunning = graph?.cards.some((c) => c.runState === "running") ?? false
  useEffect(() => {
    if (!selectedId || !anyRunning) return
    const timer = setInterval(() => void loadGraph(selectedId), 3000)
    return () => clearInterval(timer)
  }, [selectedId, anyRunning, loadGraph])

  async function act(run: Promise<Result>) {
    const result = await run
    if (!result.ok) toast.error(result.reason)
    if (selectedId) await loadGraph(selectedId)
  }

  function onCardAction(card: KanbanCard, action: CardAction) {
    const k = window.cowork.kanban
    if (action.kind === "move") void act(k.moveCard(card.id, action.columnId))
    else if (action.kind === "approve") void act(k.approveCard(card.id))
    else if (action.kind === "reject") void act(k.moveCard(card.id, null))
    else if (action.kind === "allow" || action.kind === "deny")
      void act(
        k.answerApproval(
          card.id,
          action.kind === "allow" ? "approved" : "denied"
        )
      )
    else if (action.kind === "stop") void act(k.stop(card.id))
    else if (action.kind === "remove") setPendingRemove(card)
    else if (action.kind === "history") setHistoryCard(card)
    else setFeedbackFor({ card, kind: action.kind })
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        !e.defaultPrevented &&
        !settingsOpen &&
        !switcherOpen
      ) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose, settingsOpen, switcherOpen])

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
    const result = await window.cowork.kanban.delete(pendingDelete.id)
    if (!result.ok) toast.error(result.reason)
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
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {board && graph ? (
            <>
              <div className="flex shrink-0 flex-col gap-1 border-b px-4 py-2">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Popover open={switcherOpen} onOpenChange={setSwitcherOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        className="h-auto max-w-full min-w-0 justify-between px-2 py-1.5 text-left"
                        aria-label={`Switch board: ${board.name}`}
                      >
                        <span className="truncate font-medium">
                          {board.name}
                        </span>
                        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      align="start"
                      className="w-80 max-w-[calc(100vw-2rem)] p-0"
                    >
                      <Command>
                        <CommandInput
                          placeholder="Search boards…"
                          aria-label="Search boards"
                        />
                        <CommandList>
                          <CommandEmpty>No boards found.</CommandEmpty>
                          {boards.map((b) => (
                            <CommandItem
                              key={b.id}
                              value={b.id}
                              keywords={[b.name]}
                              data-checked={b.id === selectedId}
                              onSelect={() => {
                                setSelectedId(b.id)
                                setSwitcherOpen(false)
                              }}
                            >
                              <span className="min-w-0 break-words">
                                {b.name}
                              </span>
                            </CommandItem>
                          ))}
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSettingsOpen(true)}
                    >
                      <Settings2 className="size-4" />
                      Settings
                    </Button>
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
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Board actions"
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setPendingDelete(board)}
                        >
                          <Trash2 />
                          Delete board
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
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
                <Column
                  name="Inbox"
                  cards={inbox}
                  columns={graph.columns}
                  onAction={onCardAction}
                />
                {graph.columns.map((col) => (
                  <Column
                    key={col.id}
                    name={col.name}
                    cards={graph.cards.filter((c) => c.columnId === col.id)}
                    columns={graph.columns}
                    onAction={onCardAction}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
              {boards.length === 0
                ? 'No boards yet. Ask an agent to set one up, e.g. "Make a board from my GitHub issues labeled agent-go."'
                : "Loading board…"}
            </div>
          )}
        </div>
      </div>

      <RunHistory
        card={historyCard}
        onClose={() => setHistoryCard(null)}
        onOpenConversation={onOpenConversation}
      />
      <FeedbackDialog
        title={feedbackFor ? FEEDBACK_TITLE[feedbackFor.kind] : null}
        required={feedbackFor?.kind === "rejectWithFeedback"}
        onClose={() => setFeedbackFor(null)}
        onSubmit={(feedback) => {
          if (!feedbackFor) return
          const { card, kind } = feedbackFor
          setFeedbackFor(null)
          void act(
            kind !== "sendBack"
              ? window.cowork.kanban.retry(card.id, feedback)
              : window.cowork.kanban.sendBack(card.id, feedback)
          )
        }}
      />
      {graph && settingsOpen ? (
        <KanbanSettingsSheet
          graph={graph}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false)
            void refreshList()
            void loadGraph(graph.board.id)
          }}
        />
      ) : null}
      <AlertDialog
        open={!!pendingRemove}
        onOpenChange={(open) => !open && setPendingRemove(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove #{pendingRemove?.item.id} from the board?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Deletes its worktree and run history here. Its branch is kept, and
              nothing changes in the tracker. A later sync may bring it back to
              the Inbox if it still matches.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingRemove)
                  void act(window.cowork.kanban.removeCard(pendingRemove.id))
                setPendingRemove(null)
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes the board, its cards, and their worktrees from North Star.
              Branches are kept, and nothing changes in the tracker.
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

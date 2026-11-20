import { useCallback, useEffect, useRef, useState } from "react"
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  ArrowLeft,
  Bell,
  ChevronDown,
  Download,
  ExternalLink,
  GripVertical,
  MoreHorizontal,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Trash2,
  Plus,
  Upload,
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
  DropdownMenuCheckboxItem,
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
  DialogDescription,
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
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { KanbanSettingsSheet } from "@/components/kanban-settings-sheet"
import { NewBoardDialog } from "@/components/kanban-new-board-dialog"
import { cn } from "@/lib/utils"
import { waitForTask } from "@/components/dashboards-screen"
import type {
  KanbanBoard,
  KanbanBoardSummary,
  KanbanBoardGraph,
  KanbanCard,
  KanbanCardRun,
  KanbanCall,
  KanbanColumn,
  KanbanIntakeFilter,
  KanbanSource,
  KanbanUpstreamAction,
} from "../../../shared/kanban"
import { cardVars, fillInstructions } from "../../../shared/kanban"

// Kanban board view (plans 136.1/136.2). Boards are authored by an agent
// (kanban_write) or the settings sheet; this view approves the intake recipe,
// syncs, and moves cards through columns whose agents run unattended.

type Result = { ok: true } | { ok: false; reason: string }
type CardAction =
  | { kind: "move"; columnId: string | null }
  | { kind: "approve"; outcome?: string }
  | { kind: "reject" | "stop" | "remove" | "history" | "resume" }
  | { kind: "allow" | "deny" }
  | { kind: "approveAction" | "skipAction"; actionId: string }
  | { kind: "ownWorktree"; value: boolean }
  | { kind: FeedbackKind }

type FeedbackKind = "sendBack" | "retry" | "rejectWithFeedback"
const FEEDBACK_TITLE: Record<FeedbackKind | "move", string> = {
  move: "Move and run",
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
  gated: { label: "waiting on tracker", variant: "outline" },
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
  worktreeDefault,
  onAction,
}: {
  card: KanbanCard
  columns: KanbanColumn[]
  worktreeDefault: boolean | null
  onAction: (action: CardAction) => void
}) {
  const running = card.runState === "running"
  const index = columns.findIndex((c) => c.id === card.columnId)
  // A column command (136.5) is dropped or stopped when its card moves away.
  const locked =
    running && !(columns[index]?.owner === "user" && columns[index]?.command)
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
        {!locked && index >= 0 ? (
          <DropdownMenuItem onSelect={() => onAction({ kind: "sendBack" })}>
            Send back to {columns[index - 1]?.name ?? "Inbox"}…
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={locked}>
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
        {worktreeDefault !== null ? (
          // Fixed once the card has run: its work already lives in one place.
          <DropdownMenuCheckboxItem
            checked={card.ownWorktree ?? worktreeDefault}
            disabled={!!card.started}
            onCheckedChange={(value) =>
              onAction({ kind: "ownWorktree", value: value === true })
            }
          >
            Own worktree
          </DropdownMenuCheckboxItem>
        ) : null}
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
  column,
  onAction,
}: {
  card: KanbanCard
  column: KanbanColumn | undefined
  onAction: (action: CardAction) => void
}) {
  const box = "flex flex-col gap-1.5 rounded-md border p-2 text-xs"
  const row = "flex flex-wrap gap-1.5"
  const [outcome, setOutcome] = useState(card.outcome ?? "")
  useEffect(() => setOutcome(card.outcome ?? ""), [card.outcome])
  const action = card.pendingAction
  if (action && card.runState !== "running")
    return (
      <div className={cn(box, "border-amber-500/40 bg-amber-500/10")}>
        <span className="font-medium">
          Tracker write: {action.actionName}
          <span className="font-normal text-muted-foreground">
            {" "}
            ({action.phase === "enter" ? "entering" : "leaving"}{" "}
            {action.columnName}
            {action.outcome ? `, ${action.outcome}` : ""})
          </span>
        </span>
        <span className="font-mono break-all">{describeCall(action.call)}</span>
        {card.runError ? (
          <span className="text-muted-foreground">{card.runError}</span>
        ) : null}
        <div className={row}>
          {action.approved ? (
            <Button size="xs" onClick={() => onAction({ kind: "resume" })}>
              Retry
            </Button>
          ) : (
            <Button
              size="xs"
              onClick={() =>
                onAction({ kind: "approveAction", actionId: action.id })
              }
            >
              Approve and run
            </Button>
          )}
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              onAction({ kind: "skipAction", actionId: action.id })
            }
          >
            Skip this write
          </Button>
        </div>
      </div>
    )
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
  const mine = column?.owner === "user"
  if (card.runState === "waiting")
    return (
      <div className={cn(box, "bg-muted/60")}>
        {mine && !card.runError ? (
          <>
            <span className="font-medium">Your turn</span>
            {column.instructions ? (
              <span className="line-clamp-6 whitespace-pre-wrap">
                {fillInstructions(column.instructions, cardVars(card))}
              </span>
            ) : null}
          </>
        ) : (
          <span>
            {card.runError ??
              "Done here. Review the result, then approve or reject."}
          </span>
        )}
        {column?.outcomes.length ? (
          <NativeSelect
            size="sm"
            className="w-full"
            aria-label="Outcome"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
          >
            {!outcome ? (
              <NativeSelectOption value="">Pick an outcome…</NativeSelectOption>
            ) : null}
            {column.outcomes.map((o) => (
              <NativeSelectOption key={o.name} value={o.name}>
                {o.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : null}
        <div className={row}>
          <Button
            size="xs"
            disabled={!!column?.outcomes.length && !outcome}
            onClick={() =>
              onAction({ kind: "approve", outcome: outcome || undefined })
            }
          >
            {mine ? "Done" : "Approve"}
          </Button>
          {mine ? null : (
            <Button
              size="xs"
              variant="outline"
              onClick={() => onAction({ kind: "rejectWithFeedback" })}
            >
              Reject with feedback
            </Button>
          )}
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
            onClick={() =>
              onAction({ kind: card.continuation ? "resume" : "retry" })
            }
          >
            {card.continuation ? "Retry" : "Rerun…"}
          </Button>
        </div>
      </div>
    )
  return null
}

function Card({
  card,
  columns,
  worktreeDefault,
  onAction,
}: {
  card: KanbanCard
  columns: KanbanColumn[]
  // The board's worktree setting; null when the workspace has no repos.
  worktreeDefault: boolean | null
  onAction: (action: CardAction) => void
}) {
  const { item } = card
  // Only an idle card can be dragged, by its handle; a running one moves
  // through its menu. A handle keeps the card's own buttons plain buttons.
  const draggable = card.runState !== "running"
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } =
    useDraggable({ id: card.id, disabled: !draggable })
  const badge =
    card.pendingApproval || (card.pendingAction && !card.pendingAction.approved)
      ? ({ label: "needs approval", variant: "default" } as const)
      : card.queued
        ? ({ label: "queued", variant: "outline" } as const)
        : card.runState === "waiting" &&
            columns.find((c) => c.id === card.columnId)?.owner === "user"
          ? ({ label: "your turn", variant: "default" } as const)
          : RUN_BADGE[card.runState]
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex flex-col gap-1.5 rounded-md border bg-card p-2.5",
        card.status === "unmatched" && "opacity-60",
        isDragging && "opacity-40"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {draggable ? (
            <button
              type="button"
              ref={setActivatorNodeRef}
              {...attributes}
              {...listeners}
              aria-label={`Drag #${item.id} to another column`}
              className="-ml-1 cursor-grab touch-none rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing"
            >
              <GripVertical className="size-3.5" />
            </button>
          ) : null}
          #{item.id}
          {card.runState === "running" && !card.queued ? (
            <Spinner className="size-3" />
          ) : null}
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
          <CardMenu
            card={card}
            columns={columns}
            worktreeDefault={worktreeDefault}
            onAction={onAction}
          />
        </span>
      </div>
      <button
        type="button"
        className="text-left text-sm leading-snug hover:underline"
        onClick={() => onAction({ kind: "history" })}
      >
        {item.title}
      </button>
      <CardAttention
        card={card}
        column={columns.find((c) => c.id === card.columnId)}
        onAction={onAction}
      />
      <div className="flex flex-wrap gap-1">
        {badge ? <Badge variant={badge.variant}>{badge.label}</Badge> : null}
        {card.repos.map((r) => (
          <Badge key={r.path} variant="outline" title={`On ${r.branch}`}>
            {r.path}
          </Badge>
        ))}
        {item.type ? <Badge variant="outline">{item.type}</Badge> : null}
        {item.state ? <Badge variant="outline">{item.state}</Badge> : null}
        {card.outcome ? (
          <Badge variant="outline">outcome: {card.outcome}</Badge>
        ) : null}
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

// Drop-target id for the Inbox (a column id otherwise).
const INBOX_DROP_ID = "inbox"

function Column({
  id,
  name,
  cards,
  columns,
  worktreeDefault,
  onAction,
}: {
  id: string | null // null = Inbox
  name: string
  cards: KanbanCard[]
  columns: KanbanColumn[]
  worktreeDefault: boolean | null
  onAction: (card: KanbanCard, action: CardAction) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: id ?? INBOX_DROP_ID })
  return (
    // Columns share the width; past min-w-56 the board scrolls sideways.
    <section
      ref={setNodeRef}
      aria-label={name}
      className={cn(
        "flex min-h-0 max-w-80 min-w-56 flex-1 flex-col rounded-lg bg-muted/40",
        isOver && "ring-2 ring-primary/40"
      )}
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
            worktreeDefault={worktreeDefault}
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
  const [writes, setWrites] = useState<KanbanUpstreamAction[]>([])
  useEffect(() => {
    if (!card) return
    void window.cowork.kanban.runs(card.id).then((r) => setRuns(r.reverse()))
    void window.cowork.kanban
      .actions(card.id)
      .then((a) => setWrites(a.reverse()))
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
                  <span className="text-xs font-medium">
                    {r.columnName}
                    {r.outcome ? (
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        · {r.outcome}
                      </span>
                    ) : null}
                  </span>
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
            {writes.length ? (
              <h3 className="mt-2 text-xs font-medium">Tracker writes</h3>
            ) : null}
            {writes.map((w) => (
              <div
                key={w.id}
                className="flex flex-col gap-1 rounded-md border p-2.5 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {w.actionName}
                    <span className="font-normal text-muted-foreground">
                      {" "}
                      · {w.columnName}
                      {w.outcome ? ` · ${w.outcome}` : ""}
                    </span>
                  </span>
                  <Badge
                    variant={
                      w.status === "failed"
                        ? "destructive"
                        : w.status === "pending"
                          ? "secondary"
                          : "outline"
                    }
                  >
                    {w.status}
                  </Badge>
                </div>
                <span className="text-muted-foreground">
                  {new Date(w.createdAt).toLocaleString()}
                </span>
                <span className="font-mono break-all">
                  {describeCall(w.call)}
                </span>
                {w.error || w.output ? (
                  <p
                    className={cn(
                      "line-clamp-6 whitespace-pre-wrap",
                      w.error && "text-destructive"
                    )}
                  >
                    {w.error ?? w.output}
                  </p>
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
// `command` set: the target column runs a command, so the person may edit it
// for this one run instead of giving an agent feedback.
function FeedbackDialog({
  title,
  required = false,
  command,
  onClose,
  onSubmit,
}: {
  title: string | null
  required?: boolean
  command?: string
  onClose: () => void
  onSubmit: (text: string) => void
}) {
  const [text, setText] = useState("")
  const runRef = useRef<HTMLButtonElement>(null)
  useEffect(() => setText(command ?? ""), [title, command])
  return (
    <Dialog open={!!title} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        // A command usually runs as is: Enter runs it; Tab reaches the text.
        onOpenAutoFocus={(e) => {
          if (command === undefined) return
          e.preventDefault()
          runRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {command !== undefined ? (
            <DialogDescription>
              Edit the command for this card's run only. The column's command
              stays as is for other cards.
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <Textarea
          aria-label={
            command !== undefined
              ? "Command for this run"
              : "Feedback for the agent"
          }
          className={command !== undefined ? "font-mono text-xs" : undefined}
          placeholder={
            command !== undefined
              ? "The command to run"
              : required
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
            ref={runRef}
            disabled={(required || command !== undefined) && !text.trim()}
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
  const [boards, setBoards] = useState<KanbanBoardSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [graph, setGraph] = useState<KanbanBoardGraph | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<KanbanBoard | null>(null)
  const [historyCard, setHistoryCard] = useState<KanbanCard | null>(null)
  const [feedbackFor, setFeedbackFor] = useState<{
    card: KanbanCard
    kind: FeedbackKind | "move"
    columnId?: string | null // a move's target
    command?: string // the target column's command, to edit for this run
  } | null>(null)
  const [pendingRemove, setPendingRemove] = useState<KanbanCard | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedId

  const refreshList = useCallback(async () => {
    const list = (await window.cowork.kanban.list()).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    )
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
    const timer = setInterval(() => void refreshList(), 3000)
    return () => clearInterval(timer)
  }, [refreshList])

  // Show stored cards at once. With background sync on (Settings → Behavior),
  // main syncs every approved board and this screen just reloads; off, it
  // syncs the open board on open and at its interval.
  const [backgroundSync, setBackgroundSync] = useState<boolean | null>(null)
  useEffect(() => {
    // A failed read falls back to syncing from this screen.
    void Promise.resolve()
      .then(() => window.cowork.settings.getConversations())
      .then((s) => setBackgroundSync(s.syncBoardsInBackground !== false))
      .catch(() => setBackgroundSync(false))
  }, [])
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
    if (!selectedId || !approved || !intervalMs || backgroundSync !== false)
      return
    void sync(selectedId, true)
    const timer = setInterval(() => void sync(selectedId, true), intervalMs)
    return () => clearInterval(timer)
  }, [selectedId, approved, intervalMs, backgroundSync, sync])
  useEffect(() => {
    if (!selectedId || !backgroundSync) return
    const timer = setInterval(() => void loadGraph(selectedId), 15_000)
    return () => clearInterval(timer)
  }, [selectedId, backgroundSync, loadGraph])

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

  // The command a user column runs, if any: the person may edit it per run.
  const commandOf = (columnId: string | null | undefined) => {
    const column = graph?.columns.find((c) => c.id === columnId)
    return column?.owner === "user" ? column.command || undefined : undefined
  }

  function onCardAction(card: KanbanCard, action: CardAction) {
    const k = window.cowork.kanban
    if (action.kind === "move") {
      const command = commandOf(action.columnId)
      // Back into a command column the card ran in: offer to edit the command.
      if (command && action.columnId && card.visits[action.columnId])
        setFeedbackFor({
          card,
          kind: "move",
          columnId: action.columnId,
          command,
        })
      else void act(k.moveCard(card.id, action.columnId))
    } else if (action.kind === "approve")
      void act(k.approveCard(card.id, action.outcome))
    else if (action.kind === "approveAction")
      void act(k.approveAction(card.id, action.actionId))
    else if (action.kind === "skipAction")
      void act(k.skipAction(card.id, action.actionId))
    else if (action.kind === "resume") void act(k.retry(card.id))
    else if (action.kind === "reject") void act(k.moveCard(card.id, null))
    else if (action.kind === "allow" || action.kind === "deny")
      void act(
        k.answerApproval(
          card.id,
          action.kind === "allow" ? "approved" : "denied"
        )
      )
    else if (action.kind === "stop") void act(k.stop(card.id))
    else if (action.kind === "ownWorktree")
      void act(k.setOwnWorktree(card.id, action.value))
    else if (action.kind === "remove") setPendingRemove(card)
    else if (action.kind === "history") setHistoryCard(card)
    else {
      const columns = graph?.columns ?? []
      const index = columns.findIndex((c) => c.id === card.columnId)
      const target =
        action.kind === "retry"
          ? card.columnId
          : action.kind === "sendBack"
            ? (columns[index - 1]?.id ?? null)
            : null
      setFeedbackFor({ card, kind: action.kind, command: commandOf(target) })
    }
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

  async function exportBoard(id: string) {
    const result = await window.cowork.kanban.exportFile(id)
    if (!result.ok) toast.error(result.reason)
    else if (!result.canceled) toast.success("Board exported")
  }

  async function importBoard() {
    const result = await window.cowork.kanban.importFile()
    if (!result.ok) {
      toast.error(result.reason)
      return
    }
    if (result.canceled || !result.boardId) return
    await refreshList()
    setSelectedId(result.boardId)
    toast.success(
      `Imported "${result.name}". Check its filter, then approve the intake recipe.`
    )
  }

  const board = graph?.board
  const inbox = graph?.cards.filter((c) => c.columnId === null) ?? []
  // Drag and drop: the same move as the card's "Move to" menu (idle cards only).
  // The distance lets a click on the card's buttons through.
  const dragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  )
  const [dragging, setDragging] = useState<string | null>(null)
  const draggedCard = graph?.cards.find((c) => c.id === dragging) ?? null
  const onCardDrop = ({ active, over }: DragEndEvent) => {
    setDragging(null)
    const card = graph?.cards.find((c) => c.id === active.id)
    if (!card || !over || card.runState === "running") return
    const columnId = over.id === INBOX_DROP_ID ? null : String(over.id)
    if (columnId !== card.columnId)
      onCardAction(card, { kind: "move", columnId })
  }
  // null hides the card's "Own worktree" toggle: no repos to make one from.
  const worktreeDefault =
    graph && graph.layout !== "none" ? graph.board.worktrees : null

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
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setNewOpen(true)}>
            <Plus className="size-4" />
            New board
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void importBoard()}
          >
            <Upload className="size-4" />
            Import board
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <XIcon />
            <span className="sr-only">Close</span>
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {board && graph ? (
            <>
              <div className="flex shrink-0 flex-col gap-1 border-b px-4 py-2">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                    <Popover open={switcherOpen} onOpenChange={setSwitcherOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          variant="ghost"
                          className="h-auto max-w-full min-w-0 justify-between px-2 py-1.5 text-left"
                          aria-label={`Switch board: ${board.name}`}
                        >
                          {boards.find((b) => b.id === board.id)
                            ?.needsAttention ? (
                            <Bell
                              className="size-4 shrink-0 fill-current text-orange-600 dark:text-orange-400"
                              aria-label="Needs your attention"
                            />
                          ) : null}
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
                                {b.needsAttention ? (
                                  <Bell
                                    className="size-4 shrink-0 fill-current text-orange-600 dark:text-orange-400"
                                    aria-label="Needs your attention"
                                  />
                                ) : null}
                                <span className="min-w-0 break-words">
                                  {b.name}
                                </span>
                              </CommandItem>
                            ))}
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                    <span
                      className="min-w-0 truncate text-xs text-muted-foreground"
                      title={board.workspace ?? undefined}
                    >
                      {board.workspace
                        ? `Workspace: ${board.workspace}`
                        : "No workspace"}
                    </span>
                  </div>
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
                          onSelect={() => void exportBoard(board.id)}
                        >
                          <Download />
                          Export board
                        </DropdownMenuItem>
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
              <DndContext
                sensors={dragSensors}
                onDragStart={(e) => setDragging(String(e.active.id))}
                onDragCancel={() => setDragging(null)}
                onDragEnd={onCardDrop}
              >
                <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
                  <Column
                    id={null}
                    name="Inbox"
                    cards={inbox}
                    columns={graph.columns}
                    worktreeDefault={worktreeDefault}
                    onAction={onCardAction}
                  />
                  {graph.columns.map((col) => (
                    <Column
                      key={col.id}
                      id={col.id}
                      name={col.name}
                      cards={graph.cards.filter((c) => c.columnId === col.id)}
                      columns={graph.columns}
                      worktreeDefault={worktreeDefault}
                      onAction={onCardAction}
                    />
                  ))}
                </div>
                {/* A floating copy: the columns scroll, so the card itself would be clipped. */}
                <DragOverlay>
                  {draggedCard ? (
                    <div className="flex max-w-72 flex-col gap-1 rounded-md border bg-card p-2.5 shadow-lg">
                      <span className="text-xs text-muted-foreground">
                        #{draggedCard.item.id}
                      </span>
                      <span className="text-sm leading-snug">
                        {draggedCard.item.title}
                      </span>
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
              {boards.length === 0
                ? 'No boards yet. Create one with New board, import one, or ask an agent to set one up, e.g. "Make a board from my GitHub issues labeled agent-go."'
                : "Loading board…"}
            </div>
          )}
        </div>
      </div>

      <NewBoardDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={(boardId) => {
          void refreshList().then(() => setSelectedId(boardId))
          toast.success("Board created. Add columns in its settings.")
        }}
      />
      <RunHistory
        card={historyCard}
        onClose={() => setHistoryCard(null)}
        onOpenConversation={onOpenConversation}
      />
      <FeedbackDialog
        title={feedbackFor ? FEEDBACK_TITLE[feedbackFor.kind] : null}
        required={feedbackFor?.kind === "rejectWithFeedback"}
        command={feedbackFor?.command}
        onClose={() => setFeedbackFor(null)}
        onSubmit={(text) => {
          if (!feedbackFor) return
          const { card, kind, columnId, command } = feedbackFor
          setFeedbackFor(null)
          const k = window.cowork.kanban
          // Unchanged: run the column's own command.
          const edited =
            command !== undefined && text.trim() !== command.trim()
              ? text
              : undefined
          const feedback = command === undefined ? text : undefined
          void act(
            kind === "move"
              ? k.moveCard(card.id, columnId ?? null, edited)
              : kind === "sendBack"
                ? k.sendBack(card.id, feedback, edited)
                : k.retry(card.id, feedback, edited)
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

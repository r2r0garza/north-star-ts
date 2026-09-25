import { useCallback, useEffect, useMemo, useState } from "react"
import { ChevronDown, ChevronRight, MessagesSquare, Send } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn, formatRelativeTime } from "@/lib/utils"
import type {
  InitiativeGraph,
  SeatMessage,
  SeatOverview,
  SeatThread,
} from "@/types"
import { SeatsPanel } from "./seats-panel"
import {
  SeatTranscriptDialog,
  type TranscriptTarget,
} from "./seat-transcript-dialog"
import { SteerDialog } from "./steer-dialog"

// Comms (plan 106.4): the observation deck for everything seats say to each
// other on an initiative. Read-only for agent threads — no composer inside
// them, no typing indicators, no reactions. The user's one write is Steer.

const USER_ADDRESS = "user@rig"
const PAGE = 200

export function useComms(initiativeId: string) {
  const [threads, setThreads] = useState<SeatThread[]>([])
  const [messages, setMessages] = useState<SeatMessage[]>([])
  const [seats, setSeats] = useState<SeatOverview[]>([])
  const reload = useCallback(async () => {
    const [feed, overview] = await Promise.all([
      window.cowork.missionControl.comms.list(initiativeId),
      window.cowork.missionControl.comms.seats(initiativeId),
    ])
    setThreads(feed.threads)
    setMessages(feed.messages)
    setSeats(overview)
  }, [initiativeId])
  useEffect(() => {
    void reload()
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = window.cowork.missionControl.comms.onChanged((changed) => {
      if (changed !== initiativeId) return
      clearTimeout(timer)
      timer = setTimeout(() => void reload(), 150)
    })
    return () => {
      off()
      clearTimeout(timer)
    }
  }, [initiativeId, reload])
  return { threads, messages, seats, reload }
}

type Anchor = { kind: "slice" | "mission"; id: string }

function anchorLabel(graph: InitiativeGraph, thread: SeatThread): string | null {
  if (thread.anchorKind === "slice") {
    const slice = graph.slices.find((s) => s.id === thread.anchorId)
    return slice ? `slice ${slice.key}` : "slice (deleted)"
  }
  if (thread.anchorKind === "mission") {
    const mission = graph.missions.find((m) => m.id === thread.anchorId)
    return mission ? `mission ${mission.key}` : "mission (deleted)"
  }
  return null
}

const STATUS_VARIANT: Record<
  SeatMessage["status"],
  "default" | "secondary" | "outline" | "destructive"
> = {
  queued: "outline",
  delivered: "secondary",
  replied: "secondary",
  acknowledged: "secondary",
  expired: "outline",
  refused: "destructive",
}

export function MessageCard({
  message,
  compact = false,
  onOpenTranscript,
}: {
  message: SeatMessage
  compact?: boolean
  onOpenTranscript: (target: TranscriptTarget) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const steer = message.kind === "steer"
  const fromUser = message.fromAddress === USER_ADDRESS
  const long = message.body.length > 400 || message.body.split("\n").length > 6
  return (
    <div
      className={cn(
        "rounded-md border p-3 text-sm",
        steer && "border-primary/50 bg-primary/5",
        message.kind === "escalation" && "border-amber-500/50 bg-amber-500/5",
        message.status === "refused" && "border-destructive/40 bg-destructive/5"
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="font-mono font-medium">
          {fromUser ? "You (user@rig)" : message.fromAddress}
        </span>
        <span className="text-muted-foreground">→</span>
        <span className="font-mono">
          {message.toAddress === USER_ADDRESS ? "You (user@rig)" : message.toAddress}
        </span>
        {message.kind !== "message" && (
          <Badge variant={steer ? "default" : "outline"} className="text-[10px]">
            {message.kind}
          </Badge>
        )}
        <Badge variant={STATUS_VARIANT[message.status]} className="text-[10px]">
          {message.status}
        </Badge>
        {message.expectsReply && message.status !== "replied" && (
          <Badge variant="outline" className="text-[10px]">
            expects reply
          </Badge>
        )}
        {message.answerOnly && (
          <Badge variant="outline" className="text-[10px]">
            answer-only
          </Badge>
        )}
        {message.needsDecision && (
          <Badge variant="outline" className="text-[10px]">
            needs {message.needsDecision}
          </Badge>
        )}
        {message.hop > 0 && (
          <span className="text-muted-foreground">hop {message.hop}</span>
        )}
        <span className="ml-auto text-muted-foreground">
          {formatRelativeTime(message.createdAt)}
        </span>
      </div>
      <p
        className={cn(
          "mt-2 whitespace-pre-wrap break-words",
          !expanded && long && (compact ? "line-clamp-3" : "line-clamp-6")
        )}
      >
        {message.body}
      </p>
      {long && (
        <button
          className="mt-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show all"}
        </button>
      )}
      {message.status === "refused" && message.refusalReason && (
        <p className="mt-2 text-xs text-destructive">
          Refused: {message.refusalReason}
        </p>
      )}
      {message.deliveredConversationId && (
        <Button
          size="sm"
          variant="ghost"
          className="mt-1 -ml-2 h-6 px-2 text-xs text-muted-foreground"
          onClick={() =>
            onOpenTranscript({
              conversationId: message.deliveredConversationId!,
              title: `${message.toAddress}'s transcript`,
              focusMessageId: message.deliveredMessageId,
            })
          }
        >
          Open in seat transcript
        </Button>
      )}
    </div>
  )
}

function ThreadGroup({
  graph,
  thread,
  messages,
  onOpenAnchor,
  onOpenTranscript,
}: {
  graph: InitiativeGraph
  thread: SeatThread
  messages: SeatMessage[]
  onOpenAnchor: (anchor: Anchor) => void
  onOpenTranscript: (target: TranscriptTarget) => void
}) {
  const anchor = anchorLabel(graph, thread)
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <MessagesSquare className="size-3.5" />
        <span className="truncate font-medium text-foreground">
          {thread.subject}
        </span>
        {anchor && thread.anchorId && (
          <button
            className="rounded border px-1.5 py-0.5 font-mono text-[10px] hover:bg-muted"
            onClick={() =>
              onOpenAnchor({
                kind: thread.anchorKind as Anchor["kind"],
                id: thread.anchorId!,
              })
            }
          >
            {anchor}
          </button>
        )}
      </div>
      <div className="space-y-2 border-l pl-3">
        {messages.map((message) => (
          <MessageCard
            key={message.id}
            message={message}
            onOpenTranscript={onOpenTranscript}
          />
        ))}
      </div>
    </div>
  )
}

export function CommsTab({
  graph,
  onOpenAnchor,
}: {
  graph: InitiativeGraph
  onOpenAnchor: (anchor: Anchor) => void
}) {
  const initiativeId = graph.initiative.id
  const { threads, messages, seats, reload } = useComms(initiativeId)
  const [pod, setPod] = useState("all")
  const [seat, setSeat] = useState("all")
  const [kind, setKind] = useState("all")
  const [anchor, setAnchor] = useState("all")
  const [since, setSince] = useState("all")
  const [limit, setLimit] = useState(PAGE)
  const [steerOpen, setSteerOpen] = useState(false)
  const [steerTarget, setSteerTarget] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<TranscriptTarget | null>(null)

  const podOf = useMemo(() => {
    const map = new Map(seats.map((s) => [s.address, s.podKey]))
    map.set(USER_ADDRESS, "rig")
    return map
  }, [seats])
  const threadById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads]
  )
  const pods = useMemo(
    () => [...new Map(seats.map((s) => [s.podKey, s.podName])).entries()],
    [seats]
  )

  const filtered = useMemo(() => {
    const cutoff =
      since === "1h"
        ? Date.now() - 3_600_000
        : since === "24h"
          ? Date.now() - 86_400_000
          : 0
    return messages.filter((message) => {
      if (message.createdAt < cutoff) return false
      if (kind === "refused") {
        if (message.status !== "refused") return false
      } else if (kind !== "all" && message.kind !== kind) return false
      if (
        seat !== "all" &&
        message.fromAddress !== seat &&
        message.toAddress !== seat
      )
        return false
      if (
        pod !== "all" &&
        podOf.get(message.fromAddress) !== pod &&
        podOf.get(message.toAddress) !== pod
      )
        return false
      if (anchor !== "all") {
        const thread = threadById.get(message.threadId)
        const key = thread?.anchorKind
          ? `${thread.anchorKind}:${thread.anchorId}`
          : "none"
        if (key !== anchor) return false
      }
      return true
    })
  }, [messages, since, kind, seat, pod, anchor, podOf, threadById])

  const visible = filtered.slice(-limit)
  // Threads in the order of their latest visible message: the newest activity
  // sits at the bottom, like a feed.
  const groups = useMemo(() => {
    const byThread = new Map<string, SeatMessage[]>()
    for (const message of visible) {
      const list = byThread.get(message.threadId) ?? []
      list.push(message)
      byThread.set(message.threadId, list)
    }
    return [...byThread.entries()]
      .map(([threadId, list]) => ({ thread: threadById.get(threadId), list }))
      .filter((group): group is { thread: SeatThread; list: SeatMessage[] } =>
        !!group.thread
      )
      .sort((a, b) => a.list.at(-1)!.createdAt - b.list.at(-1)!.createdAt)
  }, [visible, threadById])

  const anchors = useMemo(() => {
    const keys = new Set(
      threads
        .filter((t) => t.anchorKind)
        .map((t) => `${t.anchorKind}:${t.anchorId}`)
    )
    return [...keys].map((key) => {
      const [kindKey, id] = key.split(":")
      const label =
        kindKey === "slice"
          ? `slice ${graph.slices.find((s) => s.id === id)?.key ?? "(deleted)"}`
          : `mission ${graph.missions.find((m) => m.id === id)?.key ?? "(deleted)"}`
      return { key, label }
    })
  }, [threads, graph])

  const openSteer = (target: string | null) => {
    setSteerTarget(target)
    setSteerOpen(true)
  }

  const active = graph.initiative.status === "active"

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <FilterSelect
            value={pod}
            onChange={setPod}
            label="Pod"
            options={[
              ["all", "All pods"],
              ...pods,
              ["rig", "Rig (user)"],
            ]}
          />
          <FilterSelect
            value={seat}
            onChange={setSeat}
            label="Seat"
            options={[
              ["all", "All seats"],
              ...seats.map((s) => [s.address, s.address] as [string, string]),
              [USER_ADDRESS, "You (user@rig)"],
            ]}
          />
          <FilterSelect
            value={kind}
            onChange={setKind}
            label="Kind"
            options={[
              ["all", "All kinds"],
              ["message", "Messages"],
              ["steer", "Steer"],
              ["escalation", "Escalations"],
              ["direction", "Directions"],
              ["alert", "Alerts"],
              ["refused", "Refused only"],
            ]}
          />
          <FilterSelect
            value={anchor}
            onChange={setAnchor}
            label="Anchor"
            options={[
              ["all", "Any work"],
              ["none", "Unanchored"],
              ...anchors.map((a) => [a.key, a.label] as [string, string]),
            ]}
          />
          <FilterSelect
            value={since}
            onChange={setSince}
            label="Time"
            options={[
              ["all", "All time"],
              ["24h", "Last 24 hours"],
              ["1h", "Last hour"],
            ]}
          />
          <Button
            size="sm"
            className="ml-auto"
            disabled={!active}
            title={active ? undefined : "Start the initiative to steer its seats."}
            onClick={() => openSteer(null)}
          >
            <Send className="size-3.5" /> Steer
          </Button>
        </div>

        {messages.length === 0 ? (
          <div className="grid place-items-center rounded-xl border border-dashed py-14 text-center">
            <MessagesSquare className="mb-3 size-8 text-muted-foreground" />
            <h3 className="font-medium">No messages yet</h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              When seats message each other during a run, every exchange shows
              up here. Use Steer to send a lead a message of your own.
            </p>
          </div>
        ) : groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No messages match these filters.
          </p>
        ) : (
          <div className="space-y-5">
            {filtered.length > visible.length && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLimit(limit + PAGE)}
              >
                Show earlier ({filtered.length - visible.length} more)
              </Button>
            )}
            {groups.map(({ thread, list }) => (
              <ThreadGroup
                key={thread.id}
                graph={graph}
                thread={thread}
                messages={list}
                onOpenAnchor={onOpenAnchor}
                onOpenTranscript={setTranscript}
              />
            ))}
          </div>
        )}
      </div>
      <SeatsPanel
        seats={seats}
        onOpenTranscript={setTranscript}
        onSteer={(address) => openSteer(address)}
        onChanged={() => void reload()}
      />
      <SteerDialog
        open={steerOpen}
        initiativeId={initiativeId}
        seats={seats}
        initialTarget={steerTarget}
        onOpenChange={setSteerOpen}
        onSent={() => void reload()}
      />
      <SeatTranscriptDialog
        target={transcript}
        onClose={() => setTranscript(null)}
      />
    </div>
  )
}

function FilterSelect({
  value,
  onChange,
  label,
  options,
}: {
  value: string
  onChange: (value: string) => void
  label: string
  options: Array<[string, string]>
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className="text-xs" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([optionValue, optionLabel]) => (
          <SelectItem key={optionValue} value={optionValue}>
            {optionLabel}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// A compact "Comms (n)" section for a slice or mission view: the threads
// anchored to that work (a mission also includes its slices' threads).
export function AnchoredComms({
  graph,
  anchor,
}: {
  graph: InitiativeGraph
  anchor: Anchor
}) {
  const { threads, messages } = useComms(graph.initiative.id)
  const [open, setOpen] = useState(false)
  const [transcript, setTranscript] = useState<TranscriptTarget | null>(null)
  const anchored = useMemo(() => {
    const ids = new Set([anchor.id])
    if (anchor.kind === "mission")
      for (const slice of graph.slices)
        if (slice.missionId === anchor.id) ids.add(slice.id)
    const threadIds = new Set(
      threads
        .filter((thread) => thread.anchorId && ids.has(thread.anchorId))
        .map((thread) => thread.id)
    )
    return messages.filter((message) => threadIds.has(message.threadId))
  }, [anchor, graph.slices, threads, messages])

  return (
    <div className="rounded-md border">
      <button
        className="flex w-full items-center gap-2 p-3 text-left text-sm font-medium"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="size-4" />
        ) : (
          <ChevronRight className="size-4" />
        )}
        Comms ({anchored.length})
      </button>
      {open && (
        <div className="space-y-2 border-t p-3">
          {anchored.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No seat messages about this {anchor.kind} yet.
            </p>
          ) : (
            anchored
              .slice(-20)
              .map((message) => (
                <MessageCard
                  key={message.id}
                  message={message}
                  compact
                  onOpenTranscript={setTranscript}
                />
              ))
          )}
        </div>
      )}
      <SeatTranscriptDialog
        target={transcript}
        onClose={() => setTranscript(null)}
      />
    </div>
  )
}

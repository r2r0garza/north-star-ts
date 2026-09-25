import { useEffect, useRef, useState } from "react"
import { Wrench } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Markdown } from "@/components/markdown"
import { cn } from "@/lib/utils"
import type { Message } from "@/types"
import {
  formatSeatMessageEvent,
  isSeatMessageEvent,
} from "../../../../shared/runtime-messages"

// A read-only view of a seat's transcript (plan 106.4): the session or worker
// conversation a message was delivered into, scrolled to the tagged turn.
// Observation only — there is no composer here.

export interface TranscriptTarget {
  conversationId: string
  title: string
  focusMessageId?: string | null
}

export function SeatTranscriptDialog({
  target,
  onClose,
}: {
  target: TranscriptTarget | null
  onClose: () => void
}) {
  const [rows, setRows] = useState<Message[] | null>(null)
  const focusRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setRows(null)
    if (!target) return
    let live = true
    void window.cowork.db.messages
      .list(target.conversationId)
      .then((next) => live && setRows(next))
      .catch(() => live && setRows([]))
    return () => {
      live = false
    }
  }, [target])

  useEffect(() => {
    if (rows && target?.focusMessageId)
      focusRef.current?.scrollIntoView({ block: "center" })
  }, [rows, target?.focusMessageId])

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{target?.title}</DialogTitle>
          <DialogDescription>
            Read-only. Incoming seat mail is shown as attributed cards.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-2 flex-1 space-y-3 overflow-y-auto px-2">
          {rows === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This transcript is empty or was deleted.
            </p>
          ) : (
            rows.map((row) => {
              const focused = row.id === target?.focusMessageId
              return (
                <div
                  key={row.id}
                  ref={focused ? focusRef : undefined}
                  className={cn(
                    "rounded-md border p-3",
                    focused && "border-primary ring-1 ring-primary/40"
                  )}
                >
                  <TranscriptRow row={row} />
                </div>
              )
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TranscriptRow({ row }: { row: Message }) {
  if (row.role === "tool")
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Wrench className="size-3" />
        <span className="font-mono">{row.toolName ?? "tool"}</span>
        <span className="truncate">result</span>
      </div>
    )
  const seatMail = row.role === "user" && isSeatMessageEvent(row.content)
  const label = seatMail
    ? "incoming mail"
    : row.role === "user"
      ? "kickoff"
      : row.role
  return (
    <div className="space-y-2">
      <Badge variant={seatMail ? "default" : "outline"} className="text-[10px]">
        {label}
      </Badge>
      {row.content?.trim() && (
        <Markdown
          content={seatMail ? formatSeatMessageEvent(row.content!) : row.content!}
        />
      )}
      {row.toolCalls?.map((call) => (
        <div
          key={call.id}
          className="flex items-center gap-2 text-xs text-muted-foreground"
        >
          <Wrench className="size-3" />
          <span className="font-mono">{call.name}</span>
        </div>
      ))}
    </div>
  )
}

import { useState } from "react"
import { ChevronDown, ChevronRight, RefreshCw, Send } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatRelativeTime } from "@/lib/utils"
import type { SeatOverview, SeatSession } from "@/types"
import type { TranscriptTarget } from "./seat-transcript-dialog"

// The Seats side panel of Comms (plan 106.4): every seat on the initiative's
// rig with its live session (idle/busy), generation, inbox depth, and last
// activity. Rotate starts the next generation with a bounded handoff; older
// generations stay readable.

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^\w*Error:\s*/, "")
}

function stateOf(seat: SeatOverview): {
  label: string
  variant: "default" | "secondary" | "outline"
} {
  if (seat.vacant) return { label: "vacant", variant: "outline" }
  if (seat.busy) return { label: "busy", variant: "default" }
  if (seat.wake === "running") return { label: "waking", variant: "default" }
  if (seat.wake === "queued") return { label: "wake queued", variant: "outline" }
  if (seat.held) return { label: "mail held", variant: "outline" }
  if (seat.session) return { label: "idle", variant: "secondary" }
  return { label: "no session", variant: "outline" }
}

export function SeatsPanel({
  seats,
  onOpenTranscript,
  onSteer,
  onChanged,
}: {
  seats: SeatOverview[]
  onOpenTranscript: (target: TranscriptTarget) => void
  onSteer: (address: string) => void
  onChanged: () => void
}) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [rotating, setRotating] = useState<string | null>(null)

  const rotate = async (session: SeatSession) => {
    if (
      !window.confirm(
        `Rotate ${session.seatAddress}? This session is retired and a new one starts with a short handoff, not the full transcript.`
      )
    )
      return
    setRotating(session.id)
    try {
      await window.cowork.missionControl.comms.rotate(session.id)
      toast.success(`${session.seatAddress} rotated`)
      onChanged()
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setRotating(null)
    }
  }

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Seats</h3>
      {seats.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Start the initiative to seat its rig.
        </p>
      )}
      {seats.map((seat) => {
        const state = stateOf(seat)
        const open = expanded === seat.address
        const retired = seat.generations.filter((g) => g.id !== seat.session?.id)
        const lastActivity = seat.session?.lastActivityAt ?? null
        return (
          <div key={seat.address} className="rounded-md border p-2.5 text-xs">
            <div className="flex items-center gap-1.5">
              <button
                className="flex min-w-0 items-center gap-1 font-mono text-[11px] font-medium"
                onClick={() => setExpanded(open ? null : seat.address)}
                aria-expanded={open}
              >
                {retired.length > 0 ? (
                  open ? (
                    <ChevronDown className="size-3 shrink-0" />
                  ) : (
                    <ChevronRight className="size-3 shrink-0" />
                  )
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <span className="truncate">{seat.address}</span>
              </button>
              {seat.isLead && (
                <Badge variant="outline" className="text-[10px]">
                  lead
                </Badge>
              )}
              <Badge variant={state.variant} className="ml-auto text-[10px]">
                {state.label}
              </Badge>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 pl-4 text-muted-foreground">
              {seat.session && <span>{seat.session.label}</span>}
              <span>inbox {seat.inboxDepth}</span>
              {lastActivity && <span>{formatRelativeTime(lastActivity)}</span>}
            </div>
            {seat.held && !seat.busy && (
              <p className="mt-1 pl-4 text-muted-foreground">
                Mail waits for this seat&apos;s next playbook step.
              </p>
            )}
            {seat.lastWakeError && (
              <p className="mt-1 pl-4 text-destructive">
                Last wake failed: {seat.lastWakeError}
              </p>
            )}
            {!seat.vacant && (
              <div className="mt-2 flex gap-1 pl-4">
                {seat.session?.conversationId && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    onClick={() =>
                      onOpenTranscript({
                        conversationId: seat.session!.conversationId!,
                        title: `${seat.address} · ${seat.session!.label}`,
                      })
                    }
                  >
                    Transcript
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => onSteer(seat.address)}
                >
                  <Send className="size-3" /> Steer
                </Button>
                {seat.session && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    disabled={seat.busy || rotating === seat.session.id}
                    title={
                      seat.busy
                        ? "A turn is running in this seat. Rotate after it ends."
                        : undefined
                    }
                    onClick={() => void rotate(seat.session!)}
                  >
                    <RefreshCw className="size-3" /> Rotate
                  </Button>
                )}
              </div>
            )}
            {open && retired.length > 0 && (
              <div className="mt-2 space-y-1 border-t pt-2 pl-4">
                {retired.map((generation) => (
                  <button
                    key={generation.id}
                    className="block w-full truncate text-left text-muted-foreground hover:text-foreground disabled:opacity-60"
                    disabled={!generation.conversationId}
                    onClick={() =>
                      generation.conversationId &&
                      onOpenTranscript({
                        conversationId: generation.conversationId,
                        title: `${seat.address} · ${generation.label} (${generation.status})`,
                      })
                    }
                  >
                    {generation.label} · {generation.status}
                    {generation.rotationReason
                      ? ` — ${generation.rotationReason}`
                      : ""}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

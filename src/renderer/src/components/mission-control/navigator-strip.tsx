import { useCallback, useEffect, useState } from "react"
import { ChevronDown, ChevronRight, Navigation } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { NavigatorTick, Position } from "@/types"

// The Navigator's view of an initiative (plan 106.6): its current position,
// next maneuver, and tick log. Position and ticks are read from main; every
// recorded tick (and every merge-queue change) refreshes them.

export interface NavigatorState {
  position: Position | null
  ticks: NavigatorTick[]
  reload: () => Promise<void>
}

export function useNavigator(initiativeId: string): NavigatorState {
  const [position, setPosition] = useState<Position | null>(null)
  const [ticks, setTicks] = useState<NavigatorTick[]>([])
  const reload = useCallback(async () => {
    const [nextPosition, nextTicks] = await Promise.all([
      window.cowork.missionControl.navigator.position(initiativeId),
      window.cowork.missionControl.navigator.ticks(initiativeId, 50),
    ])
    setPosition(nextPosition)
    setTicks(nextTicks)
  }, [initiativeId])
  useEffect(() => {
    setPosition(null)
    setTicks([])
    void reload().catch(() => {})
    const refresh = (changed: string) => {
      if (changed === initiativeId) void reload().catch(() => {})
    }
    const offNavigator = window.cowork.missionControl.navigator.onChanged(refresh)
    const offComms = window.cowork.missionControl.comms.onChanged(refresh)
    return () => {
      offNavigator()
      offComms()
    }
  }, [initiativeId, reload])
  return { position, ticks, reload }
}

const MODE_LABEL: Record<string, string> = {
  manual: "Manual",
  copilot: "Co-pilot",
  autopilot: "Autopilot",
}

function time(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function TickRow({ tick }: { tick: NavigatorTick }) {
  return (
    <div className="border-l pl-3 text-xs">
      <div className="flex gap-2 text-muted-foreground">
        <span className="shrink-0 tabular-nums">{time(tick.createdAt)}</span>
        <span className="min-w-0 text-foreground">{tick.summary}</span>
      </div>
      {tick.actions.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {tick.actions.map((action, index) => (
            <Badge
              key={index}
              variant={action.ok ? "outline" : "destructive"}
              title={action.detail}
              className="max-w-full truncate font-normal"
            >
              {action.kind.replace(/_/g, " ")}
              {action.target && action.kind !== "direction" ? ` ${action.target}` : ""}
              {action.ok ? "" : " failed"}
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}

// Every slice state, so a slice never disappears from the count (a slice
// waiting on a merge or held back by overlapping files is still work).
function summaryParts(position: Position, m: NonNullable<Position["mission"]>): string[] {
  const live = m.waves.flat().filter((id) => position.slices[id]?.status !== "cancelled")
  const failed = live.filter(
    (id) => position.slices[id]?.status === "failed" && !m.retryable.includes(id)
  ).length
  // Held back: ready (or retryable) but waiting for capacity or files.
  const held = new Set(position.deferred.map((d) => d.slice))
  const parts: Array<[number, string]> = [
    [m.done.length, "done"],
    [m.running.length, "running"],
    [m.integrating.length, "merging"],
    [m.ready.filter((id) => !held.has(id)).length, "ready"],
    [held.size, "held back"],
    [m.waiting.length, "waiting on merges"],
    [m.retryable.filter((id) => !held.has(id)).length, "to retry"],
    [failed, "failed"],
    [m.blocked.length, "blocked"],
  ]
  return [
    ...parts
      .filter(([count, label]) => count > 0 || ["done", "running", "ready"].includes(label))
      .map(([count, label]) => `${Math.max(0, count)} ${label}`),
    `${live.length} total`,
  ]
}

export function NavigatorStrip({
  state,
  missionId,
}: {
  state: NavigatorState
  // On a mission view: say so when another mission is the active one.
  missionId?: string
}) {
  const [open, setOpen] = useState(false)
  const { position, ticks } = state
  if (!position) return null
  const m = position.mission
  const key = (id: string) => position.slices[id]?.key ?? id
  const elsewhere = missionId && m && m.id !== missionId
  return (
    <div className="rounded-lg border bg-muted/30 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Navigation className="size-4 text-primary" />
        <span className="font-medium">Navigator</span>
        <Badge variant="outline">{MODE_LABEL[position.initiative.driveMode]}</Badge>
        {m ? (
          <span className="text-muted-foreground">
            Milestone <code>{m.key}</code> ({m.status}) ·{" "}
            {summaryParts(position, m).join(" · ")}
          </span>
        ) : (
          <span className="text-muted-foreground">
            {position.initiative.complete ? "Every milestone is complete." : "No active milestone."}
          </span>
        )}
      </div>
      {elsewhere && (
        <p className="mt-2 text-xs text-muted-foreground">
          This isn't the active mission; missions run in order.
        </p>
      )}
      <div className="mt-2">
        <span className="text-muted-foreground">Next: </span>
        {position.maneuver.text}
        {((position.initiative.driveMode === "manual" &&
          ["dispatch", "complete_mission"].includes(position.maneuver.kind)) ||
          (position.initiative.driveMode !== "autopilot" &&
            position.maneuver.kind === "run_hook")) && (
          <span className="text-muted-foreground"> (you run it)</span>
        )}
        {position.initiative.driveMode === "copilot" &&
          position.maneuver.kind === "dispatch" && (
            <span className="text-muted-foreground"> (the lead starts it)</span>
          )}
      </div>
      {position.deferred.length > 0 && (
        <div className="mt-1 text-xs text-muted-foreground">
          Waiting:{" "}
          {position.deferred.map((d) => `${key(d.slice)} (${d.reason})`).join("; ")}
        </div>
      )}
      {m && m.waiting.length > 0 && (
        <div className="mt-1 text-xs text-muted-foreground">
          After merges:{" "}
          {m.waiting.map((w) => `${key(w.slice)} after ${w.on.map(key).join(", ")}`).join("; ")}
        </div>
      )}
      {ticks.length > 0 && (
        <div className="mt-3 space-y-2">
          <button
            type="button"
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
          >
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {open ? "Tick log" : "Recent ticks"}
          </button>
          {(open ? ticks : ticks.slice(0, 3)).map((tick) => (
            <TickRow key={tick.id} tick={tick} />
          ))}
        </div>
      )}
    </div>
  )
}

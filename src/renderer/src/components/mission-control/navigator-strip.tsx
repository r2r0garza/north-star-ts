import { useCallback, useEffect, useState } from "react"
import { ChevronDown, ChevronRight, Navigation } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { NavigatorTick, Position } from "@/types"

// The Navigator's view of a feature (plan 106.6): its current position,
// next maneuver, and tick log. Position and ticks are read from main; every
// recorded tick (and every merge-queue change) refreshes them.

export interface NavigatorState {
  position: Position | null
  ticks: NavigatorTick[]
  reload: () => Promise<void>
}

export function useNavigator(featureId: string): NavigatorState {
  const [position, setPosition] = useState<Position | null>(null)
  const [ticks, setTicks] = useState<NavigatorTick[]>([])
  const reload = useCallback(async () => {
    const [nextPosition, nextTicks] = await Promise.all([
      window.cowork.missionControl.navigator.position(featureId),
      window.cowork.missionControl.navigator.ticks(featureId, 50),
    ])
    setPosition(nextPosition)
    setTicks(nextTicks)
  }, [featureId])
  useEffect(() => {
    setPosition(null)
    setTicks([])
    void reload().catch(() => {})
    const refresh = (changed: string) => {
      if (changed === featureId) void reload().catch(() => {})
    }
    const offNavigator = window.cowork.missionControl.navigator.onChanged(refresh)
    const offComms = window.cowork.missionControl.comms.onChanged(refresh)
    return () => {
      offNavigator()
      offComms()
    }
  }, [featureId, reload])
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

// Every user story state, so a user story never disappears from the count (a user story
// waiting on a merge or held back by overlapping files is still work).
function summaryParts(position: Position, m: NonNullable<Position["milestone"]>): string[] {
  const live = m.waves.flat().filter((id) => position.userStories[id]?.status !== "cancelled")
  const failed = live.filter(
    (id) => position.userStories[id]?.status === "failed" && !m.retryable.includes(id)
  ).length
  // Held back: ready (or retryable) but waiting for capacity or files.
  const held = new Set(position.deferred.map((d) => d.userStory))
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
  milestoneId,
}: {
  state: NavigatorState
  // On a milestone view: say so when another milestone is the active one.
  milestoneId?: string
}) {
  const [open, setOpen] = useState(false)
  const { position, ticks } = state
  if (!position) return null
  const m = position.milestone
  const key = (id: string) => position.userStories[id]?.key ?? id
  const elsewhere = milestoneId && m && m.id !== milestoneId
  return (
    <div className="rounded-lg border bg-muted/30 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Navigation className="size-4 text-primary" />
        <span className="font-medium">Navigator</span>
        <Badge variant="outline">{MODE_LABEL[position.feature.driveMode]}</Badge>
        {m ? (
          <span className="text-muted-foreground">
            Milestone <code>{m.key}</code> ({m.status}) ·{" "}
            {summaryParts(position, m).join(" · ")}
          </span>
        ) : (
          <span className="text-muted-foreground">
            {position.feature.complete ? "Every milestone is complete." : "No active milestone."}
          </span>
        )}
      </div>
      {elsewhere && (
        <p className="mt-2 text-xs text-muted-foreground">
          This isn't the active milestone; milestones run in order.
        </p>
      )}
      <div className="mt-2">
        <span className="text-muted-foreground">Next: </span>
        {position.maneuver.text}
        {((position.feature.driveMode === "manual" &&
          ["dispatch", "complete_milestone"].includes(position.maneuver.kind)) ||
          (position.feature.driveMode !== "autopilot" &&
            position.maneuver.kind === "run_hook")) && (
          <span className="text-muted-foreground"> (you run it)</span>
        )}
        {position.feature.driveMode === "copilot" &&
          position.maneuver.kind === "dispatch" && (
            <span className="text-muted-foreground"> (the lead starts it)</span>
          )}
      </div>
      {position.deferred.length > 0 && (
        <div className="mt-1 text-xs text-muted-foreground">
          Waiting:{" "}
          {position.deferred.map((d) => `${key(d.userStory)} (${d.reason})`).join("; ")}
        </div>
      )}
      {m && m.waiting.length > 0 && (
        <div className="mt-1 text-xs text-muted-foreground">
          After merges:{" "}
          {m.waiting.map((w) => `${key(w.userStory)} after ${w.on.map(key).join(", ")}`).join("; ")}
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

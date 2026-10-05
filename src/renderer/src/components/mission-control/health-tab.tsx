import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  BellOff,
  Check,
  ChevronDown,
  ChevronRight,
  Info,
  PauseCircle,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { cn, formatRelativeTime } from "@/lib/utils"
import {
  HEALTH_DETECTORS,
  HEALTH_SETTING_SPECS,
  detectorLabel,
} from "../../../../shared/mission-control/health-weights"
import type {
  BreakdownRow,
  FeatureGraph,
  HealthAnchors,
  HealthEvidence,
  HealthReport,
  HealthSeverity,
  HealthSignal,
  HealthStatus,
  SeriesPoint,
} from "@/types"

// Health (plan 106.8): is the team moving the map, or just busy? Progress vs
// ceremony over time, the signals the detectors raised with their evidence,
// and where the ceremony comes from, per pod and per seat.

type Anchor = { kind: "user_story" | "milestone"; id: string }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useHealth(featureId: string) {
  const [report, setReport] = useState<HealthReport | null>(null)
  const reload = useCallback(async () => {
    try {
      setReport(await window.cowork.missionControl.health.report(featureId))
    } catch (error) {
      console.warn("[health] report failed:", error)
    }
  }, [featureId])
  useEffect(() => {
    void reload()
    let timer: ReturnType<typeof setTimeout> | undefined
    const soon = (changed: string) => {
      if (changed !== featureId) return
      clearTimeout(timer)
      timer = setTimeout(() => void reload(), 300)
    }
    const offs = [
      window.cowork.missionControl.health.onChanged(soon),
      window.cowork.missionControl.comms.onChanged(soon),
      window.cowork.missionControl.navigator.onChanged(soon),
    ]
    // Time since progress moves even when nothing is recorded.
    const every = setInterval(() => void reload(), 30_000)
    return () => {
      for (const off of offs) off()
      clearTimeout(timer)
      clearInterval(every)
    }
  }, [featureId, reload])
  return { report, reload, setReport }
}

// User story / milestone id → worst live severity, for the small dots.
export function useHealthAnchors(featureId: string): HealthAnchors {
  const [anchors, setAnchors] = useState<HealthAnchors>({})
  useEffect(() => {
    let live = true
    const load = () =>
      window.cowork.missionControl.health
        .anchors(featureId)
        .then((next) => live && setAnchors(next))
        .catch(() => {})
    void load()
    const off = window.cowork.missionControl.health.onChanged((changed) => {
      if (changed === featureId) void load()
    })
    return () => {
      live = false
      off()
    }
  }, [featureId])
  return anchors
}

const SEVERITY: Record<
  HealthSeverity,
  { label: string; icon: typeof Info; className: string }
> = {
  info: { label: "Info", icon: Info, className: "text-muted-foreground" },
  warn: {
    label: "Warning",
    icon: AlertTriangle,
    className: "text-amber-600 dark:text-amber-500",
  },
  critical: {
    label: "Critical",
    icon: AlertOctagon,
    className: "text-destructive",
  },
}

// A small status dot for an anchored signal (user story / milestone views).
export function HealthDot({
  severity,
  className,
}: {
  severity: HealthSeverity | undefined
  className?: string
}) {
  if (!severity || severity === "info") return null
  const spec = SEVERITY[severity]
  const Icon = spec.icon
  return (
    <span
      className={cn("inline-flex shrink-0", spec.className, className)}
      title={`Health: ${spec.label.toLowerCase()} (see the Health tab)`}
      aria-label={`Health ${spec.label.toLowerCase()}`}
    >
      <Icon className="size-3.5" />
    </span>
  )
}

const STATUS: Record<
  HealthStatus,
  { label: string; help: string; icon: typeof Info; className: string }
> = {
  idle: {
    label: "Not started",
    help: "Health is measured once the feature starts.",
    icon: Activity,
    className: "text-muted-foreground",
  },
  healthy: {
    label: "Healthy",
    help: "No warnings. Ceremony and progress are in proportion.",
    icon: Check,
    className: "text-emerald-600 dark:text-emerald-500",
  },
  watch: {
    label: "Watch",
    help: "A detector raised a warning; the lead was alerted.",
    icon: AlertTriangle,
    className: "text-amber-600 dark:text-amber-500",
  },
  degraded: {
    label: "Degraded",
    help: "A critical signal is open.",
    icon: AlertOctagon,
    className: "text-destructive",
  },
  paused_by_health: {
    label: "Paused by health",
    help: "A critical signal paused the feature. Review it, then resume.",
    icon: PauseCircle,
    className: "text-destructive",
  },
}

function duration(ms: number | null): string {
  if (ms === null) return "—"
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `${hours} h ${minutes % 60} min`
}

function number(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

// ── progress vs ceremony sparkline ──────────────────────────────────────────

const PROGRESS = "var(--health-progress)"
const CEREMONY = "var(--health-ceremony)"

function Sparkline({
  title,
  points,
}: {
  title: string
  points: SeriesPoint[]
}) {
  const [hover, setHover] = useState<number | null>(null)
  const width = 280
  const height = 64
  const pad = 4
  const max = Math.max(1, ...points.flatMap((p) => [p.progress, p.ceremony]))
  const x = (i: number) =>
    pad +
    (points.length <= 1 ? 0 : (i / (points.length - 1)) * (width - 2 * pad))
  const y = (v: number) => height - pad - (v / max) * (height - 2 * pad)
  const path = (key: "progress" | "ceremony") =>
    points
      .map(
        (p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`
      )
      .join(" ")
  const last = points.at(-1)
  const shown = hover !== null ? points[hover] : null
  const time = (t: number) =>
    new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  return (
    <figure className="min-w-0 flex-1">
      <figcaption className="mb-1 flex items-baseline gap-3 text-xs">
        <span className="font-medium">{title}</span>
        <span className="ml-auto flex items-center gap-1 text-muted-foreground">
          <span
            className="inline-block h-0.5 w-3 rounded"
            style={{ background: PROGRESS }}
          />
          Progress
        </span>
        <span className="flex items-center gap-1 text-muted-foreground">
          <span
            className="inline-block h-0.5 w-3 rounded"
            style={{ background: CEREMONY }}
          />
          Ceremony
        </span>
      </figcaption>
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-16 w-full"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${title}: progress and ceremony weight over time`}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            const ratio = (event.clientX - box.left) / box.width
            setHover(
              Math.max(
                0,
                Math.min(
                  points.length - 1,
                  Math.round(ratio * (points.length - 1))
                )
              )
            )
          }}
        >
          <line
            x1={pad}
            x2={width - pad}
            y1={height - pad}
            y2={height - pad}
            className="stroke-border"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          {hover !== null && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={pad}
              y2={height - pad}
              className="stroke-muted-foreground/50"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {(["ceremony", "progress"] as const).map((key) => (
            <path
              key={key}
              d={path(key)}
              fill="none"
              stroke={key === "progress" ? PROGRESS : CEREMONY}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {shown && (
          <div className="pointer-events-none absolute -top-2 left-1/2 -translate-x-1/2 -translate-y-full rounded-md border bg-popover px-2 py-1 text-xs shadow-sm">
            <div className="text-muted-foreground">
              {time(shown.start)}–{time(shown.end)}
            </div>
            <div>
              Progress {number(shown.progress)} · Ceremony{" "}
              {number(shown.ceremony)}
            </div>
          </div>
        )}
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th>From</th>
            <th>Progress</th>
            <th>Ceremony</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.start}>
              <td>{time(p.start)}</td>
              <td>{number(p.progress)}</td>
              <td>{number(p.ceremony)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {last && (
        <div className="mt-1 text-xs text-muted-foreground">
          Latest bucket: progress {number(last.progress)}, ceremony{" "}
          {number(last.ceremony)}
        </div>
      )}
    </figure>
  )
}

// ── signals ─────────────────────────────────────────────────────────────────

function EvidenceList({
  evidence,
  onOpenAnchor,
  onOpenComms,
}: {
  evidence: HealthEvidence[]
  onOpenAnchor: (anchor: Anchor) => void
  onOpenComms: () => void
}) {
  if (!evidence.length)
    return <p className="text-xs text-muted-foreground">No evidence items.</p>
  return (
    <ul className="space-y-1 text-xs">
      {evidence.map((item, index) => (
        <li key={`${item.refId ?? ""}:${index}`} className="flex gap-2">
          <span className="min-w-0 flex-1 break-words">{item.label}</span>
          {item.at !== null && (
            <span className="shrink-0 text-muted-foreground">
              {formatRelativeTime(item.at)}
            </span>
          )}
          {item.link && (
            <button
              className="shrink-0 text-primary underline-offset-2 hover:underline"
              onClick={() =>
                item.link!.kind === "thread"
                  ? onOpenComms()
                  : onOpenAnchor({
                      kind: item.link!.kind as Anchor["kind"],
                      id: item.link!.id,
                    })
              }
            >
              {item.link.kind === "thread" ? "Comms" : "Open"}
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

function SignalRow({
  signal,
  onChanged,
  onOpenAnchor,
  onOpenComms,
}: {
  signal: HealthSignal
  onChanged: () => void
  onOpenAnchor: (anchor: Anchor) => void
  onOpenComms: () => void
}) {
  const [open, setOpen] = useState(false)
  const severity = SEVERITY[signal.severity]
  const Icon = severity.icon
  const act = (action: "acknowledge" | "resolve" | "mute" | "unmute") =>
    window.cowork.missionControl.health
      .setSignalStatus(signal.id, action)
      .then(onChanged)
      .catch((error) => toast.error(errorMessage(error)))
  const live = signal.status === "open" || signal.status === "acknowledged"
  return (
    <div className="rounded-md border">
      <div className="flex items-start gap-2 px-3 py-2 text-sm">
        <button
          className="mt-0.5 shrink-0 text-muted-foreground"
          aria-label={open ? "Hide evidence" : "Show evidence"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
        </button>
        <span
          className={cn(
            "mt-0.5 flex shrink-0 items-center gap-1",
            severity.className
          )}
        >
          <Icon className="size-4" />
          <span className="sr-only">{severity.label}</span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">
              {detectorLabel(signal.detector)}
            </span>
            <span className="text-muted-foreground">
              · {signal.anchorLabel}
            </span>
            <Badge variant="outline" className="h-5 text-[11px]">
              {signal.status}
            </Badge>
            {signal.criticalAt && (
              <Badge variant="destructive" className="h-5 text-[11px]">
                paused the feature
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-muted-foreground">{signal.summary}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            First seen {formatRelativeTime(signal.firstSeenAt)} · last seen{" "}
            {formatRelativeTime(signal.lastSeenAt)}
            {signal.alertedTo && <> · alerted {signal.alertedTo}</>}
            {signal.refocusCount > 0 && <> · {signal.refocusCount} Refocus</>}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          {signal.status === "open" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void act("acknowledge")}
            >
              Acknowledge
            </Button>
          )}
          {live && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void act("resolve")}
            >
              Resolve
            </Button>
          )}
          {signal.status === "muted" ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void act("unmute")}
            >
              Unmute
            </Button>
          ) : (
            live && (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Mute this signal"
                title="Mute this signal"
                onClick={() => void act("mute")}
              >
                <BellOff className="size-4" />
              </Button>
            )
          )}
        </div>
      </div>
      {open && (
        <div className="border-t bg-muted/30 px-3 py-2 pl-12">
          <EvidenceList
            evidence={signal.evidence}
            onOpenAnchor={onOpenAnchor}
            onOpenComms={onOpenComms}
          />
        </div>
      )}
    </div>
  )
}

function BreakdownTable({
  title,
  rows,
}: {
  title: string
  rows: BreakdownRow[]
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 text-xs font-medium text-muted-foreground">
        {title}
      </div>
      {rows.length ? (
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="text-left">
              <th className="py-1 font-normal">
                {title === "Pods" ? "Pod" : "Seat"}
              </th>
              <th className="py-1 text-right font-normal">Ratio</th>
              <th className="py-1 text-right font-normal">Messages</th>
              <th className="py-1 text-right font-normal">Progress</th>
              <th className="py-1 text-right font-normal">Busy</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((row) => (
              <tr key={row.key} className="border-t">
                <td className="max-w-40 truncate py-1">{row.key}</td>
                <td className="py-1 text-right">
                  {row.progress || row.ceremony ? number(row.ratio) : "—"}
                </td>
                <td className="py-1 text-right">{row.messages}</td>
                <td className="py-1 text-right">{row.progressEvents}</td>
                <td className="py-1 text-right">{duration(row.busyMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-xs text-muted-foreground">Nothing recorded yet.</p>
      )}
    </div>
  )
}

// ── settings ────────────────────────────────────────────────────────────────

function HealthSettingsDialog({
  graph,
  report,
  open,
  onOpenChange,
  onGraph,
  onReport,
}: {
  graph: FeatureGraph
  report: HealthReport
  open: boolean
  onOpenChange: (open: boolean) => void
  onGraph: (graph: FeatureGraph) => void
  onReport: (report: HealthReport) => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!open) return
    const next: Record<string, string> = {}
    for (const spec of HEALTH_SETTING_SPECS) {
      const value = graph.feature.budgets[spec.key]
      next[spec.key] = typeof value === "number" ? String(value) : ""
    }
    setValues(next)
  }, [open, graph.feature.budgets])
  const save = async () => {
    const patch: Record<string, number | null> = {}
    for (const spec of HEALTH_SETTING_SPECS) {
      const raw = values[spec.key]?.trim() ?? ""
      if (!raw) patch[spec.key] = null
      else {
        const value = Number(raw)
        if (!Number.isInteger(value) || value < 0) {
          toast.error(`${spec.label} must be a whole number of 0 or more.`)
          return
        }
        patch[spec.key] = value
      }
    }
    setSaving(true)
    try {
      onGraph(
        await window.cowork.missionControl.drive.setBudgets(
          graph.feature.id,
          patch
        )
      )
      onOpenChange(false)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }
  const mute = (detector: string, muted: boolean) =>
    window.cowork.missionControl.health
      .muteDetector(graph.feature.id, detector, muted)
      .then(onReport)
      .catch((error) => toast.error(errorMessage(error)))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Health settings</DialogTitle>
          <DialogDescription>
            Thresholds for this feature's detectors. Leave a field empty for its
            default.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {HEALTH_SETTING_SPECS.map((spec) => (
            <div
              key={spec.key}
              className="grid grid-cols-[1fr_7rem] items-center gap-3"
            >
              <div>
                <Label htmlFor={`health-${spec.key}`}>{spec.label}</Label>
                <p className="text-xs text-muted-foreground">{spec.help}</p>
              </div>
              <Input
                id={`health-${spec.key}`}
                inputMode="numeric"
                placeholder={String(spec.default)}
                value={values[spec.key] ?? ""}
                onChange={(e) =>
                  setValues((current) => ({
                    ...current,
                    [spec.key]: e.target.value,
                  }))
                }
              />
            </div>
          ))}
          <p className="pt-2 text-xs font-medium text-muted-foreground">
            Detectors
          </p>
          {HEALTH_DETECTORS.map((detector) => (
            <div
              key={detector.key}
              className="grid grid-cols-[1fr_auto] items-center gap-3"
            >
              <div>
                <Label htmlFor={`detector-${detector.key}`}>
                  {detector.label}{" "}
                  <span className="font-normal text-muted-foreground">
                    · {detector.pathology}
                  </span>
                </Label>
                <p className="text-xs text-muted-foreground">
                  {detector.description}
                </p>
              </div>
              <Switch
                id={`detector-${detector.key}`}
                checked={!report.muted.includes(detector.key)}
                onCheckedChange={(checked) => void mute(detector.key, !checked)}
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            Save thresholds
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── the tab ─────────────────────────────────────────────────────────────────

export function HealthTab({
  graph,
  onGraph,
  onOpenAnchor,
  onOpenComms,
}: {
  graph: FeatureGraph
  onGraph: (graph: FeatureGraph) => void
  onOpenAnchor: (anchor: Anchor) => void
  onOpenComms: () => void
}) {
  const { report, reload, setReport } = useHealth(graph.feature.id)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showSettled, setShowSettled] = useState(false)
  const signals = useMemo(() => {
    const all = report?.signals ?? []
    const live = all.filter(
      (s) => s.status === "open" || s.status === "acknowledged"
    )
    const rank = { critical: 0, warn: 1, info: 2 } as const
    live.sort(
      (a, b) =>
        rank[a.severity] - rank[b.severity] || b.lastSeenAt - a.lastSeenAt
    )
    return {
      live,
      settled: all.filter(
        (s) => s.status === "resolved" || s.status === "muted"
      ),
    }
  }, [report])
  if (!report)
    return <p className="text-sm text-muted-foreground">Loading health…</p>
  const status = STATUS[report.status]
  const StatusIcon = status.icon
  const hour = report.windows.find((w) => w.key === "1h")
  const lifetime = report.windows.find((w) => w.key === "lifetime")
  const stat = (label: string, value: string, help?: string) => (
    <div className="min-w-0" title={help}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
  return (
    <div className="space-y-5">
      <div className="rounded-md border p-4">
        <div className="flex items-center gap-2">
          <StatusIcon className={cn("size-5", status.className)} />
          <span className={cn("font-medium", status.className)}>
            {status.label}
          </span>
          <span className="text-sm text-muted-foreground">{status.help}</span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 text-xs"
            onClick={() => setSettingsOpen(true)}
          >
            Health settings
          </Button>
        </div>
        {report.status === "paused_by_health" && report.pauseReason && (
          <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm">
            {report.pauseReason}
          </p>
        )}
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {stat(
            "Time since progress",
            duration(report.sinceProgressMs),
            report.lastProgress
              ? `Last: ${report.lastProgress.label}`
              : "Nothing has moved the map yet"
          )}
          {stat(
            "Ceremony ratio · 1 h",
            hour ? `${number(hour.ratio)}×` : "—",
            "Ceremony weight over progress weight (progress floored at 1) in the last hour"
          )}
          {stat(
            "User stories done · 1 h",
            String(report.throughput.lastHour),
            report.throughput.medianStoryMinutes !== null
              ? `Median ${report.throughput.medianStoryMinutes} min from start to done`
              : undefined
          )}
          {stat(
            "Drive time used",
            duration(report.activeMs),
            report.throughput.perActiveHour !== null
              ? `${report.throughput.perActiveHour} user stories per active hour`
              : undefined
          )}
        </div>
        <div className="mt-4 flex flex-col gap-4 sm:flex-row">
          <Sparkline title="Last hour" points={report.series.hour} />
          <Sparkline title="Whole run" points={report.series.lifetime} />
        </div>
        {lifetime && (
          <p className="mt-2 text-xs text-muted-foreground">
            Whole run: progress {number(lifetime.progress)} from{" "}
            {lifetime.progressEvents} events, ceremony{" "}
            {number(lifetime.ceremony)} from {lifetime.ceremonyEvents} events.
          </p>
        )}
      </div>

      <section className="space-y-2">
        <div className="flex items-center">
          <h3 className="text-sm font-medium">Signals</h3>
          {report.muted.length > 0 && (
            <span className="ml-2 text-xs text-muted-foreground">
              Muted: {report.muted.map(detectorLabel).join(", ")}
            </span>
          )}
        </div>
        {signals.live.length ? (
          signals.live.map((signal) => (
            <SignalRow
              key={signal.id}
              signal={signal}
              onChanged={() => void reload()}
              onOpenAnchor={onOpenAnchor}
              onOpenComms={onOpenComms}
            />
          ))
        ) : (
          <p className="text-sm text-muted-foreground">
            No open signals. The detectors re-check after every event and every
            minute while the feature is active.
          </p>
        )}
        {signals.settled.length > 0 && (
          <div>
            <button
              className="flex items-center gap-1 text-xs text-muted-foreground"
              aria-expanded={showSettled}
              onClick={() => setShowSettled((v) => !v)}
            >
              {showSettled ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              Resolved and muted ({signals.settled.length})
            </button>
            {showSettled && (
              <div className="mt-2 space-y-2">
                {signals.settled.map((signal) => (
                  <SignalRow
                    key={signal.id}
                    signal={signal}
                    onChanged={() => void reload()}
                    onOpenAnchor={onOpenAnchor}
                    onOpenComms={onOpenComms}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-6 lg:flex-row">
        <BreakdownTable title="Pods" rows={report.pods} />
        <BreakdownTable title="Seats" rows={report.seats} />
      </section>

      <HealthSettingsDialog
        graph={graph}
        report={report}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onGraph={(next) => {
          onGraph(next)
          void reload()
        }}
        onReport={setReport}
      />
    </div>
  )
}

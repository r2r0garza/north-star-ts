import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ArrowLeft,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XIcon,
} from "lucide-react"
import GridLayout, { WidthProvider, type Layout } from "react-grid-layout"
import "react-grid-layout/css/styles.css"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  Area,
  AreaChart,
  XAxis,
  YAxis,
} from "recharts"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { toast } from "sonner"
import type {
  Dashboard,
  DashboardGraph,
  DashboardWidget,
  DashboardWidgetData,
  DashboardWidgetType,
} from "@/types"

const ResponsiveGrid = WidthProvider(GridLayout)
const GRID_COLS = 12
const ROW_HEIGHT = 40

// On opening a dashboard, only auto-refresh widgets whose cached data is older
// than this. Rapidly switching between dashboards won't re-run their recipes; the
// manual Refresh button always forces a full re-run (maxAgeMs = 0).
const ON_OPEN_MAX_AGE_MS = 60_000

// A palette for chart series — CSS vars would be ideal, but a small fixed set
// reads fine in both themes and keeps a manually-authored widget zero-config.
const SERIES_COLORS = [
  "var(--chart-1, #2563eb)",
  "var(--chart-2, #16a34a)",
  "var(--chart-3, #d97706)",
  "var(--chart-4, #dc2626)",
  "var(--chart-5, #7c3aed)",
]

// ── config shapes (parsed from the widget's JSON `config` blob) ───────────────

interface ChartSeries {
  key: string
  label?: string
  color?: string
}
interface ChartWidgetConfig {
  chartKind?: "line" | "bar" | "area"
  xKey?: string
  series?: ChartSeries[]
}
interface StatWidgetConfig {
  valueKey?: string
  unit?: string
  label?: string
}
interface TableWidgetConfig {
  columns?: Array<{ key: string; label?: string }>
}

// The rows a widget renders, normalized to an array of flat objects.
function asRows(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>
  if (data && typeof data === "object")
    return [data as Record<string, unknown>]
  return []
}

const TERMINAL_TASK_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "paused",
])

// Resolve when a task reaches a terminal state, watching the shared task event
// tail (the same channel the indexing strip uses). Falls back to a poll so a
// task that settled before we subscribed still resolves; a timeout guards against
// a lost event. Used to know when a dashboard_refresh executor has finished so
// the view can re-read the cache.
function waitForTask(taskId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      unsub()
      clearInterval(poll)
      clearTimeout(timeout)
      resolve()
    }
    const unsub = window.cowork.tasks.onEvent(({ taskId: id, event }) => {
      if (id !== taskId) return
      if (
        event.type === "task_completed" ||
        event.type === "task_failed" ||
        (event.type === "status_change" &&
          TERMINAL_TASK_STATUSES.has(event.to))
      ) {
        finish()
      }
    })
    // Poll as a backstop (the task may already be terminal, or an event missed).
    const poll = setInterval(async () => {
      const task = await window.cowork.db.tasks.get(taskId)
      if (task && TERMINAL_TASK_STATUSES.has(task.status)) finish()
    }, 400)
    // Never hang the UI on a lost signal.
    const timeout = setTimeout(finish, 30_000)
  })
}

// ── widget renderers ──────────────────────────────────────────────────────────

function ChartWidget({
  config,
  rows,
}: {
  config: ChartWidgetConfig
  rows: Array<Record<string, unknown>>
}) {
  const xKey = config.xKey ?? "name"
  const series: ChartSeries[] =
    config.series && config.series.length > 0
      ? config.series
      : // Infer numeric series from the first row when none declared.
        Object.keys(rows[0] ?? {})
          .filter((k) => k !== xKey && typeof rows[0]?.[k] === "number")
          .map((key) => ({ key }))

  const chartConfig: ChartConfig = Object.fromEntries(
    series.map((s, i) => [
      s.key,
      { label: s.label ?? s.key, color: s.color ?? SERIES_COLORS[i % SERIES_COLORS.length] },
    ])
  )

  const kind = config.chartKind ?? "line"
  const common = { data: rows }

  return (
    <ChartContainer config={chartConfig} className="h-full w-full">
      {kind === "bar" ? (
        <BarChart {...common}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey={xKey} tickLine={false} axisLine={false} />
          <YAxis tickLine={false} axisLine={false} width={36} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <ChartLegend content={<ChartLegendContent />} />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              fill={s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]}
              radius={4}
            />
          ))}
        </BarChart>
      ) : kind === "area" ? (
        <AreaChart {...common}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey={xKey} tickLine={false} axisLine={false} />
          <YAxis tickLine={false} axisLine={false} width={36} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <ChartLegend content={<ChartLegendContent />} />
          {series.map((s, i) => (
            <Area
              key={s.key}
              dataKey={s.key}
              stroke={s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]}
              fill={s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]}
              fillOpacity={0.2}
            />
          ))}
        </AreaChart>
      ) : (
        <LineChart {...common}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey={xKey} tickLine={false} axisLine={false} />
          <YAxis tickLine={false} axisLine={false} width={36} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <ChartLegend content={<ChartLegendContent />} />
          {series.map((s, i) => (
            <Line
              key={s.key}
              dataKey={s.key}
              stroke={s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]}
              dot={false}
            />
          ))}
        </LineChart>
      )}
    </ChartContainer>
  )
}

function StatWidget({
  config,
  rows,
}: {
  config: StatWidgetConfig
  rows: Array<Record<string, unknown>>
}) {
  const row = rows[0] ?? {}
  const valueKey =
    config.valueKey ?? Object.keys(row).find((k) => typeof row[k] === "number")
  const value = valueKey ? row[valueKey] : undefined
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1">
      <div className="text-4xl font-semibold tabular-nums">
        {value === undefined || value === null ? "—" : String(value)}
        {config.unit ? (
          <span className="ml-1 text-lg text-muted-foreground">
            {config.unit}
          </span>
        ) : null}
      </div>
      {config.label ? (
        <div className="text-sm text-muted-foreground">{config.label}</div>
      ) : null}
    </div>
  )
}

function TableWidget({
  config,
  rows,
}: {
  config: TableWidgetConfig
  rows: Array<Record<string, unknown>>
}) {
  const columns: Array<{ key: string; label?: string }> =
    config.columns && config.columns.length > 0
      ? config.columns
      : Object.keys(rows[0] ?? {}).map((key) => ({ key }))
  return (
    <ScrollArea className="h-full w-full">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-background">
          <tr className="border-b">
            {columns.map((c) => (
              <th key={c.key} className="px-2 py-1 font-medium">
                {c.label ?? c.key}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border/50">
              {columns.map((c) => (
                <td key={c.key} className="px-2 py-1 tabular-nums">
                  {r[c.key] === undefined || r[c.key] === null
                    ? ""
                    : String(r[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  )
}

function WidgetBody({
  widget,
  data,
  onApprove,
}: {
  widget: DashboardWidget
  data: DashboardWidgetData | undefined
  onApprove: (widgetId: string) => void
}) {
  // `stale` = the recipe needs approval to re-run headless (fail-closed). Offer a
  // one-click bless-and-refresh, but ONLY when approving can actually help: a
  // `url`, or a `command` that carries a `cwd`. A command with no cwd (e.g. a
  // recipe authored before 033.3) can't be scoped/run — show re-author guidance
  // instead of a dead button.
  if (data?.status === "stale") {
    const recipe = (widget.recipe ?? {}) as {
      command?: string
      url?: string
      cwd?: string
    }
    const approvable = !!recipe.url || (!!recipe.command && !!recipe.cwd)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-center">
        <p className="text-xs text-muted-foreground">
          {data.error ?? "This recipe needs approval to refresh."}
        </p>
        {approvable ? (
          <Button size="sm" variant="outline" onClick={() => onApprove(widget.id)}>
            <ShieldCheck className="size-4" />
            Approve this recipe
          </Button>
        ) : null}
      </div>
    )
  }
  if (data?.status === "error") {
    return (
      <div className="flex h-full items-center justify-center p-2 text-center text-xs text-destructive">
        {data.error ?? "Failed to load data."}
      </div>
    )
  }
  const rows = asRows(data?.data)
  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-2 text-center text-xs text-muted-foreground">
        No data yet.
      </div>
    )
  }
  switch (widget.type) {
    case "chart":
      return (
        <ChartWidget config={(widget.config ?? {}) as ChartWidgetConfig} rows={rows} />
      )
    case "stat":
      return (
        <StatWidget config={(widget.config ?? {}) as StatWidgetConfig} rows={rows} />
      )
    default:
      return (
        <TableWidget config={(widget.config ?? {}) as TableWidgetConfig} rows={rows} />
      )
  }
}

// ── screen ────────────────────────────────────────────────────────────────────

export function DashboardsScreen({ onClose }: { onClose: () => void }) {
  const [dashboards, setDashboards] = useState<Dashboard[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [graph, setGraph] = useState<DashboardGraph | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<Dashboard | null>(null)

  const refreshList = useCallback(async () => {
    const list = await window.cowork.db.dashboards.list()
    setDashboards(list)
    setSelectedId((cur) => cur ?? list[0]?.id ?? null)
  }, [])

  const loadGraph = useCallback(async (id: string) => {
    setLoading(true)
    try {
      const g = await window.cowork.db.dashboards.graph(id)
      setGraph(g)
    } finally {
      setLoading(false)
    }
  }, [])

  // Kick off the deterministic refresh executor (plan 033.3) — it replays each
  // widget's stored recipe (no LLM) into the cache — then re-read the graph when
  // the task settles. Silent = the automatic on-open refresh (no toast + a
  // staleness window so switching between dashboards doesn't re-run every recipe
  // on each glance; the manual button forces a full re-run).
  const runRefresh = useCallback(
    async (id: string, opts?: { silent?: boolean }) => {
      setRefreshing(true)
      try {
        const maxAgeMs = opts?.silent ? ON_OPEN_MAX_AGE_MS : 0
        const taskId = await window.cowork.dashboard.refresh(id, maxAgeMs)
        // Null → nothing to refresh (no recipes) or a refresh was already live;
        // just re-read what's cached.
        if (taskId) await waitForTask(taskId)
        // Only reload if this dashboard is still the one on screen.
        setSelectedId((cur) => {
          if (cur === id) void loadGraph(id)
          return cur
        })
        if (!opts?.silent) toast.success("Dashboard refreshed")
      } finally {
        setRefreshing(false)
      }
    },
    [loadGraph]
  )

  useEffect(() => {
    void refreshList()
  }, [refreshList])

  useEffect(() => {
    if (!selectedId) {
      setGraph(null)
      return
    }
    // Show cached data immediately, then re-fetch in the background (on-open
    // refresh). ensureRefresh dedups, and a recipe-less dashboard is a no-op.
    void loadGraph(selectedId)
    void runRefresh(selectedId, { silent: true })
  }, [selectedId, loadGraph, runRefresh])

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

  const dataByWidget = useMemo(() => {
    const m = new Map<string, DashboardWidgetData>()
    for (const d of graph?.data ?? []) m.set(d.widgetId, d)
    return m
  }, [graph])

  // Grid layout derived from each widget's `pos`; falls back to a 2-wide flow.
  const layout: Layout[] = useMemo(
    () =>
      (graph?.widgets ?? []).map((w, i) => {
        const pos = (w.pos ?? {}) as {
          x?: number
          y?: number
          w?: number
          h?: number
        }
        return {
          i: w.id,
          x: pos.x ?? (i % 2) * 6,
          y: pos.y ?? Math.floor(i / 2) * 6,
          w: pos.w ?? 6,
          h: pos.h ?? 6,
        }
      }),
    [graph]
  )

  // window.prompt is unavailable in Electron's renderer — use a dialog instead.
  async function createDashboard(name: string) {
    const dash = await window.cowork.db.dashboards.create({ name })
    setCreateOpen(false)
    await refreshList()
    setSelectedId(dash.id)
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    await window.cowork.db.dashboards.delete(pendingDelete.id)
    const wasSelected = pendingDelete.id === selectedId
    setPendingDelete(null)
    await refreshList()
    if (wasSelected) setSelectedId(null)
  }

  // Persist a drag/resize as each widget's `pos` (mutate-then-refetch).
  async function onLayoutChange(next: Layout[]) {
    if (!graph) return
    const byId = new Map(next.map((l) => [l.i, l]))
    let changed = false
    await Promise.all(
      graph.widgets.map(async (w) => {
        const l = byId.get(w.id)
        if (!l) return
        const cur = (w.pos ?? {}) as {
          x?: number
          y?: number
          w?: number
          h?: number
        }
        if (
          cur.x !== l.x ||
          cur.y !== l.y ||
          cur.w !== l.w ||
          cur.h !== l.h
        ) {
          changed = true
          await window.cowork.db.dashboards.widgets.update(w.id, {
            pos: { x: l.x, y: l.y, w: l.w, h: l.h },
          })
        }
      })
    )
    if (changed && selectedId) void loadGraph(selectedId)
  }

  async function refresh() {
    if (selectedId) await runRefresh(selectedId)
  }

  async function approveRecipe(widgetId: string) {
    if (!selectedId) return
    setRefreshing(true)
    try {
      const result = await window.cowork.dashboard.approveRecipe(widgetId)
      if (!result?.ok) {
        // Always show text — never a blank toast, even on an unexpected shape.
        toast.error(result?.reason || "Could not approve this recipe.")
        return
      }
      if (result.taskId) await waitForTask(result.taskId)
      await loadGraph(selectedId)
      toast.success("Recipe approved")
    } finally {
      setRefreshing(false)
    }
  }

  async function deleteWidget(id: string) {
    await window.cowork.db.dashboards.widgets.delete(id)
    if (selectedId) void loadGraph(selectedId)
  }

  return (
    <div
      data-slot="dashboards-screen"
      className="flex min-h-0 flex-1 flex-col bg-background pt-11 text-sm text-foreground"
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-4">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dashboards"
          className="group/back flex items-center gap-2 rounded-md text-left"
        >
          <ArrowLeft className="size-4 text-muted-foreground transition-colors group-hover/back:text-foreground" />
          <h1 className="font-heading text-base font-medium">Dashboards</h1>
        </button>
        <Button variant="ghost" size="icon-sm" onClick={onClose}>
          <XIcon />
          <span className="sr-only">Close</span>
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Left rail: dashboard list */}
        <div className="flex w-60 shrink-0 flex-col border-r">
          <div className="flex h-12 shrink-0 items-center justify-between px-3">
            <span className="text-xs font-medium text-muted-foreground">
              Dashboards
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setCreateOpen(true)}
              aria-label="New dashboard"
            >
              <Plus className="size-4" />
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-0.5 px-2 pb-2">
              {dashboards.map((d) => (
                <div
                  key={d.id}
                  className={cn(
                    "group/row flex items-center justify-between rounded-md px-2 py-1.5",
                    d.id === selectedId
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50"
                  )}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left"
                    onClick={() => setSelectedId(d.id)}
                  >
                    {d.name}
                  </button>
                  <button
                    type="button"
                    className="ml-1 shrink-0 opacity-0 transition-opacity group-hover/row:opacity-100"
                    onClick={() => setPendingDelete(d)}
                    aria-label={`Delete ${d.name}`}
                  >
                    <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
                  </button>
                </div>
              ))}
              {dashboards.length === 0 ? (
                <p className="px-2 py-4 text-xs text-muted-foreground">
                  No dashboards yet. Create one, or ask an agent to author one.
                </p>
              ) : null}
            </div>
          </ScrollArea>
        </div>

        {/* Main: the selected dashboard's grid */}
        <div className="flex min-h-0 flex-1 flex-col">
          {selectedId && graph ? (
            <>
              <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
                <div className="min-w-0">
                  <p className="truncate font-medium">{graph.dashboard.name}</p>
                  {graph.dashboard.description ? (
                    <p className="truncate text-xs text-muted-foreground">
                      {String(graph.dashboard.description)}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={refresh}
                    disabled={refreshing}
                  >
                    <RefreshCw
                      className={cn("size-4", refreshing && "animate-spin")}
                    />
                    Refresh
                  </Button>
                  <Button size="sm" onClick={() => setAddOpen(true)}>
                    <Plus className="size-4" />
                    Add widget
                  </Button>
                </div>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                {graph.widgets.length === 0 ? (
                  <p className="p-8 text-center text-sm text-muted-foreground">
                    No widgets yet. Add one, or ask an agent to author this
                    dashboard.
                  </p>
                ) : (
                  <ResponsiveGrid
                    className="p-2"
                    cols={GRID_COLS}
                    rowHeight={ROW_HEIGHT}
                    layout={layout}
                    onLayoutChange={onLayoutChange}
                    draggableHandle=".widget-drag-handle"
                    margin={[12, 12]}
                  >
                    {graph.widgets.map((w) => (
                      <div
                        key={w.id}
                        className="flex flex-col overflow-hidden rounded-lg border bg-card"
                      >
                        <div className="widget-drag-handle flex h-8 shrink-0 cursor-move items-center justify-between border-b px-3">
                          <span className="truncate text-xs font-medium">
                            {w.title}
                          </span>
                          <button
                            type="button"
                            onClick={() => deleteWidget(w.id)}
                            aria-label={`Delete ${w.title}`}
                            className="shrink-0"
                          >
                            <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
                          </button>
                        </div>
                        <div className="min-h-0 flex-1 p-2">
                          <WidgetBody
                            widget={w}
                            data={dataByWidget.get(w.id)}
                            onApprove={approveRecipe}
                          />
                        </div>
                      </div>
                    ))}
                  </ResponsiveGrid>
                )}
              </ScrollArea>
            </>
          ) : loading ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
              Select a dashboard, or create one.
            </div>
          )}
        </div>
      </div>

      {createOpen ? (
        <NewDashboardDialog
          onClose={() => setCreateOpen(false)}
          onCreate={createDashboard}
        />
      ) : null}

      {addOpen && selectedId ? (
        <AddWidgetDialog
          dashboardId={selectedId}
          onClose={() => setAddOpen(false)}
          onCreated={() => {
            setAddOpen(false)
            void loadGraph(selectedId)
          }}
        />
      ) : null}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete dashboard?</AlertDialogTitle>
            <AlertDialogDescription>
              “{pendingDelete?.name}” and all its widgets will be permanently
              removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// A small name prompt for creating a dashboard (window.prompt is unavailable in
// Electron's renderer). Enter submits, Escape/backdrop closes.
function NewDashboardDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (name: string) => void | Promise<void>
}) {
  const [name, setName] = useState("")
  const [saving, setSaving] = useState(false)

  async function submit() {
    const trimmed = name.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      await onCreate(trimmed)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>New dashboard</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="dashboard-name">Name</Label>
          <Input
            id="dashboard-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                void submit()
              }
            }}
            placeholder="Ops overview"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || !name.trim()}>
            {saving ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// A manual widget-authoring form — proves the render path without an agent. The
// user picks a type, gives a title, and pastes config + data as JSON.
function AddWidgetDialog({
  dashboardId,
  onClose,
  onCreated,
}: {
  dashboardId: string
  onClose: () => void
  onCreated: () => void
}) {
  const [title, setTitle] = useState("")
  const [type, setType] = useState<DashboardWidgetType>("chart")
  const [configText, setConfigText] = useState(
    '{\n  "chartKind": "line",\n  "xKey": "month"\n}'
  )
  const [dataText, setDataText] = useState(
    '[\n  { "month": "Jan", "value": 12 },\n  { "month": "Feb", "value": 19 }\n]'
  )
  const [saving, setSaving] = useState(false)

  async function submit() {
    let config: unknown = null
    let data: unknown = null
    try {
      config = configText.trim() ? JSON.parse(configText) : null
    } catch {
      toast.error("Config is not valid JSON")
      return
    }
    try {
      data = dataText.trim() ? JSON.parse(dataText) : null
    } catch {
      toast.error("Data is not valid JSON")
      return
    }
    setSaving(true)
    try {
      const widget = await window.cowork.db.dashboards.widgets.create({
        dashboardId,
        title: title.trim() || "Untitled",
        type,
        config,
      })
      if (data !== null) {
        await window.cowork.db.dashboards.data.upsert({
          widgetId: widget.id,
          data,
          status: "ok",
        })
      }
      onCreated()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add widget</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="widget-title">Title</Label>
            <Input
              id="widget-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Monthly sign-ups"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="widget-type">Type</Label>
            {/* NativeSelect (not Radix Select): inside a Dialog, an open Radix
                Select sets body pointer-events:none and dismissing it closes the
                dialog (the 023 finding). */}
            <NativeSelect
              id="widget-type"
              className="w-full"
              value={type}
              onChange={(e) =>
                setType(e.target.value as DashboardWidgetType)
              }
            >
              <NativeSelectOption value="chart">Chart</NativeSelectOption>
              <NativeSelectOption value="stat">Stat</NativeSelectOption>
              <NativeSelectOption value="table">Table</NativeSelectOption>
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="widget-config">Config (JSON)</Label>
            <Textarea
              id="widget-config"
              value={configText}
              onChange={(e) => setConfigText(e.target.value)}
              className="h-24 font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="widget-data">Data (JSON)</Label>
            <Textarea
              id="widget-data"
              value={dataText}
              onChange={(e) => setDataText(e.target.value)}
              className="h-28 font-mono text-xs"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || !title.trim()}>
            {saving ? "Adding…" : "Add widget"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

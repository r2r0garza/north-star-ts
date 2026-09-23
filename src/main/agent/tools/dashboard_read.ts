import { TOOL_EFFECTS, type Tool } from "./types"
import { toolError } from "./output"
import * as dashboards from "../../db/repositories/dashboards"
import type { DashboardWidget, DashboardWidgetData } from "../../db/types"

// Read saved live dashboards (plan 033.4). The read-side partner of
// dashboard_write: with no `dashboardId` it lists dashboards for discovery; with
// one it returns each widget's render config joined to its LATEST CACHED data,
// plus status / error / fetchedAt so the model can qualify stale or failed
// values. It never refreshes, runs a recipe, or writes anything — it reports
// what the dashboard view currently shows.
//
// Recipes (commands / URLs), captured workspace paths, and grid layout are
// deliberately omitted: they aren't needed to answer questions about displayed
// values.
//
// Output is deterministically bounded (see the 033.4 decisions): widgets are
// filled in position order under a byte budget with a per-widget row cap; the
// first widget whose rows don't fit is cut short and every later widget is
// listed in `omittedWidgets`. Oversized single items become explicit
// `_omitted` markers so paging with widgetIds/rowOffset always makes progress.

export const MAX_LISTED_DASHBOARDS = 100
export const WIDGET_BUDGET_BYTES = 32_000
export const MAX_ROWS_PER_WIDGET = 50
export const MAX_ITEM_BYTES = 4_000
const MAX_ERROR_CHARS = 1_000
const MAX_TITLE_CHARS = 200
const MAX_DESCRIPTION_CHARS = 500

type WidgetStatus = DashboardWidgetData["status"] | "no_data"

interface WidgetRecord {
  id: string
  title: string
  type: DashboardWidget["type"]
  config: unknown
  status: WidgetStatus
  fetchedAt: string | null
  error?: string
  errorTruncated?: true
  // Non-array cached data (e.g. a stat's single object).
  value?: unknown
  rowsTotal?: number
  rowOffset?: number
  rowsReturned?: number
  nextRowOffset?: number
  // Kept LAST so a record's serialized size is exactly
  // size(record with rows: []) + sum(row sizes) + separating commas.
  rows?: unknown[]
}

export const dashboardReadTool: Tool = {
  effects: TOOL_EFFECTS.readOnlyParallel,
  definition: {
    type: "function",
    function: {
      name: "dashboard_read",
      description:
        "Read saved live dashboards. Use this whenever the user asks what a dashboard " +
        "shows, requests dashboard stats or values, or names a saved dashboard. Do not " +
        "search the workspace, inspect dashboard implementation files, or substitute " +
        "live Git/system data for the dashboard's displayed values. If the dashboard ID " +
        "is unknown, call with no arguments first to list dashboards (id, name, " +
        "description, widgetCount), match the requested dashboard by name, then call " +
        "again with `dashboardId` to read its widgets and their LATEST CACHED data — " +
        "the values the dashboard view shows.\n\n" +
        "This never refreshes data. Each widget reports `status` ('ok', 'error', 'stale' " +
        "= never fetched / needs refresh, or 'no_data'), `error`, and `fetchedAt`; compare " +
        "fetchedAt with `readAt` and say so when data is old, failed, or missing rather " +
        "than presenting it as current.\n\n" +
        `Output is bounded: at most ${MAX_ROWS_PER_WIDGET} rows per widget and a size ` +
        "budget across widgets. When `complete` is false, follow `hint`: pass `widgetIds` " +
        "to read omitted widgets, or a single widget id plus `rowOffset` (from " +
        "`nextRowOffset`) to page through its rows.",
      parameters: {
        type: "object",
        properties: {
          dashboardId: {
            type: "string",
            description: "Dashboard to read. Omit to list dashboards.",
          },
          widgetIds: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional: read only these widgets (returned in dashboard order).",
          },
          rowOffset: {
            type: "integer",
            minimum: 0,
            description:
              "Optional row offset for paging. Only valid with exactly one widgetId.",
          },
        },
        required: [],
      },
    },
  },
  execute: async (args) => {
    const {
      dashboardId,
      widgetIds: rawWidgetIds,
      rowOffset: rawOffset,
    } = args as {
      dashboardId?: unknown
      widgetIds?: unknown
      rowOffset?: unknown
    }

    const id = typeof dashboardId === "string" ? dashboardId.trim() : ""
    if (!id) {
      if (rawWidgetIds !== undefined || rawOffset !== undefined) {
        return toolError(
          "bad_args",
          "`widgetIds` and `rowOffset` require a `dashboardId`.",
          "Call dashboard_read with no arguments to list dashboards first."
        )
      }
      return listDashboards()
    }

    // LLMs sometimes send arrays as JSON strings; parse defensively.
    let widgetIds = rawWidgetIds
    if (typeof widgetIds === "string") {
      try {
        widgetIds = JSON.parse(widgetIds)
      } catch {
        widgetIds = [widgetIds]
      }
    }
    if (
      widgetIds !== undefined &&
      widgetIds !== null &&
      !(
        Array.isArray(widgetIds) &&
        widgetIds.every((w) => typeof w === "string")
      )
    ) {
      return toolError("bad_args", "`widgetIds` must be an array of strings.")
    }
    const selected = (widgetIds ?? undefined) as string[] | undefined

    let rowOffset = 0
    if (rawOffset !== undefined && rawOffset !== null) {
      const n = typeof rawOffset === "string" ? Number(rawOffset) : rawOffset
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
        return toolError(
          "bad_args",
          "`rowOffset` must be a non-negative integer."
        )
      }
      if (!selected || new Set(selected).size !== 1) {
        return toolError(
          "bad_args",
          "`rowOffset` is only valid when `widgetIds` names exactly one widget."
        )
      }
      rowOffset = n
    }

    const graph = dashboards.getDashboardGraph(id)
    if (!graph) {
      return toolError(
        "not_found",
        `No dashboard with id ${id}.`,
        "Call dashboard_read with no arguments to list dashboards."
      )
    }
    return JSON.stringify(readDashboard(graph, selected, rowOffset))
  },
}

function listDashboards(): string {
  const all = dashboards.listDashboards()
  const counts = dashboards.countWidgetsByDashboard()
  const listed = all.slice(0, MAX_LISTED_DASHBOARDS).map((d) => ({
    id: d.id,
    name: clip(d.name, MAX_TITLE_CHARS),
    description:
      d.description === null
        ? null
        : clip(d.description, MAX_DESCRIPTION_CHARS),
    pinned: d.pinned,
    updatedAt: iso(d.updatedAt),
    widgetCount: counts.get(d.id) ?? 0,
  }))
  return JSON.stringify({
    dashboards: listed,
    total: all.length,
    returned: listed.length,
    truncated: all.length > listed.length,
  })
}

function readDashboard(
  graph: NonNullable<ReturnType<typeof dashboards.getDashboardGraph>>,
  selected: string[] | undefined,
  rowOffset: number
) {
  const dataById = new Map(graph.data.map((d) => [d.widgetId, d]))
  const known = new Set(graph.widgets.map((w) => w.id))
  const wanted = selected ? new Set(selected) : null
  const targets = wanted
    ? graph.widgets.filter((w) => wanted.has(w.id))
    : graph.widgets
  const unknownWidgetIds = selected
    ? [...new Set(selected)].filter((w) => !known.has(w))
    : []

  const widgets: WidgetRecord[] = []
  const omittedWidgets: {
    id: string
    title: string
    type: DashboardWidget["type"]
    reason: "budget"
  }[] = []
  let remaining = WIDGET_BUDGET_BYTES
  let incomplete = false
  let exhausted = false

  for (const w of targets) {
    if (exhausted) {
      omittedWidgets.push({
        id: w.id,
        title: clip(w.title, MAX_TITLE_CHARS),
        type: w.type,
        reason: "budget",
      })
      continue
    }
    const fit = fitWidget(w, dataById.get(w.id), rowOffset, remaining)
    if (!fit) {
      exhausted = true
      incomplete = true
      omittedWidgets.push({
        id: w.id,
        title: clip(w.title, MAX_TITLE_CHARS),
        type: w.type,
        reason: "budget",
      })
      continue
    }
    widgets.push(fit.record)
    remaining -= fit.bytes
    if (fit.record.nextRowOffset !== undefined) incomplete = true
    if (fit.budgetCut) exhausted = true
  }

  const hint = incomplete
    ? omittedWidgets.length > 0
      ? `Some widgets were omitted for size. Call dashboard_read again with this dashboardId and widgetIds ${JSON.stringify(omittedWidgets.map((o) => o.id))} to read them. For a widget with nextRowOffset, pass that single widget id and rowOffset to page its rows.`
      : "Some rows were not returned. For each widget with nextRowOffset, call dashboard_read again with that single widget id in widgetIds and rowOffset = nextRowOffset."
    : undefined

  return {
    dashboard: {
      id: graph.dashboard.id,
      name: clip(graph.dashboard.name, MAX_TITLE_CHARS),
      description:
        graph.dashboard.description === null
          ? null
          : clip(graph.dashboard.description, MAX_DESCRIPTION_CHARS),
      pinned: graph.dashboard.pinned,
      updatedAt: iso(graph.dashboard.updatedAt),
    },
    readAt: iso(Date.now()),
    widgetCount: graph.widgets.length,
    ...(selected ? { selectedWidgetCount: targets.length } : {}),
    complete: !incomplete,
    widgets,
    omittedWidgets,
    ...(unknownWidgetIds.length > 0 ? { unknownWidgetIds } : {}),
    limits: {
      widgetBudgetBytes: WIDGET_BUDGET_BYTES,
      maxRowsPerWidget: MAX_ROWS_PER_WIDGET,
      maxItemBytes: MAX_ITEM_BYTES,
    },
    ...(hint ? { hint } : {}),
  }
}

// Fit one widget into `remaining` bytes. Returns null when even its rowless
// record doesn't fit. `budgetCut` means rows were cut short by the BUDGET (not
// the per-widget row cap), which ends the fill: later widgets are omitted.
function fitWidget(
  w: DashboardWidget,
  cache: DashboardWidgetData | undefined,
  rowOffset: number,
  remaining: number
): { record: WidgetRecord; bytes: number; budgetCut: boolean } | null {
  const base: WidgetRecord = {
    id: w.id,
    title: clip(w.title, MAX_TITLE_CHARS),
    type: w.type,
    config: capItem(w.config, "config_too_large"),
    status: cache ? cache.status : "no_data",
    fetchedAt: cache ? iso(cache.fetchedAt) : null,
  }
  if (cache?.error) {
    base.error = clip(cache.error, MAX_ERROR_CHARS)
    if (cache.error.length > MAX_ERROR_CHARS) base.errorTruncated = true
  }

  if (!cache || !Array.isArray(cache.data)) {
    const record = cache
      ? { ...base, value: capItem(cache.data, "value_too_large") }
      : base
    const bytes = byteSize(record)
    return bytes <= remaining ? { record, bytes, budgetCut: false } : null
  }

  const all = cache.data
  const start = Math.min(rowOffset, all.length)
  const capped = all.slice(start, start + MAX_ROWS_PER_WIDGET)
  const rowBytes = capped.map((r) => {
    const item = capItem(r, "row_too_large")
    return { item, bytes: byteSize(item) }
  })

  // Take k rows greedily; the metadata (rowsReturned / nextRowOffset) depends
  // on k, so re-measure the rowless record for each candidate k.
  const build = (k: number): WidgetRecord => {
    const end = start + k
    return {
      ...base,
      rowsTotal: all.length,
      rowOffset: start,
      rowsReturned: k,
      ...(end < all.length ? { nextRowOffset: end } : {}),
      rows: [],
    }
  }
  const sizeOf = (k: number, rowsSum: number) =>
    byteSize(build(k)) + rowsSum + Math.max(0, k - 1)

  if (sizeOf(0, 0) > remaining) return null
  let k = 0
  let rowsSum = 0
  while (
    k < rowBytes.length &&
    sizeOf(k + 1, rowsSum + rowBytes[k].bytes) <= remaining
  ) {
    rowsSum += rowBytes[k].bytes
    k++
  }
  const record = build(k)
  record.rows = rowBytes.slice(0, k).map((r) => r.item)
  return {
    record,
    bytes: sizeOf(k, rowsSum),
    budgetCut: k < rowBytes.length,
  }
}

// Replace a single JSON item larger than MAX_ITEM_BYTES with an explicit marker.
function capItem(value: unknown, reason: string): unknown {
  const bytes = byteSize(value)
  return bytes > MAX_ITEM_BYTES ? { _omitted: reason, bytes } : value
}

function byteSize(value: unknown): number {
  const text = JSON.stringify(value)
  return text === undefined ? 0 : Buffer.byteLength(text, "utf8")
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

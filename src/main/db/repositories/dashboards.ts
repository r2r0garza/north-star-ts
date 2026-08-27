import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type {
  Dashboard,
  DashboardGraph,
  DashboardWidget,
  DashboardWidgetData,
  DashboardWidgetDataStatus,
  DashboardWidgetType,
} from "../types"

// Repository for Live dashboards (plan 033). Flat module of functions,
// namespaced by the barrel as `dashboards.*`. Two halves mirror the 025
// definition-vs-run split: the DEFINITION (dashboards + dashboard_widgets) and
// the RUN/CACHE side (dashboard_widget_data — the last fetched rows the view
// renders). Widget `type` and cache `status` are bare TEXT in the DB, coerced
// here against the unions in types.ts (no CHECK — the 025 convention). JSON
// blobs (layout/config/recipe/pos/data) are stored as TEXT and parsed here.

// Caps so a model-authored write (dashboard_write, plan 033.2) can't blow up the
// table. Generous for real dashboards — a handful of widgets, small configs.
export const MAX_WIDGETS = 64
export const MAX_JSON_CHARS = 200_000

export class DashboardJsonTooLargeError extends Error {
  readonly code = "dashboard_json_too_large"

  constructor(
    readonly size: number,
    readonly limit: number
  ) {
    super(
      `Dashboard JSON value is ${size} characters, above the ${limit} character limit. Reduce the widget config, recipe, or cached rows before saving.`
    )
    this.name = "DashboardJsonTooLargeError"
  }
}

const VALID_TYPES: ReadonlySet<DashboardWidgetType> = new Set([
  "chart",
  "stat",
  "table",
])
const VALID_DATA_STATUSES: ReadonlySet<DashboardWidgetDataStatus> = new Set([
  "ok",
  "error",
  "stale",
])

export function normalizeType(type: unknown): DashboardWidgetType {
  const t = String(type ?? "")
    .trim()
    .toLowerCase()
  return VALID_TYPES.has(t as DashboardWidgetType)
    ? (t as DashboardWidgetType)
    : "table"
}

function normalizeDataStatus(status: unknown): DashboardWidgetDataStatus {
  const s = String(status ?? "")
    .trim()
    .toLowerCase()
  return VALID_DATA_STATUSES.has(s as DashboardWidgetDataStatus)
    ? (s as DashboardWidgetDataStatus)
    : "ok"
}

// Serialize a JSON-able value for a TEXT column: null passes through, everything
// else is JSON.stringify'd and size-checked. An unserializable value becomes
// null, but oversized JSON is rejected before any SQL write can corrupt a cell.
function toJsonText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  try {
    const text = JSON.stringify(value)
    if (typeof text !== "string") return null
    if (text.length > MAX_JSON_CHARS) {
      throw new DashboardJsonTooLargeError(text.length, MAX_JSON_CHARS)
    }
    return text
  } catch (err) {
    if (err instanceof DashboardJsonTooLargeError) throw err
    return null
  }
}

function toOptionalJsonText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  return toJsonText(value)
}

// Parse a TEXT column back into a value; a null or unparseable cell reads null.
function fromJsonText(text: string | null): unknown {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ── row types + mappers ─────────────────────────────────────────────────────

interface DashboardRow {
  id: string
  name: string
  description: string | null
  layout: string | null
  pinned: number
  created_at: number
  updated_at: number
}

function toDashboard(row: DashboardRow): Dashboard {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    layout: fromJsonText(row.layout),
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

interface DashboardWidgetRow {
  id: string
  dashboard_id: string
  title: string
  type: string
  config: string | null
  recipe: string | null
  pos: string | null
  position: number
}

function toWidget(row: DashboardWidgetRow): DashboardWidget {
  return {
    id: row.id,
    dashboardId: row.dashboard_id,
    title: row.title,
    type: normalizeType(row.type),
    config: fromJsonText(row.config),
    recipe: fromJsonText(row.recipe),
    pos: fromJsonText(row.pos),
    position: row.position,
  }
}

interface DashboardWidgetDataRow {
  widget_id: string
  data: string | null
  status: string
  error: string | null
  fetched_at: number
}

function toWidgetData(row: DashboardWidgetDataRow): DashboardWidgetData {
  return {
    widgetId: row.widget_id,
    data: fromJsonText(row.data),
    status: normalizeDataStatus(row.status),
    error: row.error,
    fetchedAt: row.fetched_at,
  }
}

// ── dashboards ───────────────────────────────────────────────────────────────

export function createDashboard(input: {
  name: string
  description?: string | null
  layout?: unknown
}): Dashboard {
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      "INSERT INTO dashboards (id, name, description, layout, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(
      id,
      input.name,
      input.description ?? null,
      toJsonText(input.layout),
      now,
      now
    )
  return getDashboard(id)!
}

export function getDashboard(id: string): Dashboard | null {
  const row = getDb()
    .prepare("SELECT * FROM dashboards WHERE id = ?")
    .get(id) as DashboardRow | undefined
  return row ? toDashboard(row) : null
}

export function listDashboards(): Dashboard[] {
  const rows = getDb()
    .prepare("SELECT * FROM dashboards ORDER BY pinned DESC, updated_at DESC")
    .all() as DashboardRow[]
  return rows.map(toDashboard)
}

export function updateDashboard(
  id: string,
  patch: {
    name?: string
    description?: string | null
    layout?: unknown
    pinned?: boolean
  }
): Dashboard {
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.name !== undefined) {
    sets.push("name = ?")
    values.push(patch.name)
  }
  if (patch.description !== undefined) {
    sets.push("description = ?")
    values.push(patch.description)
  }
  if (patch.layout !== undefined) {
    sets.push("layout = ?")
    values.push(toJsonText(patch.layout))
  }
  if (patch.pinned !== undefined) {
    sets.push("pinned = ?")
    values.push(patch.pinned ? 1 : 0)
  }
  if (sets.length > 0) {
    sets.push("updated_at = ?")
    values.push(Date.now())
    values.push(id)
    getDb()
      .prepare(`UPDATE dashboards SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values)
  }
  return getDashboard(id)!
}

export function deleteDashboard(id: string): void {
  // Widgets + their cache rows cascade via the FK (ON DELETE CASCADE).
  getDb().prepare("DELETE FROM dashboards WHERE id = ?").run(id)
}

// ── widgets ──────────────────────────────────────────────────────────────────

export function listWidgets(dashboardId: string): DashboardWidget[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM dashboard_widgets WHERE dashboard_id = ? ORDER BY position ASC"
    )
    .all(dashboardId) as DashboardWidgetRow[]
  return rows.map(toWidget)
}

export function getWidget(id: string): DashboardWidget | null {
  const row = getDb()
    .prepare("SELECT * FROM dashboard_widgets WHERE id = ?")
    .get(id) as DashboardWidgetRow | undefined
  return row ? toWidget(row) : null
}

export function createWidget(input: {
  dashboardId: string
  title: string
  type: unknown
  config?: unknown
  recipe?: unknown
  pos?: unknown
  position?: number
}): DashboardWidget {
  const id = randomUUID()
  // Default position to the end of the list when not given.
  const position =
    input.position ??
    ((
      getDb()
        .prepare(
          "SELECT COALESCE(MAX(position) + 1, 0) AS next FROM dashboard_widgets WHERE dashboard_id = ?"
        )
        .get(input.dashboardId) as { next: number }
    ).next as number)
  getDb()
    .prepare(
      "INSERT INTO dashboard_widgets (id, dashboard_id, title, type, config, recipe, pos, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      id,
      input.dashboardId,
      input.title,
      normalizeType(input.type),
      toJsonText(input.config),
      toJsonText(input.recipe),
      toJsonText(input.pos),
      position
    )
  return getWidget(id)!
}

export function updateWidget(
  id: string,
  patch: {
    title?: string
    type?: unknown
    config?: unknown
    recipe?: unknown
    pos?: unknown
    position?: number
  }
): DashboardWidget {
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.title !== undefined) {
    sets.push("title = ?")
    values.push(patch.title)
  }
  if (patch.type !== undefined) {
    sets.push("type = ?")
    values.push(normalizeType(patch.type))
  }
  if (patch.config !== undefined) {
    sets.push("config = ?")
    values.push(toJsonText(patch.config))
  }
  if (patch.recipe !== undefined) {
    sets.push("recipe = ?")
    values.push(toJsonText(patch.recipe))
  }
  if (patch.pos !== undefined) {
    sets.push("pos = ?")
    values.push(toJsonText(patch.pos))
  }
  if (patch.position !== undefined) {
    sets.push("position = ?")
    values.push(patch.position)
  }
  if (sets.length > 0) {
    values.push(id)
    getDb()
      .prepare(`UPDATE dashboard_widgets SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values)
  }
  return getWidget(id)!
}

export function deleteWidget(id: string): void {
  // The cache row cascades via the FK (ON DELETE CASCADE).
  getDb().prepare("DELETE FROM dashboard_widgets WHERE id = ?").run(id)
}

// ── widget data (cache) ────────────────────────────────────────────────────────

export function getWidgetData(widgetId: string): DashboardWidgetData | null {
  const row = getDb()
    .prepare("SELECT * FROM dashboard_widget_data WHERE widget_id = ?")
    .get(widgetId) as DashboardWidgetDataRow | undefined
  return row ? toWidgetData(row) : null
}

// Replace a widget's cached data (one row per widget). Called on author-time
// write (033.2) and, later, by the deterministic refresh executor (033.3).
export function upsertWidgetData(input: {
  widgetId: string
  data?: unknown
  status?: unknown
  error?: string | null
}): DashboardWidgetData {
  const now = Date.now()
  const dataText = toOptionalJsonText(input.data)
  const keepExistingData = dataText === undefined ? 1 : 0
  getDb()
    .prepare(
      `INSERT INTO dashboard_widget_data (widget_id, data, status, error, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(widget_id) DO UPDATE SET
         data = CASE
           WHEN ? = 1 THEN dashboard_widget_data.data
           ELSE excluded.data
         END,
         status = excluded.status,
         error = excluded.error,
         fetched_at = excluded.fetched_at`
    )
    .run(
      input.widgetId,
      dataText ?? null,
      normalizeDataStatus(input.status),
      input.error ?? null,
      now,
      keepExistingData
    )
  return getWidgetData(input.widgetId)!
}

// ── composite ────────────────────────────────────────────────────────────────

// The whole dashboard in one shape — the view loads it in a single call.
export function getDashboardGraph(id: string): DashboardGraph | null {
  const dashboard = getDashboard(id)
  if (!dashboard) return null
  const widgets = listWidgets(id)
  const data = widgets
    .map((w) => getWidgetData(w.id))
    .filter((d): d is DashboardWidgetData => d !== null)
  return { dashboard, widgets, data }
}

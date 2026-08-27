import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

// better-sqlite3's native binary is built for the Electron ABI here; under
// plain-Node vitest it may not load. SQLite-backed tests skip rather than fail.

import {
  createDashboard,
  getDashboard,
  listDashboards,
  updateDashboard,
  deleteDashboard,
  createWidget,
  getWidget,
  listWidgets,
  updateWidget,
  deleteWidget,
  getWidgetData,
  upsertWidgetData,
  getDashboardGraph,
  normalizeType,
  DashboardJsonTooLargeError,
  MAX_JSON_CHARS,
} from "./dashboards"

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)("dashboards repo", () => {
  it("creates + reads + lists + updates + deletes a dashboard", () => {
    const dash = createDashboard({ name: "Ops", description: "live ops" })
    expect(dash.name).toBe("Ops")
    expect(getDashboard(dash.id)?.description).toBe("live ops")
    expect(listDashboards()).toHaveLength(1)

    const updated = updateDashboard(dash.id, { name: "Ops v2" })
    expect(updated.name).toBe("Ops v2")

    deleteDashboard(dash.id)
    expect(getDashboard(dash.id)).toBeNull()
    expect(listDashboards()).toHaveLength(0)
  })

  it("defaults to unpinned and sorts pinned dashboards to the top", () => {
    const a = createDashboard({ name: "A" })
    const b = createDashboard({ name: "B" })
    const c = createDashboard({ name: "C" })
    expect(a.pinned).toBe(false)

    // Pin the oldest (a). Regardless of updated_at tiebreaks, a pinned dashboard
    // always sorts ahead of every unpinned one.
    const pinnedA = updateDashboard(a.id, { pinned: true })
    expect(pinnedA.pinned).toBe(true)
    expect(listDashboards()[0]?.id).toBe(a.id)

    // Unpinning drops it back among the unpinned rows.
    expect(updateDashboard(a.id, { pinned: false }).pinned).toBe(false)
    const ids = listDashboards().map((d) => d.id)
    expect(ids).toContain(a.id)
    expect(ids).toContain(b.id)
    expect(ids).toContain(c.id)
  })

  it("round-trips JSON blobs (layout/config/recipe/pos)", () => {
    const dash = createDashboard({ name: "D", layout: { cols: 12 } })
    expect(getDashboard(dash.id)?.layout).toEqual({ cols: 12 })

    const w = createWidget({
      dashboardId: dash.id,
      title: "Signups",
      type: "chart",
      config: { chartKind: "bar", xKey: "month" },
      recipe: { command: "echo hi" },
      pos: { x: 0, y: 0, w: 6, h: 6 },
    })
    const read = listWidgets(dash.id)[0]
    expect(read.config).toEqual({ chartKind: "bar", xKey: "month" })
    expect(read.recipe).toEqual({ command: "echo hi" })
    expect(read.pos).toEqual({ x: 0, y: 0, w: 6, h: 6 })
    expect(read.id).toBe(w.id)
  })

  it("coerces an unknown widget type to 'table'", () => {
    expect(normalizeType("chart")).toBe("chart")
    expect(normalizeType("STAT")).toBe("stat")
    expect(normalizeType("bogus")).toBe("table")
    const dash = createDashboard({ name: "D" })
    const w = createWidget({ dashboardId: dash.id, title: "T", type: "nope" })
    expect(w.type).toBe("table")
  })

  it("auto-assigns widget position to the end of the list", () => {
    const dash = createDashboard({ name: "D" })
    const a = createWidget({ dashboardId: dash.id, title: "A", type: "stat" })
    const b = createWidget({ dashboardId: dash.id, title: "B", type: "stat" })
    expect(a.position).toBe(0)
    expect(b.position).toBe(1)
  })

  it("upserts widget data (replace) and reads it back", () => {
    const dash = createDashboard({ name: "D" })
    const w = createWidget({ dashboardId: dash.id, title: "T", type: "table" })
    upsertWidgetData({ widgetId: w.id, data: [{ a: 1 }], status: "ok" })
    expect(getWidgetData(w.id)?.data).toEqual([{ a: 1 }])

    // Second upsert replaces (one row per widget).
    upsertWidgetData({
      widgetId: w.id,
      status: "error",
      error: "boom",
    })
    const d = getWidgetData(w.id)
    expect(d?.status).toBe("error")
    expect(d?.error).toBe("boom")
  })

  it("cascades widget + data deletes with the dashboard", () => {
    const dash = createDashboard({ name: "D" })
    const w = createWidget({ dashboardId: dash.id, title: "T", type: "stat" })
    upsertWidgetData({ widgetId: w.id, data: [{ n: 1 }] })
    deleteDashboard(dash.id)
    expect(listWidgets(dash.id)).toHaveLength(0)
    expect(getWidgetData(w.id)).toBeNull()
  })

  it("deleting a widget cascades its data row", () => {
    const dash = createDashboard({ name: "D" })
    const w = createWidget({ dashboardId: dash.id, title: "T", type: "stat" })
    upsertWidgetData({ widgetId: w.id, data: [{ n: 1 }] })
    deleteWidget(w.id)
    expect(getWidgetData(w.id)).toBeNull()
  })

  it("assembles the whole dashboard via getDashboardGraph", () => {
    const dash = createDashboard({ name: "D" })
    const w1 = createWidget({
      dashboardId: dash.id,
      title: "One",
      type: "chart",
    })
    createWidget({ dashboardId: dash.id, title: "Two", type: "stat" })
    upsertWidgetData({ widgetId: w1.id, data: [{ x: 1 }] })

    const graph = getDashboardGraph(dash.id)!
    expect(graph.dashboard.name).toBe("D")
    expect(graph.widgets).toHaveLength(2)
    expect(graph.data).toHaveLength(1)
    expect(graph.data[0].widgetId).toBe(w1.id)

    expect(getDashboardGraph("missing")).toBeNull()
  })

  it("updateWidget patches only provided fields", () => {
    const dash = createDashboard({ name: "D" })
    const w = createWidget({
      dashboardId: dash.id,
      title: "T",
      type: "chart",
      config: { chartKind: "line" },
    })
    const updated = updateWidget(w.id, { pos: { x: 1, y: 2, w: 3, h: 4 } })
    expect(updated.pos).toEqual({ x: 1, y: 2, w: 3, h: 4 })
    // Untouched fields survive.
    expect(updated.config).toEqual({ chartKind: "line" })
    expect(updated.title).toBe("T")
  })

  it("rejects oversized widget JSON without corrupting existing config, recipe, or data", () => {
    const dash = createDashboard({ name: "D" })
    const w = createWidget({
      dashboardId: dash.id,
      title: "T",
      type: "table",
      config: { columns: [{ key: "name" }] },
      recipe: { command: "printf '[]'" },
    })
    upsertWidgetData({
      widgetId: w.id,
      data: [{ name: "before" }],
      status: "ok",
    })

    const oversized = "x".repeat(MAX_JSON_CHARS)
    expect(() => updateWidget(w.id, { config: oversized })).toThrow(
      DashboardJsonTooLargeError
    )
    expect(() =>
      updateWidget(w.id, { recipe: { command: "printf '[]'", oversized } })
    ).toThrow(DashboardJsonTooLargeError)
    expect(() =>
      upsertWidgetData({
        widgetId: w.id,
        data: [{ name: "after", oversized }],
        status: "ok",
      })
    ).toThrow(DashboardJsonTooLargeError)

    const read = getWidget(w.id)!
    expect(read.config).toEqual({ columns: [{ key: "name" }] })
    expect(read.recipe).toEqual({ command: "printf '[]'" })
    expect(getWidgetData(w.id)?.data).toEqual([{ name: "before" }])

    const rows = db
      .prepare(
        `SELECT config, recipe, NULL AS data FROM dashboard_widgets
         UNION ALL
         SELECT NULL AS config, NULL AS recipe, data FROM dashboard_widget_data`
      )
      .all() as Array<{
      config: string | null
      recipe: string | null
      data: string | null
    }>
    for (const row of rows) {
      for (const value of [row.config, row.recipe, row.data]) {
        if (value !== null) expect(() => JSON.parse(value)).not.toThrow()
      }
    }
  })

  it("preserves cached data when updating only status and error", () => {
    const dash = createDashboard({ name: "D" })
    const w = createWidget({ dashboardId: dash.id, title: "T", type: "table" })
    upsertWidgetData({ widgetId: w.id, data: [{ n: 1 }], status: "ok" })

    upsertWidgetData({ widgetId: w.id, status: "error", error: "boom" })

    const data = getWidgetData(w.id)
    expect(data?.status).toBe("error")
    expect(data?.error).toBe("boom")
    expect(data?.data).toEqual([{ n: 1 }])
  })
})

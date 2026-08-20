import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../migrations"

let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

// better-sqlite3's native binary is built for the Electron ABI here; under
// plain-Node vitest it may not load. SQLite-backed tests skip rather than fail.
let sqliteLoads = true
try {
  new Database(":memory:").close()
} catch {
  sqliteLoads = false
}

import {
  createDashboard,
  getDashboard,
  listDashboards,
  updateDashboard,
  deleteDashboard,
  createWidget,
  listWidgets,
  updateWidget,
  deleteWidget,
  getWidgetData,
  upsertWidgetData,
  getDashboardGraph,
  normalizeType,
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
    const w1 = createWidget({ dashboardId: dash.id, title: "One", type: "chart" })
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
})

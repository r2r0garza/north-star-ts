import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../../db/migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

// Real in-memory DB behind getDb, like dashboard_write.test.ts: the tool reads
// through the dashboards repo, so a live DB exercises the real join.
let db: Database.Database
vi.mock("../../db/connection", () => ({ getDb: () => db }))

import {
  dashboardReadTool,
  MAX_ITEM_BYTES,
  MAX_LISTED_DASHBOARDS,
  MAX_ROWS_PER_WIDGET,
  WIDGET_BUDGET_BYTES,
} from "./dashboard_read"
import * as dashboards from "../../db/repositories/dashboards"
import type { ToolContext } from "./types"

const ctx: ToolContext = { workspace: "/repo" }

async function read(args: Record<string, unknown> = {}) {
  return dashboardReadTool.execute(args, ctx)
}
async function readJson(args: Record<string, unknown> = {}) {
  return JSON.parse(await read(args))
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8")
}

function addWidget(
  dashboardId: string,
  position: number,
  input: {
    title?: string
    type?: string
    config?: unknown
    recipe?: unknown
    data?: unknown
    status?: string
    error?: string
  } = {}
) {
  const w = dashboards.createWidget({
    dashboardId,
    title: input.title ?? `W${position}`,
    type: input.type ?? "table",
    config: input.config ?? null,
    recipe: input.recipe ?? null,
    pos: { x: 0, y: position, w: 4, h: 3 },
    position,
  })
  if ("data" in input || input.status) {
    dashboards.upsertWidgetData({
      widgetId: w.id,
      data: input.data,
      status: input.status ?? "ok",
      error: input.error ?? null,
    })
  }
  return w
}

function rows(n: number, pad = 0) {
  return Array.from({ length: n }, (_, i) => ({ i, pad: "x".repeat(pad) }))
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

it("directs named-dashboard questions through discovery instead of workspace inspection", () => {
  const description = dashboardReadTool.definition.function.description
  expect(description).toContain("whenever the user asks what a dashboard shows")
  expect(description).toContain("Do not search the workspace")
  expect(description).toContain("call with no arguments first")
  expect(description).toContain("match the requested dashboard by name")
})

describe.skipIf(!sqliteLoads)("dashboard_read", () => {
  it("lists dashboards with stable ids and widget counts, pinned first", async () => {
    const ops = dashboards.createDashboard({
      name: "Ops",
      description: "infra",
    })
    addWidget(ops.id, 0)
    addWidget(ops.id, 1)
    const empty = dashboards.createDashboard({ name: "Empty" })
    dashboards.updateDashboard(empty.id, { pinned: true })

    const parsed = await readJson()
    expect(parsed.total).toBe(2)
    expect(parsed.returned).toBe(2)
    expect(parsed.truncated).toBe(false)
    expect(parsed.dashboards.map((d: { id: string }) => d.id)).toEqual([
      empty.id,
      ops.id,
    ])
    expect(parsed.dashboards[0]).toMatchObject({
      name: "Empty",
      pinned: true,
      widgetCount: 0,
    })
    expect(parsed.dashboards[1]).toMatchObject({
      name: "Ops",
      description: "infra",
      widgetCount: 2,
    })
  })

  it(`caps discovery at ${MAX_LISTED_DASHBOARDS} dashboards and says so`, async () => {
    for (let i = 0; i <= MAX_LISTED_DASHBOARDS; i++) {
      dashboards.createDashboard({ name: `D${i}` })
    }
    const parsed = await readJson()
    expect(parsed.total).toBe(MAX_LISTED_DASHBOARDS + 1)
    expect(parsed.returned).toBe(MAX_LISTED_DASHBOARDS)
    expect(parsed.dashboards).toHaveLength(MAX_LISTED_DASHBOARDS)
    expect(parsed.truncated).toBe(true)
  })

  it("joins each widget to its own cache row across widget types", async () => {
    const d = dashboards.createDashboard({ name: "Repo" })
    const chart = addWidget(d.id, 0, {
      title: "Commits",
      type: "chart",
      config: { chartKind: "bar", xKey: "month" },
      data: [{ month: "Jan", commits: 12 }],
    })
    const stat = addWidget(d.id, 1, {
      title: "Total",
      type: "stat",
      config: { valueKey: "total" },
      data: { total: 412 },
    })
    const table = addWidget(d.id, 2, {
      title: "Authors",
      type: "table",
      data: [{ name: "a" }, { name: "b" }],
    })

    const parsed = await readJson({ dashboardId: d.id })
    expect(parsed.complete).toBe(true)
    expect(parsed.widgetCount).toBe(3)
    expect(parsed.omittedWidgets).toEqual([])
    expect(parsed.widgets.map((w: { id: string }) => w.id)).toEqual([
      chart.id,
      stat.id,
      table.id,
    ])
    expect(parsed.widgets[0]).toMatchObject({
      title: "Commits",
      type: "chart",
      config: { chartKind: "bar", xKey: "month" },
      status: "ok",
      rowsTotal: 1,
      rowsReturned: 1,
      rows: [{ month: "Jan", commits: 12 }],
    })
    expect(parsed.widgets[1]).toMatchObject({
      type: "stat",
      value: { total: 412 },
    })
    expect(parsed.widgets[1].rows).toBeUndefined()
    expect(parsed.widgets[2].rows).toEqual([{ name: "a" }, { name: "b" }])
  })

  it("preserves status, error, and fetchedAt, and shows widgets with no cache", async () => {
    const d = dashboards.createDashboard({ name: "Health" })
    const failed = addWidget(d.id, 0, {
      data: [{ n: 1 }],
      status: "error",
      error: "command exited 1",
    })
    addWidget(d.id, 1, { status: "stale" })
    addWidget(d.id, 2)
    const cache = dashboards.getWidgetData(failed.id)!

    const parsed = await readJson({ dashboardId: d.id })
    expect(parsed.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(parsed.widgets[0]).toMatchObject({
      status: "error",
      error: "command exited 1",
      fetchedAt: new Date(cache.fetchedAt).toISOString(),
      rows: [{ n: 1 }],
    })
    expect(parsed.widgets[1]).toMatchObject({ status: "stale", value: null })
    expect(parsed.widgets[2]).toMatchObject({
      status: "no_data",
      fetchedAt: null,
    })
    expect(parsed.widgets[2]).not.toHaveProperty("value")
    expect(parsed.widgets[2]).not.toHaveProperty("rows")
  })

  it("truncates long errors with an explicit flag", async () => {
    const d = dashboards.createDashboard({ name: "E" })
    addWidget(d.id, 0, { status: "error", error: "e".repeat(5_000) })
    const [w] = (await readJson({ dashboardId: d.id })).widgets
    expect(w.errorTruncated).toBe(true)
    expect(w.error.length).toBeLessThanOrEqual(1_001)
  })

  it("returns a structured not_found error for an unknown dashboard", async () => {
    expect(await read({ dashboardId: "nope" })).toMatch(/^ERROR\[not_found\]/)
  })

  it("omits recipes, captured paths, and layout from the response", async () => {
    const d = dashboards.createDashboard({
      name: "Secretive",
      layout: { columns: 12 },
    })
    addWidget(d.id, 0, {
      recipe: {
        command: "gh api repos --json secret_marker",
        cwd: "/private/workspace",
        workspace: "/private/workspace",
      },
      data: [{ n: 1 }],
    })
    const text = await read({ dashboardId: d.id })
    expect(text).not.toContain("secret_marker")
    expect(text).not.toContain("/private/workspace")
    expect(text).not.toContain("recipe")
    expect(text).not.toContain("columns")
    const [w] = JSON.parse(text).widgets
    expect(w).not.toHaveProperty("pos")
    expect(w).not.toHaveProperty("position")
  })

  it(`caps rows at ${MAX_ROWS_PER_WIDGET} per widget and pages with rowOffset`, async () => {
    const d = dashboards.createDashboard({ name: "Many" })
    const w = addWidget(d.id, 0, { data: rows(120) })
    const next = addWidget(d.id, 1, { data: rows(1) })

    const first = await readJson({ dashboardId: d.id })
    expect(first.complete).toBe(false)
    expect(first.widgets[0]).toMatchObject({
      rowsTotal: 120,
      rowOffset: 0,
      rowsReturned: MAX_ROWS_PER_WIDGET,
      nextRowOffset: MAX_ROWS_PER_WIDGET,
    })
    // Hitting the ROW cap (not the budget) doesn't omit later widgets.
    expect(first.widgets[1].id).toBe(next.id)
    expect(first.omittedWidgets).toEqual([])
    expect(first.hint).toContain("rowOffset")

    const last = await readJson({
      dashboardId: d.id,
      widgetIds: [w.id],
      rowOffset: 100,
    })
    expect(last.selectedWidgetCount).toBe(1)
    expect(last.widgets).toHaveLength(1)
    expect(last.widgets[0]).toMatchObject({
      rowOffset: 100,
      rowsReturned: 20,
    })
    expect(last.widgets[0].rows[0]).toEqual({ i: 100, pad: "" })
    expect(last.widgets[0]).not.toHaveProperty("nextRowOffset")
    expect(last.complete).toBe(true)
  })

  it("fills the widget budget exactly at the boundary and cuts one byte over", async () => {
    const d = dashboards.createDashboard({ name: "Boundary" })
    const data = rows(MAX_ROWS_PER_WIDGET, 600)
    const w = addWidget(d.id, 0, { data })
    const after = addWidget(d.id, 1, { title: "After", data: [{ n: 1 }] })

    // Measure the single-widget record, then grow the last row so the record is
    // exactly the budget.
    const probe = await readJson({ dashboardId: d.id, widgetIds: [w.id] })
    const slack = WIDGET_BUDGET_BYTES - bytes(probe.widgets[0])
    expect(slack).toBeGreaterThan(0)
    expect(slack).toBeLessThan(MAX_ITEM_BYTES - 700)
    const exact = [...data]
    exact[exact.length - 1] = {
      i: exact.length - 1,
      pad: "x".repeat(600 + slack),
    }
    dashboards.upsertWidgetData({ widgetId: w.id, data: exact, status: "ok" })

    const fits = await readJson({ dashboardId: d.id })
    expect(bytes(fits.widgets[0])).toBe(WIDGET_BUDGET_BYTES)
    expect(fits.widgets[0].rowsReturned).toBe(MAX_ROWS_PER_WIDGET)
    expect(fits.widgets[0]).not.toHaveProperty("nextRowOffset")
    // Budget fully spent: the next widget is omitted, not partially returned.
    expect(fits.widgets).toHaveLength(1)
    expect(fits.omittedWidgets).toEqual([
      { id: after.id, title: "After", type: "table", reason: "budget" },
    ])
    expect(fits.complete).toBe(false)

    exact[exact.length - 1] = {
      i: exact.length - 1,
      pad: "x".repeat(601 + slack),
    }
    dashboards.upsertWidgetData({ widgetId: w.id, data: exact, status: "ok" })
    const over = await readJson({ dashboardId: d.id })
    expect(over.widgets[0]).toMatchObject({
      rowsReturned: MAX_ROWS_PER_WIDGET - 1,
      nextRowOffset: MAX_ROWS_PER_WIDGET - 1,
    })
    expect(bytes(over.widgets[0])).toBeLessThanOrEqual(WIDGET_BUDGET_BYTES)
    expect(over.omittedWidgets.map((o: { id: string }) => o.id)).toEqual([
      after.id,
    ])
  })

  it("omits a contiguous tail of widgets once the budget is spent, and they are readable by id", async () => {
    const d = dashboards.createDashboard({ name: "Full" })
    const ids: string[] = []
    for (let i = 0; i < 64; i++) {
      ids.push(addWidget(d.id, i, { data: rows(10, 200) }).id)
    }

    const parsed = await readJson({ dashboardId: d.id })
    const returned = parsed.widgets.map((w: { id: string }) => w.id)
    const omitted = parsed.omittedWidgets.map((o: { id: string }) => o.id)
    expect(returned.length).toBeGreaterThan(0)
    expect(omitted.length).toBeGreaterThan(0)
    expect([...returned, ...omitted]).toEqual(ids)
    const total = parsed.widgets.reduce(
      (sum: number, w: unknown) => sum + bytes(w),
      0
    )
    expect(total).toBeLessThanOrEqual(WIDGET_BUDGET_BYTES)
    expect(parsed.complete).toBe(false)
    expect(parsed.hint).toContain(omitted[0])

    const rest = await readJson({ dashboardId: d.id, widgetIds: omitted })
    expect(rest.widgets[0].id).toBe(omitted[0])
  })

  it("replaces oversized rows, values, and configs with explicit markers", async () => {
    const d = dashboards.createDashboard({ name: "Big" })
    const huge = "y".repeat(MAX_ITEM_BYTES + 10)
    addWidget(d.id, 0, {
      config: { blob: huge },
      data: [{ n: 1 }, { big: huge }, { n: 3 }],
    })
    addWidget(d.id, 1, { type: "stat", data: { big: huge } })

    const parsed = await readJson({ dashboardId: d.id })
    expect(parsed.widgets[0].config).toEqual({
      _omitted: "config_too_large",
      bytes: bytes({ blob: huge }),
    })
    expect(parsed.widgets[0].rows).toEqual([
      { n: 1 },
      { _omitted: "row_too_large", bytes: bytes({ big: huge }) },
      { n: 3 },
    ])
    expect(parsed.widgets[1].value).toMatchObject({
      _omitted: "value_too_large",
    })
  })

  it("validates widget selection and paging arguments", async () => {
    const d = dashboards.createDashboard({ name: "Args" })
    const a = addWidget(d.id, 0, { data: [{ n: 1 }] })
    const b = addWidget(d.id, 1, { data: [{ n: 2 }] })

    expect(await read({ dashboardId: d.id, rowOffset: 5 })).toMatch(
      /^ERROR\[bad_args\]/
    )
    expect(
      await read({ dashboardId: d.id, widgetIds: [a.id, b.id], rowOffset: 5 })
    ).toMatch(/^ERROR\[bad_args\]/)
    expect(
      await read({ dashboardId: d.id, widgetIds: [a.id], rowOffset: -1 })
    ).toMatch(/^ERROR\[bad_args\]/)
    expect(await read({ widgetIds: [a.id] })).toMatch(/^ERROR\[bad_args\]/)

    // Selection keeps dashboard order; unknown ids are reported; JSON-string
    // arrays are accepted.
    const parsed = await readJson({
      dashboardId: d.id,
      widgetIds: JSON.stringify([b.id, "missing", a.id]),
    })
    expect(parsed.widgets.map((w: { id: string }) => w.id)).toEqual([
      a.id,
      b.id,
    ])
    expect(parsed.unknownWidgetIds).toEqual(["missing"])
  })

  it("never mutates dashboards or their cache", async () => {
    const d = dashboards.createDashboard({ name: "Frozen" })
    addWidget(d.id, 0, { data: rows(3), status: "stale" })
    const snapshot = () => ({
      dashboards: db.prepare("SELECT * FROM dashboards").all(),
      widgets: db.prepare("SELECT * FROM dashboard_widgets").all(),
      data: db.prepare("SELECT * FROM dashboard_widget_data").all(),
    })
    const before = snapshot()
    await read()
    await read({ dashboardId: d.id })
    expect(snapshot()).toEqual(before)
    expect(dashboardReadTool.effects).toMatchObject({
      readOnly: true,
      openWorld: false,
    })
  })
})

import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../../db/migrations"

// Real in-memory DB behind getDb: the tool wraps its writes in a transaction and
// calls the dashboards repo (which also uses getDb), so a live DB exercises the
// whole path including the replace-all + data-seed.
let db: Database.Database
vi.mock("../../db/connection", () => ({ getDb: () => db }))

let sqliteLoads = true
try {
  new Database(":memory:").close()
} catch {
  sqliteLoads = false
}

import { dashboardWriteTool } from "./dashboard_write"
import * as dashboards from "../../db/repositories/dashboards"
import type { ToolContext } from "./types"

const ctx: ToolContext = { workspace: "/repo" }
const noWorkspaceCtx: ToolContext = { workspace: "" }

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)("dashboard_write", () => {
  it("creates a dashboard with widgets + seeded data", async () => {
    const result = await dashboardWriteTool.execute(
      {
        name: "Ops",
        widgets: [
          {
            title: "Signups",
            type: "chart",
            config: { chartKind: "bar", xKey: "month" },
            recipe: { command: "curl …" },
            data: [{ month: "Jan", count: 3 }],
          },
        ],
      },
      ctx
    )
    const parsed = JSON.parse(result)
    expect(parsed.name).toBe("Ops")
    expect(parsed.widgets).toHaveLength(1)
    expect(parsed.widgets[0].hasData).toBe(true)

    const graph = dashboards.getDashboardGraph(parsed.dashboardId)!
    expect(graph.widgets[0].title).toBe("Signups")
    expect(graph.widgets[0].recipe).toEqual({
      command: "curl …",
      cwd: "/repo",
      workspace: "/repo",
    })
    expect(graph.data[0].data).toEqual([{ month: "Jan", count: 3 }])
  })

  it("overwrites model-supplied command cwd with the active workspace", async () => {
    const parsed = JSON.parse(
      await dashboardWriteTool.execute(
        {
          name: "Ops",
          widgets: [
            {
              title: "External",
              type: "table",
              recipe: { command: "cat metrics.json", cwd: "/tmp/outside" },
            },
          ],
        },
        ctx
      )
    )

    const graph = dashboards.getDashboardGraph(parsed.dashboardId)!
    expect(graph.widgets[0].recipe).toEqual({
      command: "cat metrics.json",
      cwd: "/repo",
      workspace: "/repo",
    })
  })

  it("rejects command recipes without an active workspace", async () => {
    const result = await dashboardWriteTool.execute(
      {
        name: "Ops",
        widgets: [
          {
            title: "M",
            type: "table",
            recipe: { command: "cat metrics.json" },
          },
        ],
      },
      noWorkspaceCtx
    )
    expect(result).toContain("ERROR[bad_args]")
    expect(result).toMatch(/active workspace/i)
  })

  it("replaces widgets when updating an existing dashboard", async () => {
    const first = JSON.parse(
      await dashboardWriteTool.execute(
        { name: "D", widgets: [{ title: "Old", type: "stat" }] },
        ctx
      )
    )
    const updated = JSON.parse(
      await dashboardWriteTool.execute(
        {
          dashboardId: first.dashboardId,
          widgets: [
            { title: "New A", type: "table" },
            { title: "New B", type: "chart" },
          ],
        },
        ctx
      )
    )
    expect(updated.dashboardId).toBe(first.dashboardId)
    const titles = dashboards.listWidgets(first.dashboardId).map((w) => w.title)
    expect(titles).toEqual(["New A", "New B"]) // Old is gone
  })

  it("rejects oversized dashboard JSON and preserves the previous dashboard", async () => {
    const first = JSON.parse(
      await dashboardWriteTool.execute(
        {
          name: "D",
          widgets: [
            {
              title: "Old",
              type: "table",
              config: { columns: [{ key: "name" }] },
              data: [{ name: "before" }],
            },
          ],
        },
        ctx
      )
    )
    const oldWidgetId = dashboards.listWidgets(first.dashboardId)[0].id

    const result = await dashboardWriteTool.execute(
      {
        dashboardId: first.dashboardId,
        widgets: [
          {
            title: "Too big",
            type: "table",
            config: { blob: "x".repeat(dashboards.MAX_JSON_CHARS) },
          },
        ],
      },
      ctx
    )

    expect(result).toContain("ERROR[json_too_large]")
    const graph = dashboards.getDashboardGraph(first.dashboardId)!
    expect(graph.widgets).toHaveLength(1)
    expect(graph.widgets[0].id).toBe(oldWidgetId)
    expect(graph.widgets[0].title).toBe("Old")
    expect(graph.widgets[0].config).toEqual({ columns: [{ key: "name" }] })
    expect(graph.data[0].data).toEqual([{ name: "before" }])
  })

  it("coerces an unknown widget type to 'table'", async () => {
    const parsed = JSON.parse(
      await dashboardWriteTool.execute(
        { name: "D", widgets: [{ title: "T", type: "pie" }] },
        ctx
      )
    )
    expect(
      dashboards.getDashboardGraph(parsed.dashboardId)!.widgets[0].type
    ).toBe("table")
  })

  it("rejects a create with no name", async () => {
    const result = await dashboardWriteTool.execute({ widgets: [] }, ctx)
    expect(result).toContain("ERROR[bad_args]")
  })

  it("rejects updating a non-existent dashboard", async () => {
    const result = await dashboardWriteTool.execute(
      { dashboardId: "nope", name: "x", widgets: [] },
      ctx
    )
    expect(result).toContain("ERROR[not_found]")
  })

  it("parses a JSON-string widgets argument", async () => {
    const parsed = JSON.parse(
      await dashboardWriteTool.execute(
        {
          name: "D",
          widgets: JSON.stringify([{ title: "T", type: "stat" }]),
        },
        ctx
      )
    )
    expect(parsed.widgets).toHaveLength(1)
  })
})

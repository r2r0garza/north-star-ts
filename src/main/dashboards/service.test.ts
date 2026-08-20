import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../db/migrations"

// Real in-memory DB behind getDb: the executor reads widgets, authorizes via the
// shared PolicyEngine (real action_allowlist), and writes the widget-data cache.
let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))

// Mock the Environment factory's createEnvironment so a shell recipe doesn't
// spawn a real process — the mock env returns whatever stdout the current test
// wants. Preserve the rest of the module (envConfigFromEnv is used by settings).
let execStdout = "[]"
let execCalls: string[] = []
const disposed = vi.fn()
vi.mock("../agent/env/factory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent/env/factory")>()
  return {
    ...actual,
    createEnvironment: vi.fn(async () => ({
      exec: async (command: string) => {
        execCalls.push(command)
        return {
          stdout: Buffer.from(execStdout, "utf8"),
          exitCode: 0,
          signal: null,
          timedOut: false,
        }
      },
      dispose: disposed,
    })),
  }
})

let sqliteLoads = true
try {
  new Database(":memory:").close()
} catch {
  sqliteLoads = false
}

import { DashboardService, DASHBOARD_REFRESH_KIND } from "./service"
import * as dashboards from "../db/repositories/dashboards"
import { addRule } from "../db/repositories/action-allowlist"
import { normalizeCommand } from "../agent/approval/normalize"
import type { TaskRunner } from "../tasks/runner"
import type { Task } from "../db/types"

// A minimal fake runner capturing the last enqueued task + returning a stub Task.
function makeRunner(): {
  runner: TaskRunner
  enqueued: Array<{ kind: string; input: Record<string, unknown> }>
} {
  const enqueued: Array<{ kind: string; input: Record<string, unknown> }> = []
  const runner = {
    enqueueKind: (input: { kind: string; input: Record<string, unknown> }) => {
      enqueued.push({ kind: input.kind, input: input.input })
      return { id: `task-${enqueued.length}`, status: "queued" } as Task
    },
  } as unknown as TaskRunner
  return { runner, enqueued }
}

// Run the executor against a synthetic task carrying { dashboardId }.
async function runExecute(service: DashboardService, dashboardId: string) {
  const signal = new AbortController().signal
  return service.execute({
    task: { id: "t1", input: { kind: DASHBOARD_REFRESH_KIND, dashboardId } } as Task,
    signal,
    emit: () => {},
    workspace: undefined,
  })
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
  execStdout = "[]"
  execCalls = []
  disposed.mockClear()
})

afterEach(() => {
  if (sqliteLoads) db.close()
})

describe.skipIf(!sqliteLoads)("DashboardService.execute", () => {
  it("runs an allowlisted shell recipe and caches its JSON rows as ok", async () => {
    const { runner } = makeRunner()
    const service = new DashboardService(runner)
    const dash = dashboards.createDashboard({ name: "D" })
    const cmd = "cat metrics.json"
    const widget = dashboards.createWidget({
      dashboardId: dash.id,
      title: "M",
      type: "table",
      recipe: { command: cmd, cwd: "/repo" },
    })
    // Bless the command at workspace scope (as author-time "always allow" would).
    addRule({
      tool: "run_shell_tool",
      kind: "shell",
      identity: normalizeCommand(cmd),
      scope: "workspace",
      workspacePath: "/repo",
    })
    execStdout = JSON.stringify([{ a: 1 }, { a: 2 }])

    const result = await runExecute(service, dash.id)
    expect(result.content).toContain("refreshed 1/1")
    expect(execCalls).toEqual([cmd])
    const cached = dashboards.getWidgetData(widget.id)
    expect(cached?.status).toBe("ok")
    expect(cached?.data).toEqual([{ a: 1 }, { a: 2 }])
  })

  it("fails closed (stale) for a non-allowlisted shell recipe — never runs it", async () => {
    const { runner } = makeRunner()
    const service = new DashboardService(runner)
    const dash = dashboards.createDashboard({ name: "D" })
    const widget = dashboards.createWidget({
      dashboardId: dash.id,
      title: "M",
      type: "table",
      recipe: { command: "cat secrets.json", cwd: "/repo" },
    })

    await runExecute(service, dash.id)
    expect(execCalls).toEqual([]) // never executed
    const cached = dashboards.getWidgetData(widget.id)
    expect(cached?.status).toBe("stale")
    expect(cached?.error).toMatch(/approv/i)
  })

  it("marks a shell recipe with no cwd stale (fail closed)", async () => {
    const { runner } = makeRunner()
    const service = new DashboardService(runner)
    const dash = dashboards.createDashboard({ name: "D" })
    const widget = dashboards.createWidget({
      dashboardId: dash.id,
      title: "M",
      type: "table",
      recipe: { command: "echo hi" }, // no cwd
    })

    await runExecute(service, dash.id)
    expect(execCalls).toEqual([])
    expect(dashboards.getWidgetData(widget.id)?.status).toBe("stale")
  })

  it("marks a widget error when the recipe output is not JSON rows", async () => {
    const { runner } = makeRunner()
    const service = new DashboardService(runner)
    const dash = dashboards.createDashboard({ name: "D" })
    const cmd = "ls -la"
    const widget = dashboards.createWidget({
      dashboardId: dash.id,
      title: "M",
      type: "table",
      recipe: { command: cmd, cwd: "/repo" },
    })
    addRule({
      tool: "run_shell_tool",
      kind: "shell",
      identity: normalizeCommand(cmd),
      scope: "workspace",
      workspacePath: "/repo",
    })
    execStdout = "total 8\ndrwxr-xr-x  file.txt" // not JSON

    await runExecute(service, dash.id)
    const cached = dashboards.getWidgetData(widget.id)
    expect(cached?.status).toBe("error")
    expect(cached?.error).toMatch(/JSON rows/i)
  })

  it("leaves a recipe-less (manual) widget untouched", async () => {
    const { runner } = makeRunner()
    const service = new DashboardService(runner)
    const dash = dashboards.createDashboard({ name: "D" })
    const widget = dashboards.createWidget({
      dashboardId: dash.id,
      title: "manual",
      type: "stat",
    })
    dashboards.upsertWidgetData({ widgetId: widget.id, data: [{ n: 5 }], status: "ok" })

    const result = await runExecute(service, dash.id)
    expect(result.content).toContain("refreshed 0/1")
    // Its data survives unchanged.
    expect(dashboards.getWidgetData(widget.id)?.data).toEqual([{ n: 5 }])
  })

  it("returns an error for a missing dashboardId / unknown dashboard", async () => {
    const { runner } = makeRunner()
    const service = new DashboardService(runner)
    const noId = await service.execute({
      task: { id: "t", input: { kind: DASHBOARD_REFRESH_KIND } } as Task,
      signal: new AbortController().signal,
      emit: () => {},
      workspace: undefined,
    })
    expect(noId.error).toBeTruthy()
    const missing = await runExecute(service, "nope")
    expect(missing.error).toBe("dashboard not found")
  })
})

describe.skipIf(!sqliteLoads)("DashboardService.ensureRefresh", () => {
  it("enqueues a refresh task for a real dashboard", () => {
    const { runner, enqueued } = makeRunner()
    const service = new DashboardService(runner)
    const dash = dashboards.createDashboard({ name: "D" })
    const task = service.ensureRefresh(dash.id)
    expect(task).not.toBeNull()
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].kind).toBe(DASHBOARD_REFRESH_KIND)
    expect(enqueued[0].input.dashboardId).toBe(dash.id)
  })

  it("no-ops for an unknown dashboard", () => {
    const { runner, enqueued } = makeRunner()
    const service = new DashboardService(runner)
    expect(service.ensureRefresh("nope")).toBeNull()
    expect(enqueued).toHaveLength(0)
  })
})

describe.skipIf(!sqliteLoads)("DashboardService.approveRecipe", () => {
  it("writes a workspace-scoped allowlist rule for a shell recipe, then refreshes", () => {
    const { runner, enqueued } = makeRunner()
    const service = new DashboardService(runner)
    const dash = dashboards.createDashboard({ name: "D" })
    const cmd = "cat metrics.json"
    const widget = dashboards.createWidget({
      dashboardId: dash.id,
      title: "M",
      type: "table",
      recipe: { command: cmd, cwd: "/repo" },
    })
    const result = service.approveRecipe(widget.id)
    expect(result.ok).toBe(true)
    // The identity is the normalized command, scoped to the recipe's cwd.
    const rows = db
      .prepare("SELECT * FROM action_allowlist")
      .all() as Array<{ kind: string; identity: string; scope: string; workspace_path: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe("shell")
    expect(rows[0].identity).toBe(normalizeCommand(cmd))
    expect(rows[0].scope).toBe("workspace")
    expect(rows[0].workspace_path).toBe("/repo")
    // A refresh was triggered.
    expect(enqueued).toHaveLength(1)
  })

  it("fails (no rule, ok:false) for a shell recipe with no cwd", () => {
    const { runner, enqueued } = makeRunner()
    const service = new DashboardService(runner)
    const dash = dashboards.createDashboard({ name: "D" })
    const widget = dashboards.createWidget({
      dashboardId: dash.id,
      title: "M",
      type: "table",
      recipe: { command: "echo hi" }, // no cwd (e.g. a pre-033.3 recipe)
    })
    const result = service.approveRecipe(widget.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/working directory/i)
    // No grant written, no refresh enqueued.
    expect(db.prepare("SELECT * FROM action_allowlist").all()).toHaveLength(0)
    expect(enqueued).toHaveLength(0)
  })

  it("writes a global rule for a web recipe", () => {
    const { runner } = makeRunner()
    const service = new DashboardService(runner)
    const dash = dashboards.createDashboard({ name: "D" })
    const widget = dashboards.createWidget({
      dashboardId: dash.id,
      title: "W",
      type: "table",
      recipe: { url: "https://api.example.com/data" },
    })
    service.approveRecipe(widget.id)
    const rows = db
      .prepare("SELECT * FROM action_allowlist")
      .all() as Array<{ kind: string; identity: string; scope: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe("web")
    expect(rows[0].identity).toBe("web_fetch:https://api.example.com/data")
    expect(rows[0].scope).toBe("global")
  })
})

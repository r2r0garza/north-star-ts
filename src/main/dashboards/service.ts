import {
  listWidgets,
  upsertWidgetData,
  getWidget,
  getWidgetData,
  getDashboard,
} from "../db/repositories/dashboards"
import { listTasks } from "../db/repositories/tasks"
import { addRule } from "../db/repositories/action-allowlist"
import type { TaskRunner, TaskExecutor, TaskExecResult } from "../tasks/runner"
import type { DashboardRecipe, DashboardWidget, Task } from "../db/types"
import type { ToolAction } from "../agent/approval/types"
import { normalizeCommand } from "../agent/approval/normalize"
import { stripAnsi } from "../agent/approval/ansi"
import { makePolicyEngine } from "../agent/approval/engine"
import { createEnvironment, type EnvConfig } from "../agent/env/factory"
import type { Environment } from "../agent/env/types"
import { safeFetch } from "../agent/tools/web/safe-fetch"
import * as settingsService from "../settings/service"

export const DASHBOARD_REFRESH_KIND = "dashboard_refresh"

// Statuses that mean a refresh task is already in flight, so ensureRefresh should
// not enqueue a duplicate. Mirrors IndexService.LIVE_STATUSES.
const LIVE_STATUSES = new Set(["queued", "running", "waiting_for_approval"])

// Reuse the shell tool's limits so a headless replay behaves identically.
const EXEC_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 1024 * 1024

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"

// Thrown to unwind the per-widget loop on pause/cancel; runOne maps the returned
// {stopped} to the right terminal status. Mirrors IndexService's AbortedError.
class AbortedError extends Error {}

// The result of authorizing + re-running ONE widget's recipe.
type WidgetOutcome =
  | { kind: "ok" }
  | { kind: "skip" } // no recipe → left untouched
  | { kind: "stale"; reason: string } // fail-closed (needs approval / no cwd)
  | { kind: "error"; reason: string } // ran but produced unusable output

// Coerce the opaque recipe blob into the typed shape (strings only; anything
// else is treated as absent).
function asRecipe(raw: unknown): DashboardRecipe | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const pick = (v: unknown) => (typeof v === "string" ? v : undefined)
  const recipe: DashboardRecipe = {
    command: pick(r.command),
    url: pick(r.url),
    cwd: pick(r.cwd),
    workspace: pick(r.workspace),
    note: pick(r.note),
  }
  return recipe.command || recipe.url ? recipe : null
}

function validateCommandWorkspace(recipe: DashboardRecipe): string | null {
  if (!recipe.command) return null
  if (!recipe.cwd || !recipe.workspace) {
    return "recipe has no verified workspace — re-author it to refresh"
  }
  if (recipe.cwd !== recipe.workspace) {
    return "recipe working directory does not match its captured workspace — re-author it to refresh"
  }
  return null
}

// Reconstruct the SAME ToolAction the origin tool built, so the policy engine's
// allowlist match keys on an identical (kind, identity). Returns null when the
// recipe references no runnable action.
function actionFor(recipe: DashboardRecipe): ToolAction | null {
  if (recipe.command) {
    return {
      tool: "run_shell_tool",
      kind: "shell",
      summary: `$ ${recipe.command}`,
      identity: normalizeCommand(recipe.command),
      detail: { command: recipe.command },
    }
  }
  if (recipe.url) {
    let href: string
    try {
      href = new URL(recipe.url).href
    } catch {
      return null
    }
    return {
      tool: "web_fetch",
      kind: "web",
      summary: `Fetch ${href}`,
      identity: `web_fetch:${href}`,
      detail: { url: href },
    }
  }
  return null
}

// Parse a recipe's raw output into the array-of-flat-objects the view renders.
// A lone object is wrapped; anything non-JSON / non-array/object throws.
function parseRows(output: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(output) as unknown
  if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>
  if (parsed && typeof parsed === "object")
    return [parsed as Record<string, unknown>]
  throw new Error("not an array or object")
}

// Deterministic dashboard refresh (plan 033.3). Re-runs each widget's stored
// recipe with NO LLM, writing fresh rows into the dashboard_widget_data cache the
// view reads. The FIRST executor to perform a gated-in-origin side effect
// headless, so every recipe is re-authorized through the shared PolicyEngine
// (hard_block preserved) and fails CLOSED — a non-allow outcome marks the widget
// `stale` with a reason rather than running. One DashboardService per app.
export class DashboardService {
  private readonly policy = makePolicyEngine()

  constructor(private readonly runner: TaskRunner) {}

  // The executor the runner invokes for the `dashboard_refresh` kind. Registered
  // at app init: runner.registerKind(DASHBOARD_REFRESH_KIND, { run, ... }).
  readonly execute: TaskExecutor = async ({ task, signal, emit }) => {
    const input = task.input as {
      dashboardId?: string
      maxAgeMs?: number
    } | null
    const dashboardId = input?.dashboardId
    if (!dashboardId)
      return { error: "dashboard_refresh task missing dashboardId" }
    if (!getDashboard(dashboardId)) return { error: "dashboard not found" }
    // On-open refresh passes maxAgeMs so a widget whose cached data is still
    // fresh is skipped (no re-running its command/fetch on every glance). The
    // manual Refresh button omits it → force a full re-run.
    const maxAgeMs = typeof input?.maxAgeMs === "number" ? input.maxAgeMs : 0

    const widgets = listWidgets(dashboardId)
    const envConfig = settingsService.getExecutionConfig()
    // Built lazily on the first shell recipe and reused across widgets, so a
    // URL-only dashboard never spins up a container. A holder (not a plain `let`)
    // so control-flow narrowing doesn't lose the type across the closure.
    const envRef: { current: Environment | null } = { current: null }
    const getEnv = async (cwd: string): Promise<Environment> => {
      if (!envRef.current) {
        // conversationId only names a container; a synthetic id keeps runs distinct.
        envRef.current = await createEnvironment(
          cwd,
          `dashboard:${dashboardId}`,
          envConfig
        )
      }
      return envRef.current
    }

    let done = 0
    let refreshed = 0
    try {
      for (const widget of widgets) {
        if (signal.aborted) throw new AbortedError()
        const result = await this.refreshWidget(
          widget,
          envConfig,
          signal,
          getEnv,
          maxAgeMs
        )
        if (result.kind === "ok") refreshed++
        done++
        emit({
          type: "dashboard_refresh_progress",
          dashboardId,
          widgetsDone: done,
          widgetsTotal: widgets.length,
        })
      }
      return { content: `refreshed ${refreshed}/${widgets.length} widgets` }
    } catch (err) {
      if (err instanceof AbortedError || signal.aborted)
        return { stopped: true }
      const message = err instanceof Error ? err.message : String(err)
      return { error: message, retryable: false }
    } finally {
      if (envRef.current) await envRef.current.dispose()
    }
  }

  // Authorize + re-run one widget's recipe, then write the cache. A widget-level
  // failure is captured per-widget (not fatal to the whole refresh); only an
  // abort propagates (as AbortedError) to stop the run.
  private async refreshWidget(
    widget: DashboardWidget,
    envConfig: EnvConfig,
    signal: AbortSignal,
    getEnv: (cwd: string) => Promise<Environment>,
    maxAgeMs: number
  ): Promise<WidgetOutcome> {
    const recipe = asRecipe(widget.recipe)
    if (!recipe) return { kind: "skip" } // manually-authored widget: leave its data

    // Staleness throttle (on-open refresh): if the cached data is still `ok` and
    // younger than maxAgeMs, skip the re-run. maxAgeMs = 0 (manual Refresh) always
    // re-runs.
    if (maxAgeMs > 0) {
      const cached = getWidgetData(widget.id)
      if (
        cached &&
        cached.status === "ok" &&
        Date.now() - cached.fetchedAt < maxAgeMs
      ) {
        return { kind: "skip" }
      }
    }

    const action = actionFor(recipe)
    if (!action) {
      return this.markStale(widget.id, "recipe has no runnable command or URL")
    }

    // A shell command needs a server-captured workspace to run in AND to match
    // the workspace-scoped allowlist grant. Missing or mismatched legacy values
    // fail closed so a stored recipe cannot move execution to another host path.
    if (action.kind === "shell") {
      const workspaceError = validateCommandWorkspace(recipe)
      if (workspaceError) return this.markStale(widget.id, workspaceError)
    }

    // Authorize through the SAME engine the agent loop uses. hard_block always
    // wins; a workspace-scoped grant matches via the server-captured workspace;
    // a global grant (from "Approve this recipe" on a web recipe) matches with
    // no scope inputs. Any non-allow verdict fails closed — no human is watching
    // a headless refresh.
    const decision = this.policy.decide(action, {
      workspacePath: recipe.workspace,
      sandboxed: envConfig.kind === "container",
      localProfile:
        envConfig.kind === "local"
          ? (envConfig.profile ?? "host-access")
          : "host-access",
    })
    if (decision.level !== "allow") {
      return this.markStale(
        widget.id,
        decision.level === "hard_block"
          ? "recipe is blocked and cannot run"
          : "needs approval — open the dashboard and approve this recipe"
      )
    }

    let output: string
    try {
      if (action.kind === "shell") {
        const env = await getEnv(recipe.workspace!)
        const result = await env.exec(recipe.command!, {
          cwd: recipe.workspace!,
          timeoutMs: EXEC_TIMEOUT_MS,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          signal,
        })
        output = stripAnsi(result.stdout.toString("utf8"))
      } else {
        const res = await safeFetch(recipe.url!, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json,*/*" },
          signal,
        })
        if (!res.ok) {
          return this.markError(
            widget.id,
            `HTTP ${res.status} fetching the recipe URL`
          )
        }
        output = await res.text()
      }
    } catch (err) {
      // A cancel/pause aborts the fetch/exec — propagate so the run stops.
      if (err instanceof Error && err.name === "AbortError")
        throw new AbortedError()
      if (signal.aborted) throw new AbortedError()
      return this.markError(
        widget.id,
        err instanceof Error ? err.message : String(err)
      )
    }

    let rows: Array<Record<string, unknown>>
    try {
      rows = parseRows(output.trim())
    } catch {
      return this.markError(
        widget.id,
        "recipe must output JSON rows (an array of flat objects)"
      )
    }

    upsertWidgetData({ widgetId: widget.id, data: rows, status: "ok" })
    return { kind: "ok" }
  }

  private markStale(widgetId: string, reason: string): WidgetOutcome {
    upsertWidgetData({ widgetId, status: "stale", error: reason })
    return { kind: "stale", reason }
  }

  private markError(widgetId: string, reason: string): WidgetOutcome {
    upsertWidgetData({ widgetId, status: "error", error: reason })
    return { kind: "error", reason }
  }

  // Ensure a dashboard has a live/queued refresh task. Idempotent: no-op if a
  // refresh for this dashboard is already in flight. Mirrors ensureRunning.
  // maxAgeMs > 0 (the on-open path) skips widgets whose cached data is still
  // fresh; 0/omitted (the manual Refresh button) forces a full re-run.
  ensureRefresh(dashboardId: string, maxAgeMs = 0): Task | null {
    if (!getDashboard(dashboardId)) return null
    if (this.hasLiveTask(dashboardId)) return null
    return this.runner.enqueueKind({
      kind: DASHBOARD_REFRESH_KIND,
      title: "Refreshing dashboard",
      input: { dashboardId, maxAgeMs },
    })
  }

  // Whether a refresh task for this dashboard is already queued/running. Scans by
  // input blob (no dedicated column), the SummaryService.hasLiveTask pattern.
  private hasLiveTask(dashboardId: string): boolean {
    return listTasks().some((t) => {
      const input = t.input as { kind?: string; dashboardId?: string } | null
      return (
        input?.kind === DASHBOARD_REFRESH_KIND &&
        input.dashboardId === dashboardId &&
        LIVE_STATUSES.has(t.status)
      )
    })
  }

  // Bless a widget's recipe so subsequent unattended refreshes match: reconstruct
  // its ToolAction identity and write a durable action_allowlist rule. A shell
  // recipe is scoped to its cwd (workspace); a web recipe is global (no cwd to
  // scope to). Then trigger a refresh so the widget populates immediately.
  // Returns { ok } with the refresh task id, or { ok: false, reason } so the UI
  // can explain why (e.g. a pre-033.3 recipe with no cwd can't be blessed).
  approveRecipe(widgetId: string): ApproveResult {
    const widget = getWidget(widgetId)
    if (!widget) return { ok: false, reason: "widget not found" }
    const recipe = asRecipe(widget.recipe)
    const action = recipe ? actionFor(recipe) : null
    if (!recipe || !action) {
      return { ok: false, reason: "widget has no runnable recipe" }
    }

    if (action.kind === "shell") {
      const workspaceError = validateCommandWorkspace(recipe)
      if (workspaceError) {
        return {
          ok: false,
          reason: workspaceError,
        }
      }
      addRule({
        tool: action.tool,
        kind: action.kind,
        identity: action.identity,
        scope: "workspace",
        workspacePath: recipe.workspace,
      })
    } else {
      addRule({
        tool: action.tool,
        kind: action.kind,
        identity: action.identity,
        scope: "global",
      })
    }
    const task = this.ensureRefresh(widget.dashboardId)
    return { ok: true, taskId: task ? task.id : null }
  }
}

// The outcome of blessing a recipe: success (with the refresh task id, if one was
// enqueued) or a reason the UI surfaces.
export type ApproveResult =
  | { ok: true; taskId: string | null }
  | { ok: false; reason: string }

import { TOOL_EFFECTS, type Tool, type ToolContext } from "./types"
import { toolError } from "./output"
import * as processes from "../../db/repositories/processes"
import type { AppLaunch } from "../../db/types"
import {
  APP_LAUNCH_ROLES,
  describeServices,
  recipeForLink,
  serviceStatus,
  startServices,
  stopServices,
} from "../../mission-control/app-launch"
import { rootRun } from "../../mission-control/qa-checks"

// App lifecycle tools (plan 109.03). Offered only to a Mission Control
// builder or QA seat's work step. The recipe, the worktree, and the owner
// (the phase run, whose end stops everything) are resolved server-side from
// ToolContext; the model only names services.

type AppToolContext =
  | { ok: true; owner: string; root: string; recipe: AppLaunch }
  | { ok: false; error: string }

function appToolContext(name: string, ctx: ToolContext): AppToolContext {
  const unavailable = {
    ok: false as const,
    error: toolError(
      "unavailable",
      `${name} is only available to a builder or QA seat's step in a Mission Control run.`
    ),
  }
  if (!ctx.processRunId || !ctx.processPhaseRunId || !ctx.workspace)
    return unavailable
  const run = processes.getProcessRun(ctx.processRunId)
  const phaseRun = processes.getPhaseRun(ctx.processPhaseRunId)
  if (!run || !phaseRun) return unavailable
  const root = rootRun(run)
  const seat = phaseRun.seatAddress
    ? root.seatBindings?.seats[phaseRun.seatAddress]
    : undefined
  if (!root.missionControl || !seat || !APP_LAUNCH_ROLES.has(seat.role))
    return unavailable
  return {
    ok: true,
    owner: phaseRun.id,
    root: ctx.workspace,
    recipe: recipeForLink(root.missionControl),
  }
}

function serviceKeys(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const keys = value.filter(
    (k): k is string => typeof k === "string" && k.trim() !== ""
  )
  return keys.length ? keys.map((k) => k.trim()) : undefined
}

export const appStartTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "app_start",
      description:
        "Start this workspace's app in this worktree, from its app launch recipe: the requested " +
        "services and what they depend on, in order. Each gets a free port, and the call waits " +
        "until each is ready (an HTTP answer or a log line). Returns each service's URL and status; " +
        "a service that failed to start comes with the end of its output. Services already running " +
        "for this step are reused. Everything started is stopped when this step ends. Use this " +
        "instead of starting the app with a shell command.",
      parameters: {
        type: "object",
        properties: {
          services: {
            type: "array",
            items: { type: "string" },
            description:
              "Service keys to start. Omit to start every service in the recipe.",
          },
        },
      },
    },
  },
  execute: async (args, ctx) => {
    const app = appToolContext("app_start", ctx)
    if (!app.ok) return app.error
    const outcome = await startServices({
      owner: app.owner,
      root: app.root,
      recipe: app.recipe,
      keys: serviceKeys(args.services),
      signal: ctx.signal,
    })
    const body = JSON.stringify(
      {
        services: outcome.services.map((s) => ({
          key: s.key,
          url: s.url,
          port: s.port,
          status: s.status,
        })),
      },
      null,
      2
    )
    if (!outcome.ok)
      return toolError(
        outcome.code,
        `${outcome.message}${outcome.services.length ? `\n${describeServices(outcome.services)}` : ""}`
      )
    return `${body}\n\nReady:\n${describeServices(outcome.services)}`
  },
}

export const appStatusTool: Tool = {
  effects: TOOL_EFFECTS.readOnlySequential,
  definition: {
    type: "function",
    function: {
      name: "app_status",
      description:
        "The app services started for this step: each one's URL, port, and status (starting, " +
        "ready, failed, exited, stopped), with the end of the output of any that failed or exited. " +
        "Pass `logs` to see the recent output of a healthy service too.",
      parameters: {
        type: "object",
        properties: {
          logs: {
            type: "string",
            description: "A service key whose recent output to include.",
          },
        },
      },
    },
  },
  execute: async (args, ctx) => {
    const app = appToolContext("app_status", ctx)
    if (!app.ok) return app.error
    const services = serviceStatus({
      owner: app.owner,
      root: app.root,
      recipe: app.recipe,
      logs: typeof args.logs === "string" ? args.logs.trim() : undefined,
    })
    const configured = app.recipe.services.map((s) => s.key)
    if (!services.length)
      return configured.length
        ? `Nothing is running. Services in the recipe: ${configured.join(", ")}. Start them with app_start.`
        : "Nothing is running, and this workspace has no app launch recipe."
    return `${JSON.stringify(
      {
        services: services.map((s) => ({
          key: s.key,
          url: s.url,
          port: s.port,
          status: s.status,
        })),
      },
      null,
      2
    )}\n\n${describeServices(services)}`
  },
}

export const appStopTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "app_stop",
      description:
        "Stop app services started for this step (and what they spawned). Omit `services` to stop " +
        "all of them. You don't need to call this at the end of the step: everything is stopped then.",
      parameters: {
        type: "object",
        properties: {
          services: {
            type: "array",
            items: { type: "string" },
            description: "Service keys to stop. Omit to stop all.",
          },
        },
      },
    },
  },
  execute: async (args, ctx) => {
    const app = appToolContext("app_stop", ctx)
    if (!app.ok) return app.error
    const stopped = await stopServices({
      owner: app.owner,
      root: app.root,
      keys: serviceKeys(args.services),
    })
    return stopped
      ? `Stopped ${stopped} service${stopped === 1 ? "" : "s"}.`
      : "Nothing was running."
  },
}

export const appLaunchTools: Tool[] = [appStartTool, appStatusTool, appStopTool]

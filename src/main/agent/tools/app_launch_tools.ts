import { TOOL_EFFECTS, type Tool, type ToolContext } from "./types"
import { toolError } from "./output"
import * as processes from "../../db/repositories/processes"
import * as features from "../../db/repositories/features"
import { getWorkspace, updateWorkspace } from "../../db/repositories/workspaces"
import type { AppLaunch } from "../../db/types"
import {
  isProvisional,
  validateAppLaunch,
} from "../../../shared/mission-control/app-launch"
import {
  APP_LAUNCH_ROLES,
  describeServices,
  recipeForLink,
  serviceStatus,
  startServices,
  stopServices,
} from "../../mission-control/app-launch"
import { rootRun } from "../../mission-control/qa-checks"
import { serviceCommandRefusal } from "../../mission-control/workspace-analysis/recipe-model"

// App lifecycle tools (plan 109.03). Offered only to a Mission Control
// builder or QA seat's work step. The recipe, the worktree, and the owner
// (the phase run, whose end stops everything) are resolved server-side from
// ToolContext; the model only names services.

type AppToolContext =
  | {
      ok: true
      owner: string
      root: string
      recipe: AppLaunch
      featureId: string
      role: string
    }
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
    featureId: root.missionControl.featureId,
    role: seat.role,
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
    const verified = verifyProvisional(app.featureId, outcome.services.map((s) => s.key))
    return `${body}\n\nReady:\n${describeServices(outcome.services)}${verified ? "\n\nThe app started with its planned recipe, so the recipe is now confirmed." : ""}`
  },
}

// A recipe planned from the intent is proven by its first successful start:
// the services that came up ready are no longer provisional.
function verifyProvisional(featureId: string, started: string[]): boolean {
  const workspaceId = features.getFeature(featureId)?.workspaceId
  const recipe = workspaceId ? getWorkspace(workspaceId)?.appLaunch : null
  if (!workspaceId || !recipe || !isProvisional(recipe)) return false
  const ready = new Set(started)
  if (!recipe.services.some((s) => s.provisional && ready.has(s.key))) return false
  updateWorkspace(workspaceId, {
    appLaunch: {
      services: recipe.services.map(({ provisional, ...s }) =>
        provisional && !ready.has(s.key) ? { ...s, provisional } : s
      ),
    },
  })
  return true
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

// A workspace without a recipe (a greenfield project, or one the analysis
// couldn't read): the builder that makes the app runnable says how to start
// it. The recipe is tried in this worktree first and saved only if every
// service becomes ready, so QA, the acceptance gates, and later stories can
// start the app without anyone stopping to set it up.
export const appLaunchSaveTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "app_launch_save",
      description:
        "Save how Mission Control starts this workspace's app (its app launch recipe). Builder seats " +
        "only. Use it when the workspace has no recipe, when the current one (written by the " +
        "analysis or planned from the intent) can't start the app you built, or when it's missing " +
        "a service the app needs (pass the whole recipe, the new service under a new key). A " +
        "working recipe that gains nothing is kept. Each service is started in this worktree on a free port " +
        "and must become ready; the recipe is saved only if they all do, and they stay running for " +
        "this step. Pass the port the way the framework takes it: `port_env`, or `{port}` in the command.",
      parameters: {
        type: "object",
        properties: {
          services: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string", description: 'Short slug, e.g. "web".' },
                label: { type: "string" },
                command: {
                  type: "string",
                  description:
                    'One command, run in cwd. Use "{port}" where the framework takes its port as an argument, and "{port:<key>}" for another service\'s port.',
                },
                cwd: {
                  type: "string",
                  description: 'Workspace-relative directory; "" for the root.',
                },
                prepare: {
                  type: "string",
                  description:
                    "One command run to completion before the service starts (create or migrate a database, seed data). Use this instead of chaining with &&.",
                },
                port: {
                  description:
                    '"auto" (default): a free port per run. "none": the service doesn\'t listen (use ready_log). A number only if the framework can\'t be told its port.',
                },
                port_env: {
                  type: "string",
                  description: "The environment variable the port is passed in. Default PORT.",
                },
                env: {
                  type: "object",
                  additionalProperties: { type: "string" },
                  description: "Extra environment variables; values may use {port} placeholders.",
                },
                ready_timeout_ms: {
                  type: "integer",
                  description: "How long to wait for ready (default 120000, max 900000). Raise it for slow builds.",
                },
                ready_http: {
                  type: "string",
                  description: 'Ready when a GET of this path answers, e.g. "/". Use this for servers.',
                },
                ready_log: {
                  type: "string",
                  description: "Ready when the output matches this regular expression (no HTTP endpoint).",
                },
                depends_on: { type: "array", items: { type: "string" } },
              },
              required: ["key", "command"],
            },
          },
        },
        required: ["services"],
      },
    },
  },
  execute: async (args, ctx) => {
    const app = appToolContext("app_launch_save", ctx)
    if (!app.ok) return app.error
    if (app.role !== "builder")
      return toolError("not_builder", "Only a builder seat saves the app launch recipe.")
    // A recipe the user wrote is theirs. One written by the analysis, its
    // model, or a builder is replaced when it doesn't start the app: a
    // provisional one (planned from the intent) is tried as part of this call.
    if (app.recipe.services.some((service) => service.source === "user"))
      return toolError(
        "recipe_exists",
        "This workspace's app launch recipe was written by the user; start it with app_start. If it can't start the app, say so in your summary."
      )
    const workspaceId = features.getFeature(app.featureId)?.workspaceId
    if (!workspaceId || !getWorkspace(workspaceId))
      return toolError("unavailable", "This feature has no workspace to save the recipe to.")
    const raw = Array.isArray(args.services) ? args.services : []
    const validation = validateAppLaunch({
      services: raw.map((value) => {
        const v = (value ?? {}) as Record<string, unknown>
        const text = (x: unknown) => (typeof x === "string" ? x.trim() : "")
        return {
          key: text(v.key),
          label: text(v.label) || text(v.key),
          command: text(v.command),
          ...(text(v.prepare) ? { prepare: text(v.prepare) } : {}),
          cwd: text(v.cwd),
          port: v.port === undefined || v.port === null ? "auto" : v.port,
          ...(text(v.port_env) ? { portEnv: text(v.port_env) } : {}),
          ...(v.env && typeof v.env === "object" ? { env: v.env } : {}),
          ...(typeof v.ready_timeout_ms === "number" ? { readyTimeoutMs: v.ready_timeout_ms } : {}),
          ready: text(v.ready_log) && !text(v.ready_http)
            ? { log: text(v.ready_log) }
            : { http: text(v.ready_http) || "/" },
          ...(Array.isArray(v.depends_on) ? { dependsOn: v.depends_on } : {}),
          source: "seat",
        }
      }),
    })
    if (!validation.ok || !validation.recipe.services.length)
      return toolError(
        "invalid_recipe",
        validation.ok ? "Name at least one service." : validation.errors.join(" ")
      )
    for (const service of validation.recipe.services) {
      const unsafe = serviceCommandRefusal(service, app.root)
      if (unsafe)
        return toolError(
          "invalid_recipe",
          `${unsafe}. Put a step that must run first in \`prepare\`, and pass variables in \`env\`.`
        )
    }
    // A working recipe is kept unless this one adds services it lacks (a
    // backend the analysis's recipe left out).
    const currentKeys = new Set(app.recipe.services.map((service) => service.key))
    const adds = validation.recipe.services.filter((service) => !currentKeys.has(service.key))
    if (app.recipe.services.length && !adds.length) {
      const current = await startServices({
        owner: app.owner,
        root: app.root,
        recipe: app.recipe,
        signal: ctx.signal,
      })
      if (current.ok)
        return `The current app launch recipe already starts the app, so it was kept:\n${describeServices(current.services)}\nTo add a service it's missing, include it under a new key.`
    }
    await stopServices({ owner: app.owner, root: app.root })
    const outcome = await startServices({
      owner: app.owner,
      root: app.root,
      recipe: validation.recipe,
      signal: ctx.signal,
    })
    if (!outcome.ok)
      return toolError(
        outcome.code,
        `Nothing was saved: the recipe didn't start the app. ${outcome.message}${outcome.services.length ? `\n${describeServices(outcome.services)}` : ""}`
      )
    // The user may have written a recipe while the services started.
    if (getWorkspace(workspaceId)?.appLaunch.services.some((service) => service.source === "user"))
      return toolError("recipe_exists", "The user saved an app launch recipe meanwhile; use app_start.")
    const replaced = app.recipe.services.length > 0
    updateWorkspace(workspaceId, { appLaunch: validation.recipe })
    return `${replaced ? "Replaced" : "Saved"} the app launch recipe. It's running for this step:\n${describeServices(outcome.services)}`
  },
}

export const appLaunchTools: Tool[] = [
  appStartTool,
  appStatusTool,
  appStopTool,
  appLaunchSaveTool,
]

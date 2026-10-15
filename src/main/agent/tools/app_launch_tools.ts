import { randomUUID } from "crypto"
import { TOOL_EFFECTS, type Tool, type ToolContext } from "./types"
import { recordEvent } from "../../db/repositories/mc-events"
import { classifyRunFailure } from "../../mission-control/run-failure"
import { toolError } from "./output"
import * as processes from "../../db/repositories/processes"
import * as features from "../../db/repositories/features"
import { getWorkspace, updateWorkspace } from "../../db/repositories/workspaces"
import type { AppLaunch, ProcessRun } from "../../db/types"
import { validateAppLaunch } from "../../../shared/mission-control/app-launch"
import {
  APP_LAUNCH_ROLES,
  describeServices,
  serviceStatus,
  startServices,
  stopServices,
  verifyRecipe,
  workspaceForLink,
  type VerifyResult,
} from "../../mission-control/app-launch"
import { getAppRecipeService } from "../../mission-control/app-recipe"
import { recipeRefusal } from "../../mission-control/workspace-analysis/policy"

// App lifecycle tools (plan 112.1, ported from backup:109.03; app_launch_save
// with recipe ownership in 112.3). Offered only to a Mission Control builder
// or QA seat's work step, and to a builder's recipe-repair turn. The recipe,
// the worktree, and the owner (the phase run, whose end stops everything)
// are resolved server-side from ToolContext; the model only names services.

type AppToolContext =
  | {
      ok: true
      owner: string
      root: string
      recipe: AppLaunch
      role: string
      featureId: string
      workspaceId: string
      mainRoot: string
      userStoryId: string | null
      seatAddress: string | null
    }
  | { ok: false; error: string }

// The top-level run: a nested sub-process run inherits its root's seat
// bindings and Mission Control link.
function rootRun(run: ProcessRun): ProcessRun {
  let current = run
  for (let depth = 0; current.parentPhaseRunId && depth < 16; depth++) {
    const parent = processes.getPhaseRun(current.parentPhaseRunId)
    const parentRun = parent ? processes.getProcessRun(parent.runId) : undefined
    if (!parentRun) break
    current = parentRun
  }
  return current
}

function appToolContext(name: string, ctx: ToolContext): AppToolContext {
  const unavailable = {
    ok: false as const,
    error: toolError(
      "unavailable",
      `${name} is only available to a builder or QA seat's step in a Mission Control run.`
    ),
  }
  if (!ctx.workspace) return unavailable
  // A recipe-repair turn (plan 112.3) runs as the builder, outside a run.
  if (ctx.appLaunchRepair) {
    const feature = features.getFeature(ctx.appLaunchRepair.featureId)
    const workspace = feature?.workspaceId
      ? getWorkspace(feature.workspaceId)
      : undefined
    if (!feature || !workspace) return unavailable
    return {
      ok: true,
      owner: ctx.appLaunchRepair.owner,
      root: ctx.workspace,
      recipe: workspace.appLaunch,
      role: "builder",
      featureId: feature.id,
      workspaceId: workspace.id,
      mainRoot: ctx.appLaunchRepair.mainRoot,
      userStoryId: ctx.appLaunchRepair.userStoryId,
      seatAddress: ctx.missionControlSeat?.address ?? null,
    }
  }
  if (!ctx.processRunId || !ctx.processPhaseRunId) return unavailable
  const run = processes.getProcessRun(ctx.processRunId)
  const phaseRun = processes.getPhaseRun(ctx.processPhaseRunId)
  if (!run || !phaseRun) return unavailable
  const root = rootRun(run)
  const seat = phaseRun.seatAddress
    ? root.seatBindings?.seats[phaseRun.seatAddress]
    : undefined
  const workspace = workspaceForLink(root.missionControl)
  if (
    !root.missionControl ||
    !seat ||
    !APP_LAUNCH_ROLES.has(seat.role) ||
    !workspace
  )
    return unavailable
  return {
    ok: true,
    owner: phaseRun.id,
    root: ctx.workspace,
    recipe: getWorkspace(workspace.id)?.appLaunch ?? { services: [] },
    role: seat.role,
    featureId: root.missionControl.featureId,
    workspaceId: workspace.id,
    mainRoot: workspace.path,
    userStoryId: root.missionControl.userStoryId,
    seatAddress: phaseRun.seatAddress ?? null,
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
      mainRoot: app.mainRoot,
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
    if (!outcome.ok) {
      // For the scorecard (plan 112.3): a seat's start that failed, and
      // whether the fault was the environment's.
      if (outcome.failure)
        recordEvent({
          featureId: app.featureId,
          userStoryId: app.userStoryId,
          seatAddress: app.seatAddress,
          type: "app_start_failed",
          refId: randomUUID(),
          detail: {
            role: app.role,
            class: classifyRunFailure({
              launch: outcome.failure,
              smokeVerified: false,
            }).class,
            stage: outcome.failure.stage,
            reason: outcome.failure.reason,
            summary: outcome.failure.summary.slice(0, 300),
          },
        })
      return toolError(
        outcome.code,
        `${outcome.message}${outcome.services.length ? `\n${describeServices(outcome.services)}` : ""}`
      )
    }
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

// The model's service shape (snake_case, flat readiness) as a recipe service.
function serviceFromArgs(value: unknown): Record<string, unknown> {
  const v = (value ?? {}) as Record<string, unknown>
  const text = (x: unknown) => (typeof x === "string" ? x.trim() : "")
  return {
    key: text(v.key),
    label: text(v.label) || text(v.key),
    command: text(v.command),
    cwd: text(v.cwd),
    port: v.port === undefined || v.port === null ? "auto" : v.port,
    ...(text(v.port_env) ? { portEnv: text(v.port_env) } : {}),
    ...(v.env && typeof v.env === "object" ? { env: v.env } : {}),
    ...(typeof v.ready_timeout_ms === "number"
      ? { readyTimeoutMs: v.ready_timeout_ms }
      : {}),
    ready:
      text(v.ready_log) && !text(v.ready_http)
        ? { log: text(v.ready_log) }
        : { http: text(v.ready_http) || "/" },
    ...(Array.isArray(v.depends_on) ? { dependsOn: v.depends_on } : {}),
    ...(Array.isArray(v.smoke) ? { smoke: v.smoke } : {}),
    source: "seat",
  }
}

function recipeFromArgs(args: Record<string, unknown>): unknown {
  const list = (x: unknown) => (Array.isArray(x) ? x : [])
  return {
    services: list(args.services).map(serviceFromArgs),
    setup: list(args.setup).map((value) => {
      const v = (value ?? {}) as Record<string, unknown>
      return {
        label: v.label,
        command: v.command,
        cwd: v.cwd,
        ...(typeof v.service === "string" && v.service.trim()
          ? { service: v.service }
          : {}),
      }
    }),
    prerequisites: list(args.prerequisites).map((value) => {
      const v = (value ?? {}) as Record<string, unknown>
      return {
        key: v.key,
        label: v.label,
        hint: v.hint,
        check:
          typeof v.check_tcp_port === "number"
            ? { tcp: v.check_tcp_port }
            : { command: v.check_command },
      }
    }),
  }
}

function describeVerification(result: VerifyResult): string {
  const lines = [
    describeServices(result.services),
    ...result.smoke.map(
      (s) => `- smoke ${s.url}: ${s.status === null ? "no answer" : s.status}`
    ),
  ]
  if (result.browserSkipped)
    lines.push(`(No browser load: ${result.browserSkipped}.)`)
  if (result.failure) {
    lines.push(`Failed at ${result.failure.stage}: ${result.failure.summary}.`)
    if (result.failure.consoleErrors?.length)
      lines.push(
        `Console errors:\n${result.failure.consoleErrors.map((e) => `  ${e}`).join("\n")}`
      )
    if (result.failure.failedRequests?.length)
      lines.push(
        `Failed requests:\n${result.failure.failedRequests.map((e) => `  ${e}`).join("\n")}`
      )
    if (result.failure.logs && !result.services.some((s) => s.outputTail))
      lines.push(`Output:\n${result.failure.logs}`)
  }
  return lines.filter(Boolean).join("\n")
}

// How Mission Control starts this workspace's app, written by the builder
// that makes it runnable or repairs it (plan 112.3). The recipe is verified
// in this worktree — every service ready and its pages loading — and saved
// only then. No user Apply: its commands pass the same policy as the
// builder's own shell commands.
export const appLaunchSaveTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "app_launch_save",
      description:
        "Save how Mission Control starts this workspace's app (its app launch recipe). Builder seats " +
        "only. Use it when the workspace has no recipe, when the current one can't start the app, or " +
        "when the app now needs more (a service, a setup step, an environment variable): pass the " +
        "whole recipe. The recipe is verified in this worktree first — prerequisites checked, setup " +
        "run, each service started on a free port and awaited, its smoke pages loaded — and saved " +
        "only if all of that passes; everything is stopped afterwards (start it again with " +
        "app_start). A working recipe that gains no service is kept. Pass the port the way the " +
        "framework takes it: `port_env`, or `{port}` in the command.",
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
                    'One command, run in cwd (no &&, pipes, or installs). Use "{port}" where the framework takes its port as an argument, and "{port:<key>}" for another service\'s port.',
                },
                cwd: {
                  type: "string",
                  description: 'Workspace-relative directory; "" for the root.',
                },
                port: {
                  description:
                    '"auto" (default): a free port per run. "none": the service doesn\'t listen (use ready_log). A number only if the framework can\'t be told its port.',
                },
                port_env: {
                  type: "string",
                  description:
                    "The environment variable the port is passed in. Default PORT.",
                },
                env: {
                  type: "object",
                  additionalProperties: { type: "string" },
                  description:
                    'Extra environment variables. Values may use {port}, {port:<key>}, and {env:KEY} (read from .env.local or .env). Never write a secret\'s value: use "{env:KEY}".',
                },
                ready_timeout_ms: {
                  type: "integer",
                  description:
                    "How long to wait for ready (default 120000, max 900000). Raise it for slow builds.",
                },
                ready_http: {
                  type: "string",
                  description:
                    'Ready when a GET of this path answers, e.g. "/". Use this for servers.',
                },
                ready_log: {
                  type: "string",
                  description:
                    "Ready when the output matches this regular expression (no HTTP endpoint).",
                },
                depends_on: { type: "array", items: { type: "string" } },
                smoke: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    'Paths loaded to check the app works (default ["/"] for a service with a port).',
                },
              },
              required: ["key", "command"],
            },
          },
          setup: {
            type: "array",
            description:
              "Commands run to completion, in order, before services start: migrations, seed, build. Idempotent: they run on every start. Scope one to a service with `service` to give it that service's environment and ports.",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                command: { type: "string" },
                cwd: { type: "string" },
                service: { type: "string" },
              },
              required: ["command"],
            },
          },
          prerequisites: {
            type: "array",
            description:
              "What the app needs that the recipe doesn't start (a database the user runs), checked first.",
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                label: {
                  type: "string",
                  description:
                    'Plain language, e.g. "A Postgres database on port 5432".',
                },
                check_tcp_port: { type: "integer" },
                check_command: {
                  type: "string",
                  description: "Exits 0 when it's available.",
                },
                hint: {
                  type: "string",
                  description: "What makes it available, for the user.",
                },
              },
              required: ["label"],
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
      return toolError(
        "not_builder",
        "Only a builder seat saves the app launch recipe."
      )
    // A recipe the user wrote is theirs.
    if (app.recipe.services.some((service) => service.source === "user"))
      return toolError(
        "recipe_exists",
        "This workspace's app launch recipe was written by the user, so it isn't replaced. Start it with app_start; if it can't start the app, say so in your summary."
      )
    const validation = validateAppLaunch(recipeFromArgs(args))
    if (!validation.ok || !validation.recipe.services.length)
      return toolError(
        "invalid_recipe",
        validation.ok
          ? "Name at least one service."
          : validation.errors.join(" ")
      )
    const recipe = validation.recipe
    const refused = recipeRefusal(recipe, app.root)
    if (refused)
      return toolError(
        "invalid_recipe",
        `${refused}. Put a step that must run first in \`setup\`, and pass variables in \`env\`.`
      )
    const owner = `${app.owner}:recipe-save`
    // A working recipe is kept unless this one adds services it lacks.
    const currentKeys = new Set(app.recipe.services.map((s) => s.key))
    const adds = recipe.services.some((s) => !currentKeys.has(s.key))
    if (app.recipe.services.length && !adds) {
      const current = await verifyRecipe({
        root: app.root,
        recipe: app.recipe,
        owner,
        mainRoot: app.mainRoot,
        signal: ctx.signal,
        browserLoad: getAppRecipeService()?.browserLoad ?? null,
      })
      if (current.ok)
        return `The current app launch recipe already starts the app and its pages load, so it was kept:\n${describeVerification(current)}\nTo add a service it's missing, include it under a new key. Start it with app_start.`
    }
    await stopServices({ owner: app.owner, root: app.root })
    const result = await verifyRecipe({
      root: app.root,
      recipe,
      owner,
      mainRoot: app.mainRoot,
      signal: ctx.signal,
      browserLoad: getAppRecipeService()?.browserLoad ?? null,
    })
    if (!result.ok)
      return toolError(
        "recipe_failed",
        `Nothing was saved: the recipe didn't pass verification.\n${describeVerification(result)}`
      )
    // The user may have written a recipe while it ran.
    const latest = getWorkspace(app.workspaceId)
    if (latest?.appLaunch.services.some((s) => s.source === "user"))
      return toolError(
        "recipe_exists",
        "The user saved an app launch recipe meanwhile; use app_start."
      )
    const replaced = app.recipe.services.length > 0
    updateWorkspace(app.workspaceId, { appLaunch: recipe })
    recordEvent({
      featureId: app.featureId,
      userStoryId: app.userStoryId,
      seatAddress: app.seatAddress,
      type: "recipe_saved",
      refId: randomUUID(),
      detail: {
        role: app.role,
        repair: !!ctx.appLaunchRepair,
        replaced: replaced ? (app.recipe.services[0]?.source ?? null) : null,
        services: recipe.services.map((s) => s.command),
        setup: (recipe.setup ?? []).map((s) => s.command),
        prerequisites: (recipe.prerequisites ?? []).map((p) => p.label),
      },
    })
    await getAppRecipeService()?.recordVerified({
      featureId: app.featureId,
      workspaceId: app.workspaceId,
      root: app.root,
    })
    return `${replaced ? "Replaced" : "Saved"} the app launch recipe; it starts the app and its pages load:\n${describeVerification(result)}\nIt's stopped now: start it with app_start.`
  },
}

export const appLaunchTools: Tool[] = [
  appStartTool,
  appStatusTool,
  appStopTool,
  appLaunchSaveTool,
]

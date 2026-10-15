import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppLaunch } from "../../../shared/mission-control/app-launch"

// The tools resolve the seat from the run's frozen bindings; fake the
// repositories so each case sets exactly the run it needs.
const state = vi.hoisted(() => ({
  runs: new Map<string, unknown>(),
  phaseRuns: new Map<string, unknown>(),
  recipe: { services: [] } as AppLaunch,
  saved: [] as AppLaunch[],
  verified: [] as AppLaunch[],
  // What verifyRecipe answers, per recipe (by its first service's command).
  verifies: new Map<string, boolean>(),
  recorded: 0,
}))
vi.mock("../../db/repositories/processes", () => ({
  getProcessRun: (id: string) => state.runs.get(id),
  getPhaseRun: (id: string) => state.phaseRuns.get(id),
}))
vi.mock("../../db/repositories/features", () => ({
  getFeature: (id: string) =>
    id === "f" ? { id: "f", workspaceId: "w" } : undefined,
}))
vi.mock("../../db/repositories/workspaces", () => ({
  getWorkspace: (id: string) =>
    id === "w"
      ? { id: "w", path: "/repo", appLaunch: state.recipe }
      : undefined,
  updateWorkspace: (_id: string, patch: { appLaunch: AppLaunch }) => {
    state.saved.push(patch.appLaunch)
    state.recipe = patch.appLaunch
  },
}))
vi.mock("../../mission-control/app-recipe", () => ({
  getAppRecipeService: () => ({
    browserLoad: null,
    recordVerified: async () => {
      state.recorded++
    },
  }),
}))
vi.mock("../../mission-control/app-launch", () => ({
  APP_LAUNCH_ROLES: new Set(["builder", "qa"]),
  workspaceForLink: (link: unknown) =>
    link ? { id: "w", path: "/repo" } : null,
  describeServices: () => "",
  serviceStatus: () => [],
  startServices: async () => ({
    ok: false,
    code: "no_recipe",
    message: "no recipe",
    services: [],
  }),
  stopServices: async () => 0,
  verifyRecipe: async (input: { recipe: AppLaunch }) => {
    state.verified.push(input.recipe)
    const ok = state.verifies.get(input.recipe.services[0]?.command) ?? false
    return {
      ok,
      stages: [],
      services: [],
      smoke: [{ url: "http://localhost:1/", status: ok ? 200 : 500 }],
      browserSkipped: null,
      ...(ok
        ? {}
        : {
            failure: {
              stage: "smoke",
              reason: "smoke_status",
              summary: "Web answered / with 500",
              logs: "",
            },
          }),
    }
  },
}))

import {
  appLaunchSaveTool,
  appStartTool,
  appStatusTool,
  appStopTool,
} from "./app_launch_tools"

function seatRun(role: string, missionControl = true) {
  state.runs.set("run", {
    id: "run",
    parentPhaseRunId: null,
    missionControl: missionControl ? { featureId: "f" } : null,
    seatBindings: {
      seats: { [`${role}@impl`]: { address: `${role}@impl`, role } },
    },
  })
  state.phaseRuns.set("pr", {
    id: "pr",
    runId: "run",
    seatAddress: `${role}@impl`,
  })
}

const ctx = {
  workspace: "/repo",
  processRunId: "run",
  processPhaseRunId: "pr",
} as never

beforeEach(() => {
  state.runs.clear()
  state.phaseRuns.clear()
  state.recipe = { services: [] }
  state.saved = []
  state.verified = []
  state.verifies.clear()
  state.recorded = 0
})

describe("app tools' seat check", () => {
  it("refuses a call from outside a phase", async () => {
    for (const tool of [appStartTool, appStatusTool, appStopTool])
      expect(await tool.execute({}, { workspace: "/repo" } as never)).toMatch(
        /unavailable/
      )
  })

  it("refuses a lead seat and a run without Mission Control", async () => {
    seatRun("lead")
    expect(await appStartTool.execute({}, ctx)).toMatch(/unavailable/)
    seatRun("builder", false)
    expect(await appStartTool.execute({}, ctx)).toMatch(/unavailable/)
  })

  it("lets builder and QA seats through to the harness", async () => {
    for (const role of ["builder", "qa"]) {
      seatRun(role)
      expect(await appStartTool.execute({}, ctx)).toMatch(/no_recipe/)
      expect(await appStopTool.execute({}, ctx)).toBe("Nothing was running.")
    }
  })

  it("lets a recipe-repair turn act as the builder outside a run", async () => {
    const repair = {
      workspace: "/repo/wt",
      appLaunchRepair: {
        featureId: "f",
        userStoryId: null,
        owner: "recipe-repair:1",
        mainRoot: "/repo",
      },
    } as never
    expect(await appStartTool.execute({}, repair)).toMatch(/no_recipe/)
    state.verifies.set("node server.js", true)
    expect(
      await appLaunchSaveTool.execute(
        { services: [{ key: "web", command: "node server.js" }] },
        repair
      )
    ).toMatch(/Saved the app launch recipe/)
  })
})

describe("app_launch_save (plan 112.3)", () => {
  const web = (command: string) => ({
    services: [{ key: "web", command, ready_http: "/" }],
  })

  it("is the builder's alone", async () => {
    seatRun("qa")
    expect(await appLaunchSaveTool.execute(web("node server.js"), ctx)).toMatch(
      /not_builder/
    )
    expect(state.saved).toEqual([])
  })

  it("saves only a recipe that passes verification, smoke included", async () => {
    seatRun("builder")
    const failed = await appLaunchSaveTool.execute(web("node broken.js"), ctx)
    expect(failed).toMatch(/recipe_failed/)
    expect(failed).toMatch(/smoke .*500/)
    expect(state.saved).toEqual([])

    state.verifies.set("node server.js", true)
    expect(await appLaunchSaveTool.execute(web("node server.js"), ctx)).toMatch(
      /Saved the app launch recipe/
    )
    expect(state.saved).toHaveLength(1)
    expect(state.saved[0].services[0]).toMatchObject({
      key: "web",
      command: "node server.js",
      source: "seat",
    })
    expect(state.recorded).toBe(1)
  })

  it("saves setup steps, prerequisites, and .env references", async () => {
    seatRun("builder")
    state.verifies.set("node server.js", true)
    await appLaunchSaveTool.execute(
      {
        services: [
          {
            key: "web",
            command: "node server.js",
            env: { DATA_FILE: "{env:DATA_FILE}" },
          },
        ],
        setup: [{ label: "Migrate", command: "node migrate.js" }],
        prerequisites: [
          { label: "A database on port 5432", check_tcp_port: 5432 },
        ],
      },
      ctx
    )
    expect(state.saved[0]).toMatchObject({
      setup: [{ label: "Migrate", command: "node migrate.js", cwd: "" }],
      prerequisites: [
        { label: "A database on port 5432", check: { tcp: 5432 } },
      ],
      services: [{ env: { DATA_FILE: "{env:DATA_FILE}" } }],
    })
  })

  it("never replaces the user's recipe", async () => {
    seatRun("builder")
    state.recipe = {
      services: [
        {
          key: "web",
          label: "Web",
          command: "npm start",
          cwd: "",
          port: "auto",
          ready: { http: "/" },
          source: "user",
        },
      ],
    }
    expect(await appLaunchSaveTool.execute(web("node server.js"), ctx)).toMatch(
      /recipe_exists/
    )
    expect(state.verified).toEqual([])
  })

  it("keeps a detector recipe that works unless the new one adds a service", async () => {
    seatRun("builder")
    state.recipe = {
      services: [
        {
          key: "web",
          label: "Web",
          command: "npm run dev",
          cwd: "",
          port: "auto",
          ready: { http: "/" },
          source: "detector",
        },
      ],
    }
    state.verifies.set("npm run dev", true)
    state.verifies.set("node server.js", true)
    expect(await appLaunchSaveTool.execute(web("node server.js"), ctx)).toMatch(
      /already starts the app .* so it was kept/
    )
    expect(state.saved).toEqual([])
    // A failing current recipe is replaced.
    state.verifies.set("npm run dev", false)
    expect(await appLaunchSaveTool.execute(web("node server.js"), ctx)).toMatch(
      /Replaced the app launch recipe/
    )
  })

  it("refuses chained commands, installs, and literal secrets", async () => {
    seatRun("builder")
    expect(
      await appLaunchSaveTool.execute(
        web("node migrate.js && node server.js"),
        ctx
      )
    ).toMatch(/only one command/)
    expect(await appLaunchSaveTool.execute(web("npm install"), ctx)).toMatch(
      /installing dependencies/
    )
    expect(
      await appLaunchSaveTool.execute(
        {
          services: [
            {
              key: "web",
              command: "node server.js",
              env: { API_KEY: "sk-live-123" },
            },
          ],
        },
        ctx
      )
    ).toMatch(/looks like a secret.*\{env:API_KEY\}/)
    expect(
      await appLaunchSaveTool.execute(
        {
          services: [{ key: "web", command: "node server.js" }],
          setup: [{ command: "sudo service postgresql start" }],
        },
        ctx
      )
    ).toMatch(/setup step/)
    expect(state.verified).toEqual([])
    expect(state.saved).toEqual([])
  })
})

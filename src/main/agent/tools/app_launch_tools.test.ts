import { beforeEach, describe, expect, it, vi } from "vitest"

// The tools resolve the seat from the run's frozen bindings; fake the
// repositories so each case sets exactly the run it needs.
const state = vi.hoisted(() => ({
  runs: new Map<string, unknown>(),
  phaseRuns: new Map<string, unknown>(),
}))
vi.mock("../../db/repositories/processes", () => ({
  getProcessRun: (id: string) => state.runs.get(id),
  getPhaseRun: (id: string) => state.phaseRuns.get(id),
}))
vi.mock("../../mission-control/app-launch", () => ({
  APP_LAUNCH_ROLES: new Set(["builder", "qa"]),
  recipeForLink: () => ({ services: [] }),
  describeServices: () => "",
  serviceStatus: () => [],
  startServices: async () => ({
    ok: false,
    code: "no_recipe",
    message: "no recipe",
    services: [],
  }),
  stopServices: async () => 0,
}))

import { appStartTool, appStatusTool, appStopTool } from "./app_launch_tools"

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

describe("app tools' seat check", () => {
  beforeEach(() => {
    state.runs.clear()
    state.phaseRuns.clear()
  })

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
})

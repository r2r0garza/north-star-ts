import { spawnSync } from "child_process"
import { ipcMain } from "electron"
import {
  runScenarioBatch,
  type ScenarioBatchOptions,
  type ScenarioDriverDeps,
} from "../mission-control/scenarios/driver"

// The live scenario driver's dev entry points (plan 112.2). Registered only
// in a dev build with Mission Control enabled; never part of the user's UI.
//
//   From the shell:  MC_SCENARIOS=all MC_SCENARIO_RUNS=3 pnpm dev
//   From DevTools:   await window.cowork.missionControl.dev.runScenarios({ scenarios: ["6"], runs: 1 })
//
// Runs are added to an existing <date>-<label>.json recorded on the same
// model. Optional env: MC_SCENARIO_LABEL (default live-baseline),
// MC_SCENARIO_DATE (YYYY-MM-DD, to keep adding to an earlier day's file),
// MC_SCENARIO_CAP_MIN (per-run cap, default 45), MC_SCENARIO_RIG (rig id),
// MC_SCENARIO_KEEP=1 (leave features and workspaces in place),
// MC_SCENARIO_SKIP_PREFLIGHT=1, MC_SCENARIO_QUIT=1 (quit when done).

export type ScenarioRunRequest = Omit<
  ScenarioBatchOptions,
  "repoRoot" | "scenariosDir" | "appCommit" | "signal" | "onRecord"
>

// The app commit runs are measured on, with a marker when the tree is dirty.
function gitHead(dir: string): string | null {
  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: dir, encoding: "utf8" })
  const head = git("rev-parse", "--short", "HEAD")
  if (head.status !== 0) return null
  const dirty = git("status", "--porcelain").stdout.trim() !== ""
  return `${head.stdout.trim()}${dirty ? "-dirty" : ""}`
}

export function registerScenarioDriver(
  deps: ScenarioDriverDeps,
  context: {
    repoRoot: string
    scenariosDir: string
    quit: () => void
  }
): void {
  let running: AbortController | null = null

  const start = async (request: ScenarioRunRequest) => {
    if (running) throw new Error("A scenario batch is already running.")
    const controller = new AbortController()
    running = controller
    try {
      const { file, scorecard } = await runScenarioBatch(deps, {
        ...request,
        repoRoot: context.repoRoot,
        scenariosDir: context.scenariosDir,
        appCommit: gitHead(context.repoRoot),
        signal: controller.signal,
        onRecord: (record, index, total) =>
          console.info(
            `[scenarios] ${index}/${total} ${record.scenario}: ${record.outcome} (${record.settle ?? "?"}, ${Math.round(record.wallMs / 1000)} s${record.orphans.length ? `, ${record.orphans.length} orphan(s)` : ""})`
          ),
      })
      console.info(`[scenarios] scorecard written to ${file}`)
      return { file, scenarios: scorecard.scenarios }
    } finally {
      running = null
    }
  }

  ipcMain.handle(
    "missionControl:dev:runScenarios",
    (_event, request: ScenarioRunRequest) => start(request ?? {})
  )
  ipcMain.handle("missionControl:dev:stopScenarios", () => {
    running?.abort()
    return running !== null
  })

  const selected = process.env.MC_SCENARIOS?.trim()
  if (!selected) return
  const env = (name: string) => process.env[name]?.trim() || undefined
  const capMin = Number(env("MC_SCENARIO_CAP_MIN"))
  void start({
    scenarios: selected.split(",").map((s) => s.trim()),
    runs: Number(env("MC_SCENARIO_RUNS")) || 3,
    label: env("MC_SCENARIO_LABEL"),
    date: env("MC_SCENARIO_DATE"),
    rigId: env("MC_SCENARIO_RIG") ?? null,
    keep: env("MC_SCENARIO_KEEP") === "1",
    skipPreflight: env("MC_SCENARIO_SKIP_PREFLIGHT") === "1",
    ...(capMin > 0 ? { capMs: capMin * 60 * 1000 } : {}),
  })
    .catch((err) => console.error("[scenarios] batch failed:", err))
    .finally(() => {
      if (env("MC_SCENARIO_QUIT") === "1") context.quit()
    })
}

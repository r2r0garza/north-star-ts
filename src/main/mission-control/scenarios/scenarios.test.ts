import { execFileSync, spawnSync } from "child_process"
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { afterAll, describe, expect, it } from "vitest"
import {
  validateAppLaunch,
  type AppLaunch,
} from "../../../shared/mission-control/app-launch"
import { startServices, stopServices, testAppServices } from "../app-launch"
import {
  buildScorecard,
  loadScenarios,
  runRecord,
  scorecardPath,
  waitForOrphans,
  type HarnessExpectation,
  type LoadedScenario,
  type ScenarioRunRecord,
} from "./scorecard"

// The harness tier of the scenario scorecard (plan 112.1): every fixture and
// recipe variant starts → readiness → one GET of `/` → stop, with no process
// left behind. Breakage variants must fail the way they're expected to, with
// the line that says why in the output tail.
//
// Recording: SCORECARD_LABEL=<label> pnpm test scenarios writes
// .plan/112-scorecard/<date>-<label>.json.

const scenarios = loadScenarios()
const records: ScenarioRunRecord[] = []
const dirs: string[] = []

// Fixtures say `node …`; run them on this Node so nothing depends on PATH.
const NODE = JSON.stringify(process.execPath)
const withNode = (command: string) => command.replace(/^node\b/, NODE)

function onThisNode(recipe: AppLaunch): AppLaunch {
  return {
    ...recipe,
    services: recipe.services.map((s) => ({
      ...s,
      command: withNode(s.command),
    })),
    ...(recipe.setup
      ? {
          setup: recipe.setup.map((step) => ({
            ...step,
            command: withNode(step.command),
          })),
        }
      : {}),
  }
}

// A fresh copy of the project, with the variant's story patches applied.
function workingCopy(scenario: LoadedScenario, patches: string[] = []): string {
  const dir = mkdtempSync(
    path.join(tmpdir(), `scenario-${scenario.spec.number}-`)
  )
  dirs.push(dir)
  cpSync(scenario.projectDir, dir, { recursive: true })
  for (const patch of patches)
    execFileSync("git", ["apply", path.join(scenario.patchesDir, patch)], {
      cwd: dir,
      stdio: "pipe",
    })
  return dir
}

async function get(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
  return { status: res.status, body: await res.text() }
}

async function runVariant(
  scenario: LoadedScenario,
  key: string
): Promise<ScenarioRunRecord> {
  const variant = scenario.spec.variants[key]
  const expectation: HarnessExpectation = variant.expect
  const started = Date.now()
  const record = runRecord(scenario.spec.key, key, "harness")
  const validation = validateAppLaunch(variant.recipe)
  expect(validation.ok, JSON.stringify(validation)).toBe(true)
  const root = workingCopy(scenario, variant.patches)
  // Stored as written (a per-service prepare reads as a setup step).
  const recipe = onThisNode(validation.recipe)
  const owner = `scenario:${scenario.spec.key}:${key}`

  const outcome = await startServices({ owner, root, recipe })
  const pids = testAppServices.pids()
  try {
    if (!outcome.ok && outcome.code === "no_recipe") {
      record.outcome = "no_services"
    } else if (outcome.ok) {
      record.outcome = "ready"
      if (expectation.outcome === "ready") {
        const service = outcome.services.find(
          (s) => s.key === expectation.smoke.service
        )
        expect(service?.url).toBeTruthy()
        const smoke = await get(`${service!.url}/`)
        record.detail = `GET / → ${smoke.status}`
        expect(smoke.status).toBeLessThan(500)
        for (const text of expectation.smoke.contains)
          expect(smoke.body).toContain(text)
      }
    } else {
      record.outcome = "failed"
      record.failureClass = "environment"
      const failed = outcome.services.find((s) => s.status === "failed")
      record.detail = `${outcome.message}\n${failed?.outputTail ?? ""}`.trim()
      if (expectation.outcome === "failed") {
        expect(failed?.key).toBe(expectation.service)
        expect(failed?.error ?? "").toMatch(new RegExp(expectation.error))
        if (expectation.tail)
          expect(failed?.outputTail ?? "").toMatch(new RegExp(expectation.tail))
      }
    }
    expect(record.outcome).toBe(expectation.outcome)
  } finally {
    await stopServices({ owner })
    record.orphans = await waitForOrphans(pids)
    record.wallMs = Date.now() - started
  }
  expect(testAppServices.size).toBe(0)
  expect(record.orphans).toEqual([])
  record.matched = true
  return record
}

describe.skipIf(process.platform === "win32")(
  "scenario fixtures: harness tier (plan 112.1)",
  () => {
    afterAll(() => {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
      const label = process.env.SCORECARD_LABEL
      if (!label || !records.length) return
      const date = new Date().toLocaleDateString("en-CA")
      const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
        encoding: "utf8",
      }).stdout.trim()
      const file = path.resolve(scorecardPath(date, label))
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(
        file,
        `${JSON.stringify(
          buildScorecard({
            label,
            date,
            tier: "harness",
            commit: commit || null,
            notes:
              "Harness tier: each fixture and recipe variant through start → readiness → GET / → stop, on the app launch harness.",
            runs: records,
          }),
          null,
          2
        )}\n`
      )
    })

    it("has the six scenarios, in order", () => {
      expect(scenarios.map((s) => s.spec.number)).toEqual([1, 2, 3, 4, 5, 6])
      for (const { spec } of scenarios) {
        expect(spec.stories.length).toBeGreaterThan(0)
        expect(Object.keys(spec.expected.live.stories).sort()).toEqual(
          spec.stories.map((s) => s.key).sort()
        )
      }
    })

    for (const scenario of scenarios) {
      describe(`${scenario.spec.number}. ${scenario.spec.title}`, () => {
        for (const key of Object.keys(scenario.spec.variants)) {
          it(`${key}: ${scenario.spec.variants[key].expect.outcome}`, async () => {
            records.push(await runVariant(scenario, key))
          }, 30_000)
        }
        for (const check of scenario.spec.checks ?? []) {
          it(`check: ${check.label}`, () => {
            const root = workingCopy(scenario)
            const [command, ...args] = check.command.split(" ")
            const result = spawnSync(
              command === "node" ? process.execPath : command,
              args,
              { cwd: root, encoding: "utf8" }
            )
            expect(result.status, result.stderr).toBe(check.exitCode)
          })
        }
      })
    }
  }
)

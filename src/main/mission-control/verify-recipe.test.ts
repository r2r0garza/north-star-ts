import { cpSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { afterEach, describe, expect, it } from "vitest"
import {
  validateAppLaunch,
  type AppLaunch,
} from "../../shared/mission-control/app-launch"
import {
  allocatePort,
  envFileValues,
  parseDotenv,
  testAppServices,
  verifyRecipe,
  type SmokeBrowserLoad,
} from "./app-launch"
import { classifyRunFailure } from "./run-failure"
import { loadScenarios } from "./scenarios/scorecard"

// verifyRecipe on the scenario fixtures (plan 112.3): correct recipes verify;
// each deliberate breakage fails at the right stage, classifies as an
// environment failure, and leaves no process behind.

const NODE = JSON.stringify(process.execPath)
const scenarios = loadScenarios()
const scenario = (number: number) =>
  scenarios.find((s) => s.spec.number === number)!

let dirs: string[] = []
afterEach(async () => {
  await testAppServices.clear()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function copy(number: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), `verify-${number}-`))
  dirs.push(dir)
  cpSync(scenario(number).projectDir, dir, { recursive: true })
  return dir
}

function emptyDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "verify-main-"))
  dirs.push(dir)
  return dir
}

// The fixture's variant, validated (prepare → setup) and run on this Node.
function variant(
  number: number,
  key: string,
  patch?: (r: AppLaunch) => AppLaunch
): AppLaunch {
  const validated = validateAppLaunch(
    scenario(number).spec.variants[key].recipe
  )
  expect(validated.ok).toBe(true)
  const node = (command: string) => command.replace(/^node\b/, NODE)
  const recipe: AppLaunch = {
    ...validated.recipe,
    services: validated.recipe.services.map((s) => ({
      ...s,
      command: node(s.command),
    })),
    ...(validated.recipe.setup
      ? {
          setup: validated.recipe.setup.map((step) => ({
            ...step,
            command: node(step.command),
          })),
        }
      : {}),
  }
  return patch ? patch(recipe) : recipe
}

const environment = (
  failure: Parameters<typeof classifyRunFailure>[0]["launch"]
) => classifyRunFailure({ launch: failure, smokeVerified: false }).class

describe.skipIf(process.platform === "win32")("verifyRecipe", () => {
  it("verifies a correct recipe: start, smoke, stop, nothing left running", async () => {
    const result = await verifyRecipe({
      root: copy(3),
      recipe: variant(3, "correct"),
      owner: "verify:correct",
    })
    expect(result.ok, JSON.stringify(result.failure)).toBe(true)
    expect(result.smoke).toEqual([
      { url: expect.stringMatching(/^http:\/\/localhost:\d+\/$/), status: 200 },
    ])
    expect(result.stages.map((s) => s.stage)).toEqual([
      "start",
      "smoke",
      "stop",
    ])
    expect(result.stages.every((s) => s.ok)).toBe(true)
    expect(testAppServices.size).toBe(0)
  }, 30_000)

  it("verifies two services wired by port", async () => {
    const result = await verifyRecipe({
      root: copy(4),
      recipe: variant(4, "correct"),
      owner: "verify:two",
    })
    expect(result.ok, JSON.stringify(result.failure)).toBe(true)
    expect(result.smoke).toHaveLength(2)
  }, 30_000)

  it("resolves {env:KEY} from the worktree, then the main checkout", async () => {
    const withRef = (r: AppLaunch): AppLaunch => ({
      ...r,
      services: r.services.map((s) =>
        s.key === "web"
          ? { ...s, env: { ...s.env, DATA_FILE: "{env:DATA_FILE}" } }
          : s
      ),
    })
    // The worktree lacks the untracked .env.local; the main checkout has it.
    const worktree = copy(3)
    rmSync(path.join(worktree, ".env.local"))
    const main = emptyDir()
    writeFileSync(path.join(main, ".env.local"), "DATA_FILE=data/app.json\n")
    const resolved = await verifyRecipe({
      root: worktree,
      recipe: variant(3, "correct", withRef),
      owner: "verify:env",
      mainRoot: main,
    })
    expect(resolved.ok, JSON.stringify(resolved.failure)).toBe(true)

    // Neither has it: the missing-env-key breakage.
    const missing = await verifyRecipe({
      root: worktree,
      recipe: variant(3, "correct", withRef),
      owner: "verify:env-missing",
      mainRoot: emptyDir(),
    })
    expect(missing.ok).toBe(false)
    expect(missing.failure).toMatchObject({
      stage: "start",
      reason: "missing_env",
      missingEnv: ["DATA_FILE"],
      service: "web",
    })
    expect(environment(missing.failure)).toBe("environment")
    expect(testAppServices.size).toBe(0)
  }, 30_000)

  it("fails a missing migration at readiness, with the output that says why", async () => {
    const result = await verifyRecipe({
      root: copy(3),
      recipe: variant(3, "missing-migration"),
      owner: "verify:migration",
    })
    expect(result.failure).toMatchObject({
      stage: "ready",
      reason: "exited_early",
      service: "web",
    })
    expect(result.failure?.logs).toMatch(/not migrated/)
    expect(environment(result.failure)).toBe("environment")
    expect(result.stages.at(-1)).toMatchObject({ stage: "stop", ok: true })
  }, 30_000)

  it("fails a setup step that exits non-zero", async () => {
    const result = await verifyRecipe({
      root: copy(3),
      recipe: variant(3, "missing-env-key"),
      owner: "verify:setup",
    })
    expect(result.failure).toMatchObject({
      stage: "setup",
      reason: "setup_failed",
    })
    expect(result.failure?.logs).toMatch(/DATA_FILE is not set/)
    expect(environment(result.failure)).toBe("environment")
  }, 30_000)

  it("fails a second service that's missing", async () => {
    const result = await verifyRecipe({
      root: copy(4),
      recipe: variant(4, "no-api-service"),
      owner: "verify:no-api",
    })
    expect(result.failure).toMatchObject({
      stage: "ready",
      reason: "ready_timeout",
      service: "web",
    })
    expect(environment(result.failure)).toBe("environment")
  }, 30_000)

  it("fails a server that listens on the wrong port", async () => {
    const root = emptyDir()
    const elsewhere = await allocatePort()
    writeFileSync(
      path.join(root, "server.js"),
      `require("http").createServer((q, s) => s.end("ok")).listen(${elsewhere}, "127.0.0.1")\n`
    )
    const result = await verifyRecipe({
      root,
      recipe: {
        services: [
          {
            key: "web",
            label: "Web",
            command: `${NODE} server.js`,
            cwd: "",
            port: "auto",
            ready: { http: "/" },
            readyTimeoutMs: 1500,
            source: "detector",
          },
        ],
      },
      owner: "verify:port",
    })
    expect(result.failure).toMatchObject({
      stage: "ready",
      reason: "ready_timeout",
    })
    expect(environment(result.failure)).toBe("environment")
    expect(testAppServices.size).toBe(0)
  }, 30_000)

  it("fails a prerequisite that's down before running anything", async () => {
    const closed = await allocatePort()
    const recipe: AppLaunch = {
      ...variant(3, "correct"),
      prerequisites: [
        {
          key: "postgres",
          label: "A Postgres database",
          check: { tcp: closed },
          hint: "Start Postgres on that port.",
        },
      ],
    }
    const result = await verifyRecipe({
      root: copy(3),
      recipe,
      owner: "verify:prereq",
    })
    expect(result.failure).toMatchObject({
      stage: "prerequisites",
      reason: "prerequisite_unavailable",
      prerequisite: "postgres",
    })
    expect(result.failure?.summary).toMatch(
      new RegExp(
        `the app needs a Postgres database, and it isn't available \\(nothing answers on port ${closed}\\)`
      )
    )
    expect(result.services).toEqual([])
    expect(environment(result.failure)).toBe("environment")
  }, 30_000)

  it("fails smoke on a 5xx page", async () => {
    const root = emptyDir()
    writeFileSync(
      path.join(root, "server.js"),
      `require("http").createServer((q, s) => { s.statusCode = q.url === "/broken" ? 500 : 200; s.end("x") }).listen(Number(process.env.PORT), "127.0.0.1")\n`
    )
    const result = await verifyRecipe({
      root,
      recipe: {
        services: [
          {
            key: "web",
            label: "Web",
            command: `${NODE} server.js`,
            cwd: "",
            port: "auto",
            ready: { http: "/" },
            smoke: ["/", "/broken"],
            source: "seat",
          },
        ],
      },
      owner: "verify:5xx",
    })
    expect(result.failure).toMatchObject({
      stage: "smoke",
      reason: "smoke_status",
      status: 500,
      url: expect.stringMatching(/\/broken$/),
    })
    expect(environment(result.failure)).toBe("environment")
  }, 30_000)

  it("loads each smoke URL in the browser and fails on console errors", async () => {
    const seen: string[][] = []
    const failing: SmokeBrowserLoad = async ({ urls }) => {
      seen.push(urls)
      return {
        pages: urls.map((url) => ({
          url,
          error: null,
          consoleErrors: ["Uncaught ReferenceError: x is not defined"],
          failedRequests: ["GET /app.js net::ERR_FILE_NOT_FOUND"],
        })),
      }
    }
    const result = await verifyRecipe({
      root: copy(3),
      recipe: variant(3, "correct"),
      owner: "verify:browser",
      browserLoad: failing,
    })
    expect(seen).toHaveLength(1)
    expect(result.failure).toMatchObject({
      stage: "smoke",
      reason: "smoke_browser",
      service: "web",
      consoleErrors: ["Uncaught ReferenceError: x is not defined"],
      failedRequests: ["GET /app.js net::ERR_FILE_NOT_FOUND"],
    })
    expect(result.failure?.summary).toMatch(
      /1 console error and 1 failed request/
    )

    // No test browser yet: HTTP smoke decides, and the skip is reported.
    const skipped = await verifyRecipe({
      root: copy(3),
      recipe: variant(3, "correct"),
      owner: "verify:no-browser",
      browserLoad: async () => ({ notVerifiable: "browser not installed" }),
    })
    expect(skipped.ok).toBe(true)
    expect(skipped.browserSkipped).toBe("browser not installed")
  }, 30_000)
})

describe(".env files", () => {
  it("parses KEY=value lines with comments, export, and quotes", () => {
    expect(
      parseDotenv(
        [
          "# comment",
          "A=1",
          "export B = two # trailing",
          'C="quoted # kept\\nnext"',
          "D='single'",
          "not a line",
          "A=again",
        ].join("\n")
      )
    ).toEqual({ A: "1", B: "two", C: "quoted # kept\nnext", D: "single" })
  })

  it("prefers the worktree's .env.local, then .env, then the main checkout's", () => {
    const worktree = emptyDir()
    const main = emptyDir()
    writeFileSync(
      path.join(worktree, ".env"),
      "A=worktree-env\nB=worktree-env\n"
    )
    writeFileSync(path.join(worktree, ".env.local"), "A=worktree-local\n")
    writeFileSync(path.join(main, ".env.local"), "B=main\nC=main-local\n")
    writeFileSync(path.join(main, ".env"), "C=main-env\nD=main-env\n")
    expect(envFileValues(worktree, main)).toEqual({
      A: "worktree-local",
      B: "worktree-env",
      C: "main-local",
      D: "main-env",
    })
  })
})

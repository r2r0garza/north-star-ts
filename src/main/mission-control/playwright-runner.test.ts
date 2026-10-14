import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs"
import { createRequire } from "module"
import { tmpdir } from "os"
import { join } from "path"
import {
  BROWSER_NOT_INSTALLED,
  buildPlaywrightConfig,
  parsePlaywrightReport,
  runPlaywright,
  specPattern,
} from "./playwright-runner"
import {
  bundledPlaywright,
  configurePlaywright,
  getTestBrowserState,
  installTestBrowser,
  onTestBrowserChanged,
  resetTestBrowserStateForTests,
  resolvePlaywright,
  resolveTestBrowser,
  setBundledPlaywrightPackageJson,
  waitForTestBrowser,
  type PlaywrightInstall,
} from "./playwright-install"
import { clearPhaseClock, phaseClockHeld } from "../tasks/process/phase-clock"

const require = createRequire(import.meta.url)
const electronBinary = require("electron") as unknown as string

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pw-runner-"))
  resetTestBrowserStateForTests()
  configurePlaywright({
    executable: electronBinary,
    browsersPath: join(dir, "browsers"),
    findChrome: () => null,
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  resetTestBrowserStateForTests()
})

function write(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
}

// A workspace without Playwright, with one spec holding two stories' tests.
function workspace(type: "commonjs" | "module", spec: string) {
  const root = join(dir, `ws-${type}`)
  write(join(root, "package.json"), JSON.stringify({ name: "ws", type }))
  write(join(root, "e2e", "math.spec.ts"), spec)
  return root
}

const MATH_SPEC = `import { test, expect } from "@playwright/test"
test("adds @CHK.M1.US1 @AC-1", async () => { expect(1 + 1).toBe(2) })
test("another story @CHK.M1.US10", async () => { expect(1).toBe(2) })
`

// No Node on PATH: the runner must run on the app's Electron as Node.
const env = {
  PATH:
    process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin",
}

// A story's tests, the way 112.5 selects them: by tag.
const storyGrep = (ref: string) => `@${ref.replace(/\./g, "\\.")}(?![\\w.])`

function runSpecs(
  root: string,
  extra: Partial<Parameters<typeof runPlaywright>[0]> = {}
) {
  return runPlaywright({
    cwd: root,
    testDir: join(root, "e2e"),
    testMatch: ["math.spec.ts"],
    grep: storyGrep("CHK.M1.US1"),
    baseURL: null,
    env,
    outputDir: join(dir, "evidence"),
    timeoutMs: 120_000,
    ...extra,
  })
}

describe("spec selection", () => {
  it("selects a story's tag and not a longer ref that starts with it", () => {
    const grep = new RegExp(storyGrep("CHK.M1.US1"))
    expect(grep.test("adds @CHK.M1.US1 @AC-1")).toBe(true)
    expect(grep.test("adds @CHK.M1.US10")).toBe(false)
  })

  it("matches a spec file inside the test directory with either separator", () => {
    const pattern = new RegExp(specPattern("auth/login.spec.ts"))
    expect(pattern.test("/w/e2e/auth/login.spec.ts")).toBe(true)
    expect(pattern.test("C:\\w\\e2e\\auth\\login.spec.ts")).toBe(true)
    expect(pattern.test("/w/e2e/auth/xlogin.spec.ts")).toBe(false)
    expect(pattern.test("/w/e2e/auth/login.spec.tsx")).toBe(false)
  })
})

describe("generated config", () => {
  const base = {
    testDir: "/w/e2e",
    testMatch: ["login.spec.ts"],
    grep: storyGrep("CHK.M1.US1"),
    outputDir: "/data/evidence/pr-1/playwright/ac1-1",
    reportFile: "/tmp/run/report.json",
  }

  it("takes baseURL from the app, writes into the evidence directory, and reports JSON", () => {
    const config = buildPlaywrightConfig({
      ...base,
      baseURL: "http://127.0.0.1:4100",
      channel: null,
      baseConfig: null,
    })
    expect(config).toContain(`baseURL: "http://127.0.0.1:4100"`)
    expect(config).toContain(
      `outputDir: "/data/evidence/pr-1/playwright/ac1-1"`
    )
    expect(config).toContain(`["json", { outputFile: "/tmp/run/report.json" }]`)
    expect(config).toContain(`trace: "retain-on-failure"`)
    expect(config).toContain(`screenshot: "only-on-failure"`)
    expect(config).toContain("retries: 0")
    expect(config).toContain("testMatch: [new RegExp(")
    expect(config).toContain("grep: new RegExp(")
    expect(config).not.toContain("channel")
    expect(config).not.toContain("import")
  })

  it("leaves testMatch and grep to Playwright's defaults when none are asked for", () => {
    const config = buildPlaywrightConfig({
      ...base,
      testMatch: undefined,
      grep: undefined,
      baseURL: null,
      channel: null,
      baseConfig: null,
    })
    expect(config).not.toContain("testMatch:")
    expect(config).not.toContain("grep:")
    // The workspace config's own testMatch and grep are still dropped.
    expect(config).toContain("testMatch, testIgnore")
  })

  it("uses the Chrome channel and merges a workspace config under its own", () => {
    const config = buildPlaywrightConfig({
      ...base,
      baseURL: null,
      channel: "chrome",
      baseConfig: "/w/playwright.config.ts",
    })
    expect(config).toContain(`channel: "chrome"`)
    expect(config).toContain(
      `import * as baseModule from "file:///w/playwright.config.ts"`
    )
    expect(config).toContain("projects, webServer")
    expect(config).not.toContain("baseURL")
  })
})

describe("report parsing", () => {
  it("collects per-test results, errors, and failure artifacts", () => {
    const report = {
      suites: [
        {
          title: "login.spec.ts",
          file: "login.spec.ts",
          specs: [
            {
              title: "redirects @CHK.M1.US1",
              file: "login.spec.ts",
              tests: [{ results: [{ status: "passed", duration: 120 }] }],
            },
          ],
          suites: [
            {
              title: "errors",
              file: "login.spec.ts",
              specs: [
                {
                  title: "shows a message @CHK.M1.US1",
                  file: "login.spec.ts",
                  tests: [
                    {
                      results: [
                        {
                          status: "failed",
                          duration: 900,
                          error: {
                            message: "\u001b[31mexpected visible\u001b[39m",
                          },
                          attachments: [
                            { name: "trace", path: "/e/trace.zip" },
                            { name: "screenshot", path: "/e/shot.png" },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      errors: [],
    }
    const parsed = parsePlaywrightReport(JSON.stringify(report))
    expect(parsed.tests).toEqual([
      {
        title: "redirects @CHK.M1.US1",
        file: "login.spec.ts",
        status: "passed",
        durationMs: 120,
      },
      {
        title: "errors › shows a message @CHK.M1.US1",
        file: "login.spec.ts",
        status: "failed",
        durationMs: 900,
        error: "expected visible",
      },
    ])
    expect(parsed.artifacts).toEqual(["/e/trace.zip", "/e/shot.png"])
  })
})

describe("which Playwright", () => {
  it("prefers the workspace's own @playwright/test", () => {
    const root = join(dir, "own")
    write(
      join(root, "node_modules", "@playwright", "test", "package.json"),
      JSON.stringify({ name: "@playwright/test", version: "1.40.0" })
    )
    const install = resolvePlaywright(join(root))
    expect(install?.source).toBe("workspace")
    expect(install?.version).toBe("1.40.0")
    expect(install?.nodeModules).toBeNull()
  })

  it("falls back to the bundled copy", () => {
    const install = resolvePlaywright(join(dir, "nothing-here"))
    expect(install?.source).toBe("bundled")
    expect(install?.version).toBe(bundledPlaywright()!.version)
    expect(existsSync(install!.cliPath)).toBe(true)
  })
})

// A fake Playwright whose CLI answers `install --dry-run` and "downloads"
// into PLAYWRIGHT_BROWSERS_PATH, printing progress. Each version has its own
// headless shell revision. `ownBrowsers`: where a workspace Playwright's own
// browsers live (its cache), installed or not.
function fakePlaywright(
  where: string,
  version: string,
  revision: number,
  ownBrowsers?: { dir: string; installed: boolean }
): string {
  const pkg = join(dir, where, "node_modules", "@playwright", "test")
  write(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@playwright/test", version })
  )
  if (ownBrowsers?.installed)
    write(
      join(
        ownBrowsers.dir,
        `chromium_headless_shell-${revision}`,
        "INSTALLATION_COMPLETE"
      ),
      ""
    )
  write(
    join(pkg, "cli.js"),
    `const { mkdirSync, writeFileSync } = require("fs")
const path = require("path")
const base = process.env.PLAYWRIGHT_BROWSERS_PATH || ${JSON.stringify(ownBrowsers?.dir ?? join(dir, "nowhere"))}
const target = path.join(base, "chromium_headless_shell-${revision}")
if (process.argv.includes("--dry-run")) {
  console.log("Chrome Headless Shell ${revision} (playwright chromium-headless-shell v${revision})\\n  Install location:    " + target + "\\n  Download url:        https://example.invalid/shell.zip\\n")
} else {
  console.log("|■■■■■     | 50% of 80.5 MiB")
  console.log("|■■■■■■■■■■| 100% of 80.5 MiB")
  mkdirSync(target, { recursive: true })
  writeFileSync(path.join(target, "INSTALLATION_COMPLETE"), "")
}
`
  )
  return join(pkg, "package.json")
}

function fakeBundled(version = "9.9.9", revision = 1): PlaywrightInstall {
  setBundledPlaywrightPackageJson(
    fakePlaywright(`bundled-${version}`, version, revision)
  )
  return bundledPlaywright()!
}

function fakeWorkspace(installed: boolean): PlaywrightInstall {
  fakePlaywright("ws-own", "1.40.0", 7, {
    dir: join(dir, "ws-browsers"),
    installed,
  })
  return resolvePlaywright(join(dir, "ws-own"))!
}

const shellAt = (revision: number) =>
  existsSync(
    join(
      dir,
      "browsers",
      `chromium_headless_shell-${revision}`,
      "INSTALLATION_COMPLETE"
    )
  )

describe("browser resolution: workspace → Chrome → consented download", () => {
  beforeEach(() => configurePlaywright({ executable: process.execPath }))

  const chrome = () => "/Applications/Chrome"
  const noChrome = () => null

  it.each([
    [
      "workspace Playwright, its browser installed",
      "workspace",
      true,
      chrome,
      "workspace",
    ],
    [
      "workspace Playwright, no browser, Chrome present",
      "workspace",
      false,
      chrome,
      "chrome",
    ],
    ["bundled Playwright, Chrome present", "bundled", false, chrome, "chrome"],
    [
      "workspace Playwright, no browser, no Chrome",
      "workspace",
      false,
      noChrome,
      "missing",
    ],
    ["bundled Playwright, no Chrome", "bundled", false, noChrome, "missing"],
  ] as const)("%s → %s", async (_name, source, installed, findChrome, kind) => {
    configurePlaywright({ findChrome })
    const install =
      source === "workspace" ? fakeWorkspace(installed) : fakeBundled()
    expect(install.source).toBe(source)
    expect((await resolveTestBrowser(install)).kind).toBe(kind)
    // Without consent, nothing is downloaded.
    expect(existsSync(join(dir, "browsers"))).toBe(false)
  })

  it("after consent, downloads into app data once and is installed from then on", async () => {
    const install = fakeBundled()
    const progress: number[] = []
    const stop = onTestBrowserChanged(
      (s) => s.progress && progress.push(s.progress.percent)
    )
    expect(await installTestBrowser()).toBe(true)
    stop()
    expect(shellAt(1)).toBe(true)
    expect(progress).toContain(100)
    const state = getTestBrowserState()
    expect(state.status).toBe("installed")
    expect(state.consent).toBe(true)
    expect(await resolveTestBrowser(install)).toEqual({
      kind: "installed",
      browsersPath: join(dir, "browsers"),
    })
  })

  it("remembers consent across a Playwright version bump", async () => {
    let consent = false
    configurePlaywright({
      consent: () => consent,
      giveConsent: () => {
        consent = true
      },
    })
    expect(await installTestBrowser(fakeBundled("9.9.9", 1))).toBe(true)
    // The next version needs its own revision: downloaded without asking.
    expect(await resolveTestBrowser(fakeBundled("10.0.0", 2))).toEqual({
      kind: "installed",
      browsersPath: join(dir, "browsers"),
    })
    expect(shellAt(2)).toBe(true)
  })

  it("downloads a workspace Playwright's own revision into app data after consent", async () => {
    configurePlaywright({ consent: () => true })
    expect(await resolveTestBrowser(fakeWorkspace(false))).toEqual({
      kind: "installed",
      browsersPath: join(dir, "browsers"),
    })
    expect(shellAt(7)).toBe(true)
  })
})

describe("waiting for a test browser", () => {
  beforeEach(() => configurePlaywright({ executable: process.execPath }))
  afterEach(() => clearPhaseClock("phase-1"))

  it("raises the notice and holds the phase clock until a browser is ready", async () => {
    fakeBundled()
    const waiting = waitForTestBrowser({ phaseRunId: "phase-1", pollMs: 50 })
    for (let i = 0; i < 200 && !getTestBrowserState().requested; i++)
      await new Promise((r) => setTimeout(r, 10))
    expect(getTestBrowserState().requested).toBe(true)
    expect(phaseClockHeld("phase-1")).toBe(true)
    await installTestBrowser()
    expect(await waiting).toBe(true)
    expect(phaseClockHeld("phase-1")).toBe(false)
  })

  it("notices a Chrome installed meanwhile, and gives up when the phase stops", async () => {
    fakeBundled()
    let installed = false
    configurePlaywright({ findChrome: () => (installed ? "/Chrome" : null) })
    const waiting = waitForTestBrowser({ phaseRunId: "phase-1", pollMs: 20 })
    await new Promise((r) => setTimeout(r, 30))
    installed = true
    expect(await waiting).toBe(true)

    installed = false
    const abort = new AbortController()
    const stopped = waitForTestBrowser({
      phaseRunId: "phase-1",
      pollMs: 1000,
      signal: abort.signal,
    })
    for (let i = 0; i < 200 && !phaseClockHeld("phase-1"); i++)
      await new Promise((r) => setTimeout(r, 10))
    expect(phaseClockHeld("phase-1")).toBe(true)
    abort.abort()
    expect(await stopped).toBe(false)
    expect(phaseClockHeld("phase-1")).toBe(false)
  })
})

// The real bundled runner on the app's Electron as Node, with no Node on PATH.
describe("running specs", () => {
  for (const type of ["commonjs", "module"] as const)
    it(`runs a ${type} spec importing @playwright/test in a workspace without it`, async () => {
      const root = workspace(type, MATH_SPEC)
      const run = await runSpecs(root)
      expect(run.output).not.toMatch(/Cannot find (package|module)/)
      expect(run.runner.source).toBe("bundled")
      expect(run.tests).toEqual([
        expect.objectContaining({
          title: "adds @CHK.M1.US1 @AC-1",
          status: "passed",
        }),
      ])
      expect(run.passed).toBe(true)
    }, 60_000)

  for (const type of ["commonjs", "module"] as const)
    it(`uses a ${type} workspace's own Playwright with its config merged under the harness's`, async () => {
      const root = workspace(
        type,
        `import { test, expect } from "@playwright/test"
test("config @CHK.M1.US1", async ({}, info) => {
  expect(info.project.use.testIdAttribute).toBe("data-qa")
  expect(info.project.use.baseURL).toBe("http://127.0.0.1:4555")
  expect(info.project.retries).toBe(0)
})
`
      )
      mkdirSync(join(root, "node_modules", "@playwright"), { recursive: true })
      symlinkSync(
        bundledPlaywright()!.packageDir,
        join(root, "node_modules", "@playwright", "test")
      )
      write(
        join(root, "playwright.config.ts"),
        `import { defineConfig } from "@playwright/test"
export default defineConfig({
  testDir: "./elsewhere",
  retries: 3,
  use: { testIdAttribute: "data-qa", baseURL: "http://example.com" },
  projects: [{ name: "firefox", use: { browserName: "firefox" } }],
})
`
      )
      const run = await runSpecs(root, { baseURL: "http://127.0.0.1:4555" })
      expect(run.runner).toEqual(
        expect.objectContaining({ source: "workspace", browser: "workspace" })
      )
      expect(run.tests).toEqual([
        expect.objectContaining({
          title: "config @CHK.M1.US1",
          status: "passed",
        }),
      ])
      expect(run.passed).toBe(true)
    }, 60_000)

  it("fails a run whose grep matches no test, saying why", async () => {
    const root = workspace("commonjs", MATH_SPEC)
    const run = await runSpecs(root, { grep: storyGrep("CHK.M1.US2") })
    expect(run.passed).toBe(false)
    expect(run.output).toContain("No test matched in math.spec.ts with grep")
  }, 60_000)

  it("marks a run needing a browser not verifiable until one is installed", async () => {
    const root = workspace(
      "commonjs",
      `import { test, expect } from "@playwright/test"
test("heading @CHK.M1.US1", async ({ page }) => {
  await page.setContent("<h1>Hi</h1>")
  await expect(page.getByRole("heading", { name: "Hi" })).toBeVisible()
})
`
    )
    const run = await runSpecs(root)
    expect(run.passed).toBe(false)
    expect(run.runner.browser).toBe("missing")
    expect(run.notVerifiable).toBe(BROWSER_NOT_INSTALLED)
    expect(getTestBrowserState().requested).toBe(true)
  }, 60_000)

  for (const type of ["commonjs", "module"] as const)
    it(`runs Node scripts a ${type} spec starts with process.execPath as Node, not as an Electron app`, async () => {
      const root = workspace(
        type,
        `import { test, expect } from "@playwright/test"
import { spawnSync, execFileSync, fork } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
const probe = "console.log(String(process.env.ELECTRON_RUN_AS_NODE) + ':' + typeof require('node:http').createServer)"
test("starts node @CHK.M1.US1", async () => {
  const spawned = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8" })
  expect(spawned.stdout.trim()).toBe("1:function")
  expect(execFileSync(process.execPath, ["-e", probe], { encoding: "utf8" }).trim()).toBe("1:function")
  const script = join(process.cwd(), "child.cjs")
  writeFileSync(script, "process.send(process.env.ELECTRON_RUN_AS_NODE)")
  const child = fork(script)
  const message = await new Promise((resolve) => child.on("message", resolve))
  expect(message).toBe("1")
  // The worker itself still doesn't carry it, so _electron.launch is unaffected.
  expect(process.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
})
`
      )
      const run = await runSpecs(root)
      expect(run.output).not.toMatch(/Error launching app/)
      expect(run.tests).toEqual([
        expect.objectContaining({
          title: "starts node @CHK.M1.US1",
          status: "passed",
        }),
      ])
    }, 60_000)

  it("checks an Electron app with _electron.launch, without a browser", async () => {
    const root = workspace(
      "commonjs",
      `import { test, expect, _electron } from "@playwright/test"
import electronPath from "electron"
import { join } from "path"
test("shows its title @CHK.M1.US1", async () => {
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [join(__dirname, "..", "app", "main.js")],
  })
  const window = await app.firstWindow()
  await expect(window.getByRole("heading")).toHaveText("Fixture app")
  await app.close()
})
`
    )
    write(
      join(root, "app", "main.js"),
      `const { app, BrowserWindow } = require("electron")
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false })
  win.loadURL("data:text/html,<h1>Fixture app</h1>")
})
`
    )
    // The app's own Electron, as the kickoff tells QA to launch it.
    mkdirSync(join(root, "node_modules"), { recursive: true })
    symlinkSync(
      join(require.resolve("electron/package.json"), ".."),
      join(root, "node_modules", "electron")
    )
    const run = await runSpecs(root)
    expect(run.tests).toEqual([
      expect.objectContaining({
        title: "shows its title @CHK.M1.US1",
        status: "passed",
      }),
    ])
    expect(run.passed).toBe(true)
  }, 90_000)
})

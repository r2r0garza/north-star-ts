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
  buildPlaywrightConfig,
  checkGrep,
  parsePlaywrightReport,
  runPlaywrightCheck,
  specPattern,
} from "./playwright-runner"
import {
  bundledPlaywright,
  configurePlaywright,
  getTestBrowserState,
  installTestBrowser,
  resetTestBrowserStateForTests,
  resolvePlaywright,
  setBundledPlaywrightPackageJson,
  testBrowserForRun,
} from "./playwright-install"
import type { PlaywrightCheck } from "./checks-manifest"

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

function check(
  spec: string,
  extra: Partial<PlaywrightCheck> = {}
): PlaywrightCheck {
  return {
    id: "ac1-check",
    kind: "automated",
    runner: "playwright",
    spec,
    cwd: "",
    services: [],
    timeoutMs: 120_000,
    ...extra,
  }
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

describe("check selection", () => {
  it("selects the story's tag and not a longer ref that starts with it", () => {
    const grep = new RegExp(checkGrep("CHK.M1.US1"))
    expect(grep.test("adds @CHK.M1.US1 @AC-1")).toBe(true)
    expect(grep.test("adds @CHK.M1.US10")).toBe(false)
    expect(grep.test("adds")).toBe(false)
  })

  it("narrows by the check's grep on top of the tag", () => {
    const grep = new RegExp(checkGrep("CHK.M1.US1", "redirects to dashboard"))
    expect(grep.test("redirects to dashboard @CHK.M1.US1")).toBe(true)
    expect(grep.test("shows an error @CHK.M1.US1")).toBe(false)
  })

  it("matches the spec file inside the checks directory with either separator", () => {
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
    spec: "login.spec.ts",
    grep: checkGrep("CHK.M1.US1"),
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
    expect(config).not.toContain("channel")
    expect(config).not.toContain("import")
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

describe("browser resolution", () => {
  it("uses the user's Chrome when present, with no download", async () => {
    configurePlaywright({ findChrome: () => "/Applications/Chrome" })
    expect(await testBrowserForRun()).toEqual({ kind: "chrome" })
    expect(getTestBrowserState().status).toBe("chrome")
  })

  // A fake bundled Playwright whose CLI answers `install --dry-run` and
  // "downloads" into PLAYWRIGHT_BROWSERS_PATH, printing progress.
  function fakeBundled() {
    const pkg = join(dir, "fake", "node_modules", "@playwright", "test")
    write(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@playwright/test", version: "9.9.9" })
    )
    write(
      join(pkg, "cli.js"),
      `const { mkdirSync, writeFileSync } = require("fs")
const path = require("path")
const target = path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium_headless_shell-1")
if (process.argv.includes("--dry-run")) {
  console.log("Chrome Headless Shell 1 (playwright chromium-headless-shell v1)\\n  Install location:    " + target + "\\n  Download url:        https://example.invalid/shell.zip\\n")
} else {
  console.log("|■■■■■     | 50% of 80.5 MiB")
  console.log("|■■■■■■■■■■| 100% of 80.5 MiB")
  mkdirSync(target, { recursive: true })
  writeFileSync(path.join(target, "INSTALLATION_COMPLETE"), "")
}
`
    )
    setBundledPlaywrightPackageJson(join(pkg, "package.json"))
  }

  it("without Chrome or consent, reports the browser missing and downloads nothing", async () => {
    fakeBundled()
    configurePlaywright({ executable: process.execPath })
    expect(await testBrowserForRun()).toEqual({
      kind: "missing",
      browsersPath: join(dir, "browsers"),
    })
    expect(existsSync(join(dir, "browsers"))).toBe(false)
  })

  it("after consent, downloads into app data once and is installed from then on", async () => {
    fakeBundled()
    configurePlaywright({ executable: process.execPath })
    const progress: number[] = []
    const { onTestBrowserChanged } = await import("./playwright-install")
    const stop = onTestBrowserChanged(
      (s) => s.progress && progress.push(s.progress.percent)
    )
    expect(await installTestBrowser()).toBe(true)
    stop()
    expect(
      existsSync(
        join(
          dir,
          "browsers",
          "chromium_headless_shell-1",
          "INSTALLATION_COMPLETE"
        )
      )
    ).toBe(true)
    expect(progress).toContain(100)
    const state = getTestBrowserState()
    expect(state.status).toBe("installed")
    expect(state.consent).toBe(true)
    expect(await testBrowserForRun()).toEqual({
      kind: "installed",
      browsersPath: join(dir, "browsers"),
    })
  })

  it("with consent remembered, a missing browser is downloaded on next use", async () => {
    fakeBundled()
    configurePlaywright({ executable: process.execPath, consent: () => true })
    expect((await testBrowserForRun()).kind).toBe("installed")
  })
})

// The real bundled runner on the app's Electron as Node, with no Node on PATH.
describe("running checks", () => {
  const env = {
    PATH:
      process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin",
  }

  for (const type of ["commonjs", "module"] as const)
    it(`runs a ${type} spec importing @playwright/test in a workspace without it`, async () => {
      const root = workspace(type, MATH_SPEC)
      const run = await runPlaywrightCheck({
        cwd: root,
        checksDir: join(root, "e2e"),
        storyRef: "CHK.M1.US1",
        check: check("math.spec.ts"),
        env,
        outputDir: join(dir, "evidence"),
      })
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
      const run = await runPlaywrightCheck({
        cwd: root,
        checksDir: join(root, "e2e"),
        storyRef: "CHK.M1.US1",
        check: check("math.spec.ts"),
        env: { ...env, BASE_URL: "http://127.0.0.1:4555" },
        outputDir: join(dir, "evidence"),
      })
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

  it("fails a check whose grep matches no test, saying why", async () => {
    const root = workspace("commonjs", MATH_SPEC)
    const run = await runPlaywrightCheck({
      cwd: root,
      checksDir: join(root, "e2e"),
      storyRef: "CHK.M1.US2",
      check: check("math.spec.ts"),
      env,
      outputDir: join(dir, "evidence"),
    })
    expect(run.passed).toBe(false)
    expect(run.output).toContain("No test in math.spec.ts matched @CHK.M1.US2")
  }, 60_000)

  it("marks a check needing a browser not verifiable until one is installed", async () => {
    const root = workspace(
      "commonjs",
      `import { test, expect } from "@playwright/test"
test("heading @CHK.M1.US1", async ({ page }) => {
  await page.setContent("<h1>Hi</h1>")
  await expect(page.getByRole("heading", { name: "Hi" })).toBeVisible()
})
`
    )
    const run = await runPlaywrightCheck({
      cwd: root,
      checksDir: join(root, "e2e"),
      storyRef: "CHK.M1.US1",
      check: check("math.spec.ts"),
      env,
      outputDir: join(dir, "evidence"),
    })
    expect(run.passed).toBe(false)
    expect(run.runner.browser).toBe("missing")
    expect(run.notVerifiable).toMatch(/Browser not installed/)
    expect(getTestBrowserState().requested).toBe(true)
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
    const run = await runPlaywrightCheck({
      cwd: root,
      checksDir: join(root, "e2e"),
      storyRef: "CHK.M1.US1",
      check: check("math.spec.ts"),
      env,
      outputDir: join(dir, "evidence"),
    })
    expect(run.tests).toEqual([
      expect.objectContaining({
        title: "shows its title @CHK.M1.US1",
        status: "passed",
      }),
    ])
    expect(run.passed).toBe(true)
  }, 90_000)
})

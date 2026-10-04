import { spawn } from "child_process"
import { EventEmitter } from "events"
import { existsSync, readFileSync } from "fs"
import { createRequire } from "module"
import { dirname, join } from "path"
import { normalizeAsarUnpackedExecutablePath } from "../agent/env/local"

// Where QA's Playwright checks get Playwright and a browser (plan 109.06).
//
// Playwright: the workspace's own `@playwright/test` when the check's folder
// resolves one, otherwise the copy bundled with the app (unpacked from the
// asar archive). Either way it runs on the app's own Electron binary as Node
// (ELECTRON_RUN_AS_NODE), so the user needs no Node install.
//
// A browser, for the bundled runner: the user's installed Chrome, else
// Playwright's headless shell in app data. That one is a download, so it
// needs the user's consent, given once (a Mission Control notice or Settings →
// General → Browser) and remembered: a later Playwright version downloads its
// matching browser on next use without asking again. Until then a check that
// needs a browser is not verifiable, never silently failed.

export interface PlaywrightEnvironment {
  // The binary that runs Playwright as Node: the app's Electron in the app.
  executable: string
  // PLAYWRIGHT_BROWSERS_PATH for the bundled runner: in app data.
  browsersPath: string | null
  consent: () => boolean
  giveConsent: () => void
  // The user's installed Chrome, or null. Overridable for tests.
  findChrome: () => string | null
}

const CHROME_PATHS: Record<string, string[]> = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: ["/opt/google/chrome/chrome"],
  win32: [
    process.env.LOCALAPPDATA,
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
  ]
    .filter((dir): dir is string => !!dir)
    .map((dir) => join(dir, "Google", "Chrome", "Application", "chrome.exe")),
}

// Where Playwright's `channel: "chrome"` looks for stable Chrome.
export function findInstalledChrome(): string | null {
  return (
    (CHROME_PATHS[process.platform] ?? []).find((p) => existsSync(p)) ?? null
  )
}

let consentGiven = false
function defaultEnvironment(): PlaywrightEnvironment {
  return {
    executable: process.execPath,
    browsersPath: null,
    consent: () => consentGiven,
    giveConsent: () => {
      consentGiven = true
    },
    findChrome: findInstalledChrome,
  }
}
let environment = defaultEnvironment()

// Set from main/index.ts (it needs app.getPath and the settings); tests
// override parts of it.
export function configurePlaywright(
  next: Partial<PlaywrightEnvironment>
): void {
  environment = { ...environment, ...next }
  shellLocation = null
  state = { ...state, status: "unknown" }
}

export function playwrightEnvironment(): PlaywrightEnvironment {
  return environment
}

// ── which Playwright ────────────────────────────────────────────────────────

export interface PlaywrightInstall {
  source: "workspace" | "bundled"
  // The `@playwright/test` package directory.
  packageDir: string
  cliPath: string
  version: string
  // For the bundled runner: the node_modules directory holding
  // `@playwright/test` and its `playwright` dependency, which a spec's
  // `import "@playwright/test"` resolves into.
  nodeModules: string | null
}

function readInstall(
  packageJson: string,
  source: PlaywrightInstall["source"]
): PlaywrightInstall | null {
  try {
    const version = JSON.parse(readFileSync(packageJson, "utf8")).version
    const packageDir = dirname(packageJson)
    return {
      source,
      packageDir,
      cliPath: join(packageDir, "cli.js"),
      version: typeof version === "string" ? version : "unknown",
      nodeModules: source === "bundled" ? dirname(dirname(packageDir)) : null,
    }
  } catch {
    return null
  }
}

// The workspace's own `@playwright/test`, resolved the way the user's
// terminal would from the check's folder.
export function workspacePlaywright(cwd: string): PlaywrightInstall | null {
  try {
    const packageJson = createRequire(join(cwd, "noop.js")).resolve(
      "@playwright/test/package.json"
    )
    return readInstall(packageJson, "workspace")
  } catch {
    return null
  }
}

let bundledOverride: string | null | undefined

// Tests point the bundled runner elsewhere (or at nothing, with null).
export function setBundledPlaywrightPackageJson(
  path: string | null | undefined
) {
  bundledOverride = path
}

export function bundledPlaywright(): PlaywrightInstall | null {
  if (bundledOverride === null) return null
  try {
    const packageJson =
      bundledOverride ??
      createRequire(__filename).resolve("@playwright/test/package.json")
    // Packaged, the resolver returns a path inside app.asar; the files a
    // child process loads are in app.asar.unpacked.
    return readInstall(
      normalizeAsarUnpackedExecutablePath(packageJson),
      "bundled"
    )
  } catch {
    return null
  }
}

export function resolvePlaywright(cwd: string): PlaywrightInstall | null {
  return workspacePlaywright(cwd) ?? bundledPlaywright()
}

// ── running Playwright's CLI as Node ────────────────────────────────────────

function quote(arg: string): string {
  return process.platform === "win32"
    ? `"${arg.replace(/"/g, '\\"')}"`
    : `'${arg.replace(/'/g, `'\\''`)}'`
}

// A shell command running a script on the configured executable as Node.
export function nodeCommand(script: string, args: string[]): string {
  return [environment.executable, script, ...args].map(quote).join(" ")
}

export function nodeEnv(
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    ELECTRON_RUN_AS_NODE: "1",
    ...extra,
  }
}

// ── the bundled runner's browser ────────────────────────────────────────────

export type TestBrowserStatus =
  | "unknown"
  // The user's Chrome: nothing to download.
  | "chrome"
  // Playwright's headless shell, in app data.
  | "installed"
  | "missing"
  | "downloading"
  | "failed"
  // No bundled Playwright (a broken install): nothing to download either.
  | "unavailable"

export interface TestBrowserState {
  status: TestBrowserStatus
  // A check needed a browser while none was installed: Mission Control
  // shows a notice asking for the download until it's done.
  requested: boolean
  consent: boolean
  // While downloading, from Playwright's progress output.
  progress: { percent: number; totalMb: number | null } | null
  // The download's size, when known (for the consent prompt).
  sizeMb: number | null
  error: string | null
}

let state: TestBrowserState = {
  status: "unknown",
  requested: false,
  consent: false,
  progress: null,
  sizeMb: null,
  error: null,
}
const events = new EventEmitter()

function update(patch: Partial<TestBrowserState>): void {
  state = { ...state, ...patch }
  events.emit("changed", getTestBrowserState())
}

export function getTestBrowserState(): TestBrowserState {
  return { ...state, consent: environment.consent() }
}

export function onTestBrowserChanged(
  listener: (state: TestBrowserState) => void
): () => void {
  events.on("changed", listener)
  return () => events.off("changed", listener)
}

interface ShellLocation {
  dir: string
  url: string | null
}
let shellLocation: ShellLocation | null = null

// A Playwright's `install --dry-run` output: where each browser it would
// install lives (which accounts for platform revision overrides).
function dryRun(
  install: PlaywrightInstall,
  args: string[],
  env: Record<string, string>
): Promise<string> {
  return new Promise<string>((resolve) => {
    const child = spawn(
      environment.executable,
      [install.cliPath, "install", "--dry-run", ...args],
      { env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }
    )
    let text = ""
    child.stdout.on("data", (d) => (text += d))
    child.on("error", () => resolve(""))
    child.on("close", () => resolve(text))
  })
}

function dryRunLocation(out: string, browser: RegExp): ShellLocation | null {
  const section = out.split(/\n\s*\n/).find((block) => browser.test(block))
  const dir = section?.match(/Install location:\s*(.+)/)?.[1]?.trim()
  if (!dir) return null
  return { dir, url: section?.match(/Download url:\s*(\S+)/)?.[1] ?? null }
}

// Where this Playwright version installs its headless shell.
async function headlessShellLocation(
  install: PlaywrightInstall
): Promise<ShellLocation | null> {
  if (shellLocation) return shellLocation
  if (!environment.browsersPath) return null
  const out = await dryRun(
    install,
    ["--only-shell", "chromium"],
    nodeEnv({ PLAYWRIGHT_BROWSERS_PATH: environment.browsersPath })
  )
  shellLocation = dryRunLocation(out, /chromium-headless-shell/)
  return shellLocation
}

// The workspace's own Playwright uses its own browsers (Playwright's cache,
// or the user's PLAYWRIGHT_BROWSERS_PATH), never the app's. A headless run
// launches the headless shell when this version has one, else Chromium.
export async function workspaceBrowserInstalled(
  install: PlaywrightInstall
): Promise<{ installed: boolean; location: string | null }> {
  const out = await dryRun(install, ["chromium"], nodeEnv())
  const location =
    dryRunLocation(out, /chromium-headless-shell/) ??
    dryRunLocation(out, /\(playwright chromium v\d/)
  if (!location) return { installed: false, location: null }
  return {
    installed: existsSync(join(location.dir, "INSTALLATION_COMPLETE")),
    location: location.dir,
  }
}

async function shellInstalled(install: PlaywrightInstall): Promise<boolean> {
  const location = await headlessShellLocation(install)
  return !!location && existsSync(join(location.dir, "INSTALLATION_COMPLETE"))
}

// The browser state as it is now, without downloading anything. Fetches the
// download's size for the consent prompt while it's missing.
export async function refreshTestBrowserState(): Promise<TestBrowserState> {
  if (state.status === "downloading") return getTestBrowserState()
  const install = bundledPlaywright()
  if (!install) update({ status: "unavailable" })
  else if (environment.findChrome())
    update({ status: "chrome", requested: false })
  else if (await shellInstalled(install))
    update({ status: "installed", requested: false })
  else {
    update({ status: state.status === "failed" ? "failed" : "missing" })
    if (state.sizeMb === null) void fetchDownloadSize(install)
  }
  return getTestBrowserState()
}

async function fetchDownloadSize(install: PlaywrightInstall): Promise<void> {
  const url = (await headlessShellLocation(install))?.url
  if (!url) return
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(10_000),
    })
    const bytes = Number(res.headers.get("content-length"))
    if (res.ok && bytes > 0)
      update({ sizeMb: Math.round((bytes / 1024 / 1024) * 10) / 10 })
  } catch {
    // The prompt just doesn't show a size.
  }
}

// A check needed a browser and none is installed: show the notice.
export function requestTestBrowser(): void {
  if (!state.requested) update({ requested: true })
}

const BROWSER_READY: TestBrowserStatus[] = ["chrome", "installed"]

// A QA step needs the bundled runner's browser and it's missing: ask for it
// and wait until it's there (downloaded with consent, or Chrome installed),
// instead of recording the step's checks as not verifiable. The poll catches
// a Chrome installed meanwhile, which raises no event. Resolves false when
// stopped first.
export async function waitForTestBrowser(
  signal?: AbortSignal,
  pollMs = 15_000
): Promise<boolean> {
  if (signal?.aborted) return false
  if (BROWSER_READY.includes((await refreshTestBrowserState()).status))
    return true
  requestTestBrowser()
  return new Promise<boolean>((resolve) => {
    let checking = false
    const finish = (ready: boolean) => {
      off()
      clearInterval(timer)
      signal?.removeEventListener("abort", onAbort)
      resolve(ready)
    }
    const onAbort = () => finish(false)
    const off = onTestBrowserChanged((next) => {
      if (BROWSER_READY.includes(next.status)) finish(true)
    })
    const timer = setInterval(() => {
      if (checking) return
      checking = true
      void refreshTestBrowserState()
        .then((next) => {
          if (BROWSER_READY.includes(next.status)) finish(true)
          else requestTestBrowser()
        })
        .finally(() => (checking = false))
    }, pollMs)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

let downloading: Promise<boolean> | null = null

const PROGRESS = /(\d+)% of ([\d.]+) MiB/

// Download the headless shell into app data. Giving consent is part of the
// call: the user asked for it. Resolves true once it's installed.
export function installTestBrowser(): Promise<boolean> {
  if (downloading) return downloading
  environment.giveConsent()
  const install = bundledPlaywright()
  if (!install || !environment.browsersPath) {
    update({ status: "unavailable" })
    return Promise.resolve(false)
  }
  update({
    status: "downloading",
    progress: { percent: 0, totalMb: state.sizeMb },
    error: null,
  })
  downloading = new Promise<boolean>((resolve) => {
    const child = spawn(
      environment.executable,
      [install.cliPath, "install", "--only-shell", "chromium"],
      {
        env: nodeEnv({ PLAYWRIGHT_BROWSERS_PATH: environment.browsersPath! }),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }
    )
    let output = ""
    const onData = (data: Buffer) => {
      const text = data.toString()
      output = (output + text).slice(-4000)
      const matches = [...text.matchAll(new RegExp(PROGRESS, "g"))]
      const last = matches[matches.length - 1]
      // The shell is the first and largest download; ffmpeg follows.
      if (
        last &&
        state.progress &&
        Number(last[2]) >= (state.progress.totalMb ?? 0) / 2
      )
        update({
          progress: { percent: Number(last[1]), totalMb: Number(last[2]) },
        })
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)
    const finish = async (ok: boolean, error?: string) => {
      shellLocation = null
      const installed = ok && (await shellInstalled(install))
      update({
        status: installed ? "installed" : "failed",
        requested: installed ? false : state.requested,
        progress: null,
        error: installed
          ? null
          : (error ??
            (output.trim().split("\n").slice(-5).join("\n") ||
              "The download failed.")),
      })
      downloading = null
      resolve(installed)
    }
    child.on("error", (err) => void finish(false, err.message))
    child.on("close", (code) => void finish(code === 0))
  })
  return downloading
}

// The browser a bundled-runner check uses. With consent already given, a
// missing browser (first use, or a Playwright update) is downloaded first.
export type TestBrowser =
  | { kind: "chrome" }
  | { kind: "installed"; browsersPath: string }
  | { kind: "missing"; browsersPath: string | null }

export async function testBrowserForRun(): Promise<TestBrowser> {
  const current = await refreshTestBrowserState()
  const browsersPath = environment.browsersPath
  if (current.status === "chrome") return { kind: "chrome" }
  if (current.status === "installed" && browsersPath)
    return { kind: "installed", browsersPath }
  if (environment.consent() && browsersPath && (await installTestBrowser()))
    return { kind: "installed", browsersPath }
  return { kind: "missing", browsersPath }
}

// Reset module state between tests.
export function resetTestBrowserStateForTests(): void {
  state = {
    status: "unknown",
    requested: false,
    consent: false,
    progress: null,
    sizeMb: null,
    error: null,
  }
  shellLocation = null
  downloading = null
  consentGiven = false
  bundledOverride = undefined
  environment = defaultEnvironment()
}
